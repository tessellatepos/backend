import { configDotenv } from "dotenv";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";

configDotenv();

export const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
});

export const drizzleDB = drizzle({ client: pool });

export async function runMigrations(migrationsFolder: string = "./drizzle") {
    await migrate(drizzleDB, { migrationsFolder });
}
