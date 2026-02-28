import { configDotenv } from "dotenv";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";

configDotenv();

const client = postgres(process.env.DATABASE_URL!);
export const drizzleDB = drizzle({ client });
