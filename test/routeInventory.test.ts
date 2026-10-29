import "@/test/localProvider";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Express } from "express";
import { mkdirSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pool } from "@/services/db/postgres";
import { getRedisClient } from "@/services/redis";
import { createAuth } from "@/services/auth";
import { createApp, mountApiRoutes } from "@/app";
import { routes } from "@/utils/registry/api/routes";
import { TessellatePluginRegistry } from "@/utils/registry/plugin/pluginRegistry";
import {
    createConfigDevice,
    deleteConfigDevice,
    updateConfigDevice,
} from "@/services/db/configDevice";
import { issueDeviceToken } from "@/auth/deviceToken";
import { migrateTestDb } from "./helpers/db";

/**
 * Every route the real app registers must either be on this list or answer
 * 401 with no credentials. Adding a route without a guard fails the test;
 * adding it to this list is a deliberate decision to make it public.
 */
const PUBLIC = [
    // liveness and the API root
    "GET /health",
    "GET /",
    "GET /frontend",
    // plugin client bundles are public JS; plugin API calls are not
    "GET /plugins/:pluginName/assets/:filename",
    "GET /api/v1/plugins-discovery/",
    // first run and sign-in
    "GET /api/v1/setup/status",
    "POST /api/v1/setup/owner",
    "ALL /api/v1/auth/*splat",
    "GET /api/v1/auth-providers/public",
    // a device proves pairing in the body
    "POST /api/v1/auth/device-token",
    // a device with no credentials asks for (and refreshes) a pairing code
    "GET /api/v1/config/devices/pair-device/",
    "GET /api/v1/config/devices/pair-device/:pairingCode",
];

interface RouteEntry {
    method: string;
    path: string;
}

type Layer = {
    route?: { path: string; methods: Record<string, boolean> };
    handle: { stack?: Layer[] };
};

function methodsOf(route: NonNullable<Layer["route"]>): string[] {
    return route.methods._all
        ? ["ALL"]
        : Object.keys(route.methods).map((m) => m.toUpperCase());
}

/** Lists every (method, path) of the app, failing on routers it cannot place. */
function inventory(app: Express): RouteEntry[] {
    const found: RouteEntry[] = [];
    const known = new Map(routes.map((r) => [r.router, r]));
    const stack = (app.router as unknown as { stack: Layer[] }).stack;
    for (const layer of stack) {
        if (layer.route) {
            for (const method of methodsOf(layer.route)) {
                found.push({ method, path: layer.route.path });
            }
        } else if (layer.handle.stack) {
            const entry = known.get(layer.handle as never);
            assert.ok(entry, "a router is mounted that is not in routes.ts");
            const prefix = entry.override_default
                ? entry.route_path
                : `/api/${entry.version}${entry.route_path}`;
            for (const inner of layer.handle.stack) {
                // Router-level middleware (e.g. a router.use guard) has no route.
                assert.ok(
                    inner.route || !inner.handle.stack,
                    "nested routers are not supported",
                );
                if (!inner.route) continue;
                for (const method of methodsOf(inner.route)) {
                    found.push({
                        method,
                        path: `${prefix}/${inner.route.path}`.replace(
                            /\/{2,}/g,
                            "/",
                        ),
                    });
                }
            }
        }
    }
    return found;
}

const concrete = (path: string) => path.replace(/[:*]\w+/g, "x");

describe("route inventory", () => {
    const suffix = randomUUID().slice(0, 8);
    let server: Server;
    let url: string;
    let inventoryOfApp: RouteEntry[];
    const cookies: Record<string, string> = {};
    const deviceIds: string[] = [];

    before(async () => {
        await migrateTestDb();
        const auth = createAuth();
        for (const role of ["viewer", "cashier", "manager", "owner"]) {
            const email = `${role}-${suffix}@example.test`;
            await auth.api.createUser({
                body: {
                    email,
                    password: "correct-horse-battery",
                    name: role,
                    role: role as "owner",
                },
            });
            const { headers } = await auth.api.signInEmail({
                body: { email, password: "correct-horse-battery" },
                returnHeaders: true,
            });
            cookies[role] = (headers.get("set-cookie") ?? "").split(";")[0];
        }
        const app = createApp();
        app.locals.pluginRegistry = new TessellatePluginRegistry();
        mountApiRoutes(app, app.locals.pluginRegistry.apiRegistry);
        inventoryOfApp = inventory(app);
        server = await new Promise((resolve) => {
            const s = app.listen(0, "127.0.0.1", () => resolve(s));
        });
        url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    after(async () => {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        for (const id of deviceIds) await deleteConfigDevice(id);
        await pool.query(
            `DELETE FROM "tessellate-auth-user" WHERE email LIKE $1`,
            [`%-${suffix}@example.test`],
        );
        await pool.end();
        await (await getRedisClient())?.quit();
    });

    const call = (
        method: string,
        path: string,
        opts: { cookie?: string; token?: string; body?: unknown } = {},
    ) =>
        fetch(url + path, {
            method,
            headers: {
                "content-type": "application/json",
                ...(opts.cookie ? { cookie: opts.cookie } : {}),
                ...(opts.token
                    ? { authorization: `Bearer ${opts.token}` }
                    : {}),
            },
            body:
                opts.body === undefined ? undefined : JSON.stringify(opts.body),
        });

    it("finds the routes (guards against an empty walk)", () => {
        assert.ok(inventoryOfApp.length > 40, `${inventoryOfApp.length}`);
    });

    it("keeps the public list free of stale entries", () => {
        const present = new Set(
            inventoryOfApp.map((r) => `${r.method} ${r.path}`),
        );
        for (const entry of PUBLIC) {
            assert.ok(present.has(entry), `${entry} is not a route any more`);
        }
    });

    it("answers 401 to every non-public route with no credentials", async () => {
        const unguarded: string[] = [];
        for (const { method, path } of inventoryOfApp) {
            if (PUBLIC.includes(`${method} ${path}`)) continue;
            const res = await call(method, concrete(path));
            if (res.status !== 401) {
                unguarded.push(`${method} ${path} -> ${res.status}`);
            }
        }
        assert.deepEqual(unguarded, []);
    });

    it("guards plugin API dispatch but not plugin client assets", async () => {
        assert.equal((await call("GET", "/plugins/p/anything")).status, 401);
        assert.equal((await call("POST", "/plugins/p/anything")).status, 401);
        // authenticated, but no plugin claims it
        assert.equal(
            (
                await call("GET", "/plugins/p/anything", {
                    cookie: cookies.viewer,
                })
            ).status,
            404,
        );
        // public: an existing bundle is served without credentials
        const dir = path.join(
            process.cwd(),
            "plugins",
            "inventory-test",
            "dist",
        );
        mkdirSync(dir, { recursive: true });
        try {
            writeFileSync(path.join(dir, "client.js"), "// bundle");
            const res = await call(
                "GET",
                "/plugins/inventory-test/assets/client.js",
            );
            assert.equal(res.status, 200);
        } finally {
            rmSync(path.join(process.cwd(), "plugins", "inventory-test"), {
                recursive: true,
            });
            try {
                rmdirSync(path.join(process.cwd(), "plugins"));
            } catch {
                // other plugins live there
            }
        }
    });

    it("keeps the public routes reachable without credentials", async () => {
        for (const [method, path] of [
            ["GET", "/health"],
            ["GET", "/api/v1/setup/status"],
            ["GET", "/api/v1/auth-providers/public"],
            ["GET", "/api/v1/plugins-discovery/"],
        ]) {
            assert.equal((await call(method, path)).status, 200, path);
        }
    });

    it("answers 403 when the role lacks the scope", async () => {
        const cases: [string, string, string, string][] = [
            // [role, method, path, why]
            ["viewer", "POST", "/api/v1/config/devices/x", "devices:admin"],
            ["cashier", "DELETE", "/api/v1/config/devices/x", "devices:admin"],
            ["manager", "POST", "/api/v1/config/devices/x", "devices:admin"],
            ["cashier", "GET", "/api/v1/config/devices/", "devices:read"],
            ["cashier", "POST", "/api/v1/config/settings", "settings:admin"],
            ["manager", "POST", "/api/v1/config/settings", "settings:admin"],
            ["viewer", "GET", "/api/v1/config/settings", "settings:read"],
            ["viewer", "POST", "/api/v1/customers", "customers:write"],
            ["viewer", "PUT", "/api/v1/customers/x", "customers:write"],
            ["viewer", "DELETE", "/api/v1/customers/x", "customers:write"],
            ["cashier", "GET", "/api/v1/items/update/", "catalog:write"],
            ["viewer", "POST", "/api/v1/orders/create", "orders:write"],
            ["viewer", "POST", "/api/v1/orders/x/pay-cash", "orders:write"],
            [
                "cashier",
                "GET",
                "/api/v1/square/oauth/authorize",
                "settings:admin",
            ],
            ["cashier", "GET", "/api/v1/square/oauth/status", "settings:read"],
            [
                "manager",
                "POST",
                "/api/v1/square/oauth/revoke",
                "settings:admin",
            ],
            ["cashier", "GET", "/api/v1/auth-providers/", "settings:admin"],
            ["cashier", "POST", "/api/v1/setup/store", "settings:admin"],
            [
                "cashier",
                "DELETE",
                "/api/v1/auth/device-token/x",
                "devices:admin",
            ],
        ];
        for (const [role, method, path, scope] of cases) {
            const res = await call(method, path, { cookie: cookies[role] });
            assert.equal(
                res.status,
                403,
                `${role} ${method} ${path} (${scope})`,
            );
        }
    });

    it("lets roles that hold the scope through", async () => {
        for (const [role, path] of [
            ["viewer", "/api/v1/locations/"],
            ["viewer", "/api/v1/customers/"],
            ["cashier", "/api/v1/locations/"],
            ["manager", "/api/v1/config/settings"],
            ["manager", "/api/v1/config/devices/"],
            ["owner", "/api/v1/config/devices/"],
            ["owner", "/api/v1/auth-providers/"],
        ]) {
            const res = await call("GET", path, { cookie: cookies[role] });
            assert.equal(res.status, 200, `${role} ${path}`);
        }
    });

    it("never returns the encrypted Square tokens from settings", async () => {
        const res = await call("GET", "/api/v1/config/settings", {
            cookie: cookies.owner,
        });
        const text = await res.text();
        assert.ok(!text.includes("encryptedAccessToken"));
        assert.ok(!text.includes("encryptedRefreshToken"));
    });

    it("keeps a location-pinned device to its own location", async () => {
        const device = await createConfigDevice();
        deviceIds.push(device.id);
        await updateConfigDevice(device.id, {
            pairing_code: null,
            paired_at: new Date(),
            square_location: "L1",
        });
        const token = (await issueDeviceToken(device.id))!;
        const get = (path: string) => call("GET", path, { token });

        assert.equal((await get("/api/v1/items/by-location/L2")).status, 403);
        assert.equal((await get("/api/v1/items/by-location/L1")).status, 200);
        assert.equal((await get("/api/v1/locations/L2")).status, 403);
        assert.equal(
            (
                await call("POST", "/api/v1/orders/create", {
                    token,
                    body: { locationId: "L2", lineItems: [] },
                })
            ).status,
            403,
        );
        // a till has no administrative scopes
        assert.equal(
            (
                await call("POST", `/api/v1/config/devices/${device.id}`, {
                    token,
                    body: {},
                })
            ).status,
            403,
        );
        // and may only mint a Square token for itself
        assert.equal(
            (
                await call("POST", "/api/v1/square/oauth/mobile-token", {
                    token,
                    body: { deviceId: "someone-else" },
                })
            ).status,
            403,
        );
    });
});
