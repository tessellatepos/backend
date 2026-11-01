import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { pool } from "@/services/db/postgres";
import { AUTH_BASE_PATH, createAuth } from "@/services/auth";
import {
    SIGN_IN_MAX_FAILURES,
    authv1Endpoint,
    resetSignInLimits,
} from "@/endpoints/v1/auth";
import { migrateTestDb } from "./helpers/db";

/**
 * The sign-in rate limit must key on the address Express resolved from
 * TRUST_PROXY, never on a header the client picks.
 */

interface Running {
    url: string;
    server: Server;
}

function start(trustProxy: boolean | number): Promise<Running> {
    const app = express();
    app.set("trust proxy", trustProxy);
    app.use(express.json());
    app.use(AUTH_BASE_PATH, authv1Endpoint.router);
    return new Promise((resolve) => {
        const server = createServer(app).listen(0, "127.0.0.1", () =>
            resolve({
                server,
                url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
            }),
        );
    });
}

async function signIn(
    base: string,
    headers: Record<string, string>,
): Promise<number> {
    const res = await fetch(`${base}${AUTH_BASE_PATH}/sign-in/email`, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            origin: "http://localhost:5173",
            ...headers,
        },
        body: JSON.stringify({ email: "nobody@example.test", password: "x" }),
    });
    await res.arrayBuffer();
    return res.status;
}

async function attempts(
    base: string,
    headerFor: (i: number) => Record<string, string>,
    count = 8,
): Promise<number[]> {
    const out: number[] = [];
    for (let i = 0; i < count; i++) out.push(await signIn(base, headerFor(i)));
    return out;
}

describe("sign-in rate limit", () => {
    const original = process.env.AUTH_RATE_LIMIT;
    const running: Running[] = [];

    before(async () => {
        await migrateTestDb();
        // The suite helper turns rate limiting off; this suite needs it on.
        delete process.env.AUTH_RATE_LIMIT;
        createAuth();
    });

    after(async () => {
        if (original === undefined) delete process.env.AUTH_RATE_LIMIT;
        else process.env.AUTH_RATE_LIMIT = original;
        for (const r of running) {
            r.server.closeAllConnections();
            await new Promise((resolve) => r.server.close(resolve));
        }
        await pool.end();
    });

    it("is off when AUTH_RATE_LIMIT=off", () => {
        process.env.AUTH_RATE_LIMIT = "off";
        try {
            assert.equal(createAuth().options.rateLimit?.enabled, false);
        } finally {
            delete process.env.AUTH_RATE_LIMIT;
            createAuth();
        }
    });

    it("cannot be dodged by rotating x-forwarded-for with no trusted proxy", async () => {
        const r = await start(false);
        running.push(r);
        const statuses = await attempts(r.url, (i) => ({
            "x-forwarded-for": `203.0.113.${i + 1}`,
        }));
        assert.ok(statuses.includes(429), statuses.join(","));
        assert.ok(statuses.slice(0, 3).every((s) => s !== 429));
    });

    it("ignores a client-supplied client-ip header", async () => {
        const r = await start(false);
        running.push(r);
        const statuses = await attempts(r.url, (i) => ({
            "x-tessellate-client-ip": `198.51.100.${i + 1}`,
        }));
        assert.ok(statuses.includes(429), statuses.join(","));
    });

    it("with one trusted proxy, separates clients behind it and cannot be dodged by a spoofed left entry", async () => {
        const r = await start(1);
        running.push(r);
        // Same real client (last hop, appended by the proxy), rotating the
        // spoofable left entries: still one bucket.
        const same = await attempts(r.url, (i) => ({
            "x-forwarded-for": `10.9.9.${i + 1}, 192.0.2.50`,
        }));
        assert.ok(same.includes(429), same.join(","));
        // A different client behind the same proxy has its own bucket.
        const other = await signIn(r.url, {
            "x-forwarded-for": "192.0.2.77",
        });
        assert.notEqual(other, 429);
    });

    it("throttles failed password sign-ins per account across addresses", async () => {
        process.env.AUTH_RATE_LIMIT = "off";
        createAuth();
        resetSignInLimits();
        const r = await start(false);
        running.push(r);
        const post = async (email: string, ip: number) => {
            const res = await fetch(`${r.url}${AUTH_BASE_PATH}/sign-in/email`, {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    origin: "http://localhost:5173",
                    "x-forwarded-for": `203.0.113.${ip}`,
                },
                body: JSON.stringify({ email, password: "x" }),
            });
            await res.arrayBuffer();
            return res.status;
        };
        for (let i = 0; i < SIGN_IN_MAX_FAILURES; i++) {
            assert.notEqual(await post("Victim@Example.test", i), 429);
        }
        assert.equal(await post("victim@example.test", 99), 429);
        assert.notEqual(await post("other@example.test", 99), 429);
        resetSignInLimits();
        delete process.env.AUTH_RATE_LIMIT;
        createAuth();
    });
});
