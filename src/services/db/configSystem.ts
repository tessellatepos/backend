import "dotenv/config";
import { drizzle } from "drizzle-orm/postgres-js"
import { eq } from "drizzle-orm";
import { configSystem } from "./schema";

const db = drizzle(process.env.DATABASE_URL!);

export async function getConfigSystem() {
    const config = await db.select().from(configSystem).limit(1);
    return config[0] || null;
}

async function updateConfigSystem(id: number, updates: Partial<typeof configSystem.$inferInsert>) {
    await db.update(configSystem).set(updates).where(eq(configSystem.id, id));
}