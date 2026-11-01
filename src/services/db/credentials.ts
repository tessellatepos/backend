import { eq } from "drizzle-orm";
import { drizzleDB } from "@/services/db/postgres";
import { apiCredentialsTable } from "@/services/db/schema";

export type CredentialRow = typeof apiCredentialsTable.$inferSelect;
export type CredentialInsert = typeof apiCredentialsTable.$inferInsert;

/**
 * Inserts a credential row.
 * @param row the full row, secrets already hashed or encrypted
 */
export async function insertCredential(row: CredentialInsert): Promise<void> {
    await drizzleDB.insert(apiCredentialsTable).values(row);
}

/**
 * Loads one credential by its client id, including revoked ones.
 * @param id the client id
 * @returns the row, or null
 */
export async function getCredentialRow(
    id: string,
): Promise<CredentialRow | null> {
    const [row] = await drizzleDB
        .select()
        .from(apiCredentialsTable)
        .where(eq(apiCredentialsTable.id, id))
        .limit(1);
    return row ?? null;
}

/**
 * Lists every credential, newest first, including revoked ones.
 * @returns the rows
 */
export async function listCredentialRows(): Promise<CredentialRow[]> {
    return drizzleDB
        .select()
        .from(apiCredentialsTable)
        .orderBy(apiCredentialsTable.created_at);
}

/**
 * Applies a partial update to a credential row.
 * @param id the client id
 * @param patch the columns to set
 * @returns the updated row, or null when no credential has that id
 */
export async function updateCredentialRow(
    id: string,
    patch: Partial<CredentialInsert>,
): Promise<CredentialRow | null> {
    const [row] = await drizzleDB
        .update(apiCredentialsTable)
        .set({ ...patch, updated_at: new Date() })
        .where(eq(apiCredentialsTable.id, id))
        .returning();
    return row ?? null;
}
