import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import type { TestApp } from "./helpers/app";

// Setup only works while the user table is empty, which the shared test
// database never is, so this file migrates and uses its own throwaway
// database. The env must be set before the app modules load (pg pool).
const TOKEN = `test-setup-token-${randomUUID()}`;
const PASSWORD = "correct-horse-battery";
const dbName = `tessellate_setup_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
const adminUrl = process.env.DATABASE_URL;
const ADDRESS = {
    country: "CA",
    address_line_1: "1 Main St",
    locality: "Winnipeg",
    subdivision: "MB",
    postal_code: "R3C 1A1",
};

let server: TestApp;
let ownerCookie = "";
let viewerCookie = "";
let pool: typeof import("@/services/db/postgres").pool;

async function call(
    path: string,
    init: {
        method?: string;
        body?: unknown;
        cookie?: string;
        ip?: string;
    } = {},
) {
    const res = await fetch(`${server.url}/api/v1/setup${path}`, {
        method: init.method ?? (init.body === undefined ? "GET" : "POST"),
        headers: {
            "content-type": "application/json",
            "x-forwarded-for": init.ip ?? "10.0.0.1",
            ...(init.cookie ? { cookie: init.cookie } : {}),
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    const text = await res.text();
    return { res, text, json: text ? JSON.parse(text) : null };
}

const owner = (over: Record<string, unknown> = {}) => ({
    setupToken: TOKEN,
    name: "Olive Owner",
    username: "olive",
    email: "olive@example.test",
    password: PASSWORD,
    ...over,
});

describe("first-run setup API", () => {
    before(async () => {
        assert.ok(adminUrl, "DATABASE_URL is required");
        const admin = new Client({ connectionString: adminUrl });
        await admin.connect();
        await admin.query(`CREATE DATABASE ${dbName}`);
        await admin.end();
        const url = new URL(adminUrl);
        url.pathname = `/${dbName}`;
        process.env.DATABASE_URL = url.toString();
        process.env.PROVIDER = "local";
        process.env.SETUP_TOKEN = TOKEN;

        const db = await import("@/services/db/postgres");
        pool = db.pool;
        await db.runMigrations();
        const { createAuth } = await import("@/services/auth");
        createAuth();
        const { initSetupToken } = await import("@/services/setupToken");
        initSetupToken(true);
        const { setupv1Endpoint } = await import("@/endpoints/v1/setup");
        const { startTestApp } = await import("./helpers/app");
        server = await startTestApp((app) => {
            app.set("trust proxy", true);
            app.use("/api/v1/setup", setupv1Endpoint.router);
        });
    });

    after(async () => {
        await server.close();
        await pool.end();
        const admin = new Client({ connectionString: adminUrl });
        await admin.connect();
        await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
        await admin.end();
    });

    it("reports a fresh instance and never leaks the token", async () => {
        const { res, text, json } = await call("/status");
        assert.equal(res.status, 200);
        assert.deepEqual(json, {
            needsSetup: true,
            setupTokenRequired: true,
            provider: "local",
            squareConnected: false,
            steps: {
                owner: false,
                store: false,
                provider: true,
                device: false,
            },
        });
        assert.ok(!text.includes(TOKEN));
    });

    it("guards store and complete without a session", async () => {
        assert.equal((await call("/store", { body: {} })).res.status, 401);
        assert.equal((await call("/complete", { body: {} })).res.status, 401);
    });

    it("rejects a missing or wrong token with 403", async () => {
        const missing = owner();
        delete (missing as Record<string, unknown>).setupToken;
        assert.equal((await call("/owner", { body: missing })).res.status, 403);
        const wrong = await call("/owner", {
            body: owner({ setupToken: "nope" }),
        });
        assert.equal(wrong.res.status, 403);
        assert.ok(!wrong.text.includes(TOKEN));
    });

    it("verifies the token without creating anything", async () => {
        const ok = await call("/verify-token", { body: { setupToken: TOKEN } });
        assert.equal(ok.res.status, 204);
        assert.equal(ok.text, "");
        const { rows } = await pool.query(
            `SELECT 1 FROM "tessellate-auth-user"`,
        );
        assert.equal(rows.length, 0);

        for (const bad of [{ setupToken: "nope" }, {}, { setupToken: 5 }]) {
            const r = await call("/verify-token", { body: bad });
            assert.equal(r.res.status, 403, JSON.stringify(bad));
            assert.equal(r.json.code, "BAD_TOKEN");
            assert.ok(!r.text.includes(TOKEN));
        }
    });

    it("shares the failure limiter between verify-token and owner", async () => {
        const ip = "10.0.0.77";
        for (let i = 0; i < 6; i++) {
            const r = await call("/verify-token", {
                body: { setupToken: "wrong" },
                ip,
            });
            assert.equal(r.res.status, 403);
        }
        for (let i = 0; i < 4; i++) {
            const r = await call("/owner", {
                body: owner({ setupToken: "wrong" }),
                ip,
            });
            assert.equal(r.res.status, 403);
        }
        const blocked = await call("/verify-token", {
            body: { setupToken: TOKEN },
            ip,
        });
        assert.equal(blocked.res.status, 429);
        assert.ok(blocked.json.message);
        // a correct token never counts as a failure
        const other = "10.0.0.78";
        for (let i = 0; i < 12; i++) {
            const r = await call("/verify-token", {
                body: { setupToken: TOKEN },
                ip: other,
            });
            assert.equal(r.res.status, 204);
        }
    });

    it("rejects invalid input with 400", async () => {
        for (const bad of [
            { password: "short" },
            { email: "not-an-email" },
            { username: "a b" },
            { name: "  " },
        ]) {
            const r = await call("/owner", { body: owner(bad) });
            assert.equal(r.res.status, 400, JSON.stringify(bad));
        }
    });

    it("rate limits repeated failed token attempts", async () => {
        const ip = "10.0.0.99";
        for (let i = 0; i < 10; i++) {
            const r = await call("/owner", {
                body: owner({ setupToken: "wrong" }),
                ip,
            });
            assert.equal(r.res.status, 403);
        }
        const blocked = await call("/owner", {
            body: owner({ setupToken: "wrong" }),
            ip,
        });
        assert.equal(blocked.res.status, 429);
        // Even the right token is refused for that client, others unaffected.
        assert.equal(
            (await call("/owner", { body: owner(), ip })).res.status,
            429,
        );
    });

    it("creates exactly one owner from parallel requests", async () => {
        const results = await Promise.all(
            Array.from({ length: 6 }, (_, i) =>
                call("/owner", {
                    body: owner({
                        username: `racer${i}`,
                        email: `racer${i}@example.test`,
                    }),
                    ip: `10.0.1.${i}`,
                }),
            ),
        );
        const statuses = results.map((r) => r.res.status).sort();
        assert.deepEqual(statuses, [201, 409, 409, 409, 409, 409]);
        const { rows } = await pool.query(
            `SELECT role, username FROM "tessellate-auth-user"`,
        );
        assert.equal(rows.length, 1);
        assert.equal(rows[0].role, "owner");

        const winner = results.find((r) => r.res.status === 201)!;
        assert.deepEqual(Object.keys(winner.json.user).sort(), [
            "email",
            "id",
            "name",
            "username",
        ]);
        assert.ok(!winner.text.includes("password"));
        ownerCookie = (winner.res.headers.get("set-cookie") ?? "").split(
            ";",
        )[0];
        assert.ok(ownerCookie, "owner is signed in");
    });

    it("answers 409 for a second owner, even with the right token", async () => {
        const r = await call("/owner", {
            body: owner({ email: "x@example.test" }),
        });
        assert.equal(r.res.status, 409);
        assert.equal(r.json.code, "USER_EXISTS");
        const v = await call("/verify-token", { body: { setupToken: TOKEN } });
        assert.equal(v.res.status, 409);
        assert.equal(v.json.code, "USER_EXISTS");
    });

    it("flips the owner step in the status", async () => {
        const { json } = await call("/status");
        assert.equal(json.steps.owner, true);
        assert.equal(json.setupTokenRequired, false);
        assert.equal(json.needsSetup, true);
    });

    it("refuses complete until a store exists", async () => {
        const r = await call("/complete", { body: {}, cookie: ownerCookie });
        assert.equal(r.res.status, 409);
        assert.deepEqual(r.json.missing, ["store"]);
        assert.equal(r.json.code, "MISSING_STEPS");
    });

    it("forbids store for a viewer", async () => {
        const { createAuth } = await import("@/services/auth");
        const auth = createAuth();
        await auth.api.createUser({
            body: {
                email: "viewer@example.test",
                password: PASSWORD,
                name: "Vi",
                role: "viewer",
            },
        });
        const { headers } = await auth.api.signInEmail({
            body: { email: "viewer@example.test", password: PASSWORD },
            returnHeaders: true,
        });
        viewerCookie = (headers.get("set-cookie") ?? "").split(";")[0];
        const r = await call("/store", {
            body: { name: "S", address: ADDRESS, currency: "CAD" },
            cookie: viewerCookie,
        });
        assert.equal(r.res.status, 403);
    });

    it("validates the store body", async () => {
        const bad = [
            { name: "", address: ADDRESS, currency: "CAD" },
            { name: "S", address: ADDRESS, currency: "ZZZ" },
            {
                name: "S",
                address: { ...ADDRESS, postal_code: "!" },
                currency: "CAD",
            },
            { name: "S", address: { country: "XX" }, currency: "CAD" },
            { name: "S", currency: "CAD" },
        ];
        for (const body of bad) {
            const r = await call("/store", { body, cookie: ownerCookie });
            assert.equal(r.res.status, 400, JSON.stringify(body));
        }
    });

    it("is 409 for the square provider", async () => {
        const { setActiveProvider } = await import("@/services/providers");
        await setActiveProvider("square");
        try {
            const r = await call("/store", {
                body: { name: "S", address: ADDRESS, currency: "CAD" },
                cookie: ownerCookie,
            });
            assert.equal(r.res.status, 409);
            assert.equal(r.json.code, "PROVIDER_SQUARE");
            assert.equal((await call("/status")).json.provider, "square");
            assert.equal((await call("/status")).json.steps.provider, false);
        } finally {
            await setActiveProvider("local");
        }
    });

    it("creates the store and lists it", async () => {
        const r = await call("/store", {
            body: { name: "Main Street", address: ADDRESS, currency: "CAD" },
            cookie: ownerCookie,
        });
        assert.equal(r.res.status, 201);
        assert.match(r.json.id, /^loc_[A-Za-z0-9_-]{12}$/);
        assert.equal(r.json.name, "Main Street");
        const { getLocations } = await import("@/services/db/locations");
        assert.deepEqual(
            (await getLocations()).map((l) => l.id),
            [r.json.id],
        );
        const { json } = await call("/status");
        assert.equal(json.steps.store, true);
        assert.equal(json.steps.device, false);
    });

    it("refuses a second location with STORE_EXISTS", async () => {
        const r = await call("/store", {
            body: { name: "Again", address: ADDRESS, currency: "CAD" },
            cookie: ownerCookie,
        });
        assert.equal(r.res.status, 409);
        assert.deepEqual(r.json, {
            message: "A location already exists",
            code: "STORE_EXISTS",
        });
        const { getLocations } = await import("@/services/db/locations");
        assert.equal((await getLocations()).length, 1);
    });

    it("completes setup and then locks every mutation", async () => {
        const done = await call("/complete", { body: {}, cookie: ownerCookie });
        assert.equal(done.res.status, 200);
        assert.deepEqual(done.json, { done: true });

        const locked = {
            message: "Setup is already complete",
            code: "SETUP_COMPLETE",
        };
        assert.deepEqual(
            (await call("/owner", { body: owner() })).json,
            locked,
        );
        const verify = await call("/verify-token", {
            body: { setupToken: TOKEN },
        });
        assert.equal(verify.res.status, 409);
        assert.deepEqual(verify.json, locked);
        assert.equal((await call("/owner", { body: owner() })).res.status, 409);
        const store = await call("/store", {
            body: { name: "S", address: ADDRESS, currency: "CAD" },
            cookie: ownerCookie,
        });
        assert.equal(store.res.status, 409);
        assert.deepEqual(store.json, locked);
        const again = await call("/complete", {
            body: {},
            cookie: ownerCookie,
        });
        assert.equal(again.res.status, 409);
        assert.deepEqual(again.json, locked);

        const status = await call("/status");
        assert.equal(status.res.status, 200);
        assert.equal(status.json.needsSetup, false);
        assert.deepEqual(status.json.steps, {
            owner: true,
            store: true,
            provider: true,
            device: false,
        });
    });
});
