import { configProviderTable } from "@/services/db/schema";
import { drizzleDB } from "@/services/db/postgres";
import type { ProviderId } from "@tessellatepos/sdk";

/**
 * Reads the persisted provider choice.
 * @returns the provider, or null if one was never chosen
 */
export async function getStoredProvider(): Promise<ProviderId | null> {
    const [row] = await drizzleDB.select().from(configProviderTable).limit(1);
    return (row?.provider as ProviderId | undefined) ?? null;
}

/**
 * Persists the provider choice in the single config row.
 * @param provider the provider to store
 */
export async function storeProvider(provider: ProviderId) {
    await drizzleDB
        .insert(configProviderTable)
        .values({ id: 1, provider })
        .onConflictDoUpdate({
            target: configProviderTable.id,
            set: { provider, updatedAt: new Date() },
        });
}
