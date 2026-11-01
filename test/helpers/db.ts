import { pool, runMigrations } from "@/services/db/postgres";

/**
 * Applies migrations to the test database. Test files run in parallel
 * processes against one database, so migrating is serialised with a
 * Postgres advisory lock.
 */
export async function migrateTestDb(): Promise<void> {
    const client = await pool.connect();
    try {
        await client.query("SELECT pg_advisory_lock(7351001)");
        await runMigrations();
    } finally {
        await client.query("SELECT pg_advisory_unlock(7351001)");
        client.release();
    }
}
