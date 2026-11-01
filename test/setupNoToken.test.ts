import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import type { TestApp } from "./helpers/app";

// With SETUP_TOKEN unset the owner step needs no token at all. This file
// migrates its own throwaway database, as setup.test.ts does, and the env
// must be set before the app modules load (pg pool).
const dbName = `tessellate_notoken_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
const adminUrl = process.env.DATABASE_URL;
const PASSWORD = "correct-horse-battery";
const ADDRESS = {
    country: "CA",
    address_line_1: "1 Main St",
    locality: "Winnipeg",
    subdivision: "MB",
    postal_code: "R3C 1A1",
};

let server: TestApp;
let ownerCookie = "";
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
            "x-forwarded-for": init.ip ?? "10.1.0.1",
            ...(init.cookie ? { cookie: init.cookie } : {}),
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    const text = await res.text();
    return { res, text, json: text ? JSON.parse(text) : null };
}

const owner = (i: number) => ({
    name: `Owner ${i}`,
    username: `racer${i}`,
    email: `racer${i}@example.test`,
    password: PASSWORD,
});

describe("first-run setup with no SETUP_TOKEN", () => {
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
        delete process.env.SETUP_TOKEN;

        const db = await import("@/services/db/postgres");
        pool = db.pool;
        await db.runMigrations();
        const { createAuth } = await import("@/services/auth");
        createAuth();
        const { initSetupToken } = await import("@/services/setupToken");
        assert.equal(initSetupToken(true), false);
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

    it("reports that no token is required", async () => {
        const { res, json } = await call("/status");
        assert.equal(res.status, 200);
        assert.equal(json.setupTokenRequired, false);
        assert.equal(json.needsSetup, true);
        assert.equal(json.steps.owner, false);
    });

    it("verifies without any token, creating nothing", async () => {
        for (const body of [
            {},
            { setupToken: "anything" },
            { setupToken: 5 },
        ]) {
            const r = await call("/verify-token", { body });
            assert.equal(r.res.status, 204, JSON.stringify(body));
            assert.equal(r.text, "");
        }
        const { rows } = await pool.query(
            `SELECT 1 FROM "tessellate-auth-user"`,
        );
        assert.equal(rows.length, 0);
    });

    it("creates exactly one owner from parallel requests without a token", async () => {
        const results = await Promise.all(
            Array.from({ length: 6 }, (_, i) =>
                call("/owner", { body: owner(i), ip: `10.1.1.${i}` }),
            ),
        );
        const statuses = results.map((r) => r.res.status).sort();
        assert.deepEqual(statuses, [201, 409, 409, 409, 409, 409]);
        const { rows } = await pool.query(
            `SELECT role FROM "tessellate-auth-user"`,
        );
        assert.deepEqual(rows, [{ role: "owner" }]);

        const winner = results.find((r) => r.res.status === 201)!;
        ownerCookie = (winner.res.headers.get("set-cookie") ?? "").split(
            ";",
        )[0];
        assert.ok(ownerCookie, "owner is signed in");
    });

    it("answers 409 for a second owner and for verify-token afterwards", async () => {
        const again = await call("/owner", { body: owner(9), ip: "10.1.2.1" });
        assert.equal(again.res.status, 409);
        assert.equal(again.json.code, "USER_EXISTS");
        const verify = await call("/verify-token", { body: {} });
        assert.equal(verify.res.status, 409);
        assert.equal(verify.json.code, "USER_EXISTS");
    });

    it("shows the owner step done and no token required", async () => {
        const { json } = await call("/status");
        assert.equal(json.steps.owner, true);
        assert.equal(json.setupTokenRequired, false);
    });

    it("finishes setup with a store, as with a token", async () => {
        const store = await call("/store", {
            body: { name: "Main Street", address: ADDRESS, currency: "CAD" },
            cookie: ownerCookie,
        });
        assert.equal(store.res.status, 201);
        const done = await call("/complete", { body: {}, cookie: ownerCookie });
        assert.equal(done.res.status, 200);
        const { json } = await call("/status");
        assert.equal(json.needsSetup, false);
    });
});
