import "@/test/localProvider";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { z } from "zod";
import { bigintReplacer } from "@tessellatepos/sdk";
import { pool } from "@/services/db/postgres";
import { createLocalLocation, removeLocation } from "@/services/db/locations";
import { createCredential } from "@/services/credentials";
import { getRedisClient } from "@/services/redis";
import { createApp, mountApiRoutes } from "@/app";
import { routes } from "@/utils/registry/api/routes";
import { TessellatePluginRegistry } from "@/utils/registry/plugin/pluginRegistry";
import { migrateTestDb } from "./helpers/db";

// A probe router with one operation per behaviour under test. Its handlers
// stand in for internal routes, so each contract check is isolated.
const probe = express.Router();
probe.get("/bad", (_req, res) => {
    res.json({ id: 5 });
});
probe.get("/boom", () => {
    throw new Error("internal detail that must not leak");
});
probe.get("/missing", (_req, res) => {
    res.status(404).json({ message: "Thing not found" });
});
probe.get("/ok/:id", (req, res) => {
    // Handlers serialise bigints themselves, as the orders route does.
    res.status(201)
        .header("Content-Type", "application/json")
        .send(
            JSON.stringify({ id: req.params.id, amount: 7n }, bigintReplacer),
        );
});
probe.post("/echo", (req, res) => {
    res.json({ id: "x", note: req.body.note });
});

const probeRouter = {
    route_path: "/probe",
    version: "v1",
    router: probe,
    gateway: [
        {
            method: "GET" as const,
            path: "/bad",
            operationId: "probe.bad",
            scope: "catalog:read" as const,
            summary: "returns the wrong type",
            location: "none" as const,
            response: z.object({ id: z.string() }),
        },
        {
            method: "GET" as const,
            path: "/boom",
            operationId: "probe.boom",
            scope: "catalog:read" as const,
            summary: "throws",
            location: "none" as const,
            response: z.object({}),
        },
        {
            method: "GET" as const,
            path: "/missing",
            operationId: "probe.missing",
            scope: "catalog:read" as const,
            summary: "not found",
            location: "none" as const,
            response: z.object({}),
        },
        {
            method: "GET" as const,
            path: "/ok/:id",
            operationId: "probe.ok",
            scope: "catalog:read" as const,
            summary: "created with a bigint",
            location: "none" as const,
            response: z.object({ id: z.string(), amount: z.string() }),
        },
        {
            method: "POST" as const,
            path: "/echo",
            operationId: "probe.echo",
            scope: "orders:write" as const,
            summary: "echoes a note",
            location: "none" as const,
            request: z.strictObject({ note: z.string().max(10) }),
            response: z.object({ id: z.string(), note: z.string() }),
        },
    ],
};

const suffix = randomUUID().slice(0, 8);

after(async () => {
    await pool.end();
    await (await getRedisClient())?.quit();
});

describe("gateway contract: validation and failures", () => {
    let server: Server;
    let url: string;
    let loc: string;
    let auth: string;
    let clientId: string;

    before(async () => {
        await migrateTestDb();
        loc = (
            await createLocalLocation({
                name: `Contract ${suffix}`,
                currency: "CAD",
                country: "CA",
            })
        ).id;
        const made = await createCredential(
            {
                name: "Contract",
                scopes: ["catalog:read", "orders:write"] as never,
                location_ids: [loc],
            },
            "owner-user",
        );
        clientId = made.client_id;
        auth = `Basic ${Buffer.from(`${made.client_id}:${made.client_secret}`).toString("base64")}`;

        const app = createApp();
        app.locals.pluginRegistry = new TessellatePluginRegistry();
        const gatewayEndpoint = routes.find(
            (r) => r.route_path === "/gateway/v1",
        )!;
        // Mount the probe alongside the gateway so it is the only operation source.
        mountApiRoutes(app, app.locals.pluginRegistry.apiRegistry, [
            gatewayEndpoint,
            {
                ...probeRouter,
                router: probe,
                gateway: probeRouter.gateway,
            } as never,
        ]);
        server = await new Promise((resolve) => {
            const s = app.listen(0, "127.0.0.1", () => resolve(s));
        });
        url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    after(async () => {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await pool.query(
            `DELETE FROM "tessellate-api-credentials" WHERE id = $1`,
            [clientId],
        );
        await removeLocation(loc);
    });

    const call = (method: string, path: string, body?: unknown) =>
        fetch(url + path, {
            method,
            headers: {
                authorization: auth,
                "content-type": "application/json",
            },
            body: body === undefined ? undefined : JSON.stringify(body),
        });

    it("answers 500 when a handler's response does not match its schema, and does not echo it", async () => {
        const res = await call("GET", "/gateway/v1/probe/bad");
        assert.equal(res.status, 500);
        const text = await res.text();
        assert.equal(JSON.parse(text).code, "internal_error");
        assert.ok(!text.includes('"id":5'));
    });

    it("answers a generic 500 when a handler throws, never its message", async () => {
        const res = await call("GET", "/gateway/v1/probe/boom");
        assert.equal(res.status, 500);
        assert.ok(!(await res.text()).includes("must not leak"));
    });

    it("keeps an internal 404 as a 404 with a gateway error body", async () => {
        const res = await call("GET", "/gateway/v1/probe/missing");
        assert.equal(res.status, 404);
        assert.deepEqual(await res.json(), {
            message: "Thing not found",
            code: "not_found",
        });
    });

    it("keeps an internal 201 and sends bigints as digit strings", async () => {
        const res = await call("GET", `/gateway/v1/probe/ok/${suffix}`);
        assert.equal(res.status, 201);
        assert.deepEqual(await res.json(), { id: suffix, amount: "7" });
    });

    it("refuses a body with an undeclared field, and a value over the limit", async () => {
        const extra = await call("POST", "/gateway/v1/probe/echo", {
            note: "hi",
            secret: "x",
        });
        assert.equal(extra.status, 400);
        const long = await call("POST", "/gateway/v1/probe/echo", {
            note: "x".repeat(11),
        });
        assert.equal(long.status, 400);
        const bad = await call("POST", "/gateway/v1/probe/echo", {
            note: "hi",
        });
        assert.equal(bad.status, 201 - 201 + 200);
    });

    it("answers 400 with the failing field name and no value", async () => {
        const res = await call("POST", "/gateway/v1/probe/echo", {
            note: 12345,
        });
        assert.equal(res.status, 400);
        const body = (await res.json()) as { message: string };
        assert.match(body.message, /note/);
        assert.ok(!body.message.includes("12345"));
    });
});
