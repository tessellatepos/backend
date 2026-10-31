/**
 * Maps host events to the webhook types credentials receive. Only events
 * listed here are forwarded; anything else never leaves the store.
 */
import { z } from "zod";
import { bigintReplacer, type Scope } from "@tessellatepos/sdk";
import { customerSchema } from "@/gateway/schemas/customers";
import { invoiceSchema, orderSchema } from "@/gateway/schemas/orders";

/** One webhook type a credential may subscribe to through its scopes. */
export interface WebhookEventSpec {
    /** The webhook `type` value. */
    type: string;
    /** A credential needs this read scope to receive the event. */
    scope: Scope;
    /** Builds the public data for a host event's arguments, or null to drop it. */
    toData(args: unknown[]): {
        data: unknown;
        locationId?: string;
        /**
         * Set for order and invoice events: the order's id or reference id.
         * Only the credential that created that order receives the event,
         * as for the order routes. Staff orders have no owner, so no one.
         */
        orderRef?: string;
    } | null;
}

function parseWith(schema: z.ZodType, value: unknown) {
    const parsed = schema.safeParse(value);
    return parsed.success ? parsed.data : null;
}

function orderData(order: unknown) {
    // Host events carry in-memory bigint amounts; the schema reads the wire
    // form (digit strings), so convert before parsing.
    const parsed = orderSchema.safeParse(
        JSON.parse(JSON.stringify(order, bigintReplacer)),
    );
    if (!parsed.success) return null;
    // The wire form: amounts as digit strings, as the gateway returns them.
    return {
        data: JSON.parse(JSON.stringify(parsed.data, bigintReplacer)),
        locationId: parsed.data.locationId,
        orderRef: parsed.data.referenceId ?? parsed.data.id ?? "",
    };
}

/**
 * An invoice event's public data. Plugin invoice events carry the invoice and
 * its order; the order supplies the location the delivery is filtered by.
 */
function invoiceData(args: unknown[]) {
    const [invoice, order] = args as [
        { [key: string]: unknown; order_reference?: string },
        { locationId?: string } | undefined,
    ];
    if (!invoice || !order?.locationId) return null;
    const wire = JSON.parse(JSON.stringify(invoice, bigintReplacer));
    const parsed = invoiceSchema.safeParse({
        id: wire.id,
        order_id: wire.order_reference,
        processor: wire.processor_id,
        status: wire.status,
        url: wire.url,
        amount: wire.amount,
        due_date: wire.due_date ?? null,
        created_at: wire.created_at,
        updated_at: wire.updated_at,
    });
    if (!parsed.success) return null;
    return {
        data: JSON.parse(JSON.stringify(parsed.data, bigintReplacer)),
        locationId: order.locationId,
        orderRef:
            wire.order_reference ??
            (order as { referenceId?: string }).referenceId ??
            "",
    };
}

const invoiceEvent = (type: string): WebhookEventSpec => ({
    type,
    scope: "orders:read",
    toData: invoiceData,
});

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
    invoiceCreated: invoiceEvent("invoice.created"),
    invoiceSent: invoiceEvent("invoice.sent"),
    invoiceViewed: invoiceEvent("invoice.viewed"),
    invoicePaid: invoiceEvent("invoice.paid"),
    invoiceOverdue: invoiceEvent("invoice.overdue"),
    invoiceCanceled: invoiceEvent("invoice.canceled"),
    invoiceRefunded: invoiceEvent("invoice.refunded"),
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
