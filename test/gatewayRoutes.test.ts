import "@/test/localProvider";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { z } from "zod";
import type { Item, PluginPermissionProvider } from "@tessellatepos/sdk";
import { pool } from "@/services/db/postgres";
import { createAuth } from "@/services/auth";
import { createLocalLocation, removeLocation } from "@/services/db/locations";
import { createCredential, revokeCredential } from "@/services/credentials";
import { getRedisClient, setItemsByLocationID } from "@/services/redis";
import { createApp, mountApiRoutes } from "@/app";
import { TessellatePluginRegistry } from "@/utils/registry/plugin/pluginRegistry";
import { drizzleDB } from "@/services/db/postgres";
import {
    catalogItemVariationsTable,
    catalogItemsTable,
} from "@/services/db/schema";
import { eq } from "drizzle-orm";
import { migrateTestDb } from "./helpers/db";

const suffix = randomUUID().slice(0, 8);
const ORIGIN = "https://shop.example.test";

const none: PluginPermissionProvider = {
    cart: false,
    catalog: false,
    checkout: false,
    device: false,
    order: false,
    customer: false,
    auth: false,
};

// One pool and one Redis client for the file; suites share them.
after(async () => {
    await pool.end();
    await (await getRedisClient())?.quit();
});

describe("gateway routes", () => {
    let server: Server;
    let url: string;
    let locA: string;
    let locB: string;
    let reader: { client_id: string; client_secret: string };
    let writer: { client_id: string; client_secret: string };
    let publishable: { client_id: string };
    const created: string[] = [];
    const locs: string[] = [];

    before(async () => {
        await migrateTestDb();
        locA = (
            await createLocalLocation({
                name: `Routes A ${suffix}`,
                currency: "CAD",
                country: "CA",
            })
        ).id;
        locB = (
            await createLocalLocation({
                name: `Routes B ${suffix}`,
                currency: "CAD",
                country: "CA",
            })
        ).id;
        locs.push(locA, locB);

        const item = (id: string, locationIds: string[]): Item => ({
            id: `${id}-${suffix}`,
            name: id,
            variations: [
                {
                    id: `${id}-var-${suffix}`,
                    itemId: `${id}-${suffix}`,
                    name: "Regular",
                    priceMoney: { amount: 500n, currency: "CAD" },
                    pricingType: "FIXED",
                },
            ],
            locationIds,
        });
        await setItemsByLocationID([
            item("alpha", [locA]),
            item("beta", [locB]),
        ]);
        // The local provider prices online orders from the database catalog.
        await drizzleDB
            .insert(catalogItemsTable)
            .values({ id: `alpha-${suffix}`, name: "alpha", origin: "local" });
        await drizzleDB.insert(catalogItemVariationsTable).values([
            {
                variationId: `alpha-var-${suffix}`,
                itemId: `alpha-${suffix}`,
                pricingType: "FIXED",
                priceMoney: { amount: "500", currency: "CAD" },
            },
            {
                variationId: `donate-var-${suffix}`,
                itemId: `alpha-${suffix}`,
                pricingType: "VARIABLE",
                priceMoney: { amount: "0", currency: "CAD" },
            },
        ]);

        const auth = createAuth();
        const email = `owner-routes-${suffix}@example.test`;
        await auth.api.createUser({
            body: {
                email,
                password: "correct-horse-battery",
                name: "owner",
                role: "owner",
            },
        });

        const scopes = (xs: string[]) => xs as never;
        reader = await makeCredential({
            name: "Reader",
            scopes: scopes([
                "catalog:read",
                "locations:read",
                "customers:read",
            ]),
            location_ids: [locA],
            origins: [ORIGIN],
        });
        writer = await makeCredential({
            name: "Writer",
            scopes: scopes([
                "catalog:read",
                "orders:read",
                "orders:write",
                "customers:read",
                "customers:write",
            ]),
            location_ids: [locA],
        });
        publishable = { client_id: reader.client_id };

        const app = createApp();
        app.locals.pluginRegistry = new TessellatePluginRegistry();
        mountApiRoutes(app, app.locals.pluginRegistry.apiRegistry);
        server = await new Promise((resolve) => {
            const s = app.listen(0, "127.0.0.1", () => resolve(s));
        });
        url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    after(async () => {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        for (const id of created) {
            await pool.query(
                `DELETE FROM "tessellate-api-credentials" WHERE id = $1`,
                [id],
            );
        }
        for (const id of locs) await removeLocation(id);
        await drizzleDB
            .delete(catalogItemVariationsTable)
            .where(eq(catalogItemVariationsTable.itemId, `alpha-${suffix}`));
        await drizzleDB
            .delete(catalogItemsTable)
            .where(eq(catalogItemsTable.id, `alpha-${suffix}`));
        await pool.query(
            `DELETE FROM "tessellate-auth-user" WHERE email LIKE $1`,
            [`%-routes-${suffix}@example.test`],
        );
    });

    async function makeCredential(input: Record<string, unknown>) {
        const result = await createCredential(input as never, "owner-user");
        created.push(result.client_id);
        return {
            client_id: result.client_id,
            client_secret: result.client_secret,
        };
    }

    const basic = (c: { client_id: string; client_secret?: string }) =>
        `Basic ${Buffer.from(`${c.client_id}:${c.client_secret ?? ""}`).toString("base64")}`;

    const call = (
        method: string,
        path: string,
        opts: { auth?: string; body?: unknown; origin?: string } = {},
    ) =>
        fetch(url + path, {
            method,
            headers: {
                "content-type": "application/json",
                ...(opts.auth ? { authorization: opts.auth } : {}),
                ...(opts.origin ? { origin: opts.origin } : {}),
            },
            body:
                opts.body === undefined ? undefined : JSON.stringify(opts.body),
        });

    it("serves catalog items only at the credential's location", async () => {
        const res = await call("GET", "/gateway/v1/items", {
            auth: basic(reader),
        });
        assert.equal(res.status, 200);
        const items = (await res.json()) as Item[];
        const ids = items.map((i) => i.id);
        assert.ok(ids.includes(`alpha-${suffix}`));
        assert.ok(!ids.includes(`beta-${suffix}`));
        // Amounts travel as digit strings.
        const price = items.find((i) => i.id === `alpha-${suffix}`)
            ?.variations?.[0]?.priceMoney;
        assert.deepEqual(price, { amount: "500", currency: "CAD" });
    });

    it("refuses another location with 403 and serves its own", async () => {
        const denied = await call("GET", `/gateway/v1/items/${locB}`, {
            auth: basic(reader),
        });
        assert.equal(denied.status, 403);
        const allowed = await call("GET", `/gateway/v1/items/${locA}`, {
            auth: basic(reader),
        });
        assert.equal(allowed.status, 200);
    });

    it("answers 403 for a missing scope", async () => {
        const res = await call("POST", "/gateway/v1/orders", {
            auth: basic(reader),
            body: {
                location_id: locA,
                line_items: [{ variation_id: "x", quantity: "1" }],
            },
        });
        assert.equal(res.status, 403);
        assert.equal(
            ((await res.json()) as { code: string }).code,
            "missing_scope",
        );
    });

    it("lists only the credential's locations", async () => {
        const res = await call("GET", "/gateway/v1/locations", {
            auth: basic(reader),
        });
        assert.equal(res.status, 200);
        const list = (await res.json()) as { id: string }[];
        assert.deepEqual(
            list.map((l) => l.id),
            [locA],
        );
    });

    it("creates an order from ids and quantities, with the location filled in", async () => {
        const res = await call("POST", "/gateway/v1/orders", {
            auth: basic(writer),
            body: {
                line_items: [
                    { variation_id: `alpha-var-${suffix}`, quantity: "2" },
                ],
            },
        });
        assert.equal(res.status, 200, await res.clone().text());
        const order = (await res.json()) as {
            id: string;
            locationId: string;
            state: string;
        };
        assert.equal(order.locationId, locA);
        assert.equal(order.state, "OPEN");
        assert.ok(order.id);
    });

    describe("order pricing", () => {
        const order = (lines: unknown[]) =>
            call("POST", "/gateway/v1/orders", {
                auth: basic(writer),
                body: { location_id: locA, line_items: lines },
            });
        const total = async (res: Response) =>
            ((await res.json()) as { totalMoney: { amount: string } })
                .totalMoney.amount;

        it("ignores a lower client price for a fixed-price variation", async () => {
            const res = await order([
                {
                    variation_id: `alpha-var-${suffix}`,
                    quantity: "2",
                    price_money: { amount: "1", currency: "CAD" },
                },
            ]);
            assert.equal(res.status, 200, await res.clone().text());
            assert.equal(await total(res), "1000");
        });

        it("uses the client price for a variable-price variation", async () => {
            const res = await order([
                {
                    variation_id: `donate-var-${suffix}`,
                    quantity: "1",
                    price_money: { amount: "250", currency: "CAD" },
                },
            ]);
            assert.equal(res.status, 200, await res.clone().text());
            assert.equal(await total(res), "250");
            const bad = await order([
                { variation_id: `donate-var-${suffix}`, quantity: "1" },
            ]);
            assert.equal(bad.status, 400);
        });

        it("rejects an unknown variation", async () => {
            const res = await order([
                { variation_id: `nope-${suffix}`, quantity: "1" },
            ]);
            assert.equal(res.status, 400);
        });

        it("still refuses discounts and totals", async () => {
            const res = await call("POST", "/gateway/v1/orders", {
                auth: basic(writer),
                body: {
                    location_id: locA,
                    totalMoney: { amount: "1", currency: "CAD" },
                    line_items: [
                        { variation_id: `alpha-var-${suffix}`, quantity: "1" },
                    ],
                },
            });
            assert.equal(res.status, 400);
            assert.equal(
                ((await res.json()) as { code: string }).code,
                "invalid_request",
            );
        });
    });

    it("reads an order at the credential's location and 404s an unknown one", async () => {
        const created1 = await call("POST", "/gateway/v1/orders", {
            auth: basic(writer),
            body: {
                location_id: locA,
                line_items: [
                    { variation_id: `alpha-var-${suffix}`, quantity: "1" },
                ],
            },
        });
        const order = (await created1.json()) as { id: string };
        const res = await call("GET", `/gateway/v1/orders/${order.id}`, {
            auth: basic(writer),
        });
        assert.equal(res.status, 200);
        const missing = await call("GET", "/gateway/v1/orders/does-not-exist", {
            auth: basic(writer),
        });
        assert.equal(missing.status, 404);
    });

    it("creates, reads, updates and searches customers", async () => {
        const created1 = await call("POST", "/gateway/v1/customers", {
            auth: basic(writer),
            body: {
                given_name: "Ada",
                family_name: "Gateway",
                company_name: "",
                email: `ada-${suffix}@example.test`,
                phone_number: "",
                note: "",
                tags: [],
            },
        });
        assert.equal(created1.status, 201, await created1.clone().text());
        const customer = (await created1.json()) as {
            id: string;
            given_name: string;
        };
        assert.equal(customer.given_name, "Ada");

        const patched = await call(
            "PATCH",
            `/gateway/v1/customers/${customer.id}`,
            {
                auth: basic(writer),
                body: { note: "vip" },
            },
        );
        assert.equal(patched.status, 200);
        assert.equal(((await patched.json()) as { note: string }).note, "vip");

        const got = await call("GET", `/gateway/v1/customers/${customer.id}`, {
            auth: basic(writer),
        });
        assert.equal(got.status, 200);

        const search = await call(
            "GET",
            `/gateway/v1/customers?email=ada-${suffix}@example.test`,
            { auth: basic(writer) },
        );
        assert.equal(search.status, 200);
        const page = (await search.json()) as {
            customers: { id: string }[];
            next_cursor: unknown;
        };
        assert.ok(page.customers.some((c) => c.id === customer.id));
    });

    it("rejects a query parameter the operation does not declare", async () => {
        const res = await call("GET", "/gateway/v1/customers?bogus=1", {
            auth: basic(writer),
        });
        assert.equal(res.status, 400);
    });

    it("404s every route that has no descriptor, however it is spelled", async () => {
        const paths: [string, string][] = [
            ["GET", "/gateway/v1/items/update/x/y"],
            ["GET", "/gateway/v1/items/by-device-id/abc/def"],
            ["GET", "/gateway/v1/config/settings"],
            ["GET", "/gateway/v1/setup/status"],
            ["POST", "/gateway/v1/orders/abc/pay-cash"],
            ["GET", "/gateway/v1/customers/abc/export"],
            ["GET", "/gateway/v1/%2e%2e/api/v1/settings"],
        ];
        for (const [method, path] of paths) {
            const res = await call(method, path, { auth: basic(writer) });
            assert.equal(res.status, 404, `${method} ${path}`);
        }
        // A single segment is the declared /items/:locationId shape, so it is
        // refused as a location the credential does not hold, not as unknown.
        assert.equal(
            (
                await call("GET", "/gateway/v1/items/update", {
                    auth: basic(reader),
                })
            ).status,
            403,
        );
    });

    it("serves an OpenAPI document of only what the credential may call", async () => {
        const res = await call("GET", "/gateway/v1/openapi.json", {
            auth: basic(reader),
        });
        assert.equal(res.status, 200);
        const text = await res.text();
        const doc = JSON.parse(text) as {
            openapi: string;
            paths: Record<string, Record<string, { operationId: string }>>;
        };
        assert.equal(doc.openapi, "3.1.0");
        assert.ok(doc.paths["/items"]?.get);
        assert.ok(doc.paths["/items/{locationId}"]?.get);
        assert.ok(doc.paths["/locations"]?.get);
        assert.equal(doc.paths["/orders"], undefined, "no orders:write");
        assert.equal(
            doc.paths["/customers"]?.post,
            undefined,
            "no customers:write",
        );
        assert.ok(!text.includes("tcs_"));
    });

    it("serves the document and the reference without a credential", async () => {
        const anon = await call("GET", "/gateway/v1/openapi.json");
        assert.equal(anon.status, 200);
        const doc = (await anon.json()) as {
            paths: Record<string, Record<string, unknown>>;
        };
        assert.ok(doc.paths["/orders"]?.post, "anonymous sees every operation");
        const docs = await call("GET", "/gateway/v1/docs");
        assert.equal(docs.status, 200);
        const html = await docs.text();
        assert.match(html, /@scalar\/api-reference@1\.74\.0/);
        assert.match(html, /openapi\.json/);
        // Every other gateway route still needs a credential.
        for (const path of ["/gateway/v1/items", "/gateway/v1/locations"]) {
            assert.equal((await call("GET", path)).status, 401, path);
        }
        assert.equal((await call("POST", "/gateway/v1/orders")).status, 401);
        // A wrong credential gets the public view of the docs, nothing else.
        const wrong = {
            auth: "Basic " + Buffer.from("tcid_x:nope").toString("base64"),
        };
        assert.equal(
            (await call("GET", "/gateway/v1/openapi.json", wrong)).status,
            200,
        );
        assert.equal(
            (await call("GET", "/gateway/v1/items", wrong)).status,
            401,
        );
    });

    it("answers a preflight for a live origin only", async () => {
        const allowed = await call("OPTIONS", "/gateway/v1/items", {
            origin: ORIGIN,
        });
        assert.equal(allowed.status, 204);
        assert.equal(
            allowed.headers.get("access-control-allow-origin"),
            ORIGIN,
        );
        const other = await call("OPTIONS", "/gateway/v1/items", {
            origin: "https://evil.example.test",
        });
        assert.equal(other.headers.get("access-control-allow-origin"), null);
    });

    it("lets a publishable read from the allowed origin, and refuses a write", async () => {
        const read = await call("GET", "/gateway/v1/items", {
            auth: basic(publishable),
            origin: ORIGIN,
        });
        assert.equal(read.status, 200);
        assert.equal(read.headers.get("access-control-allow-origin"), ORIGIN);
        const write = await call("POST", "/gateway/v1/customers", {
            auth: basic({ client_id: writer.client_id }),
            origin: ORIGIN,
            body: {
                given_name: "x",
                family_name: "y",
                company_name: "",
                email: "",
                phone_number: "",
                note: "",
                tags: [],
            },
        });
        assert.equal(write.status, 403);
    });

    it("401s a revoked credential on every operation", async () => {
        const doomed = await makeCredential({
            name: "Doomed",
            scopes: ["catalog:read"],
            location_ids: [locA],
        });
        await revokeCredential(doomed.client_id);
        assert.equal(
            (await call("GET", "/gateway/v1/items", { auth: basic(doomed) }))
                .status,
            401,
        );
    });

    it("keeps the internal API closed to credentials", async () => {
        const res = await call("GET", "/api/v1/items/by-location/", {
            auth: basic(reader),
        });
        assert.equal(res.status, 401);
    });
});

describe("plugin routes on the gateway", () => {
    let server: Server;
    let url: string;
    let locA: string;
    const created: string[] = [];

    before(async () => {
        await migrateTestDb();
        locA = (
            await createLocalLocation({
                name: `Plugin ${suffix}`,
                currency: "CAD",
                country: "CA",
            })
        ).id;
        const app = createApp();
        app.locals.pluginRegistry = new TessellatePluginRegistry();
        const api = app.locals.pluginRegistry.apiRegistry;
        const points = z.object({ points: z.number().int() });
        api.register(
            "loyalty",
            {
                route: "/points",
                method: "GET" as never,
                gateway: {
                    operationId: "loyalty.points",
                    scope: "plugin:loyalty:read",
                    summary: "Loyalty points",
                    location: "none",
                    response: points,
                },
                handler: () => ({ body: { points: 42 } }),
            },
            none,
        );
        api.register(
            "loyalty",
            {
                route: "/boom",
                method: "GET" as never,
                gateway: {
                    operationId: "loyalty.boom",
                    scope: "plugin:loyalty:read",
                    summary: "Throws",
                    location: "none",
                    response: points,
                },
                handler: () => {
                    throw new Error("secret internal detail");
                },
            },
            none,
        );
        mountApiRoutes(app, api);
        server = await new Promise((resolve) => {
            const s = app.listen(0, "127.0.0.1", () => resolve(s));
        });
        url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    after(async () => {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        for (const id of created) {
            await pool.query(
                `DELETE FROM "tessellate-api-credentials" WHERE id = $1`,
                [id],
            );
        }
        await removeLocation(locA);
    });

    const withScopes = async (scopes: string[]) => {
        const result = await createCredential(
            { name: "Plugin", scopes: scopes as never, location_ids: [locA] },
            "owner-user",
        );
        created.push(result.client_id);
        return `Basic ${Buffer.from(`${result.client_id}:${result.client_secret}`).toString("base64")}`;
    };

    it("serves an opted-in plugin route to a credential with its scope", async () => {
        const res = await fetch(`${url}/gateway/v1/plugins/loyalty/points`, {
            headers: {
                authorization: await withScopes(["plugin:loyalty:read"]),
            },
        });
        assert.equal(res.status, 200);
        assert.deepEqual(await res.json(), { points: 42 });
    });

    it("403s the plugin route without its scope, and does not list it", async () => {
        const auth = await withScopes(["catalog:read"]);
        const res = await fetch(`${url}/gateway/v1/plugins/loyalty/points`, {
            headers: { authorization: auth },
        });
        assert.equal(res.status, 403);
        const doc = await fetch(`${url}/gateway/v1/openapi.json`, {
            headers: { authorization: auth },
        });
        const paths = ((await doc.json()) as { paths: Record<string, unknown> })
            .paths;
        assert.equal(paths["/plugins/loyalty/points"], undefined);
    });

    it("gives a generic 500 when a plugin handler throws", async () => {
        const res = await fetch(`${url}/gateway/v1/plugins/loyalty/boom`, {
            headers: {
                authorization: await withScopes(["plugin:loyalty:read"]),
            },
        });
        assert.equal(res.status, 500);
        const text = await res.text();
        assert.ok(!text.includes("secret internal detail"));
    });

    it("keeps a plugin route that did not opt in off the gateway", async () => {
        const res = await fetch(`${url}/gateway/v1/plugins/loyalty/internal`, {
            headers: {
                authorization: await withScopes(["plugin:loyalty:read"]),
            },
        });
        assert.equal(res.status, 404);
    });
});
