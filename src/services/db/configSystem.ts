import "dotenv/config";
import { eq } from "drizzle-orm";
import { configSystemTable } from "@/services/db/schema";
import { type IConfigSystem } from "@/types/database";
import { drizzleDB } from "@/services/db/postgres";

type TDrizzleDB = typeof drizzleDB;

export async function getConfigSystem(db: TDrizzleDB = drizzleDB) {
    const config = await db.select().from(configSystemTable).limit(1);
    return config[0] || null;
}

export async function updateConfigSystem(
    updates: IConfigSystem,
    db: TDrizzleDB = drizzleDB,
) {
    // always use id 1 since there should only be one row in the configSystemTable
    return db
        .update(configSystemTable)
        .set(updates)
        .where(eq(configSystemTable.id, 1));
}

/**
 * Writes the single system-config row, creating it if this deployment has
 * never been configured (the OAuth callback is usually what creates it).
 * @param values the columns to write
 */
export async function upsertConfigSystem(
    values: Omit<typeof configSystemTable.$inferInsert, "id">,
    db: TDrizzleDB = drizzleDB,
) {
    return db
        .insert(configSystemTable)
        .values({ id: 1, ...values })
        .onConflictDoUpdate({
            target: configSystemTable.id,
            set: { ...values, updatedAt: new Date() },
        });
}

export async function deleteConfigSystem(db: TDrizzleDB = drizzleDB) {
    return db.delete(configSystemTable).where(eq(configSystemTable.id, 1));
}
