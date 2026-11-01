/**
 * Invoices for orders: issuing one through a processor, cancelling it, and
 * following its status as processor webhooks and the overdue job report it.
 * An invoice is a payment attempt (kind `invoice`) on the order; the order
 * stays open and exempt from expiry while it is live.
 */
import { randomUUID } from "node:crypto";
import { and, asc, eq, gt, inArray, lte } from "drizzle-orm";
import type { Request } from "express";
import { Logger } from "tslog";
import { parseMoney, stripBigints } from "@tessellatepos/sdk";
import type {
    Customer,
    InvoiceStatus,
    Money,
    OnlinePayment,
} from "@tessellatepos/sdk";
import { events, hooks } from "@tessellatepos/plugin-sdk/server";
import type { InvoiceCreateRequest } from "@tessellatepos/plugin-sdk/server";
import { drizzleDB } from "@/services/db/postgres";
import { onlinePaymentsTable } from "@/services/db/schema";
import { getOrderByAnyId, rowToOrder, updateOrder } from "@/services/db/orders";
import {
    insertOnlinePayment,
    listOnlinePayments,
    type OnlinePaymentRow,
} from "@/services/db/onlinePayments";
import { getCustomer } from "@/services/customers";
import { getEnabledProcessorConfig } from "@/services/processors/settings";
import {
    processorRegistry,
    type PaymentProcessorRegistry,
} from "@/services/processors/registry";
import { withRedisLock } from "@/gateway/createGuard";
import { invoiceOverdueMs } from "@/gateway/lifecycleConfig";
import { completeOrderFromPayment } from "@/services/processors/completeOrder";
import { pluginContext } from "@/utils/pluginContext";
import type { TessellatePluginRegistry } from "@/utils/registry/plugin/pluginRegistry";
import {
    checkoutDeps,
    isLiveAttempt,
    refuse,
    type OrderRow,
    type Refusal,
} from "@/services/onlineOrders";

const logger = new Logger({ name: "invoices" });

export const INVOICE_DELIVERIES = ["EMAIL", "SMS", "SHARE_MANUALLY"] as const;
export type InvoiceDelivery = (typeof INVOICE_DELIVERIES)[number];

/** Statuses in which the customer can still pay. */
const OPEN_STATUSES: InvoiceStatus[] = ["draft", "sent", "viewed", "overdue"];

const OPEN_RANK: Partial<Record<InvoiceStatus, number>> = {
    draft: 0,
    sent: 1,
    viewed: 2,
    overdue: 3,
};

/**
 * What an incoming status does to an invoice, tolerant of events that arrive
 * late or twice. Open statuses only move forward; `paid` and `refunded` win
 * over an open or canceled invoice (money moved, and that is the stronger
 * fact); a paid invoice moves only to `refunded`, and a refunded or canceled
 * one never moves back.
 * @param current the stored status
 * @param incoming the status an event reports
 * @returns the new status, or null when the event changes nothing
 */
export function nextInvoiceStatus(
    current: InvoiceStatus,
    incoming: InvoiceStatus,
): InvoiceStatus | null {
    if (current === incoming || current === "refunded") return null;
    if (incoming === "refunded")
        return current === "canceled" ? null : incoming;
    if (current === "paid") return null;
    if (incoming === "paid") return incoming;
    if (current === "canceled" || incoming === "canceled") {
        return current === "canceled" ? null : incoming;
    }
    return (OPEN_RANK[incoming] ?? -1) > (OPEN_RANK[current] ?? -1)
        ? incoming
        : null;
}

const STATUS_EVENTS = {
    draft: events.invoiceCreated,
    sent: events.invoiceSent,
    viewed: events.invoiceViewed,
    paid: events.invoicePaid,
    overdue: events.invoiceOverdue,
    canceled: events.invoiceCanceled,
    refunded: events.invoiceRefunded,
} as const;

/**
 * An invoice row in the shape plugins and outbound webhooks receive.
 * @param row the attempt row
 * @returns the invoice
 */
export function rowToOnlinePayment(row: OnlinePaymentRow): OnlinePayment {
    return {
        id: row.id,
        order_reference: row.order_reference,
        processor_id: row.processor_id,
        kind: row.kind as OnlinePayment["kind"],
        external_id: row.external_id,
        ...(row.url ? { url: row.url } : {}),
        status: row.status as OnlinePayment["status"],
        amount: parseMoney(row.amount) as Money,
        ...(row.due_date ? { due_date: row.due_date } : {}),
        created_at: row.created_at.toISOString(),
        updated_at: row.updated_at.toISOString(),
    };
}

/**
 * Emits the plugin event for an invoice reaching a status (plugins and the
 * `invoice.*` outbound webhooks both listen on it).
 * @param row the invoice after the change
 * @param registry the plugin registry
 * @param caller the request that caused it; absent for webhooks and jobs
 * @param event overrides the event; defaults to the one for the row's status
 */
export async function announceInvoice(
    row: OnlinePaymentRow,
    registry: Pick<TessellatePluginRegistry, "emit">,
    caller?: Pick<Request, "principal">,
    event: (typeof STATUS_EVENTS)[InvoiceStatus] = STATUS_EVENTS[
        row.status as InvoiceStatus
    ],
): Promise<void> {
    const orderRow = await getOrderByAnyId(row.order_reference);
    if (!orderRow || !event) return;
    const order = rowToOrder(orderRow);
    registry.emit(
        event,
        rowToOnlinePayment(row),
        order,
        pluginContext(caller, order),
    );
}

/**
 * Moves an invoice to a status if the state machine allows it. The row is
 * locked while it is read and written, so of any number of concurrent events
 * that report the same change exactly one wins and gets the row back.
 * @param attemptId the invoice attempt's id
 * @param incoming the status to move to
 * @returns the updated row when the status changed, otherwise null
 */
export async function transitionInvoice(
    attemptId: string,
    incoming: InvoiceStatus,
): Promise<OnlinePaymentRow | null> {
    return drizzleDB.transaction(async (tx) => {
        const [row] = await tx
            .select()
            .from(onlinePaymentsTable)
            .where(eq(onlinePaymentsTable.id, attemptId))
            .limit(1)
            .for("update");
        if (!row || row.kind !== "invoice") return null;
        const next = nextInvoiceStatus(row.status as InvoiceStatus, incoming);
        if (!next) return null;
        const [updated] = await tx
            .update(onlinePaymentsTable)
            .set({ status: next, updated_at: new Date() })
            .where(eq(onlinePaymentsTable.id, attemptId))
            .returning();
        return updated;
    });
}

/** Today's date, `YYYY-MM-DD`, in UTC. */
const todayUtc = (now: Date) => now.toISOString().slice(0, 10);

/**
 * @param value a due date
 * @param now the current time
 * @returns true for a real calendar date that is not in the past
 */
export function isValidDueDate(value: unknown, now = new Date()): boolean {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        return false;
    }
    const date = new Date(`${value}T00:00:00Z`);
    return (
        !Number.isNaN(date.getTime()) &&
        date.toISOString().startsWith(value) &&
        value >= todayUtc(now)
    );
}

/** The contact detail a delivery method needs, or null when it has none. */
function contactProblem(
    customer: Customer,
    delivery: InvoiceDelivery,
): string | null {
    if (delivery === "EMAIL" && !customer.email) {
        return "The customer has no email address, which delivering an invoice by EMAIL needs";
    }
    if (delivery === "SMS" && !customer.phone_number) {
        return "The customer has no phone number, which delivering an invoice by SMS needs";
    }
    return null;
}

export interface CreateInvoiceInput {
    row: OrderRow;
    processorId: string;
    /** Used when the order has no customer yet. */
    customerId?: string;
    delivery: InvoiceDelivery;
    dueDate: string;
    message?: string;
    plugins: TessellatePluginRegistry;
    /** The request, for the plugin context. */
    caller?: Pick<Request, "principal">;
    registry?: PaymentProcessorRegistry;
    now?: Date;
}

export type CreateInvoiceOutcome =
    { ok: true; invoice: OnlinePaymentRow } | Refusal;

function hasTender(row: OrderRow): boolean {
    return Array.isArray(row.tenders) && row.tenders.length > 0;
}

/**
 * Issues an invoice for an unpaid order. The customer pays on the processor's
 * hosted page; this backend never sees card data and learns the result by
 * signed webhook. The order stays open and leaves the expiry job's reach.
 *
 * "Updating" an invoice is cancel and reissue: a second invoice is refused
 * while one is still open, and a canceled one can be replaced.
 * @param input the order, processor, recipient and terms
 * @returns the new invoice, or why not
 */
export async function createInvoice(
    input: CreateInvoiceInput,
): Promise<CreateInvoiceOutcome> {
    const { row, plugins } = input;
    const registry = input.registry ?? processorRegistry;
    const now = input.now ?? new Date();

    const processor = registry.get(input.processorId);
    if (!processor) {
        return refuse(400, "unknown_processor", "Unknown payment processor");
    }
    if (!processor.capabilities.invoice || !processor.createInvoice) {
        return refuse(
            409,
            "invoice_not_supported",
            "This processor does not support invoices",
        );
    }
    if (!checkoutDeps.available()) {
        return refuse(
            409,
            "online_payments_unavailable",
            "Online payments are not available: PUBLIC_URL is not set to an https address",
        );
    }
    if (!(await getEnabledProcessorConfig(processor.id, row.locationId))) {
        return refuse(
            409,
            "processor_disabled",
            "This payment processor is not enabled at the order's location",
        );
    }
    if (row.state !== "OPEN" || hasTender(row)) {
        return refuse(
            409,
            "order_not_payable",
            "Only an open, unpaid order can be invoiced",
        );
    }
    const total = parseMoney(row.totalMoney);
    if (!total?.amount || total.amount <= 0n) {
        return refuse(
            409,
            "order_not_payable",
            "This order has no amount to pay",
        );
    }
    if (!isValidDueDate(input.dueDate, now)) {
        return refuse(
            400,
            "invalid_due_date",
            "due_date must be a calendar date (YYYY-MM-DD) that is not in the past",
        );
    }

    if (
        row.customerId &&
        input.customerId &&
        row.customerId !== input.customerId
    ) {
        return refuse(
            409,
            "customer_mismatch",
            "The order already belongs to a different customer",
        );
    }
    const customerId = row.customerId ?? input.customerId;
    if (!customerId) {
        return refuse(
            422,
            "customer_required",
            "An invoice needs a customer: attach one to the order or pass customer_id",
        );
    }
    const customer = await getCustomer(customerId);
    if (!customer) {
        return refuse(422, "customer_not_found", "Unknown customer");
    }
    const missing = contactProblem(customer, input.delivery);
    if (missing) return refuse(422, "customer_contact_missing", missing);

    const openElsewhere = (await listOnlinePayments(row.referenceId)).some(
        (a) => isLiveAttempt(a, now),
    );
    if (openElsewhere) {
        return refuse(
            409,
            "payment_in_progress",
            "Another payment for this order is still open: cancel it first",
        );
    }

    const order = rowToOrder(row);
    const request: InvoiceCreateRequest = {
        order,
        customer,
        dueDate: input.dueDate,
        delivery: input.delivery,
        ...(input.message ? { message: input.message } : {}),
    };
    // The request holds the customer's contact details, so only plugins with
    // the CUSTOMER permission see it; whatever they return, order and
    // customer stay as they were.
    const hooked = await plugins.runHook(hooks.beforeInvoiceCreate, request, {
        requires: "customer",
        context: pluginContext(input.caller, order),
        carry: (output, previous) => ({
            ...previous,
            dueDate: output.dueDate,
            delivery: output.delivery,
            message: output.message,
        }),
    });
    if (!hooked.ok) {
        return refuse(400, hooked.code ?? "invoice_blocked", hooked.reason);
    }
    const terms = hooked.value;
    if (
        !INVOICE_DELIVERIES.includes(terms.delivery) ||
        !isValidDueDate(terms.dueDate, now) ||
        (terms.message !== undefined &&
            (typeof terms.message !== "string" || terms.message.length > 500))
    ) {
        return refuse(
            400,
            "invoice_blocked",
            "A plugin changed the invoice to something invalid",
        );
    }
    const stillMissing = contactProblem(customer, terms.delivery);
    if (stillMissing) {
        return refuse(422, "customer_contact_missing", stillMissing);
    }

    const locked = await withRedisLock(
        `gw:checkout-lock:${row.referenceId}`,
        async (): Promise<CreateInvoiceOutcome> => {
            const live = (await listOnlinePayments(row.referenceId)).some((a) =>
                isLiveAttempt(a, now),
            );
            if (live) {
                return refuse(
                    409,
                    "payment_in_progress",
                    "Another payment for this order is still open: cancel it first",
                );
            }
            let created: Awaited<
                ReturnType<NonNullable<typeof processor.createInvoice>>
            >;
            try {
                created = await processor.createInvoice!({
                    order,
                    customer,
                    dueDate: terms.dueDate,
                    delivery: terms.delivery,
                    message: terms.message,
                });
            } catch (err) {
                logger.error(
                    `Processor ${processor.id} could not create an invoice`,
                    err,
                );
                return refuse(
                    502,
                    "processor_error",
                    "The payment processor could not create the invoice",
                );
            }

            const id = randomUUID();
            try {
                await insertOnlinePayment({
                    id,
                    order_reference: row.referenceId,
                    processor_id: processor.id,
                    kind: "invoice",
                    external_id: created.externalId,
                    url: created.url ?? null,
                    status: created.status,
                    amount: stripBigints(total),
                    due_date: terms.dueDate,
                });
            } catch (err) {
                // The customer may already have been sent an invoice we
                // cannot track: withdraw it rather than leave it payable.
                logger.error(
                    "Could not record an invoice; withdrawing it",
                    err,
                );
                await processor
                    .cancelInvoice?.(created.externalId)
                    .catch((cancelErr) =>
                        logger.error(
                            `Invoice ${created.externalId} at ${processor.id} could not be withdrawn`,
                            cancelErr,
                        ),
                    );
                throw err;
            }
            await updateOrder(row.referenceId, { invoicedAt: now });
            const [stored] = await drizzleDB
                .select()
                .from(onlinePaymentsTable)
                .where(eq(onlinePaymentsTable.id, id));
            return { ok: true, invoice: stored };
        },
    );
    if (!locked) {
        return refuse(
            409,
            "payment_in_progress",
            "An invoice for this order is already being created",
        );
    }
    const outcome = locked.value;
    if (outcome.ok) {
        // Created first, then the status it was born with (a published
        // invoice is `sent`), so a listener sees the same sequence whether
        // the processor publishes at once or later.
        await announceInvoice(
            outcome.invoice,
            plugins,
            input.caller,
            events.invoiceCreated,
        );
        if (outcome.invoice.status !== "draft") {
            await announceInvoice(outcome.invoice, plugins, input.caller);
        }
    }
    return outcome;
}

export type CancelInvoiceOutcome =
    { ok: true; invoice: OnlinePaymentRow } | Refusal;

/**
 * Cancels the open invoice of an order through its processor. Canceling an
 * already canceled invoice answers with it; a paid or refunded one is
 * refused. The order stays open (it can be invoiced again or canceled).
 * @param row the order
 * @param plugins the plugin registry that receives `invoiceCanceled`
 * @param options the request that asked, and the processor registry
 * @returns the invoice, or why not
 */
export async function cancelInvoice(
    row: OrderRow,
    plugins: TessellatePluginRegistry,
    options: {
        caller?: Pick<Request, "principal">;
        registry?: PaymentProcessorRegistry;
    } = {},
): Promise<CancelInvoiceOutcome> {
    const registry = options.registry ?? processorRegistry;
    const invoices = (await listOnlinePayments(row.referenceId)).filter(
        (a) => a.kind === "invoice",
    );
    const latest = invoices[invoices.length - 1];
    if (!latest) {
        return refuse(404, "invoice_not_found", "This order has no invoice");
    }
    const open = invoices.find((a) =>
        OPEN_STATUSES.includes(a.status as InvoiceStatus),
    );
    if (!open) {
        if (latest.status === "canceled") return { ok: true, invoice: latest };
        return refuse(
            409,
            "invoice_not_cancellable",
            "A paid or refunded invoice cannot be canceled",
        );
    }

    const processor = registry.get(open.processor_id);
    if (!processor?.cancelInvoice) {
        return refuse(
            409,
            "invoice_not_supported",
            "This invoice's processor can no longer cancel invoices",
        );
    }
    try {
        await processor.cancelInvoice(open.external_id);
    } catch (err) {
        logger.error(`Processor ${processor.id} could not cancel`, err);
        return refuse(
            502,
            "processor_error",
            "The payment processor could not cancel the invoice",
        );
    }
    const changed = await transitionInvoice(open.id, "canceled");
    if (changed) await announceInvoice(changed, plugins, options.caller);
    const [current] = await drizzleDB
        .select()
        .from(onlinePaymentsTable)
        .where(eq(onlinePaymentsTable.id, open.id));
    if (current.status !== "canceled") {
        // Paid while the cancel was in flight.
        return refuse(
            409,
            "invoice_not_cancellable",
            "A paid or refunded invoice cannot be canceled",
        );
    }
    return { ok: true, invoice: current };
}

/**
 * Acts on a verified processor event about an invoice: a payment completes
 * the order first (so a crash in between is retried), then the status moves
 * and, only if it did, plugins and webhooks hear about it once.
 * @param attempt the invoice attempt the event names
 * @param event what the processor reported
 * @param event.status the invoice status it reported
 * @param event.paymentId the processor's payment id, when it has one
 * @param event.amount the amount collected, when it said
 * @param registry the plugin registry
 * @returns "applied" when handled; "mismatch" when a payment did not match
 * the order and the order was left open
 */
export async function applyInvoiceEvent(
    attempt: OnlinePaymentRow,
    event: { status: InvoiceStatus; paymentId?: string; amount?: Money },
    registry: TessellatePluginRegistry,
): Promise<"applied" | "mismatch"> {
    if (event.status === "paid" && attempt.status !== "refunded") {
        const result = await completeOrderFromPayment(
            attempt.order_reference,
            {
                paymentId: event.paymentId,
                amount: event.amount ?? (parseMoney(attempt.amount) as Money),
            },
            registry,
        );
        if (result.outcome === "amount_mismatch") return "mismatch";
        if (result.outcome === "canceled") {
            logger.warn(
                `Order ${attempt.order_reference} was paid after it was canceled; needs a refund`,
            );
        }
    }
    const changed = await transitionInvoice(attempt.id, event.status);
    if (changed) await announceInvoice(changed, registry);
    return "applied";
}

/** Options for {@link markOverdueInvoices}. */
export interface OverdueOptions {
    registry: Pick<TessellatePluginRegistry, "emit">;
    /** The clock; tests inject one. */
    now?: () => Date;
    /** Overrides the configured grace period after the due date. */
    graceMs?: number;
}

const OVERDUE_PAGE = 100;

/**
 * Marks sent or viewed invoices overdue once their due date, plus the grace
 * period (`INVOICE_OVERDUE_DAYS`), has passed. The due date counts to the
 * end of that day in UTC. Overdue is a label: the invoice stays payable and
 * the order stays open. Safe to run twice or on several instances because
 * the status change is made under a row lock, so each invoice announces once.
 * @param options the registry to notify and optional clock and grace period
 * @returns how many invoices this call marked overdue
 */
export async function markOverdueInvoices(
    options: OverdueOptions,
): Promise<number> {
    const now = (options.now ?? (() => new Date()))();
    const grace = options.graceMs ?? invoiceOverdueMs();
    // Due dates are midnight-UTC dates: due + 1 day + grace <= now
    const lastDue = new Date(now.getTime() - grace - 24 * 60 * 60_000)
        .toISOString()
        .slice(0, 10);
    let marked = 0;
    let after = "";
    for (;;) {
        const page = await drizzleDB
            .select()
            .from(onlinePaymentsTable)
            .where(
                and(
                    eq(onlinePaymentsTable.kind, "invoice"),
                    inArray(onlinePaymentsTable.status, ["sent", "viewed"]),
                    lte(onlinePaymentsTable.due_date, lastDue),
                    gt(onlinePaymentsTable.id, after),
                ),
            )
            .orderBy(asc(onlinePaymentsTable.id))
            .limit(OVERDUE_PAGE);
        for (const row of page) {
            try {
                const changed = await transitionInvoice(row.id, "overdue");
                if (changed) {
                    marked++;
                    await announceInvoice(changed, options.registry);
                }
            } catch (err) {
                logger.error(`Could not mark invoice ${row.id} overdue`, err);
            }
        }
        const last = page[page.length - 1];
        if (page.length < OVERDUE_PAGE || !last) break;
        after = last.id;
    }
    return marked;
}
