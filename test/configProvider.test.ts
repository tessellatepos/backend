import "@/test/localProvider";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { pool } from "@/services/db/postgres";
import { getRedisClient } from "@/services/redis";
import { createAuth } from "@/services/auth";
import { createApp, mountApiRoutes } from "@/app";
import { getStoredProvider } from "@/services/db/configProvider";
import { getLocations } from "@/services/db/locations";
import { TessellatePluginRegistry } from "@/utils/registry/plugin/pluginRegistry";
import { migrateTestDb } from "./helpers/db";

const PASSWORD = "correct-horse-battery";

describe("provider switch and local storefronts", () => {
    const suffix = randomUUID().slice(0, 8);
    const cookies: Record<string, string> = {};
    const createdIds: string[] = [];
    let server: Server;
    let url: string;

    before(async () => {
        await migrateTestDb();
        const auth = createAuth();
        for (const role of ["viewer", "cashier", "manager", "owner"]) {
            const email = `${role}-${suffix}@example.test`;
            await auth.api.createUser({
                body: {
                    email,
                    password: PASSWORD,
                    name: role,
                    role: role as "owner",
                },
            });
            const { headers } = await auth.api.signInEmail({
                body: { email, password: PASSWORD },
                returnHeaders: true,
            });
            cookies[role] = (headers.get("set-cookie") ?? "").split(";")[0];
        }
        const app = createApp();
        app.locals.pluginRegistry = new TessellatePluginRegistry();
        mountApiRoutes(app, app.locals.pluginRegistry.apiRegistry);
        server = await new Promise((resolve) => {
            const s = app.listen(0, "127.0.0.1", () => resolve(s));
        });
        url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    after(async () => {
        // Leave the deployment on the local provider for other suites.
        await call("owner", "POST", "/api/v1/config/provider", {
            provider: "local",
        });
        for (const id of createdIds) {
            await pool.query(
                `DELETE FROM "tessellate-locations" WHERE id = $1`,
                [id],
            );
        }
        await pool.query(
            `DELETE FROM "tessellate-auth-user" WHERE email LIKE $1`,
            [`%-${suffix}@example.test`],
        );
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await pool.end();
        await (await getRedisClient())?.quit();
    });

    async function call(
        role: "owner" | "manager" | "cashier" | "viewer" | "none",
        method: string,
        path: string,
        body?: unknown,
    ) {
        const res = await fetch(url + path, {
            method,
            headers: {
                "content-type": "application/json",
                ...(role === "none" ? {} : { cookie: cookies[role] }),
            },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        const text = await res.text();
        return {
            status: res.status,
            body: text ? JSON.parse(text) : undefined,
        };
    }

    describe("GET and POST /api/v1/config/provider", () => {
        it("refuses callers without a session", async () => {
            assert.equal(
                (await call("none", "GET", "/api/v1/config/provider")).status,
                401,
            );
            assert.equal(
                (
                    await call("none", "POST", "/api/v1/config/provider", {
                        provider: "local",
                    })
                ).status,
                401,
            );
        });

        it("lets any role with settings:read read, but only owners switch", async () => {
            assert.equal(
                (await call("viewer", "GET", "/api/v1/config/provider")).status,
                403,
            );
            assert.equal(
                (await call("manager", "GET", "/api/v1/config/provider"))
                    .status,
                200,
            );
            assert.equal(
                (
                    await call("manager", "POST", "/api/v1/config/provider", {
                        provider: "square",
                    })
                ).status,
                403,
            );
            assert.equal(
                (
                    await call("cashier", "POST", "/api/v1/config/provider", {
                        provider: "square",
                    })
                ).status,
                403,
            );
        });

        it("rejects an unknown provider, including inherited property names", async () => {
            for (const provider of ["toast", "constructor", "", undefined]) {
                const res = await call(
                    "owner",
                    "POST",
                    "/api/v1/config/provider",
                    { provider },
                );
                assert.equal(res.status, 400, `provider ${String(provider)}`);
            }
        });

        it("switches provider and persists the choice", async () => {
            const switched = await call(
                "owner",
                "POST",
                "/api/v1/config/provider",
                {
                    provider: "square",
                },
            );
            assert.equal(switched.status, 200);
            assert.equal(switched.body.active, "square");
            assert.equal(await getStoredProvider(), "square");

            const read = await call("owner", "GET", "/api/v1/config/provider");
            assert.equal(read.body.active, "square");
            assert.equal(read.body.info.requiresTerminalDevice, true);

            const back = await call(
                "owner",
                "POST",
                "/api/v1/config/provider",
                {
                    provider: "local",
                },
            );
            assert.equal(back.body.active, "local");
            assert.equal(await getStoredProvider(), "local");
        });
    });

    describe("storefronts", () => {
        it("refuses callers without a session, and gates by role", async () => {
            assert.equal(
                (await call("none", "GET", "/api/v1/config/storefronts"))
                    .status,
                401,
            );
            assert.equal(
                (await call("viewer", "GET", "/api/v1/config/storefronts"))
                    .status,
                403,
            );
            assert.equal(
                (await call("manager", "GET", "/api/v1/config/storefronts"))
                    .status,
                200,
            );
            const body = { name: "Nope", currency: "CAD", country: "CA" };
            assert.equal(
                (await call("none", "POST", "/api/v1/config/storefronts", body))
                    .status,
                401,
            );
            assert.equal(
                (
                    await call(
                        "manager",
                        "POST",
                        "/api/v1/config/storefronts",
                        body,
                    )
                ).status,
                403,
            );
        });

        it("creates, lists and deletes a local storefront", async () => {
            const name = `Pop-up ${suffix}`;
            const created = await call(
                "owner",
                "POST",
                "/api/v1/config/storefronts",
                {
                    name,
                    currency: "CAD",
                    country: "CA",
                },
            );
            assert.equal(created.status, 201);
            assert.match(created.body.id, /^local-/);
            createdIds.push(created.body.id);

            const listed = await call(
                "owner",
                "GET",
                "/api/v1/config/storefronts",
            );
            assert.equal(listed.body.canManage, true);
            assert.ok(
                listed.body.storefronts.some(
                    (s: { id: string }) => s.id === created.body.id,
                ),
            );

            const fetched = await call(
                "owner",
                "GET",
                `/api/v1/locations/${created.body.id}`,
            );
            assert.equal(fetched.status, 200);
            assert.equal(fetched.body.name, name);

            const removed = await call(
                "owner",
                "DELETE",
                `/api/v1/config/storefronts/${created.body.id}`,
            );
            assert.equal(removed.status, 200);
            const after = await getLocations();
            assert.ok(!after.some((s) => s.id === created.body.id));
        });

        it("validates the storefront fields", async () => {
            const noName = await call(
                "owner",
                "POST",
                "/api/v1/config/storefronts",
                {
                    name: "  ",
                    currency: "CAD",
                    country: "CA",
                },
            );
            assert.equal(noName.status, 400);
            const badCurrency = await call(
                "owner",
                "POST",
                "/api/v1/config/storefronts",
                {
                    name: "X",
                    currency: "constructor",
                    country: "CA",
                },
            );
            assert.equal(badCurrency.status, 400);
        });

        it("refuses to create storefronts under the square provider", async () => {
            await call("owner", "POST", "/api/v1/config/provider", {
                provider: "square",
            });
            try {
                const res = await call(
                    "owner",
                    "POST",
                    "/api/v1/config/storefronts",
                    {
                        name: "Refused",
                        currency: "CAD",
                        country: "CA",
                    },
                );
                assert.equal(res.status, 400);
                const listed = await call(
                    "owner",
                    "GET",
                    "/api/v1/config/storefronts",
                );
                assert.equal(listed.body.canManage, false);
            } finally {
                await call("owner", "POST", "/api/v1/config/provider", {
                    provider: "local",
                });
            }
        });
    });
});
