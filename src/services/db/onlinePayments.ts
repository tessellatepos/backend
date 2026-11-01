import { and, eq, inArray } from "drizzle-orm";
import { drizzleDB } from "@/services/db/postgres";
import { onlinePaymentsTable } from "@/services/db/schema";

export type OnlinePaymentRow = typeof onlinePaymentsTable.$inferSelect;
export type OnlinePaymentInsert = typeof onlinePaymentsTable.$inferInsert;

/**
 * @param row the attempt to record
 * @throws on a duplicate (processor_id, external_id) or an unknown order
 */
export async function insertOnlinePayment(
    row: OnlinePaymentInsert,
): Promise<void> {
    await drizzleDB.insert(onlinePaymentsTable).values(row);
}

/**
 * @param processorId a processor id
 * @param externalId the processor's id for the attempt
 * @returns the row, or null
 */
export async function findOnlinePayment(
    processorId: string,
    externalId: string,
): Promise<OnlinePaymentRow | null> {
    const [row] = await drizzleDB
        .select()
        .from(onlinePaymentsTable)
        .where(
            and(
                eq(onlinePaymentsTable.processor_id, processorId),
                eq(onlinePaymentsTable.external_id, externalId),
            ),
        )
        .limit(1);
    return row ?? null;
}

/**
 * @param orderReference an order's reference id
 * @returns every attempt for the order, oldest first
 */
export async function listOnlinePayments(
    orderReference: string,
): Promise<OnlinePaymentRow[]> {
    return drizzleDB
        .select()
        .from(onlinePaymentsTable)
        .where(eq(onlinePaymentsTable.order_reference, orderReference))
        .orderBy(onlinePaymentsTable.created_at);
}

/**
 * @param id the attempt's id
 * @param status the new status
 */
export async function setOnlinePaymentStatus(
    id: string,
    status: OnlinePaymentRow["status"],
): Promise<void> {
    await drizzleDB
        .update(onlinePaymentsTable)
        .set({ status, updated_at: new Date() })
        .where(eq(onlinePaymentsTable.id, id));
}

/**
 * Which status a checkout attempt may take given the one it has. `refunded`
 * is final and `paid` only moves on to `refunded`. `failed` and `expired` stay
 * unless a real `paid` event arrives (money did move, whatever the order of
 * delivery), so a late `expired` never overwrites `failed` and vice versa.
 * @param current the status the attempt has
 * @param next the status an event reports
 * @returns the status to store, or null to leave the attempt as it is
 */
export function nextCheckoutStatus(
    current: OnlinePaymentRow["status"],
    next: OnlinePaymentRow["status"],
): OnlinePaymentRow["status"] | null {
    if (current === next || current === "refunded") return null;
    if (current === "paid") return next === "refunded" ? next : null;
    if (current === "failed" || current === "expired") {
        return next === "paid" ? next : null;
    }
    return next;
}

/**
 * Applies a status reported by an event to a checkout attempt. The status is
 * read under a row lock and written in the same transaction, so two events
 * for one attempt cannot both act on a stale status.
 * @param id the attempt's id
 * @param next the status the event reports
 * @returns the status stored, or null when the attempt kept its status
 */
export async function applyCheckoutStatus(
    id: string,
    next: OnlinePaymentRow["status"],
): Promise<OnlinePaymentRow["status"] | null> {
    return drizzleDB.transaction(async (tx) => {
        const [row] = await tx
            .select({ status: onlinePaymentsTable.status })
            .from(onlinePaymentsTable)
            .where(eq(onlinePaymentsTable.id, id))
            .for("update");
        if (!row) return null;
        const to = nextCheckoutStatus(row.status, next);
        if (!to) return null;
        await tx
            .update(onlinePaymentsTable)
            .set({ status: to, updated_at: new Date() })
            .where(eq(onlinePaymentsTable.id, id));
        return to;
    });
}

/**
 * @param orderReferences order reference ids
 * @returns every attempt for those orders, oldest first
 */
export async function listOnlinePaymentsForOrders(
    orderReferences: string[],
): Promise<OnlinePaymentRow[]> {
    if (orderReferences.length === 0) return [];
    return drizzleDB
        .select()
        .from(onlinePaymentsTable)
        .where(inArray(onlinePaymentsTable.order_reference, orderReferences))
        .orderBy(onlinePaymentsTable.created_at);
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
 * @param orderReference an order's reference id
 * @param now the current time
 * @returns its hosted checkouts a shopper could still pay (status `created`,
 * not expired), oldest first
 */
export async function listLiveCheckouts(
    orderReference: string,
    now: Date,
): Promise<OnlinePaymentRow[]> {
    return (await listOnlinePayments(orderReference)).filter(
        (a) => a.kind === "checkout" && isLiveAttempt(a, now),
    );
}
