import express, { Request, Response, Router } from "express";
import { Logger } from "tslog";
import { bigintReplacer } from "@tessellatepos/sdk";
import type {
    Customer,
    CustomerInput,
    CustomerQuery,
    Order,
} from "@tessellatepos/sdk";
import { hooks, events } from "@tessellatepos/plugin-sdk/server";
import {
    CustomerValidationError,
    createCustomer,
    deleteCustomer,
    findCustomers,
    getCustomer,
    updateCustomer,
    validateCustomerInput,
} from "@/services/customers";
import { InvalidCursorError, listOrdersByCustomer } from "@/services/db/orders";
import { requireScope } from "@/middleware/authenticate";
import { ITessellateApiRouter } from "@/utils/registry/api/apiRegistry";
import type {
    DispatchOptions,
    TessellatePluginRegistry,
} from "@/utils/registry/plugin/pluginRegistry";

// Guards: customers:read for GET, customers:write for POST/PUT/PATCH/DELETE.
const customerRouter: Router = express.Router();

const logger = new Logger();

export const customersv1Endpoint: ITessellateApiRouter = {
    route_path: "/customers",
    version: "v1",
    router: customerRouter,
};

// Customers are PII: only plugins holding the CUSTOMER permission may see
// the hook input or the events. Handlers log ids only, never customer fields.
const CUSTOMER_ONLY = {
    requires: "customer",
} as const satisfies DispatchOptions;

function getPluginRegistry(req: Request): TessellatePluginRegistry {
    return (req.app.locals as { pluginRegistry: TessellatePluginRegistry })
        .pluginRegistry;
}

/** Reads a single-valued query string parameter. */
function queryString(value: unknown): string | undefined {
    return typeof value === "string" && value !== "" ? value : undefined;
}

/** Sends a body that may hold bigint money amounts. */
function sendJson(res: Response, status: number, body: unknown): void {
    res.status(status)
        .header("Content-Type", "application/json")
        .send(JSON.stringify(body, bigintReplacer));
}

/**
 * Handles an error: validation problems are 400 with the rule violated (never
 * the value), anything else is logged by id and answered with a generic 500.
 */
function fail(res: Response, error: unknown, what: string, id?: string): void {
    if (
        error instanceof CustomerValidationError ||
        error instanceof InvalidCursorError
    ) {
        res.status(400).json({ message: error.message });
        return;
    }
    logger.error(`Failed to ${what}`, id ?? "", error);
    res.status(500).json({ message: `Failed to ${what}` });
}

/**
 * Validates the body, then lets CUSTOMER plugins modify or block it.
 * @returns the input to save, or null if a plugin blocked it (response sent)
 */
async function prepareInput(
    req: Request,
    res: Response,
    existingId?: string,
    raw: unknown = req.body,
): Promise<CustomerInput | null> {
    const customer = validateCustomerInput(raw);
    // The hook takes { customer, existingId } but returns a CustomerInput, so
    // each handler's output is re-wrapped for the next one.
    let modified: CustomerInput | undefined;
    const result = await getPluginRegistry(req).runHook(
        hooks.beforeCustomerSave,
        { customer, existingId },
        {
            ...CUSTOMER_ONLY,
            carry: (output, previous) => {
                modified = output;
                return { ...previous, customer: output };
            },
        },
    );
    if (!result.ok) {
        res.status(400).json({ message: result.reason });
        return null;
    }
    return modified ?? customer;
}

customerRouter.get(
    "/",
    requireScope("customers:read"),
    async (req: Request, res: Response) => {
        try {
            const query: CustomerQuery = {
                text: queryString(req.query.text),
                email: queryString(req.query.email),
                phone_number: queryString(req.query.phone_number),
                tag: queryString(req.query.tag),
                cursor: queryString(req.query.cursor),
            };
            const limit = queryString(req.query.limit);
            if (limit !== undefined) {
                if (!/^\d+$/.test(limit) || Number(limit) < 1) {
                    res.status(400).json({
                        message: "limit must be a positive integer",
                    });
                    return;
                }
                query.limit = Number(limit);
            }
            res.json(await findCustomers(query));
        } catch (error) {
            fail(res, error, "list customers");
        }
    },
);

customerRouter.get(
    "/:id",
    requireScope("customers:read"),
    async (req: Request<{ id: string }>, res) => {
        try {
            const customer = await getCustomer(req.params.id);
            if (!customer) {
                res.status(404).json({ message: "Customer not found" });
                return;
            }
            res.json(customer);
        } catch (error) {
            fail(res, error, "fetch customer", req.params.id);
        }
    },
);

customerRouter.post(
    "/",
    requireScope("customers:write"),
    async (req: Request, res: Response) => {
        try {
            const input = await prepareInput(req, res);
            if (!input) return;
            const customer = await createCustomer(input);
            getPluginRegistry(req).emitTo(
                CUSTOMER_ONLY,
                events.customerCreated,
                customer,
            );
            res.status(201).json(customer);
        } catch (error) {
            fail(res, error, "create customer");
        }
    },
);

customerRouter.put(
    "/:id",
    requireScope("customers:write"),
    async (req: Request<{ id: string }>, res) => {
        const { id } = req.params;
        try {
            const previous = await getCustomer(id);
            if (!previous) {
                res.status(404).json({ message: "Customer not found" });
                return;
            }
            const input = await prepareInput(req, res, id);
            if (!input) return;
            const customer = await updateCustomer(id, input);
            if (!customer) {
                res.status(404).json({ message: "Customer not found" });
                return;
            }
            getPluginRegistry(req).emitTo(
                CUSTOMER_ONLY,
                events.customerUpdated,
                customer,
                previous,
            );
            res.json(customer);
        } catch (error) {
            fail(res, error, "update customer", id);
        }
    },
);

// PUT replaces the whole record: fields missing from the body are cleared.
// PATCH merges: only the fields present in the body change, the rest keep
// their stored values (send null or "" to clear one). Both then share the
// validation, beforeCustomerSave hook, write-through update and
// customerUpdated event.
customerRouter.patch(
    "/:id",
    requireScope("customers:write"),
    async (req: Request<{ id: string }>, res) => {
        const { id } = req.params;
        try {
            const previous = await getCustomer(id);
            if (!previous) {
                res.status(404).json({ message: "Customer not found" });
                return;
            }
            const patch: unknown = req.body;
            const isObject =
                typeof patch === "object" &&
                patch !== null &&
                !Array.isArray(patch);
            // A non-object body is passed on so validation rejects it.
            const merged = isObject ? { ...previous, ...patch } : patch;
            const input = await prepareInput(req, res, id, merged);
            if (!input) return;
            const customer = await updateCustomer(id, input);
            if (!customer) {
                res.status(404).json({ message: "Customer not found" });
                return;
            }
            getPluginRegistry(req).emitTo(
                CUSTOMER_ONLY,
                events.customerUpdated,
                customer,
                previous,
            );
            res.json(customer);
        } catch (error) {
            fail(res, error, "update customer", id);
        }
    },
);

customerRouter.delete(
    "/:id",
    requireScope("customers:write"),
    async (req: Request<{ id: string }>, res) => {
        const { id } = req.params;
        try {
            if (!(await deleteCustomer(id))) {
                res.status(404).json({ message: "Customer not found" });
                return;
            }
            getPluginRegistry(req).emitTo(
                CUSTOMER_ONLY,
                events.customerDeleted,
                id,
            );
            res.status(200).json({ message: "Customer deleted" });
        } catch (error) {
            fail(res, error, "delete customer", id);
        }
    },
);

customerRouter.get(
    "/:id/orders",
    requireScope("customers:read"),
    async (req: Request<{ id: string }>, res: Response) => {
        const { id } = req.params;
        try {
            if (!(await getCustomer(id))) {
                res.status(404).json({ message: "Customer not found" });
                return;
            }
            const limit = queryString(req.query.limit);
            if (limit !== undefined && (!/^\d+$/.test(limit) || +limit < 1)) {
                res.status(400).json({
                    message: "limit must be a positive integer",
                });
                return;
            }
            const page = await listOrdersByCustomer(id, {
                limit: limit === undefined ? undefined : Number(limit),
                cursor: queryString(req.query.cursor),
            });
            sendJson(res, 200, {
                orders: page.orders,
                next_cursor: page.nextCursor,
            });
        } catch (error) {
            fail(res, error, "list customer orders", id);
        }
    },
);

customerRouter.get(
    "/:id/export",
    requireScope("customers:read"),
    async (req: Request<{ id: string }>, res: Response) => {
        const { id } = req.params;
        try {
            const customer: Customer | null = await getCustomer(id);
            if (!customer) {
                res.status(404).json({ message: "Customer not found" });
                return;
            }
            const orders: Order[] = [];
            let cursor: string | undefined;
            do {
                const page = await listOrdersByCustomer(id, {
                    limit: 200,
                    cursor,
                });
                orders.push(...page.orders);
                cursor = page.nextCursor ?? undefined;
            } while (cursor);
            res.header(
                "Content-Disposition",
                `attachment; filename="customer-${encodeURIComponent(id)}.json"`,
            );
            sendJson(res, 200, { customer, orders });
        } catch (error) {
            fail(res, error, "export customer", id);
        }
    },
);
