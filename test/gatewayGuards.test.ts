import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import express from "express";
import { eq } from "drizzle-orm";
import { drizzleDB, pool } from "@/services/db/postgres";
import { apiCredentialsTable } from "@/services/db/schema";
import { createLocalLocation, removeLocation } from "@/services/db/locations";
import {
    createCredential,
    recordCredentialUse,
    revokeCredential,
} from "@/services/credentials";
import { getRedisClient } from "@/services/redis";
import { installGatewayPrincipals } from "@/gateway/principal";
import {
    auditLine,
    decideLocation,
    gatewayOrigin,
    gatewayRateLimit,
    gatewayScope,
    requireGatewayCredential,
    sendGatewayError,
} from "@/gateway/guards";
import { takeToken } from "@/gateway/rateLimit";
import { migrateTestDb } from "./helpers/db";
import { startTestApp, type TestApp } from "./helpers/app";

const suffix = randomUUID().slice(0, 8);
const ORIGIN = "https://shop.example.test";

after(async () => {
    await pool.end();
    await (await getRedisClient())?.quit();
});

describe("decideLocation", () => {
    const allowed = ["A", "B"];
    it("does nothing for an operation not tied to a location", () => {
        assert.deepEqual(
            decideLocation("none", allowed, {
                params: {},
                query: {},
                body: {},
            }),
            { ok: true },
        );
    });

    it("accepts an allowed id and refuses another", () => {
        assert.deepEqual(
            decideLocation("path", allowed, {
                params: { locationId: "A" },
                query: {},
                body: undefined,
            }),
            { ok: true },
        );
        const refused = decideLocation("path", allowed, {
            params: { locationId: "Z" },
            query: {},
            body: undefined,
        });
        assert.equal(refused.ok, false);
        assert.equal(refused.ok === false && refused.status, 403);
    });

    it("reads the query and body fields for their locations", () => {
        assert.deepEqual(
            decideLocation("query", allowed, {
                params: {},
                query: { location_id: "B" },
                body: undefined,
            }),
            { ok: true },
        );
        const refused = decideLocation("body", allowed, {
            params: {},
            query: {},
            body: { location_id: "Z" },
        });
        assert.equal(refused.ok, false);
    });

    it("fills a missing body location when the credential has exactly one", () => {
        assert.deepEqual(
            decideLocation("body", ["only"], {
                params: {},
                query: {},
                body: {},
            }),
            { ok: true, fill: { field: "body", value: "only" } },
        );
    });

    it("requires a location when the credential has several and none is sent", () => {
        const decision = decideLocation("body", allowed, {
            params: {},
            query: {},
            body: {},
        });
        assert.equal(decision.ok, false);
        assert.equal(
            decision.ok === false && decision.code,
            "location_required",
        );
    });
});

describe("audit line", () => {
    it("holds who, what, outcome and latency, and nothing secret", () => {
        const line = auditLine({
            credentialId: "tcid_abc",
            operationId: "items.list",
            status: 200,
            latencyMs: 12,
        });
        assert.equal(
            line,
            "gateway credential=tcid_abc operation=items.list status=200 latency_ms=12",
        );
        assert.ok(!/tcs_|whsec_|Basic /.test(line));
    });
});

describe("token bucket", () => {
    const key = `gw:rl:test:${suffix}`;
    after(async () => {
        await (await getRedisClient()).del(key);
    });

    it("spends the burst, refuses, then refills at the steady rate", async () => {
        // 600 per minute is 10 per second: a capacity of 1 refills in 100 ms.
        assert.equal((await takeToken(key, 600, 1)).allowed, true);
        const denied = await takeToken(key, 600, 1);
        assert.equal(denied.allowed, false);
        assert.ok(denied.retryAfterMs > 0 && denied.retryAfterMs <= 100);
        await new Promise((r) => setTimeout(r, 150));
        assert.equal((await takeToken(key, 600, 1)).allowed, true);
    });
});

describe("gateway guards over HTTP", () => {
    let server: TestApp;
    let locA: string;
    let locB: string;
    const created: string[] = [];

    before(async () => {
        await migrateTestDb();
        // startTestApp skips createApp, so register the credential resolver here.
        installGatewayPrincipals();
        locA = (
            await createLocalLocation({
                name: `GA ${suffix}`,
                currency: "CAD",
                country: "CA",
            })
        ).id;
        locB = (
            await createLocalLocation({
                name: `GB ${suffix}`,
                currency: "CAD",
                country: "CA",
            })
        ).id;

        server = await startTestApp((app) => {
            const router = express.Router();
            const ok = (_req: express.Request, res: express.Response) => {
                res.json({ ok: true });
            };
            router.get(
                "/read/:locationId",
                requireGatewayCredential,
                gatewayOrigin("catalog:read"),
                gatewayScope("catalog:read"),
                gatewayRateLimit(),
                (req, res, next) => {
                    const allowedLocations = req.principal?.location_ids;
                    const decision = decideLocation(
                        "path",
                        Array.isArray(allowedLocations) ? allowedLocations : [],
                        {
                            params: req.params,
                            query: req.query as Record<string, unknown>,
                            body: undefined,
                        },
                    );
                    if (!decision.ok) {
                        sendGatewayError(
                            res,
                            decision.status,
                            decision.code,
                            decision.message,
                        );
                        return;
                    }
                    next();
                },
                ok,
            );
            router.post(
                "/write",
                requireGatewayCredential,
                gatewayOrigin("orders:write"),
                gatewayScope("orders:write"),
                gatewayRateLimit(),
                ok,
            );
            app.use("/gateway/v1", router);
        });
    });

    after(async () => {
        await server.close();
        for (const id of created) {
            await pool.query(
                `DELETE FROM "tessellate-api-credentials" WHERE id = $1`,
                [id],
            );
        }
        await removeLocation(locA);
        await removeLocation(locB);
    });

    async function make(overrides: Record<string, unknown> = {}) {
        const result = await createCredential(
            {
                name: "Guards",
                scopes: ["catalog:read", "orders:write"],
                location_ids: [locA],
                origins: [ORIGIN],
                ...overrides,
            } as never,
            "owner-user",
        );
        created.push(result.client_id);
        return result;
    }

    const basic = (id: string, secret: string) =>
        `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`;

    const call = (
        method: string,
        path: string,
        headers: Record<string, string> = {},
    ) =>
        fetch(server.url + path, {
            method,
            headers: { "content-type": "application/json", ...headers },
            body: method === "POST" ? "{}" : undefined,
        });

    it("401 with no credential, and a challenge", async () => {
        const res = await call("GET", `/gateway/v1/read/${locA}`);
        assert.equal(res.status, 401);
        assert.match(res.headers.get("www-authenticate") ?? "", /Basic/);
    });

    it("401 for a wrong secret and never echoes it", async () => {
        const result = await make();
        const res = await call("GET", `/gateway/v1/read/${locA}`, {
            authorization: basic(result.client_id, "tcs_wrong"),
        });
        assert.equal(res.status, 401);
        assert.ok(!(await res.text()).includes("tcs_wrong"));
    });

    it("403 when the credential lacks the scope", async () => {
        const result = await make({ scopes: ["catalog:read"] });
        const res = await call("POST", "/gateway/v1/write", {
            authorization: basic(result.client_id, result.client_secret),
        });
        assert.equal(res.status, 403);
        assert.equal(
            ((await res.json()) as { code: string }).code,
            "missing_scope",
        );
    });

    it("lets a server with the secret read from any origin, with no CORS header", async () => {
        const result = await make();
        const res = await call("GET", `/gateway/v1/read/${locA}`, {
            authorization: basic(result.client_id, result.client_secret),
        });
        assert.equal(res.status, 200);
        assert.equal(res.headers.get("access-control-allow-origin"), null);
    });

    it("lets a publishable read from an allowed origin, with CORS for that origin only", async () => {
        const result = await make();
        const res = await call("GET", `/gateway/v1/read/${locA}`, {
            authorization: basic(result.client_id, ""),
            origin: ORIGIN,
        });
        assert.equal(res.status, 200);
        assert.equal(res.headers.get("access-control-allow-origin"), ORIGIN);
    });

    it("refuses a publishable read from another origin or with no origin", async () => {
        const result = await make();
        const other = await call("GET", `/gateway/v1/read/${locA}`, {
            authorization: basic(result.client_id, ""),
            origin: "https://evil.example.test",
        });
        assert.equal(other.status, 403);
        assert.equal(
            ((await other.json()) as { code: string }).code,
            "origin_not_allowed",
        );
        const none = await call("GET", `/gateway/v1/read/${locA}`, {
            authorization: basic(result.client_id, ""),
        });
        assert.equal(none.status, 403);
    });

    it("refuses a write with only the client id, even from an allowed origin", async () => {
        const result = await make();
        const res = await call("POST", "/gateway/v1/write", {
            authorization: basic(result.client_id, ""),
            origin: ORIGIN,
        });
        assert.equal(res.status, 403);
        assert.equal(
            ((await res.json()) as { code: string }).code,
            "secret_required",
        );
    });

    it("allows a write with the secret", async () => {
        const result = await make();
        const res = await call("POST", "/gateway/v1/write", {
            authorization: basic(result.client_id, result.client_secret),
        });
        assert.equal(res.status, 200);
    });

    it("refuses a location outside the credential's locations", async () => {
        const result = await make();
        const res = await call("GET", `/gateway/v1/read/${locB}`, {
            authorization: basic(result.client_id, result.client_secret),
        });
        assert.equal(res.status, 403);
        assert.equal(
            ((await res.json()) as { code: string }).code,
            "location_forbidden",
        );
        const inside = await call("GET", `/gateway/v1/read/${locA}`, {
            authorization: basic(result.client_id, result.client_secret),
        });
        assert.equal(inside.status, 200);
    });

    it("answers 429 with Retry-After once the credential's budget is spent", async () => {
        const result = await make({ rate_limit_per_minute: 2 });
        const headers = {
            authorization: basic(result.client_id, result.client_secret),
        };
        assert.equal(
            (await call("GET", `/gateway/v1/read/${locA}`, headers)).status,
            200,
        );
        assert.equal(
            (await call("GET", `/gateway/v1/read/${locA}`, headers)).status,
            200,
        );
        const limited = await call("GET", `/gateway/v1/read/${locA}`, headers);
        assert.equal(limited.status, 429);
        assert.ok(Number(limited.headers.get("retry-after")) >= 1);
        assert.equal(
            ((await limited.json()) as { code: string }).code,
            "rate_limited",
        );
    });

    it("401 for a revoked credential, even with the right secret", async () => {
        const result = await make();
        await revokeCredential(result.client_id);
        const res = await call("GET", `/gateway/v1/read/${locA}`, {
            authorization: basic(result.client_id, result.client_secret),
        });
        assert.equal(res.status, 401);
    });

    it("401 for an expired credential", async () => {
        const result = await make({
            expires_at: new Date(Date.now() + 1500).toISOString(),
        });
        const headers = {
            authorization: basic(result.client_id, result.client_secret),
        };
        assert.equal(
            (await call("GET", `/gateway/v1/read/${locA}`, headers)).status,
            200,
        );
        await new Promise((r) => setTimeout(r, 1600));
        assert.equal(
            (await call("GET", `/gateway/v1/read/${locA}`, headers)).status,
            401,
        );
    });

    it("never returns the secret in any error body", async () => {
        const result = await make({ scopes: ["catalog:read"] });
        const res = await call("POST", "/gateway/v1/write", {
            authorization: basic(result.client_id, result.client_secret),
        });
        assert.ok(!(await res.text()).includes(result.client_secret));
    });
});

describe("recording credential use", () => {
    let locId: string;
    before(async () => {
        await migrateTestDb();
        locId = (
            await createLocalLocation({
                name: `Use ${suffix}`,
                currency: "CAD",
                country: "CA",
            })
        ).id;
    });
    after(async () => {
        await removeLocation(locId);
    });

    it("writes last_used_at at most once a minute", async () => {
        const result = await createCredential(
            { name: "Use", scopes: ["catalog:read"], location_ids: [locId] },
            "owner-user",
        );
        const t0 = Date.now() + 1_000_000;
        await recordCredentialUse(result.client_id, t0);
        const [first] = await drizzleDB
            .select({ at: apiCredentialsTable.last_used_at })
            .from(apiCredentialsTable)
            .where(eq(apiCredentialsTable.id, result.client_id));
        await recordCredentialUse(result.client_id, t0 + 10_000);
        const [second] = await drizzleDB
            .select({ at: apiCredentialsTable.last_used_at })
            .from(apiCredentialsTable)
            .where(eq(apiCredentialsTable.id, result.client_id));
        assert.ok(first.at);
        assert.equal(second.at?.getTime(), first.at.getTime());
        await pool.query(
            `DELETE FROM "tessellate-api-credentials" WHERE id = $1`,
            [result.client_id],
        );
    });
});
