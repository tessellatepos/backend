import { pool, runMigrations } from "@/services/db/postgres";

/**
 * Migrates the test database. Refuses to run against anything whose name
 * doesn't end in _test, since the tests truncate tables.
 */
export async function setupTestDb(): Promise<void> {
    const url = process.env.DATABASE_URL ?? "";
    if (!/_test(\?.*)?$/.test(url)) {
        throw new Error(
            "Tests need DATABASE_URL to point at a *_test database",
        );
    }
    await runMigrations();
}

/**
 * Empties the given tables.
 * @param tables the quoted-safe table names to truncate
 */
export async function truncate(...tables: string[]): Promise<void> {
    const list = tables.map((table) => `"${table}"`).join(", ");
    await pool.query(`TRUNCATE ${list} CASCADE`);
}

/** Closes the connection pool so the test process can exit. */
export async function closeTestDb(): Promise<void> {
    await pool.end();
}
