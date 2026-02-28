import "dotenv/config";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq } from "drizzle-orm";
import { configSystemTable } from "@/services/db/schema";
import { IConfigSystem } from "@tessellate-pos/common/src/types/database";
import { configDotenv } from "dotenv";
import postgres from "postgres";
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
