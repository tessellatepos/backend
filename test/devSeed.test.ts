import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import type { DevSeedDeps, DevSeedEnv } from "@/services/devSeed";

// The seed writes a real owner, store and till, so this file migrates and
// uses its own throwaway database. Env is set before the app modules load.
const dbName = `tessellate_seed_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
const adminUrl = process.env.DATABASE_URL;

let pool: typeof import("@/services/db/postgres").pool;
let runDevSeed: typeof import("@/services/devSeed").runDevSeed;
let devSeedDeps: typeof import("@/services/devSeed").devSeedDeps;

/** Records every log line so tests can check what the operator sees. */
function captureLog() {
    const lines: { level: string; text: string }[] = [];
    const record =
        (level: string) =>
        (...args: unknown[]) =>
            lines.push({ level, text: args.map(String).join(" ") });
    return {
        lines,
        log: {
            info: record("info"),
            warn: record("warn"),
            error: record("error"),
        },
    };
}

/**
 * Dependencies that fail the test if the seed touches them. `hasUsers` is
 * allowed (and reports no users) so the seed reaches its own checks.
 */
function untouchableDeps() {
    const calls: string[] = [];
    const boom = (name: string) => async () => {
        calls.push(name);
        throw new Error(`${name} must not be called`);
    };
    const deps: DevSeedDeps & { calls: string[] } = {
        calls,
        hasUsers: async () => false,
        createOwner: boom("createOwner"),
        createLocation: boom("createLocation") as DevSeedDeps["createLocation"],
        createDevice: boom("createDevice"),
        setProvider: boom("setProvider") as DevSeedDeps["setProvider"],
        countCatalogItems: boom(
            "countCatalogItems",
        ) as DevSeedDeps["countCatalogItems"],
        importDemoCatalog: boom(
            "importDemoCatalog",
        ) as DevSeedDeps["importDemoCatalog"],
        completeSetup: boom("completeSetup"),
        log: captureLog().log,
    };
    return deps;
}

describe("DEV_SEED", () => {
    before(async () => {
        assert.ok(adminUrl, "DATABASE_URL is required");
        const admin = new Client({ connectionString: adminUrl });
        await admin.connect();
        await admin.query(`CREATE DATABASE ${dbName}`);
        await admin.end();
        const url = new URL(adminUrl);
        url.pathname = `/${dbName}`;
        process.env.DATABASE_URL = url.toString();

        const db = await import("@/services/db/postgres");
        pool = db.pool;
        const { migrateTestDb } = await import("./helpers/db");
        await migrateTestDb();
        const { createAuth } = await import("@/services/auth");
        createAuth();
        ({ runDevSeed, devSeedDeps } = await import("@/services/devSeed"));
    });

    after(async () => {
        await pool.end();
        const admin = new Client({ connectionString: adminUrl });
        await admin.connect();
        await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
        await admin.end();
    });

    describe("refusals and skips (no writes)", () => {
        it("does nothing unless DEV_SEED is exactly true", async () => {
            for (const env of [
                {},
                { DEV_SEED: "" },
                { DEV_SEED: "false" },
                { DEV_SEED: "1" },
            ] as DevSeedEnv[]) {
                const deps = untouchableDeps();
                assert.equal(await runDevSeed(env, deps), "disabled");
                assert.deepEqual(deps.calls, []);
            }
        });

        it("refuses under NODE_ENV=production and logs an error", async () => {
            const deps = untouchableDeps();
            const { log, lines } = captureLog();
            deps.log = log;
            const outcome = await runDevSeed(
                { DEV_SEED: "true", NODE_ENV: "production" },
                deps,
            );
            assert.equal(outcome, "refused");
            assert.deepEqual(deps.calls, []);
            assert.ok(lines.some((l) => l.level === "error"));
        });

        it("refuses when SETUP_TOKEN is set alongside DEV_SEED", async () => {
            const deps = untouchableDeps();
            const { log, lines } = captureLog();
            deps.log = log;
            const outcome = await runDevSeed(
                { DEV_SEED: "true", SETUP_TOKEN: "something" },
                deps,
            );
            assert.equal(outcome, "refused");
            assert.deepEqual(deps.calls, []);
            assert.ok(lines.some((l) => l.level === "error"));
        });

        it("refuses when PUBLIC_URL is set alongside DEV_SEED", async () => {
            const deps = untouchableDeps();
            const { log, lines } = captureLog();
            deps.log = log;
            const outcome = await runDevSeed(
                { DEV_SEED: "true", PUBLIC_URL: "https://shop.example.test" },
                deps,
            );
            assert.equal(outcome, "refused");
            assert.deepEqual(deps.calls, []);
            assert.ok(lines.some((l) => l.level === "error"));
        });

        it("treats a blank SETUP_TOKEN and PUBLIC_URL as unset", async () => {
            const deps = untouchableDeps();
            deps.hasUsers = async () => true;
            assert.equal(
                await runDevSeed(
                    { DEV_SEED: "true", SETUP_TOKEN: "  ", PUBLIC_URL: "" },
                    deps,
                ),
                "skipped",
            );
        });

        it("does nothing when a user already exists", async () => {
            const deps = untouchableDeps();
            deps.hasUsers = async () => true;
            assert.equal(
                await runDevSeed({ DEV_SEED: "true" }, deps),
                "skipped",
            );
            assert.deepEqual(deps.calls, []);
        });

        it("logs an error and reports failed when a step throws", async () => {
            const deps = untouchableDeps();
            const { log, lines } = captureLog();
            deps.log = log;
            deps.createOwner = async () => {
                throw new Error("boom");
            };
            assert.equal(
                await runDevSeed({ DEV_SEED: "true" }, deps),
                "failed",
            );
            assert.ok(lines.some((l) => l.level === "error"));
            assert.ok(!lines.some((l) => l.level === "warn"));
        });
    });

    describe("on an empty database", () => {
        it("seeds the owner, store, till, provider and setup state", async () => {
            const { log, lines } = captureLog();
            const outcome = await runDevSeed(
                { DEV_SEED: "true" },
                { ...devSeedDeps, log },
            );
            assert.equal(outcome, "seeded");

            const warning = lines.find((l) => l.level === "warn");
            assert.ok(warning, "a warning is logged");
            assert.match(warning.text, /admin \/ password/);

            // Signs in through the real auth API, as a wizard owner would.
            const { getAuth } = await import("@/services/auth");
            const { headers } = await getAuth().api.signInUsername({
                body: { username: "admin", password: "password" },
                returnHeaders: true,
            });
            assert.ok(headers.getSetCookie().length > 0, "session cookie set");

            const { rows: users } = await pool.query(
                `SELECT role, username FROM "tessellate-auth-user"`,
            );
            assert.deepEqual(users, [{ role: "owner", username: "admin" }]);

            const { getLocations } = await import("@/services/db/locations");
            const locations = await getLocations();
            assert.equal(locations.length, 1);
            const [store] = locations;
            assert.equal(store.name, "Test Store");
            assert.equal(store.currency, "CAD");
            assert.equal(store.address.country, "CA");

            const { getLocalDeviceForLocation } =
                await import("@/services/db/configDevice");
            const till = await getLocalDeviceForLocation(store.id);
            assert.ok(till, "a LOCAL till is pinned to the store");
            assert.equal(till.device_type, "LOCAL");

            const { getStoredProvider } =
                await import("@/services/db/configProvider");
            const { getActiveProviderId } =
                await import("@/services/providers");
            assert.equal(await getStoredProvider(), "local");
            assert.equal(getActiveProviderId(), "local");

            const { getSetupStatus } = await import("@/services/setup");
            const status = await getSetupStatus();
            assert.equal(status.needsSetup, false);
            assert.equal(status.setupTokenRequired, false);
            assert.deepEqual(status.steps, {
                owner: true,
                store: true,
                provider: true,
                device: false,
            });
        });

        it("loads the demo catalog into the empty catalog", async () => {
            const count = async (table: string) =>
                Number(
                    (await pool.query(`SELECT count(*) AS n FROM "${table}"`))
                        .rows[0].n,
                );
            assert.equal(await count("tessellate-catalog-items"), 31);
            assert.equal(await count("tessellate-catalog-item-variations"), 33);
            assert.equal(await count("tessellate-catalog-categories"), 4);
        });

        it("uses a password that meets better-auth's minimum length", async () => {
            const { getAuth } = await import("@/services/auth");
            const { minPasswordLength } = (await getAuth().$context).password
                .config;
            const { DEV_SEED_PASSWORD } = await import("@/services/devSeed");
            assert.equal(DEV_SEED_PASSWORD, "password");
            assert.ok(
                DEV_SEED_PASSWORD.length >= minPasswordLength,
                `${DEV_SEED_PASSWORD.length} < ${minPasswordLength}`,
            );
        });

        it("creates nothing new when run a second time", async () => {
            const counts = async () => {
                const count = async (table: string) =>
                    Number(
                        (
                            await pool.query(
                                `SELECT count(*) AS n FROM "${table}"`,
                            )
                        ).rows[0].n,
                    );
                return {
                    users: await count("tessellate-auth-user"),
                    locations: await count("tessellate-locations"),
                    devices: await count("tessellate-devices-config"),
                    items: await count("tessellate-catalog-items"),
                    variations: await count(
                        "tessellate-catalog-item-variations",
                    ),
                    categories: await count("tessellate-catalog-categories"),
                };
            };
            const before = await counts();
            assert.deepEqual(before, {
                users: 1,
                locations: 1,
                devices: 1,
                items: 31,
                variations: 33,
                categories: 4,
            });
            const outcome = await runDevSeed(
                { DEV_SEED: "true" },
                { ...devSeedDeps, log: captureLog().log },
            );
            assert.equal(outcome, "skipped");
            assert.deepEqual(await counts(), before);
        });
    });
});
