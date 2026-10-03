import "dotenv/config";
import { pluginRegistryTable } from "@/services/db/schema";
import { drizzleDB } from "@/services/db/postgres";

type TDrizzleDB = typeof drizzleDB;

export async function getPluginRegistry(db: TDrizzleDB = drizzleDB) {
    const config = await db.select().from(pluginRegistryTable).limit(1);
    return config[0] || null;
}
