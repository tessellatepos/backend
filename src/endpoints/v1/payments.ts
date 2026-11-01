import express, { type Request, type Response, Router } from "express";
import { Logger } from "tslog";
import { getPublicUrl, onlinePaymentsAvailable } from "@/config/urls";
import { requireLocation, requireScope } from "@/middleware/authenticate";
import { bigintReplacer } from "@tessellatepos/sdk";
import type { OrderPaymentStatus } from "@tessellatepos/sdk";
import { InvalidCursorError, getOrderByAnyId } from "@/services/db/orders";
import {
    listStaffOnlineOrders,
    presentStaffOrder,
    toInvoiceView,
    type OrderRow,
} from "@/services/onlineOrders";
import { cancelInvoice, createInvoice } from "@/services/invoices";
import { orderInvoiceSchema } from "@/gateway/schemas/orders";
import type { TessellatePluginRegistry } from "@/utils/registry/plugin/pluginRegistry";
import { ITessellateApiRouter } from "@/utils/registry/api/apiRegistry";
import {
    ProcessorNotFoundError,
    ProcessorSettingsError,
    listProcessorsForLocation,
    updateProcessorSettings,
} from "@/services/processors/settings";

const paymentsRouter: Router = express.Router();

const logger = new Logger();

export const paymentsv1Endpoint: ITessellateApiRouter = {
    route_path: "/payments",
    version: "v1",
    router: paymentsRouter,
};

function sendError(res: Response, err: unknown, action: string): void {
    if (err instanceof ProcessorSettingsError) {
        res.status(400).json({ message: err.message });
    } else if (err instanceof ProcessorNotFoundError) {
        res.status(404).json({ message: err.message });
    } else {
        logger.error(`Failed to ${action} payment processors`, err);
        res.status(500).json({ message: `Failed to ${action} processors` });
    }
}

const queryLocation = (req: Request) =>
    typeof req.query.location_id === "string"
        ? req.query.location_id
        : undefined;

// Whether this server can take payments online at all (PUBLIC_URL over https).
paymentsRouter.get(
    "/status",
    requireScope("payments:read"),
    (_req: Request, res: Response) => {
        res.json({
            online_payments_available: onlinePaymentsAvailable(),
            public_url: getPublicUrl(),
        });
    },
);

paymentsRouter.get(
    "/processors",
    requireScope("payments:read"),
    requireLocation(queryLocation),
    async (req: Request, res: Response) => {
        const locationId = queryLocation(req);
        if (!locationId) {
            res.status(400).json({ message: "location_id is required" });
            return;
        }
        try {
            res.json(await listProcessorsForLocation(locationId));
        } catch (err) {
            sendError(res, err, "list");
        }
    },
);

// Enable, disable or configure one processor at one location. Config values
// are write-only: the response lists which keys are set, never their values.
paymentsRouter.put(
    "/processors/:processorId/locations/:locationId",
    requireScope("payments:admin"),
    requireLocation((req) => req.params.locationId as string),
    async (
        req: Request<{ processorId: string; locationId: string }>,
        res: Response,
    ) => {
        const body: unknown = req.body ?? {};
        if (typeof body !== "object" || body === null || Array.isArray(body)) {
            res.status(400).json({ message: "Body must be an object" });
            return;
        }
        const { enabled, config, ...rest } = body as Record<string, unknown>;
        if (Object.keys(rest).length > 0) {
            res.status(400).json({
                message: `Cannot change: ${Object.keys(rest).join(", ")}`,
            });
            return;
        }
        try {
            res.json(
                await updateProcessorSettings(
                    req.params.processorId,
                    req.params.locationId,
                    { enabled, config },
                ),
            );
        } catch (err) {
            sendError(res, err, "update");
        }
    },
);

const PAYMENT_STATUSES: OrderPaymentStatus[] = [
    "unpaid",
    "processing",
    "paid",
    "failed",
    "refunded",
];

function sendJson(res: Response, body: unknown, status = 200) {
    res.status(status)
        .header("Content-Type", "application/json")
        .send(JSON.stringify(body, bigintReplacer));
}

/** The order if the staff principal may reach its location, else a 404. */
async function staffOrder(
    req: Request<{ orderId: string }>,
    res: Response,
): Promise<OrderRow | null> {
    const row = await getOrderByAnyId(req.params.orderId);
    const locations = req.principal?.location_ids;
    // Same answer for missing and elsewhere, as for the other order routes.
    if (
        !row ||
        !locations ||
        (locations !== "all" && !locations.includes(row.locationId))
    ) {
        res.status(404).json({ message: "Order not found" });
        return null;
    }
    return row;
}

const pluginRegistryOf = (req: Request) =>
    (req.app.locals as { pluginRegistry: TessellatePluginRegistry })
        .pluginRegistry;

function sendRefusal(
    res: Response,
    refusal: { status: number; code: string; message: string },
) {
    res.status(refusal.status).json({
        message: refusal.message,
        code: refusal.code,
    });
}

// Online orders at one location, for the Payments screen: orders a gateway
// credential created plus any order with a payment attempt.
paymentsRouter.get(
    "/orders",
    requireScope("payments:read"),
    requireLocation(queryLocation),
    async (req: Request, res: Response) => {
        const locationId = queryLocation(req);
        if (!locationId) {
            res.status(400).json({ message: "location_id is required" });
            return;
        }
        const text = (value: unknown) =>
            typeof value === "string" && value ? value : undefined;
        const status = text(req.query.payment_status);
        const limit = text(req.query.limit);
        if (
            (status &&
                !PAYMENT_STATUSES.includes(status as OrderPaymentStatus)) ||
            (limit && !/^\d+$/.test(limit))
        ) {
            res.status(400).json({ message: "Invalid query" });
            return;
        }
        try {
            sendJson(
                res,
                await listStaffOnlineOrders({
                    locationId,
                    source: text(req.query.source),
                    processor: text(req.query.processor),
                    paymentStatus: status as OrderPaymentStatus | undefined,
                    limit: limit ? Number(limit) : undefined,
                    cursor: text(req.query.cursor),
                }),
            );
        } catch (err) {
            if (err instanceof InvalidCursorError) {
                res.status(400).json({ message: "Invalid cursor" });
                return;
            }
            logger.error("Failed to list online orders", err);
            res.status(500).json({ message: "Failed to list orders" });
        }
    },
);

paymentsRouter.get(
    "/orders/:orderId",
    requireScope("payments:read"),
    async (req: Request<{ orderId: string }>, res: Response) => {
        try {
            const row = await staffOrder(req, res);
            if (!row) return;
            sendJson(res, await presentStaffOrder(row));
        } catch (err) {
            logger.error("Failed to fetch online order", err);
            res.status(500).json({ message: "Failed to fetch order" });
        }
    },
);

// Staff may invoice any order at their locations, not only online ones.
paymentsRouter.post(
    "/orders/:orderId/invoice",
    requireScope("payments:write"),
    async (req: Request<{ orderId: string }>, res: Response) => {
        try {
            const parsed = orderInvoiceSchema.safeParse(req.body);
            if (!parsed.success) {
                res.status(400).json({ message: "Invalid invoice request" });
                return;
            }
            const row = await staffOrder(req, res);
            if (!row) return;
            const outcome = await createInvoice({
                row,
                processorId: parsed.data.processor,
                customerId: parsed.data.customer_id,
                delivery: parsed.data.delivery,
                dueDate: parsed.data.due_date,
                message: parsed.data.message,
                plugins: pluginRegistryOf(req),
                caller: req,
            });
            if (!outcome.ok) {
                sendRefusal(res, outcome);
                return;
            }
            sendJson(res, toInvoiceView(outcome.invoice), 201);
        } catch (err) {
            logger.error("Failed to create invoice", err);
            res.status(500).json({ message: "Failed to create invoice" });
        }
    },
);

paymentsRouter.post(
    "/orders/:orderId/invoice/cancel",
    requireScope("payments:write"),
    async (req: Request<{ orderId: string }>, res: Response) => {
        try {
            const row = await staffOrder(req, res);
            if (!row) return;
            const outcome = await cancelInvoice(row, pluginRegistryOf(req), {
                caller: req,
            });
            if (!outcome.ok) {
                sendRefusal(res, outcome);
                return;
            }
            sendJson(res, toInvoiceView(outcome.invoice));
        } catch (err) {
            logger.error("Failed to cancel invoice", err);
            res.status(500).json({ message: "Failed to cancel invoice" });
        }
    },
);
