import "dotenv/config";
import { drizzle } from "drizzle-orm/postgres-js"
import { eq } from "drizzle-orm";
import { configSystemTable } from "@/services/db/schema";
import { IConfigSystem } from "@tessellate-pos/common/src/types/database";

const db = drizzle(process.env.DATABASE_URL!);

export async function getConfigSystem() {
	const config = await db.select().from(configSystemTable).limit(1);
	return config[0] || null;
}

export async function updateConfigSystem(updates: IConfigSystem) {
	// always use id 1 since there should only be one row in the configSystemTable
	return await db.update(configSystemTable).set(updates).where(eq(configSystemTable.id, 1));
}
