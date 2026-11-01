/**
 * What the gateway does with an online order after it exists: who may reach it,
 * how its payment state is derived, starting a hosted checkout, cancelling.
 * Orders live in our database for online sales, so this reads the local rows
 * whichever provider created them.
 */
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import type { Request } from "express";
import { Logger } from "tslog";
import { pluginContext } from "@/utils/pluginContext";
import { parseMoney, stripBigints } from "@tessellatepos/sdk";
import type {
    Money,
    Order,
    OrderPaymentStatus,
    Principal,
} from "@tessellatepos/sdk";
import { hooks, events } from "@tessellatepos/plugin-sdk/server";
import { onlinePaymentsAvailable } from "@/config/urls";
import { drizzleDB } from "@/services/db/postgres";
import {
    catalogItemVariationsTable,
    catalogItemsTable,
} from "@/services/db/schema";
import {
    getOrderByAnyId,
    listOnlineOrdersAtLocation,
    rowToOrder,
} from "@/services/db/orders";
import type { ordersTable } from "@/services/db/schema";
import {
    insertOnlinePayment,
    listOnlinePayments,
    listOnlinePaymentsForOrders,
    type OnlinePaymentRow,
} from "@/services/db/onlinePayments";
import { getCustomer } from "@/services/customers";
import { getActiveProvider } from "@/services/providers";
import { getEnabledProcessorConfig } from "@/services/processors/settings";
import {
    processorRegistry,
    type PaymentProcessorRegistry,
} from "@/services/processors/registry";
import { withRedisLock } from "@/gateway/createGuard";
import type { TessellatePluginRegistry } from "@/utils/registry/plugin/pluginRegistry";

const logger = new Logger({ name: "gateway" });

export type OrderRow = typeof ordersTable.$inferSelect;

/** A refusal in the gateway's error vocabulary. */
export interface Refusal {
    ok: false;
    status: number;
    code: string;
    message: string;
}

export const refuse = (
    status: number,
    code: string,
    message: string,
): Refusal => ({
    ok: false,
    status,
    code,
    message,
});

/** Test seam: how availability is decided. */
export const checkoutDeps = {
    available: (): boolean => onlinePaymentsAvailable(),
};

/** The caller as the checks see it. */
export interface GatewayCaller {
    credentialId: string;
    locationIds: string[] | "all";
}

/**
 * The order a credential may reach: one it created, at a location it still
 * holds. Both must be true, which is stricter than the location rule alone,
 * so a credential never sees staff orders or another store's orders at a
 * shared location. Anything else is "not found", as for other order routes.
 * @param caller the credential and its locations
 * @param id the order's id or reference id
 * @returns the row, or null
 */
export async function findOwnedOrder(
    caller: GatewayCaller,
    id: string,
): Promise<OrderRow | null> {
    const row = await getOrderByAnyId(id);
    if (!row || row.createdByCredential !== caller.credentialId) return null;
    if (
        caller.locationIds !== "all" &&
        !caller.locationIds.includes(row.locationId)
    ) {
        return null;
    }
    return row;
}

/**
 * Variation ids that cannot be ordered through the online channel: unknown,
 * on an archived item, or not including `online` (a variation without its own
 * channels follows its item).
 * @param variationIds the ids on an order
 * @returns the unknown ids and the ids that exist but are not sold online
 */
export async function nonOnlineVariations(
    variationIds: string[],
): Promise<{ unknown: string[]; notOnline: string[] }> {
    const rows = await drizzleDB
        .select({
            variationId: catalogItemVariationsTable.variationId,
            variationChannels: catalogItemVariationsTable.channels,
            itemChannels: catalogItemsTable.channels,
            archived: catalogItemsTable.isArchived,
        })
        .from(catalogItemVariationsTable)
        .innerJoin(
            catalogItemsTable,
            eq(catalogItemVariationsTable.itemId, catalogItemsTable.id),
        )
        .where(inArray(catalogItemVariationsTable.variationId, variationIds));
    const byId = new Map(rows.map((r) => [r.variationId, r]));
    const unknown: string[] = [];
    const notOnline: string[] = [];
    for (const id of new Set(variationIds)) {
        const row = byId.get(id);
        if (!row) {
            unknown.push(id);
            continue;
        }
        const channels = row.variationChannels ?? row.itemChannels;
        if (
            row.archived ||
            !row.itemChannels.includes("online") ||
            !channels.includes("online")
        ) {
            notOnline.push(id);
        }
    }
    return { unknown, notOnline };
}

const ACTIVE_INVOICE = ["draft", "sent", "viewed", "overdue"];

/**
 * Whether an attempt can still be paid: a checkout that has not expired, or
 * an open invoice.
 * @param attempt the attempt
 * @param now the current time
 * @returns true when the shopper could still pay it
 */
export function isLiveAttempt(attempt: OnlinePaymentRow, now: Date): boolean {
    if (attempt.kind === "invoice") {
        return ACTIVE_INVOICE.includes(attempt.status);
    }
    if (attempt.status !== "created") return false;
    return !attempt.expires_at || attempt.expires_at > now;
}

/**
 * The payment state of an order, derived from what happened to it.
 * `refunded` wins over `paid` (a refund follows a payment); `paid` also holds
 * for an order settled in person. An attempt still payable means
 * `processing`. Otherwise the latest attempt decides: `failed` only when the
 * processor reported a failure, so an expired or canceled attempt leaves the
 * order `unpaid` and ready for another.
 * @param order the order's state and tenders
 * @param attempts its attempts, oldest first
 * @param now the current time
 * @returns the derived status
 */
export function derivePaymentStatus(
    order: { state?: string | null; tenders?: unknown },
    attempts: OnlinePaymentRow[],
    now = new Date(),
): OrderPaymentStatus {
    if (attempts.some((a) => a.status === "refunded")) return "refunded";
    if (attempts.some((a) => a.status === "paid")) return "paid";
    const tenders = Array.isArray(order.tenders) ? order.tenders : [];
    if (order.state === "COMPLETED" && tenders.length > 0) return "paid";
    if (attempts.some((a) => isLiveAttempt(a, now))) return "processing";
    const latest = attempts[attempts.length - 1];
    return latest?.status === "failed" ? "failed" : "unpaid";
}

/** An attempt as the gateway shows it: no processor ids, no secrets. */
export function toAttemptView(attempt: OnlinePaymentRow) {
    return {
        id: attempt.id,
        processor: attempt.processor_id,
        kind: attempt.kind,
        status: attempt.status,
        ...(attempt.url ? { url: attempt.url } : {}),
        amount: parseMoney(attempt.amount),
        ...(attempt.due_date ? { due_date: attempt.due_date } : {}),
        expires_at: attempt.expires_at?.toISOString() ?? null,
        created_at: attempt.created_at.toISOString(),
        updated_at: attempt.updated_at.toISOString(),
    };
}

/** An invoice as the gateway shows it (also the `invoice.*` webhook data). */
export function toInvoiceView(attempt: OnlinePaymentRow) {
    return {
        id: attempt.id,
        order_id: attempt.order_reference,
        processor: attempt.processor_id,
        status: attempt.status,
        ...(attempt.url ? { url: attempt.url } : {}),
        amount: parseMoney(attempt.amount),
        due_date: attempt.due_date ?? null,
        created_at: attempt.created_at.toISOString(),
        updated_at: attempt.updated_at.toISOString(),
    };
}

/**
 * An order as the gateway returns it, with its derived payment status, latest
 * attempt and latest invoice.
 * @param order the order
 * @param attempts the order's attempts, oldest first
 * @returns the order plus `payment_status` and `latest_payment`
 */
export function presentOrder(order: Order, attempts: OnlinePaymentRow[]) {
    const latest = attempts[attempts.length - 1];
    const invoice = attempts.filter((a) => a.kind === "invoice").pop();
    return {
        ...order,
        payment_status: derivePaymentStatus(order, attempts),
        latest_payment: latest ? toAttemptView(latest) : null,
        invoice: invoice ? toInvoiceView(invoice) : null,
    };
}

/**
 * Whether a URL is on one of the credential's allowed origins. Credentials in
 * the URL are refused.
 * @param value the URL a store supplied
 * @param origins the credential's allowed origins
 * @returns true when the URL's origin is listed
 */
export function urlOnAllowedOrigin(
    value: string,
    origins: readonly string[],
): boolean {
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        return false;
    }
    if (url.username || url.password) return false;
    return origins.includes(url.origin);
}

/** What the caller asked a checkout for. */
export interface CheckoutRequest {
    row: OrderRow;
    processorId: string;
    successUrl: string;
    cancelUrl: string;
    caller: GatewayCaller & {
        origins: readonly string[];
        principal: Pick<Principal, "kind" | "id" | "display_name">;
    };
    plugins: TessellatePluginRegistry;
    registry?: PaymentProcessorRegistry;
}

export type CheckoutOutcome =
    | {
          ok: true;
          url: string;
          expires_at: string | null;
          processor: string;
          payment_id: string;
      }
    | Refusal;

/**
 * Starts (or resumes) a hosted checkout for an unpaid order. The shopper pays
 * on the processor's page; this backend never sees card data and learns the
 * result by signed webhook.
 *
 * A live checkout at the same processor is returned as it is, so a shopper who
 * comes back gets the same page; its return URLs are the ones of the call that
 * created it. A live attempt at another processor blocks a new one, so an
 * order cannot be paid twice.
 * @param request the order, processor, return URLs and caller
 * @returns the hosted URL, or why not
 */
export async function startCheckout(
    request: CheckoutRequest,
): Promise<CheckoutOutcome> {
    const { row, processorId, caller } = request;
    const registry = request.registry ?? processorRegistry;

    for (const url of [request.successUrl, request.cancelUrl]) {
        if (!urlOnAllowedOrigin(url, caller.origins)) {
            return refuse(
                400,
                "url_origin_not_allowed",
                "success_url and cancel_url must be on one of this credential's allowed origins",
            );
        }
    }
    if (row.state !== "OPEN" || hasTender(row)) {
        return refuse(
            409,
            "order_not_payable",
            "Only an open, unpaid order can be checked out",
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

    if (registry.list().length === 0) {
        return refuse(
            409,
            "pay_at_pickup",
            "Online payment is not offered here: pay at pickup",
        );
    }
    if (!checkoutDeps.available()) {
        return refuse(
            409,
            "online_payments_unavailable",
            "Online payments are not available: PUBLIC_URL is not set to an https address",
        );
    }
    const processor = registry.get(processorId);
    if (!processor) {
        return refuse(400, "unknown_processor", "Unknown payment processor");
    }
    if (!processor.capabilities.checkout || !processor.createCheckout) {
        return refuse(
            409,
            "checkout_not_supported",
            "This processor does not support hosted checkout",
        );
    }
    if (!(await getEnabledProcessorConfig(processor.id, row.locationId))) {
        return refuse(
            409,
            "processor_disabled",
            "This payment processor is not enabled at the order's location",
        );
    }

    const blocked = await request.plugins.runHook(hooks.beforeCheckout, {
        orderId: row.referenceId,
        amount: total as Money,
        processor: processor.id,
        source: caller.principal.display_name,
        principal: caller.principal,
    });
    if (!blocked.ok) {
        return refuse(400, blocked.code ?? "checkout_blocked", blocked.reason);
    }

    const locked = await withRedisLock(
        `gw:checkout-lock:${row.referenceId}`,
        async (): Promise<CheckoutOutcome> => {
            const now = new Date();
            const live = (await listOnlinePayments(row.referenceId)).filter(
                (a) => isLiveAttempt(a, now),
            );
            const same = live.find(
                (a) =>
                    a.kind === "checkout" &&
                    a.processor_id === processor.id &&
                    a.url,
            );
            if (same) {
                return {
                    ok: true,
                    url: same.url as string,
                    expires_at: same.expires_at?.toISOString() ?? null,
                    processor: processor.id,
                    payment_id: same.id,
                };
            }
            if (live.length > 0) {
                return refuse(
                    409,
                    "payment_in_progress",
                    "Another payment for this order is still open",
                );
            }

            const order = rowToOrder(row);
            const customer = order.customerId
                ? ((await getCustomer(order.customerId)) ?? undefined)
                : undefined;
            let created: Awaited<
                ReturnType<NonNullable<typeof processor.createCheckout>>
            >;
            try {
                created = await processor.createCheckout!({
                    order,
                    successUrl: request.successUrl,
                    cancelUrl: request.cancelUrl,
                    customer,
                });
            } catch (err) {
                logger.error(
                    `Processor ${processor.id} could not create a checkout`,
                    err,
                );
                return refuse(
                    502,
                    "processor_error",
                    "The payment processor could not start a checkout",
                );
            }
            const parsedExpiry = created.expiresAt
                ? new Date(created.expiresAt)
                : null;
            const expiresAt =
                parsedExpiry && !Number.isNaN(parsedExpiry.getTime())
                    ? parsedExpiry
                    : null;
            const id = randomUUID();
            await insertOnlinePayment({
                id,
                order_reference: row.referenceId,
                processor_id: processor.id,
                kind: "checkout",
                external_id: created.externalId,
                url: created.url,
                status: "created",
                amount: stripBigints(total),
                expires_at: expiresAt,
            });
            return {
                ok: true,
                url: created.url,
                expires_at: expiresAt?.toISOString() ?? null,
                processor: processor.id,
                payment_id: id,
            };
        },
    );
    return (
        locked?.value ??
        refuse(
            409,
            "payment_in_progress",
            "A checkout for this order is already being created",
        )
    );
}

function hasTender(row: OrderRow): boolean {
    return Array.isArray(row.tenders) && row.tenders.length > 0;
}

export type CancelOutcome = { ok: true; order: Order } | Refusal;

/**
 * Cancels an order that has not been paid. Idempotent: an order already
 * canceled answers as canceled. A paid order, one with a tender, or one that
 * was invoiced (the invoice has to be canceled first) is refused.
 * @param row the order
 * @param registry the plugin registry that receives `orderCancelled`
 * @param caller the request that asked for the cancel, for the plugin context
 * @returns the canceled order, or why not
 */
export async function cancelUnpaidOrder(
    row: OrderRow,
    registry: TessellatePluginRegistry,
    caller?: Pick<Request, "principal">,
): Promise<CancelOutcome> {
    if (row.state === "CANCELED") return { ok: true, order: rowToOrder(row) };
    const attempts = await listOnlinePayments(row.referenceId);
    if (
        row.state === "COMPLETED" ||
        hasTender(row) ||
        attempts.some((a) => a.status === "paid" || a.status === "refunded")
    ) {
        return refuse(
            409,
            "order_not_cancellable",
            "A paid order cannot be canceled",
        );
    }
    // An open invoice is payable at the processor, so it has to be canceled
    // first; once every invoice is canceled the order is an ordinary unpaid
    // one. An order marked invoiced with no invoice on record stays refused.
    const invoices = attempts.filter((a) => a.kind === "invoice");
    if (
        row.invoicedAt &&
        (invoices.length === 0 ||
            invoices.some((a) => isLiveAttempt(a, new Date())))
    ) {
        return refuse(
            409,
            "order_invoiced",
            "An invoiced order cannot be canceled here: cancel its invoice",
        );
    }
    const canceled = await getActiveProvider().cancelOrder(
        row.id ?? row.referenceId,
    );
    if (!canceled) {
        // A payment or another cancel won the race.
        const now = await getOrderByAnyId(row.referenceId);
        if (now?.state === "CANCELED") {
            return { ok: true, order: rowToOrder(now) };
        }
        return refuse(
            409,
            "order_not_cancellable",
            "This order can no longer be canceled",
        );
    }
    registry.emit(
        events.orderCancelled,
        canceled,
        pluginContext(caller, canceled),
    );
    return { ok: true, order: canceled };
}

/** What a staff list of online orders can be narrowed by. */
export interface StaffOrderQuery {
    locationId: string;
    source?: string;
    processor?: string;
    paymentStatus?: OrderPaymentStatus;
    limit?: number;
    cursor?: string;
}

/** Most pages read to find matches for a payment status filter. */
const MAX_STATUS_SCANS = 10;

/**
 * A page of online orders at a location with their derived payment status.
 * `payment_status` is derived, not stored, so that filter is applied after
 * reading: pages are scanned until one yields `limit` matches (or the end, or
 * a scan limit), which can return somewhat more than `limit`. The cursor is
 * always where scanning stopped, so no order is skipped.
 * @param query the location, filters and paging
 * @returns presented orders and the cursor for the next page
 */
export async function listStaffOnlineOrders(query: StaffOrderQuery) {
    const limit = Math.min(Math.max(Math.floor(query.limit ?? 50), 1), 200);
    const found: ReturnType<typeof presentOrder>[] = [];
    let cursor = query.cursor;
    let next: string | null = null;
    for (let scan = 0; scan < MAX_STATUS_SCANS; scan++) {
        const page = await listOnlineOrdersAtLocation(
            query.locationId,
            { source: query.source, processor: query.processor },
            { limit, cursor },
        );
        const attempts = await listOnlinePaymentsForOrders(
            page.orders.map((o) => o.referenceId!),
        );
        for (const order of page.orders) {
            const presented = presentOrder(
                order,
                attempts.filter((a) => a.order_reference === order.referenceId),
            );
            if (
                !query.paymentStatus ||
                presented.payment_status === query.paymentStatus
            ) {
                found.push(presented);
            }
        }
        next = page.nextCursor;
        cursor = next ?? undefined;
        if (!next || found.length >= limit) break;
    }
    return { orders: found, next_cursor: next };
}

/**
 * An order for staff: the gateway view plus every attempt, with the
 * processor's own id for support.
 * @param row the order
 * @returns the order, `payments` oldest first, and `invoice`
 */
export async function presentStaffOrder(row: OrderRow) {
    const attempts = await listOnlinePayments(row.referenceId);
    return {
        ...presentOrder(rowToOrder(row), attempts),
        invoiced_at: row.invoicedAt?.toISOString() ?? null,
        payments: attempts.map((a) => ({
            ...toAttemptView(a),
            external_id: a.external_id,
        })),
    };
}
