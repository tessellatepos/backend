import { and, eq } from "drizzle-orm";
import { drizzleDB } from "@/services/db/postgres";
import { paymentProcessorSettingsTable } from "@/services/db/schema";

export type ProcessorSettingsRow =
    typeof paymentProcessorSettingsTable.$inferSelect;

/**
 * @param locationId a location id
 * @returns every processor settings row of the location
 */
export async function listSettingsRows(
    locationId: string,
): Promise<ProcessorSettingsRow[]> {
    return drizzleDB
        .select()
        .from(paymentProcessorSettingsTable)
        .where(eq(paymentProcessorSettingsTable.location_id, locationId));
}

/**
 * @param processorId a processor id
 * @param locationId a location id
 * @returns the row, or null
 */
export async function getSettingsRow(
    processorId: string,
    locationId: string,
): Promise<ProcessorSettingsRow | null> {
    const [row] = await drizzleDB
        .select()
        .from(paymentProcessorSettingsTable)
        .where(
            and(
                eq(paymentProcessorSettingsTable.processor_id, processorId),
                eq(paymentProcessorSettingsTable.location_id, locationId),
            ),
        )
        .limit(1);
    return row ?? null;
}

/**
 * Inserts or replaces the settings row of a processor at a location.
 * @param row the full row
 */
export async function upsertSettingsRow(
    row: typeof paymentProcessorSettingsTable.$inferInsert,
): Promise<void> {
    await drizzleDB
        .insert(paymentProcessorSettingsTable)
        .values(row)
        .onConflictDoUpdate({
            target: [
                paymentProcessorSettingsTable.processor_id,
                paymentProcessorSettingsTable.location_id,
            ],
            set: {
                enabled: row.enabled,
                config_encrypted: row.config_encrypted,
                updated_at: row.updated_at,
            },
        });
}

/**
 * @param processorId a processor id
 * @returns the enabled rows of the processor, at every location
 */
export async function listEnabledRowsForProcessor(
    processorId: string,
): Promise<ProcessorSettingsRow[]> {
    return drizzleDB
        .select()
        .from(paymentProcessorSettingsTable)
        .where(
            and(
                eq(paymentProcessorSettingsTable.processor_id, processorId),
                eq(paymentProcessorSettingsTable.enabled, true),
            ),
        );
}
