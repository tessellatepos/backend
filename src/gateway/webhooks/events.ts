/**
 * Maps host events to the webhook types credentials receive. Only events
 * listed here are forwarded; anything else never leaves the store.
 */
import { z } from "zod";
import { bigintReplacer, type Scope } from "@tessellatepos/sdk";
import { customerSchema } from "@/gateway/schemas/customers";
import { orderSchema } from "@/gateway/schemas/orders";

/** One webhook type a credential may subscribe to through its scopes. */
export interface WebhookEventSpec {
    /** The webhook `type` value. */
    type: string;
    /** A credential needs this read scope to receive the event. */
    scope: Scope;
    /** Builds the public data for a host event's arguments, or null to drop it. */
    toData(args: unknown[]): { data: unknown; locationId?: string } | null;
}

function parseWith(schema: z.ZodType, value: unknown) {
    const parsed = schema.safeParse(value);
    return parsed.success ? parsed.data : null;
}

function orderData(order: unknown) {
    const parsed = orderSchema.safeParse(order);
    if (!parsed.success) return null;
    // The wire form: amounts as digit strings, as the gateway returns them.
    return {
        data: JSON.parse(JSON.stringify(parsed.data, bigintReplacer)),
        locationId: parsed.data.locationId,
    };
}

/**
 * Host event name to webhook spec. Names are the plugin-sdk event names, plus
 * `catalogSynced` for a finished catalog pull.
 */
export const WEBHOOK_EVENTS: Record<string, WebhookEventSpec> = {
    orderCreated: {
        type: "order.created",
        scope: "orders:read",
        toData: (args) => orderData(args[0]),
    },
    paymentCompleted: {
        type: "order.paid",
        scope: "orders:read",
        toData: (args) => orderData(args[0]),
    },
    orderCancelled: {
        type: "order.canceled",
        scope: "orders:read",
        toData: (args) => orderData(args[0]),
    },
    customerCreated: {
        type: "customer.created",
        scope: "customers:read",
        toData: (args) => {
            const data = parseWith(customerSchema, args[0]);
            return data ? { data } : null;
        },
    },
    customerUpdated: {
        type: "customer.updated",
        scope: "customers:read",
        toData: (args) => {
            const data = parseWith(customerSchema, args[0]);
            return data ? { data } : null;
        },
    },
    customerDeleted: {
        type: "customer.deleted",
        scope: "customers:read",
        toData: (args) =>
            typeof args[0] === "string" ? { data: { id: args[0] } } : null,
    },
    catalogSynced: {
        type: "catalog.updated",
        scope: "catalog:read",
        // A signal to revalidate, not the catalog itself.
        toData: () => ({ data: {} }),
    },
};
