/**
 * Maps host events to the webhook types credentials receive. Only events
 * listed here are forwarded; anything else never leaves the store.
 */
import { Logger } from "tslog";
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
    toData(args: unknown[]): { data: unknown; locationId?: string } | null;
    /**
     * Order and invoice events only: the id or reference id of the order the
     * event is about. Only the credential that created that order receives
     * the event, as for the order routes; staff orders have no owner, so no
     * one does. Read before `toData`, so an event nobody gets is not parsed.
     */
    orderRef?(args: unknown[]): string;
}

const logger = new Logger({ name: "webhooks" });

/**
 * Logs why an event's data was dropped: where it failed and why, never the
 * values (they are customer and order data).
 */
function warnIssues(what: string, error: z.ZodError): void {
    const issues = error.issues.map(
        (i) => `${i.path.join(".") || "(root)"}: ${i.message}`,
    );
    logger.warn(
        `Webhook data for ${what} does not match its schema at: ${issues.join("; ")}`,
    );
}

function parseWith(what: string, schema: z.ZodType, value: unknown) {
    const parsed = schema.safeParse(value);
    if (parsed.success) return parsed.data;
    warnIssues(what, parsed.error);
    return null;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null;

/**
 * Puts a staff-till line into the wire form the schema reads. Tills send
 * quantities and amounts as JSON numbers and leave unset fields as null,
 * which the wire form spells as digit strings and absent keys. Values that
 * are not recognisably those are left alone, so the schema still refuses them.
 */
function wireLine(line: unknown): unknown {
    if (!isRecord(line)) return line;
    const out: Record<string, unknown> = { ...line };
    if (typeof out.quantity === "number" && Number.isSafeInteger(out.quantity))
        out.quantity = String(out.quantity);
    for (const key of ["priceMoney", "pricingType"]) {
        if (out[key] === null) delete out[key];
    }
    const price = out.priceMoney;
    if (
        isRecord(price) &&
        typeof price.amount === "number" &&
        Number.isSafeInteger(price.amount)
    ) {
        out.priceMoney = { ...price, amount: String(price.amount) };
    }
    return out;
}

function orderData(order: unknown) {
    // Host events carry in-memory bigint amounts; the schema reads the wire
    // form (digit strings), so convert before parsing.
    const wire: unknown = JSON.parse(JSON.stringify(order, bigintReplacer));
    if (isRecord(wire) && Array.isArray(wire.lineItems)) {
        wire.lineItems = wire.lineItems.map(wireLine);
    }
    const parsed = orderSchema.safeParse(wire);
    if (!parsed.success) {
        warnIssues("an order", parsed.error);
        return null;
    }
    // The wire form: amounts as digit strings, as the gateway returns them.
    return {
        data: JSON.parse(JSON.stringify(parsed.data, bigintReplacer)),
        locationId: parsed.data.locationId,
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
    if (!parsed.success) {
        warnIssues("an invoice", parsed.error);
        return null;
    }
    return {
        data: JSON.parse(JSON.stringify(parsed.data, bigintReplacer)),
        locationId: order.locationId,
    };
}

const orderEvent = (type: string): WebhookEventSpec => ({
    type,
    scope: "orders:read",
    toData: (args) => orderData(args[0]),
    orderRef: (args) => {
        const order = (args[0] ?? {}) as { referenceId?: string; id?: string };
        return order.referenceId ?? order.id ?? "";
    },
});

const invoiceEvent = (type: string): WebhookEventSpec => ({
    type,
    scope: "orders:read",
    toData: invoiceData,
    orderRef: (args) => {
        const [invoice, order] = args as [
            { order_reference?: string } | undefined,
            { referenceId?: string } | undefined,
        ];
        return invoice?.order_reference ?? order?.referenceId ?? "";
    },
});

/**
 * Host event name to webhook spec. Names are the plugin-sdk event names, plus
 * `catalogSynced` for a finished catalog pull.
 */
export const WEBHOOK_EVENTS: Record<string, WebhookEventSpec> = {
    orderCreated: orderEvent("order.created"),
    paymentCompleted: orderEvent("order.paid"),
    orderCancelled: orderEvent("order.canceled"),
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
            const data = parseWith("a customer", customerSchema, args[0]);
            return data ? { data } : null;
        },
    },
    customerUpdated: {
        type: "customer.updated",
        scope: "customers:read",
        toData: (args) => {
            const data = parseWith("a customer", customerSchema, args[0]);
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
