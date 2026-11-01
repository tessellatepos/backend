import { and, desc, eq, inArray, lte, sql } from "drizzle-orm";
import { drizzleDB } from "@/services/db/postgres";
import { apiWebhookDeliveriesTable } from "@/services/db/schema";

export type DeliveryRow = typeof apiWebhookDeliveriesTable.$inferSelect;
export type DeliveryInsert = typeof apiWebhookDeliveriesTable.$inferInsert;

/**
 * Inserts delivery rows.
 * @param rows the rows, status pending
 */
export async function insertDeliveries(rows: DeliveryInsert[]): Promise<void> {
    if (rows.length === 0) return;
    await drizzleDB.insert(apiWebhookDeliveriesTable).values(rows);
}

/**
 * Claims up to `limit` due pending deliveries for one sender. The claim pushes
 * each row's next attempt out by `leaseMs` and counts the attempt, so another
 * instance skips it. Rows locked by a concurrent claim are skipped.
 * @param now the time a row must be due by
 * @param limit the most rows to claim
 * @param leaseMs how long a claim holds the row
 * @returns the claimed rows
 */
export async function claimDueDeliveries(
    now: Date,
    limit: number,
    leaseMs: number,
): Promise<DeliveryRow[]> {
    const t = apiWebhookDeliveriesTable;
    const due = drizzleDB
        .select({ id: t.id })
        .from(t)
        .where(and(eq(t.status, "pending"), lte(t.next_attempt_at, now)))
        .orderBy(t.next_attempt_at)
        .limit(limit)
        .for("update", { skipLocked: true });
    return drizzleDB
        .update(t)
        .set({
            next_attempt_at: new Date(now.getTime() + leaseMs),
            attempts: sql`${t.attempts} + 1`,
        })
        .where(inArray(t.id, due))
        .returning();
}

/**
 * Updates a delivery row.
 * @param id the delivery id
 * @param patch the columns to set
 */
export async function updateDelivery(
    id: string,
    patch: Partial<DeliveryInsert>,
): Promise<void> {
    await drizzleDB
        .update(apiWebhookDeliveriesTable)
        .set(patch)
        .where(eq(apiWebhookDeliveriesTable.id, id));
}

/**
 * Reads one delivery belonging to a credential.
 * @param credentialId the credential
 * @param id the delivery id
 * @returns the row, or null
 */
export async function getDelivery(
    credentialId: string,
    id: string,
): Promise<DeliveryRow | null> {
    const [row] = await drizzleDB
        .select()
        .from(apiWebhookDeliveriesTable)
        .where(
            and(
                eq(apiWebhookDeliveriesTable.id, id),
                eq(apiWebhookDeliveriesTable.credential_id, credentialId),
            ),
        )
        .limit(1);
    return row ?? null;
}

/**
 * The newest deliveries of a credential.
 * @param credentialId the credential
 * @param limit the most rows to return
 * @returns the rows, newest first
 */
export async function listDeliveries(
    credentialId: string,
    limit: number,
): Promise<DeliveryRow[]> {
    return drizzleDB
        .select()
        .from(apiWebhookDeliveriesTable)
        .where(eq(apiWebhookDeliveriesTable.credential_id, credentialId))
        .orderBy(desc(apiWebhookDeliveriesTable.created_at))
        .limit(limit);
}
