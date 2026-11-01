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
