import express, { type Request, type Response, Router } from "express";
import { Logger } from "tslog";
import {
    getActiveProvider,
    getActiveProviderId,
    providerInfo,
} from "@/services/providers";
import {
    getConfigDeviceByID,
    getPairedDeviceByType,
} from "@/services/db/configDevice";
import { getCustomer } from "@/services/customers";
import { insertOrder, syncOrderFromSquare } from "@/services/db/orders";
import { bigintReplacer } from "@tessellatepos/sdk";
import type { Money, Order, TenderType } from "@tessellatepos/sdk";
import { hooks, events } from "@tessellatepos/plugin-sdk/server";
import { emitPaymentStatusEvent } from "@/services/websocket/events";
import { requireLocation, requireScope } from "@/middleware/authenticate";
import { ITessellateApiRouter } from "@/utils/registry/api/apiRegistry";
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

export const ordersv1Endpoint: ITessellateApiRouter = {
    route_path: "/orders",
    version: "v1",
    router: orderRouter,
};

// The plugin registry is attached to app.locals in server.ts after plugins
// are loaded. Each handler reads it from the request so we don't need a
// factory or module-level mutable state.
function getPluginRegistry(req: express.Request): TessellatePluginRegistry {
    return (req.app.locals as { pluginRegistry: TessellatePluginRegistry })
        .pluginRegistry;
}

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

            // HOOK: beforeOrderCreate — plugins can modify or block the order
            const hookResult = await getPluginRegistry(req).runHook(
                hooks.beforeOrderCreate,
                orderDetails,
            );
            if (!hookResult.ok) {
                res.status(400).json({ message: hookResult.reason });
                return;
            }
            const modifiedOrderDetails = hookResult.value;

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

            const order = await provider.createOrder(modifiedOrderDetails);

            if (order !== null && order !== undefined) {
                logger.debug("Created order:", order.referenceId);
                await insertOrder(order);

                // EVENT: orderCreated — plugins react (non-blocking)
                getPluginRegistry(req).emit(events.orderCreated, order);

                res.status(200)
                    .header("Content-Type", "application/json")
                    .send(JSON.stringify(order, bigintReplacer));
            } else {
                logger.debug(
                    "Failed to create order",
                    JSON.stringify(order, bigintReplacer),
                );
                res.status(500).json({ message: "Failed to create order" });
            }
        } catch (error) {
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

            if (amountTendered === undefined || amountTendered === null) {
                res.status(400).json({ message: "Missing amountTendered" });
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
            );
            if (!payResult.ok) {
                res.status(400).json({ message: payResult.reason });
                return;
            }

            const tenderedMoney: Money = {
                amount: BigInt(amountTendered),
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

            // HOOK: beforePayment — plugins can block payment (gate)
            const payResult = await getPluginRegistry(req).runHook(
                hooks.beforePayment,
                { orderId, method: "MOBILE_READER" as TenderType },
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
            getPluginRegistry(req).emit(events.paymentCompleted, order, "CARD");

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
