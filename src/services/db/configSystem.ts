import "dotenv/config";
import { drizzle } from "drizzle-orm/postgres-js"
import { eq } from "drizzle-orm";
import { configSystem } from "./schema";

const db = drizzle(process.env.DATABASE_URL!);