import express, { type Request, type Response, Router } from "express";
import { Logger } from "tslog";
import {
    getActiveProvider,
    getActiveProviderId,
    providerInfo,
} from "@/services/providers";
import {
    InvalidOrderError,
    OrderConflictError,
} from "@/services/providers/types";
import {
    getConfigDeviceByID,
    getPairedDeviceByType,
} from "@/services/db/configDevice";
import { getCustomer } from "@/services/customers";
import {
    InvalidCursorError,
    insertOrder,
    listOrdersByCredential,
    rowToOrder,
    syncOrderFromSquare,
} from "@/services/db/orders";
import {
    listOnlinePayments,
    listOnlinePaymentsForOrders,
} from "@/services/db/onlinePayments";
import {
    cancelUnpaidOrder,
    findOwnedOrder,
    nonOnlineVariations,
    presentOrder,
    startCheckout,
    toInvoiceView,
    type GatewayCaller,
} from "@/services/onlineOrders";
import { bigintReplacer } from "@tessellatepos/sdk";
import type { Money, Order, TenderType } from "@tessellatepos/sdk";
import { hooks, events } from "@tessellatepos/plugin-sdk/server";
import { emitPaymentStatusEvent } from "@/services/websocket/events";
import {
    hasScope,
    requireLocation,
    requireScope,
} from "@/middleware/authenticate";
import { cancelInvoice, createInvoice } from "@/services/invoices";
import { ITessellateApiRouter } from "@/utils/registry/api/apiRegistry";
import {
    invoiceSchema,
    orderCheckoutResponseSchema,
    orderCheckoutSchema,
    orderCreateSchema,
    orderInvoiceSchema,
    orderListQuerySchema,
    orderPageSchema,
    orderSchema,
    toInternalOrder,
} from "@/gateway/schemas/orders";
import { pluginContext } from "@/utils/pluginContext";
import type { TessellatePluginRegistry } from "@/utils/registry/plugin/pluginRegistry";

const orderRouter: Router = express.Router();

const logger = new Logger();

/**
 * Whether a till named in a request is a LOCAL till. Card tenders are refused
 * for it under every provider: a LOCAL till is staff-browser cash only. The
 * till names itself in the body, so this only restricts and never grants.
 * @param deviceId the deviceId from the request body
 * @returns true when the device is a LOCAL till
 */
async function isLocalTill(deviceId: unknown): Promise<boolean> {
    if (typeof deviceId !== "string" || !deviceId) return false;
    const device = await getConfigDeviceByID(deviceId);
    return device?.device_type === "LOCAL";
}

/**
 * Whether the request's principal may act on an order. A principal pinned to
 * locations can only reach orders at those locations. An unknown order and an
 * order at another location answer differently (404 vs 403), as the brief asks.
 * @param req the request, carrying the principal
 * @param orderId the order the route targets
 * @returns "ok", "not-found", or "forbidden"
 */
async function checkOrderLocation(
    req: express.Request,
    orderId: string,
): Promise<"ok" | "not-found" | "forbidden"> {
    const principal = req.principal;
    if (principal?.location_ids === "all") return "ok";
    const order = await getActiveProvider().fetchOrder(orderId);
    if (!order) return "not-found";
    if (!principal || !order.locationId) return "forbidden";
    return principal.location_ids.includes(order.locationId)
        ? "ok"
        : "forbidden";
}

/**
 * Sends the refusal for {@link checkOrderLocation} when it is not "ok".
 * @returns true when a response was sent and the handler must stop
 */
function refuseOrderAccess(
    res: Response,
    access: "ok" | "not-found" | "forbidden",
): boolean {
    if (access === "ok") return false;
    // Same answer for both, so a principal cannot tell an order elsewhere from
    // one that does not exist.
    res.status(404).json({ message: "Order not found" });
    return true;
}

/**
 * Reads an integer sent as a JSON number or a digit string (the gateway
 * hands over bigints already).
 * @param value the raw value
 * @returns the integer, or null when it is anything else
 */
function wholeNumber(value: unknown): bigint | null {
    if (typeof value === "bigint") return value;
    if (typeof value === "number") {
        return Number.isSafeInteger(value) ? BigInt(value) : null;
    }
    if (typeof value === "string" && /^-?\d{1,18}$/.test(value.trim())) {
        return BigInt(value.trim());
    }
    return null;
}

/**
 * Checks what the create route would otherwise turn into a 500: a quantity
 * that is not a positive whole number, or a price that is not whole minor units.
 * @param lineItems the request's line items
 * @returns a message for the first problem, or null
 */
function invalidLineItem(lineItems: unknown[]): string | null {
    for (const [i, raw] of lineItems.entries()) {
        const line = (raw ?? {}) as {
            quantity?: unknown;
            priceMoney?: { amount?: unknown } | null;
        };
        if (typeof raw !== "object" || raw === null) {
            return `lineItems[${i}] must be an object`;
        }
        if (line.quantity !== undefined && line.quantity !== null) {
            const q = wholeNumber(line.quantity);
            if (q === null || q < 1n) {
                return `lineItems[${i}].quantity must be a positive whole number`;
            }
        }
        const amount = line.priceMoney?.amount;
        if (amount !== undefined && amount !== null) {
            if (wholeNumber(amount) === null) {
                return `lineItems[${i}].priceMoney.amount must be a whole number of minor units`;
            }
        }
    }
    return null;
}

export const ordersv1Endpoint: ITessellateApiRouter = {
    route_path: "/orders",
    version: "v1",
    router: orderRouter,
    gateway: [
        {
            method: "POST",
            path: "/",
            internalPath: "/create",
            operationId: "orders.create",
            scope: "orders:write",
            summary: "Create an order from variation ids and quantities",
            location: "body",
            request: orderCreateSchema,
            response: orderSchema,
            toInternal: (input) =>
                toInternalOrder(input as Parameters<typeof toInternalOrder>[0]),
            headers: [
                {
                    name: "Idempotency-Key",
                    description:
                        "1 to 255 printable ASCII characters. A retry with the same key and body returns the first answer (with Idempotent-Replayed: true) instead of creating a second order; the key is remembered for 24 hours per credential.",
                },
            ],
            responseHeaders: [
                {
                    name: "Idempotent-Replayed",
                    description:
                        "true when this answer is a replay of an earlier request with the same Idempotency-Key",
                },
            ],
            statuses: {
                409: "idempotency_in_progress: a request with this key is still running",
                422: "idempotency_key_reused: the key was used with a different body",
                429: "open_order_limit or rate_limited",
            },
        },
        {
            method: "GET",
            path: "/",
            internalPath: "/online",
            operationId: "orders.list",
            scope: "orders:read",
            summary:
                "List the orders this credential created, newest first, one page at a time",
            location: "none",
            request: orderListQuerySchema,
            response: orderPageSchema,
        },
        {
            method: "GET",
            path: "/:orderId",
            operationId: "orders.get",
            scope: "orders:read",
            summary: "Get one order this credential created",
            location: "none",
            response: orderSchema,
        },
        {
            method: "POST",
            path: "/:orderId/checkout",
            internalPath: "/:orderId/online-checkout",
            operationId: "orders.checkout",
            scope: "orders:write",
            summary:
                "Start a hosted checkout for an unpaid order and return the page to send the shopper to",
            location: "none",
            request: orderCheckoutSchema,
            response: orderCheckoutResponseSchema,
            statuses: {
                404: "not_found: no such order for this credential",
                409: "order_not_payable, pay_at_pickup, online_payments_unavailable, processor_disabled, checkout_not_supported or payment_in_progress",
                502: "processor_error: the processor could not start a checkout",
            },
        },
        {
            method: "POST",
            path: "/:orderId/invoice",
            internalPath: "/:orderId/online-invoice",
            operationId: "orders.invoice",
            scope: "orders:write",
            summary:
                "Invoice an unpaid order: the processor sends the customer an invoice to pay later",
            location: "none",
            request: orderInvoiceSchema,
            response: invoiceSchema,
            statuses: {
                403: "customer_scope_required: customer_id needs the customers:read scope",
                404: "not_found: no such order for this credential",
                409: "order_not_payable, invoice_not_supported, processor_disabled, online_payments_unavailable, payment_in_progress or customer_mismatch",
                422: "customer_required, customer_not_found or customer_contact_missing: the customer lacks the email or phone the delivery method needs",
                502: "processor_error: the processor could not create the invoice",
            },
        },
        {
            method: "POST",
            path: "/:orderId/invoice/cancel",
            internalPath: "/:orderId/online-invoice/cancel",
            operationId: "orders.cancelInvoice",
            scope: "orders:write",
            summary:
                "Cancel the order's open invoice (to change one, cancel it and issue a new one)",
            location: "none",
            response: invoiceSchema,
            statuses: {
                404: "not_found or invoice_not_found",
                409: "invoice_not_cancellable: the invoice is paid or refunded",
                502: "processor_error: the processor could not cancel the invoice",
            },
        },
        {
            method: "POST",
            path: "/:orderId/cancel",
            operationId: "orders.cancel",
            scope: "orders:write",
            summary: "Cancel an order that has not been paid",
            location: "none",
            response: orderSchema,
            statuses: {
                404: "not_found: no such order for this credential",
                409: "order_not_cancellable or order_invoiced",
            },
        },
    ],
};

// The plugin registry is attached to app.locals in server.ts after plugins
// are loaded. Each handler reads it from the request so we don't need a
// factory or module-level mutable state.
function getPluginRegistry(req: express.Request): TessellatePluginRegistry {
    return (req.app.locals as { pluginRegistry: TessellatePluginRegistry })
        .pluginRegistry;
}

/**
 * The gateway credential behind a request, with the facts the online order
 * rules need. Answers 403 and returns null for any other caller: these
 * routes exist for the gateway only.
 */
function gatewayCaller(
    req: express.Request,
    res: Response,
): (GatewayCaller & Parameters<typeof startCheckout>[0]["caller"]) | null {
    const credential = req.gatewayCredential;
    const principal = req.principal;
    if (!credential || !principal) {
        res.status(403).json({ message: "Gateway credential required" });
        return null;
    }
    return {
        credentialId: credential.id,
        locationIds: principal.location_ids,
        origins: credential.origins,
        principal: {
            kind: principal.kind,
            id: principal.id,
            display_name: principal.display_name,
        },
    };
}

function sendOrder(res: Response, body: unknown, status = 200) {
    res.status(status)
        .header("Content-Type", "application/json")
        .send(JSON.stringify(body, bigintReplacer));
}

function sendRefusal(
    res: Response,
    refusal: { status: number; code: string; message: string },
) {
    res.status(refusal.status).json({
        message: refusal.message,
        code: refusal.code,
    });
}

// The orders a gateway credential created, at its locations, newest first.
// Declared before "/:orderId" so "online" is not read as an order id.
orderRouter.get(
    "/online",
    requireScope("orders:read"),
    async (req: Request, res: Response) => {
        const caller = gatewayCaller(req, res);
        if (!caller) return;
        try {
            const parsedQuery = orderListQuerySchema.safeParse(req.query);
            if (!parsedQuery.success) {
                res.status(400).json({ message: "Invalid query" });
                return;
            }
            const query = parsedQuery.data;
            const page = await listOrdersByCredential(
                caller.credentialId,
                caller.locationIds,
                { limit: query.limit, cursor: query.cursor },
            );
            const attempts = await listOnlinePaymentsForOrders(
                page.orders.map((o) => o.referenceId!),
            );
            sendOrder(res, {
                orders: page.orders.map((order) =>
                    presentOrder(
                        order,
                        attempts.filter(
                            (a) => a.order_reference === order.referenceId,
                        ),
                    ),
                ),
                next_cursor: page.nextCursor,
            });
        } catch (error) {
            if (error instanceof InvalidCursorError) {
                res.status(400).json({ message: "Invalid cursor" });
                return;
            }
            logger.error("Failed to list orders", error);
            res.status(500).json({ message: "Failed to list orders" });
        }
    },
);

// Reads one order. The order's own location is checked, as for payments. A
// gateway credential also has to have created the order.
orderRouter.get(
    "/:orderId",
    requireScope("orders:read"),
    async (req: Request<{ orderId: string }>, res: Response) => {
        try {
            const orderId = req.params.orderId;
            if (req.gatewayCredential) {
                const caller = gatewayCaller(req, res);
                if (!caller) return;
                const row = await findOwnedOrder(caller, orderId);
                if (!row) {
                    res.status(404).json({ message: "Order not found" });
                    return;
                }
                sendOrder(
                    res,
                    presentOrder(
                        rowToOrder(row),
                        await listOnlinePayments(row.referenceId),
                    ),
                );
                return;
            }
            if (refuseOrderAccess(res, await checkOrderLocation(req, orderId)))
                return;
            const order = await getActiveProvider().fetchOrder(orderId);
            if (!order) {
                res.status(404).json({ message: "Order not found" });
                return;
            }
            res.status(200)
                .header("Content-Type", "application/json")
                .send(JSON.stringify(order, bigintReplacer));
        } catch (error) {
            logger.error("Failed to fetch order", error);
            res.status(500).json({ message: "Failed to fetch order" });
        }
    },
);

orderRouter.post(
    "/:orderId/online-checkout",
    requireScope("orders:write"),
    async (req: Request<{ orderId: string }>, res: Response) => {
        const caller = gatewayCaller(req, res);
        if (!caller) return;
        try {
            const parsed = orderCheckoutSchema.safeParse(req.body);
            if (!parsed.success) {
                res.status(400).json({ message: "Invalid checkout request" });
                return;
            }
            const row = await findOwnedOrder(caller, req.params.orderId);
            if (!row) {
                res.status(404).json({ message: "Order not found" });
                return;
            }
            const outcome = await startCheckout({
                row,
                processorId: parsed.data.processor,
                successUrl: parsed.data.success_url,
                cancelUrl: parsed.data.cancel_url,
                caller,
                plugins: getPluginRegistry(req),
            });
            if (!outcome.ok) {
                sendRefusal(res, outcome);
                return;
            }
            sendOrder(res, {
                url: outcome.url,
                expires_at: outcome.expires_at,
                processor: outcome.processor,
                payment_id: outcome.payment_id,
            });
        } catch (error) {
            logger.error("Failed to start online checkout", error);
            res.status(500).json({ message: "Failed to start checkout" });
        }
    },
);

orderRouter.post(
    "/:orderId/online-invoice",
    requireScope("orders:write"),
    async (req: Request<{ orderId: string }>, res: Response) => {
        const caller = gatewayCaller(req, res);
        if (!caller) return;
        try {
            const parsed = orderInvoiceSchema.safeParse(req.body);
            if (!parsed.success) {
                res.status(400).json({ message: "Invalid invoice request" });
                return;
            }
            // Naming a customer by id is a customer lookup in effect.
            if (
                parsed.data.customer_id &&
                !hasScope(req.principal!, "customers:read")
            ) {
                res.status(403).json({
                    message: "customer_id needs the customers:read scope",
                    code: "customer_scope_required",
                });
                return;
            }
            const row = await findOwnedOrder(caller, req.params.orderId);
            if (!row) {
                res.status(404).json({ message: "Order not found" });
                return;
            }
            const outcome = await createInvoice({
                row,
                processorId: parsed.data.processor,
                customerId: parsed.data.customer_id,
                delivery: parsed.data.delivery,
                dueDate: parsed.data.due_date,
                message: parsed.data.message,
                plugins: getPluginRegistry(req),
                caller: req,
            });
            if (!outcome.ok) {
                sendRefusal(res, outcome);
                return;
            }
            sendOrder(res, toInvoiceView(outcome.invoice));
        } catch (error) {
            logger.error("Failed to create invoice", error);
            res.status(500).json({ message: "Failed to create invoice" });
        }
    },
);

orderRouter.post(
    "/:orderId/online-invoice/cancel",
    requireScope("orders:write"),
    async (req: Request<{ orderId: string }>, res: Response) => {
        const caller = gatewayCaller(req, res);
        if (!caller) return;
        try {
            const row = await findOwnedOrder(caller, req.params.orderId);
            if (!row) {
                res.status(404).json({ message: "Order not found" });
                return;
            }
            const outcome = await cancelInvoice(row, getPluginRegistry(req), {
                caller: req,
            });
            if (!outcome.ok) {
                sendRefusal(res, outcome);
                return;
            }
            sendOrder(res, toInvoiceView(outcome.invoice));
        } catch (error) {
            logger.error("Failed to cancel invoice", error);
            res.status(500).json({ message: "Failed to cancel invoice" });
        }
    },
);

orderRouter.post(
    "/:orderId/cancel",
    requireScope("orders:write"),
    async (req: Request<{ orderId: string }>, res: Response) => {
        const caller = gatewayCaller(req, res);
        if (!caller) return;
        try {
            const row = await findOwnedOrder(caller, req.params.orderId);
            if (!row) {
                res.status(404).json({ message: "Order not found" });
                return;
            }
            const outcome = await cancelUnpaidOrder(
                row,
                getPluginRegistry(req),
                req,
            );
            if (!outcome.ok) {
                sendRefusal(res, outcome);
                return;
            }
            sendOrder(
                res,
                presentOrder(
                    outcome.order,
                    await listOnlinePayments(row.referenceId),
                ),
            );
        } catch (error) {
            logger.error("Failed to cancel order", error);
            res.status(500).json({ message: "Failed to cancel order" });
        }
    },
);

orderRouter.post(
    "/create",
    requireScope("orders:write"),
    requireLocation((req) => req.body?.locationId),
    async (req, res) => {
        const provider = getActiveProvider();
        try {
            const orderDetails: Order = req.body;

            logger.debug("orderDetails created", orderDetails);

            if (!orderDetails || typeof orderDetails !== "object") {
                res.status(400).json({
                    message: "Missing or invalid order details",
                });
                return;
            }

            if (!Array.isArray(orderDetails.lineItems)) {
                res.status(400).json({
                    message: "orderDetails.lineItems must be an array",
                });
                return;
            }

            const lineProblem = invalidLineItem(orderDetails.lineItems);
            if (lineProblem) {
                res.status(400).json({ message: lineProblem });
                return;
            }

            // Only what is sold online can be ordered through a credential.
            // Totals come from the catalog, so a staff-only item must not be
            // reachable by guessing its variation id.
            if (req.gatewayCredential) {
                const variationIds = orderDetails.lineItems
                    .map((line) => line.itemId)
                    .filter((id): id is string => typeof id === "string");
                const { unknown, notOnline } =
                    await nonOnlineVariations(variationIds);
                if (unknown.length > 0) {
                    res.status(400).json({
                        message: `Unknown variation ${unknown[0]}`,
                        code: "unknown_variation",
                    });
                    return;
                }
                if (notOnline.length > 0) {
                    res.status(400).json({
                        message: `Variation ${notOnline[0]} is not sold online`,
                        code: "item_not_online",
                    });
                    return;
                }
            }

            // HOOK: beforeOrderCreate — plugins can modify or block the order
            const hookResult = await getPluginRegistry(req).runHook(
                hooks.beforeOrderCreate,
                orderDetails,
                { context: pluginContext(req) },
            );
            if (!hookResult.ok) {
                res.status(400).json({ message: hookResult.reason });
                return;
            }
            const modifiedOrderDetails = hookResult.value;

            // A credential's orders are attributed to it, whatever a plugin
            // hook did; staff orders keep the source they came with.
            if (req.gatewayCredential && req.principal?.display_name) {
                modifiedOrderDetails.source = {
                    name: req.principal.display_name.slice(0, 255),
                };
            }

            // An attached customer must exist (checked after the hook, which may
            // have set or changed it).
            const customerId = modifiedOrderDetails.customerId;
            if (customerId !== undefined && customerId !== null) {
                if (
                    typeof customerId !== "string" ||
                    !(await getCustomer(customerId))
                ) {
                    res.status(400).json({ message: "Unknown customer" });
                    return;
                }
            }

            modifiedOrderDetails.referenceId = crypto.randomUUID();

            const order = await provider.createOrder(modifiedOrderDetails, {
                catalogPricing: Boolean(req.gatewayCredential),
            });

            if (order !== null && order !== undefined) {
                logger.debug("Created order:", order.referenceId);
                await insertOrder(order, undefined, req.gatewayCredential?.id);

                // EVENT: orderCreated — plugins react (non-blocking)
                getPluginRegistry(req).emit(
                    events.orderCreated,
                    order,
                    pluginContext(req, order),
                );

                sendOrder(
                    res,
                    req.gatewayCredential
                        ? {
                              ...order,
                              payment_status: "unpaid",
                              latest_payment: null,
                          }
                        : order,
                );
            } else {
                logger.debug(
                    "Failed to create order",
                    JSON.stringify(order, bigintReplacer),
                );
                res.status(500).json({ message: "Failed to create order" });
            }
        } catch (error) {
            if (error instanceof InvalidOrderError) {
                res.status(400).json({ message: error.message });
                return;
            }
            logger.error("Failed to create order", error);
            res.status(500).json({ message: "Failed to create order" });
        }
    },
);

orderRouter.post(
    "/:orderId/checkout",
    requireScope("orders:write"),
    async (
        req: Request<{ orderId: string; checkoutId: string }>,
        res: Response,
    ) => {
        const provider = getActiveProvider();
        try {
            const orderId = req.params.orderId;

            if (refuseOrderAccess(res, await checkOrderLocation(req, orderId)))
                return;

            if (await isLocalTill(req.body?.deviceId)) {
                res.status(400).json({
                    message: "Local tills take cash only",
                });
                return;
            }

            if (!provider.createTerminalCheckout) {
                res.status(400).json({
                    message:
                        "Terminal checkout is not supported by this provider",
                });
                return;
            }

            // Only providers with hardware terminals need a paired device; the
            // local provider takes the payment without one.
            let deviceId = "";
            if (providerInfo[getActiveProviderId()].requiresTerminalDevice) {
                const terminalDevice = await getPairedDeviceByType("TERMINAL");
                deviceId = terminalDevice?.square_device_id ?? "";
                if (!deviceId) {
                    logger.error(
                        "No Square-paired Terminal device is configured",
                    );
                    res.status(500).json({
                        message: "Terminal device is not paired with Square",
                    });
                    return;
                }
            }

            const order = await provider.fetchOrder(orderId);
            if (!order || !order.totalMoney) {
                res.status(404).json({
                    message: "Order not found or missing total",
                });
                return;
            }

            // HOOK: beforeCheckout — plugins can block checkout (gate)
            const checkoutResult = await getPluginRegistry(req).runHook(
                hooks.beforeCheckout,
                { orderId, amount: order.totalMoney },
                { context: pluginContext(req, order) },
            );
            if (!checkoutResult.ok) {
                res.status(400).json({ message: checkoutResult.reason });
                return;
            }

            const checkoutId = await provider.createTerminalCheckout(
                orderId,
                order.totalMoney,
                deviceId,
            );

            if (!checkoutId) {
                res.status(500).json({
                    message: "Failed to create terminal checkout",
                });
                return;
            }

            const status =
                await provider.getTerminalCheckoutStatus?.(checkoutId);

            if (status === "COMPLETED") {
                const paidOrder = await provider.fetchOrder(orderId);
                if (paidOrder) {
                    await syncOrderFromSquare(paidOrder);
                }
                emitPaymentStatusEvent({
                    type: "payment_status",
                    payload: {
                        orderId,
                        locationId: order.locationId,
                        status: "COMPLETED",
                        paymentMethod: "TERMINAL",
                    },
                });

                // EVENT: paymentCompleted — plugins react (non-blocking)
                if (paidOrder) {
                    getPluginRegistry(req).emit(
                        events.paymentCompleted,
                        paidOrder,
                        "CARD",
                        pluginContext(req, paidOrder),
                    );
                }

                res.status(200)
                    .header("Content-Type", "application/json")
                    .send(
                        JSON.stringify(
                            { checkoutId, status, order: paidOrder },
                            bigintReplacer,
                        ),
                    );
                return;
            }

            res.status(200).json({ checkoutId, status });
        } catch (error) {
            logger.error("Failed to checkout order", error);
            res.status(500).json({ message: "Failed to checkout order" });
        }
    },
);

// Polling this syncs the order and announces the payment, so it is a write.
orderRouter.get(
    "/:orderId/checkout/:checkoutId",
    requireScope("orders:write"),
    async (
        req: Request<{ orderId: string; checkoutId: string }>,
        res: Response,
    ) => {
        const provider = getActiveProvider();
        try {
            const { checkoutId } = req.params;

            if (
                refuseOrderAccess(
                    res,
                    await checkOrderLocation(req, req.params.orderId),
                )
            )
                return;

            const status =
                await provider.getTerminalCheckoutStatus?.(checkoutId);
            if (!status) {
                res.status(404).json({ message: "Checkout not found" });
                return;
            }

            if (status === "COMPLETED") {
                const paidOrder = await provider.fetchOrder(req.params.orderId);
                if (paidOrder) {
                    await syncOrderFromSquare(paidOrder);
                }
                emitPaymentStatusEvent({
                    type: "payment_status",
                    payload: {
                        orderId: req.params.orderId,
                        locationId: paidOrder?.locationId,
                        status: "COMPLETED",
                        paymentMethod: "TERMINAL",
                    },
                });

                // EVENT: paymentCompleted — plugins react (non-blocking)
                if (paidOrder) {
                    getPluginRegistry(req).emit(
                        events.paymentCompleted,
                        paidOrder,
                        "CARD",
                        pluginContext(req, paidOrder),
                    );
                }

                res.status(200)
                    .header("Content-Type", "application/json")
                    .send(
                        JSON.stringify(
                            { checkoutId, status, order: paidOrder },
                            bigintReplacer,
                        ),
                    );
                return;
            }

            res.status(200).json({ checkoutId, status });
        } catch (error) {
            logger.error("Failed to get checkout status", error);
            res.status(500).json({
                message: "Failed to get checkout status",
            });
        }
    },
);

orderRouter.post(
    "/:orderId/pay-cash",
    requireScope("orders:write"),
    async (
        req: Request<{ orderId: string; checkoutId: string }>,
        res: Response,
    ) => {
        const provider = getActiveProvider();
        try {
            const orderId = req.params.orderId;
            const amountTendered = req.body?.amountTendered;

            if (refuseOrderAccess(res, await checkOrderLocation(req, orderId)))
                return;

            if (amountTendered === undefined || amountTendered === null) {
                res.status(400).json({ message: "Missing amountTendered" });
                return;
            }
            const tendered = wholeNumber(amountTendered);
            if (tendered === null || tendered < 0n) {
                res.status(400).json({
                    message:
                        "amountTendered must be a whole number of minor units",
                });
                return;
            }

            const order = await provider.fetchOrder(orderId);
            if (!order || !order.totalMoney) {
                res.status(404).json({
                    message: "Order not found or missing total",
                });
                return;
            }

            // HOOK: beforePayment — plugins can block payment (gate)
            const payResult = await getPluginRegistry(req).runHook(
                hooks.beforePayment,
                { orderId, method: "CASH" as TenderType },
                { context: pluginContext(req, order) },
            );
            if (!payResult.ok) {
                res.status(400).json({ message: payResult.reason });
                return;
            }

            const tenderedMoney: Money = {
                amount: tendered,
                currency: order.totalMoney.currency,
            };

            if (tenderedMoney.amount! < order.totalMoney.amount!) {
                res.status(400).json({
                    message: "Amount tendered is less than the order total",
                });
                return;
            }

            const changeDue = await provider.payCash(
                orderId,
                tenderedMoney,
                order.totalMoney,
            );

            const paidOrder = await provider.fetchOrder(orderId);
            if (!paidOrder) {
                res.status(500).json({
                    message:
                        "Payment may have succeeded but order refetch failed",
                });
                return;
            }
            await syncOrderFromSquare(paidOrder);

            // EVENT: paymentCompleted — plugins react (non-blocking)
            getPluginRegistry(req).emit(
                events.paymentCompleted,
                paidOrder,
                "CASH",
                pluginContext(req, paidOrder),
            );

            res.status(200)
                .header("Content-Type", "application/json")
                .send(
                    JSON.stringify(
                        { order: paidOrder, changeDue },
                        bigintReplacer,
                    ),
                );
        } catch (error) {
            if (error instanceof OrderConflictError) {
                res.status(409).json({ message: error.message });
                return;
            }
            logger.error("Failed to pay with cash", error);
            res.status(500).json({ message: "Failed to pay with cash" });
        }
    },
);

orderRouter.post(
    "/:orderId/pay-mobile-reader",
    requireScope("orders:write"),
    async (
        req: Request<{ orderId: string; checkoutId: string }>,
        res: Response,
    ) => {
        const provider = getActiveProvider();
        try {
            const orderId = req.params.orderId;
            const paymentId = req.body?.paymentId;

            if (refuseOrderAccess(res, await checkOrderLocation(req, orderId)))
                return;

            if (!paymentId) {
                res.status(400).json({ message: "Missing paymentId" });
                return;
            }

            if (await isLocalTill(req.body?.deviceId)) {
                res.status(400).json({
                    message: "Local tills take cash only",
                });
                return;
            }

            if (!provider.confirmMobileReaderPayment) {
                res.status(400).json({
                    message:
                        "Mobile reader payment is not supported by this provider",
                });
                return;
            }

            // The hook sees the order's source, so it is read first.
            const existing = await provider.fetchOrder(orderId);

            // HOOK: beforePayment — plugins can block payment (gate)
            const payResult = await getPluginRegistry(req).runHook(
                hooks.beforePayment,
                { orderId, method: "MOBILE_READER" as TenderType },
                { context: pluginContext(req, existing) },
            );
            if (!payResult.ok) {
                res.status(400).json({ message: payResult.reason });
                return;
            }

            const verified = await provider.confirmMobileReaderPayment(
                orderId,
                paymentId,
            );
            if (!verified) {
                res.status(400).json({
                    message: "Mobile reader payment could not be verified",
                });
                return;
            }

            const order = await provider.fetchOrder(orderId);
            if (!order) {
                res.status(404).json({ message: "Order not found" });
                return;
            }
            await syncOrderFromSquare(order);

            emitPaymentStatusEvent({
                type: "payment_status",
                payload: {
                    orderId,
                    locationId: order.locationId,
                    status: "COMPLETED",
                    paymentMethod: "MOBILE_READER",
                    paymentId,
                },
            });

            // EVENT: paymentCompleted — plugins react (non-blocking)
            getPluginRegistry(req).emit(
                events.paymentCompleted,
                order,
                "CARD",
                pluginContext(req, order),
            );

            res.status(200)
                .header("Content-Type", "application/json")
                .send(JSON.stringify(order, bigintReplacer));
        } catch (error) {
            logger.error("Failed to confirm mobile reader payment", error);
            res.status(500).json({
                message: "Failed to confirm mobile reader payment",
            });
        }
    },
);
