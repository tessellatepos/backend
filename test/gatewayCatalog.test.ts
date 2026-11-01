import "@/test/localProvider";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { inArray, like } from "drizzle-orm";
import type { Item } from "@tessellatepos/sdk";
import { drizzleDB, pool } from "@/services/db/postgres";
import { createAuth } from "@/services/auth";
import { createLocalLocation, removeLocation } from "@/services/db/locations";
import { createCredential } from "@/services/credentials";
import { getCatalogByLocation } from "@/services/db/catalog";
import {
    catalogCategoriesTable,
    catalogItemCategoriesTable,
    catalogItemLocationsTable,
    catalogItemVariationsTable,
    catalogItemsTable,
    ordersTable,
} from "@/services/db/schema";
import { getRedisClient, setItemsByLocationID } from "@/services/redis";
import { createApp, mountApiRoutes } from "@/app";
import { ordersv1Endpoint } from "@/endpoints/v1/orders";
import { TessellatePluginRegistry } from "@/utils/registry/plugin/pluginRegistry";
import { decodeCursor, encodeCursor } from "@/services/onlineCatalog";
import { migrateTestDb } from "./helpers/db";

const suffix = randomUUID().slice(0, 8);
const ORIGIN = "https://shop.example.test";
const id = (name: string) => `gc-${suffix}-${name}`;

after(async () => {
    await pool.end();
    await (await getRedisClient())?.quit();
});

interface Page {
    items: Item[];
    next_cursor: string | null;
}

describe("gateway online catalog", () => {
    let server: Server;
    let url: string;
    let locA: string;
    let locB: string;
    let readerA: { client_id: string; client_secret: string };
    let readerAB: { client_id: string; client_secret: string };
    let writerA: { client_id: string; client_secret: string };
    const credentials: string[] = [];
    const locations: string[] = [];
    const orderIds: string[] = [];
    const itemIds = new Set<string>();
    let cacheKeysToDrop: string[] = [];

    /**
     * Inserts an item and its variations into Postgres.
     * @param name short id of the item
     * @param options its channels, variations, locations and category
     */
    async function insertItem(
        name: string,
        options: {
            channels?: string[];
            locations: string[];
            category?: string;
            variations?: {
                channels?: string[] | null;
                sku?: string;
                overrides?: unknown;
            }[];
        },
    ) {
        const itemId = id(name);
        itemIds.add(itemId);
        await drizzleDB.insert(catalogItemsTable).values({
            id: itemId,
            name: `Item ${name}`,
            origin: "local",
            ...(options.channels ? { channels: options.channels } : {}),
        });
        const variations = options.variations ?? [{}];
        await drizzleDB.insert(catalogItemVariationsTable).values(
            variations.map((v, index) => ({
                variationId: `${itemId}-v${index}`,
                itemId,
                name: `Var ${index}`,
                sku: v.sku ?? null,
                ordinal: String(index),
                pricingType: "FIXED" as const,
                priceMoney: { amount: "500", currency: "CAD" },
                channels: v.channels ?? null,
                locationOverrides: v.overrides ?? null,
            })),
        );
        await drizzleDB
            .insert(catalogItemLocationsTable)
            .values(options.locations.map((l) => ({ itemId, locationId: l })));
        if (options.category) {
            await drizzleDB
                .insert(catalogItemCategoriesTable)
                .values({ itemId, categoryId: options.category });
        }
    }

    /** Rebuilds the cache entries for this file's items from Postgres. */
    async function refresh() {
        const { items } = await getCatalogByLocation(undefined, drizzleDB);
        const mine = items.filter((item) => itemIds.has(item.id));
        await setItemsByLocationID(mine);
        cacheKeysToDrop = [...new Set([...cacheKeysToDrop, ...itemIds])];
    }

    before(async () => {
        await migrateTestDb();
        locA = (
            await createLocalLocation({
                name: `Online A ${suffix}`,
                currency: "CAD",
                country: "CA",
            })
        ).id;
        locB = (
            await createLocalLocation({
                name: `Online B ${suffix}`,
                currency: "CAD",
                country: "CA",
            })
        ).id;
        locations.push(locA, locB);

        await drizzleDB.insert(catalogCategoriesTable).values([
            { id: id("cat-hot"), name: "Hot", origin: "local" },
            {
                id: id("cat-tea"),
                name: "Tea",
                parentCategoryId: id("cat-hot"),
                origin: "local",
            },
            { id: id("cat-pos"), name: "PosOnly", origin: "local" },
        ]);

        const overrides = [
            {
                locationId: locB,
                priceMoney: { amount: "999", currency: "CAD" },
            },
            {
                locationId: locA,
                priceMoney: { amount: "450", currency: "CAD" },
            },
        ];
        // Online at A, in id order: n01, n03, n04, n05, n06, n08.
        await insertItem("n01", { channels: ["online"], locations: [locA] });
        await insertItem("n02", { locations: [locA] });
        await insertItem("n03", {
            channels: ["pos", "online"],
            locations: [locA],
            category: id("cat-tea"),
        });
        await insertItem("n04", { channels: ["online"], locations: [locA] });
        await insertItem("n05", { channels: ["online"], locations: [locA] });
        await insertItem("n06", { channels: ["online"], locations: [locA] });
        await insertItem("n07", {
            channels: ["online"],
            locations: [locA],
            variations: [{ channels: ["pos"] }],
        });
        await insertItem("n08", {
            channels: ["online"],
            locations: [locA, locB],
            variations: [
                { channels: ["pos"], sku: `HIDDEN-${suffix}` },
                { sku: `SHOWN-${suffix}`, overrides },
            ],
        });
        await insertItem("nb1", { channels: ["online"], locations: [locB] });
        await insertItem("npos", {
            channels: ["pos"],
            locations: [locA],
            category: id("cat-pos"),
        });
        await refresh();

        const auth = createAuth();
        await auth.api.createUser({
            body: {
                email: `owner-gc-${suffix}@example.test`,
                password: "correct-horse-battery",
                name: "owner",
                role: "owner",
            },
        });

        const make = async (input: Record<string, unknown>) => {
            const result = await createCredential(input as never, "owner-user");
            credentials.push(result.client_id);
            return {
                client_id: result.client_id,
                client_secret: result.client_secret,
            };
        };
        const readScopes = ["catalog:read", "locations:read"] as never;
        readerA = await make({
            name: "Reader A",
            scopes: readScopes,
            location_ids: [locA],
            origins: [ORIGIN],
        });
        readerAB = await make({
            name: "Reader AB",
            scopes: readScopes,
            location_ids: [locA, locB],
            origins: [ORIGIN],
        });
        writerA = await make({
            name: "Web Store",
            scopes: ["catalog:read", "orders:read", "orders:write"] as never,
            location_ids: [locA],
            origins: [ORIGIN],
        });

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
        const ids = [...itemIds];
        for (const orderId of orderIds) {
            await pool.query(
                `DELETE FROM "tessellate-orders" WHERE reference_id = $1`,
                [orderId],
            );
        }
        await drizzleDB
            .delete(catalogItemCategoriesTable)
            .where(inArray(catalogItemCategoriesTable.itemId, ids));
        await drizzleDB
            .delete(catalogItemLocationsTable)
            .where(inArray(catalogItemLocationsTable.itemId, ids));
        await drizzleDB
            .delete(catalogItemVariationsTable)
            .where(inArray(catalogItemVariationsTable.itemId, ids));
        await drizzleDB
            .delete(catalogItemsTable)
            .where(inArray(catalogItemsTable.id, ids));
        await drizzleDB
            .delete(catalogCategoriesTable)
            .where(like(catalogCategoriesTable.id, `gc-${suffix}-%`));
        const redis = await getRedisClient();
        for (const itemId of cacheKeysToDrop) {
            await redis.del(`square:item:${itemId}`);
            await redis.sRem("square:items:all", itemId);
            for (const loc of locations) {
                await redis.sRem(`square:items:location:${loc}`, itemId);
            }
        }
        for (const clientId of credentials) {
            await pool.query(
                `DELETE FROM "tessellate-api-credentials" WHERE id = $1`,
                [clientId],
            );
        }
        for (const loc of locations) await removeLocation(loc);
        await pool.query(
            `DELETE FROM "tessellate-auth-user" WHERE email LIKE $1`,
            [`%-gc-${suffix}@example.test`],
        );
    });

    const basic = (c: { client_id: string; client_secret?: string }) =>
        `Basic ${Buffer.from(`${c.client_id}:${c.client_secret ?? ""}`).toString("base64")}`;

    const get = (
        path: string,
        who: { client_id: string; client_secret?: string },
        headers: Record<string, string> = {},
    ) =>
        fetch(url + path, {
            headers: { authorization: basic(who), ...headers },
        });

    const page = async (
        path: string,
        who: { client_id: string; client_secret?: string },
    ) => {
        const res = await get(path, who);
        assert.equal(res.status, 200, await res.clone().text());
        return (await res.json()) as Page;
    };

    const ours = (items: Item[]) =>
        items.filter((i) => itemIds.has(i.id)).map((i) => i.id);

    it("gives a new item the pos channel by default and does not sell it online", async () => {
        const [row] = await drizzleDB
            .select({ channels: catalogItemsTable.channels })
            .from(catalogItemsTable)
            .where(inArray(catalogItemsTable.id, [id("n02")]));
        assert.deepEqual(row.channels, ["pos"]);
        const all = await page("/gateway/v1/items?limit=200", readerA);
        assert.ok(!ours(all.items).includes(id("n02")));
    });

    it("returns online items at the credential's locations only", async () => {
        const all = await page("/gateway/v1/items?limit=200", readerA);
        assert.deepEqual(ours(all.items), [
            id("n01"),
            id("n03"),
            id("n04"),
            id("n05"),
            id("n06"),
            id("n08"),
        ]);
        for (const item of all.items) {
            assert.ok(item.channels?.includes("online"));
        }
    });

    it("keeps only online variations and hides other locations' data", async () => {
        const all = await page("/gateway/v1/items?limit=200", readerA);
        const n08 = all.items.find((i) => i.id === id("n08"))!;
        assert.deepEqual(
            n08.variations?.map((v) => v.sku),
            [`SHOWN-${suffix}`],
        );
        assert.deepEqual(n08.locationIds, [locA]);
        assert.deepEqual(n08.variations?.[0].channels, ["online"]);
        assert.deepEqual(
            n08.variations?.[0].locationOverrides?.map((o) => o.locationId),
            [locA],
        );
        assert.deepEqual(n08.variations?.[0].priceMoney, {
            amount: "500",
            currency: "CAD",
        });
        const wide = await page("/gateway/v1/items?limit=200", readerAB);
        const wideN08 = wide.items.find((i) => i.id === id("n08"))!;
        assert.deepEqual(
            wideN08.locationIds?.slice().sort(),
            [locA, locB].sort(),
        );
        assert.ok(ours(wide.items).includes(id("nb1")));
    });

    describe("pagination", () => {
        const walk = async (limit: number, between?: () => Promise<void>) => {
            const seen: string[] = [];
            let cursor: string | null = null;
            let first = true;
            do {
                const query: string = `limit=${limit}${cursor ? `&cursor=${cursor}` : ""}`;
                const result = await page(
                    `/gateway/v1/items?${query}`,
                    readerA,
                );
                assert.ok(result.items.length <= limit);
                seen.push(...ours(result.items));
                cursor = result.next_cursor;
                if (first && between) await between();
                first = false;
            } while (cursor);
            return seen;
        };

        it("walks every item once, in order, with an opaque cursor", async () => {
            const seen = await walk(2);
            assert.deepEqual(seen, [
                id("n01"),
                id("n03"),
                id("n04"),
                id("n05"),
                id("n06"),
                id("n08"),
            ]);
            const first = await page("/gateway/v1/items?limit=2", readerA);
            assert.equal(first.items.length, 2);
            assert.match(first.next_cursor ?? "", /^[A-Za-z0-9_-]+$/);
            const last = await page(
                `/gateway/v1/items?limit=200&cursor=${first.next_cursor}`,
                readerA,
            );
            assert.equal(last.next_cursor, null);
        });

        it("does not repeat or skip an item when others come and go between pages", async () => {
            const seen = await walk(2, async () => {
                // One item before the cursor appears, one after; one later
                // item disappears.
                await insertItem("n00", {
                    channels: ["online"],
                    locations: [locA],
                });
                await insertItem("n07z", {
                    channels: ["online"],
                    locations: [locA],
                });
                await drizzleDB
                    .update(catalogItemsTable)
                    .set({ channels: ["pos"] })
                    .where(inArray(catalogItemsTable.id, [id("n05")]));
                await refresh();
            });
            assert.equal(new Set(seen).size, seen.length, "no repeats");
            for (const stable of ["n01", "n03", "n04", "n06", "n08"]) {
                assert.ok(seen.includes(id(stable)), `${stable} not skipped`);
            }
            assert.ok(!seen.includes(id("n00")), "before the cursor");
            assert.ok(seen.includes(id("n07z")), "after the cursor");

            await drizzleDB
                .update(catalogItemsTable)
                .set({ channels: ["online"] })
                .where(inArray(catalogItemsTable.id, [id("n05")]));
            await drizzleDB
                .update(catalogItemsTable)
                .set({ channels: ["pos"] })
                .where(inArray(catalogItemsTable.id, [id("n00"), id("n07z")]));
            await refresh();
        });

        it("refuses a cursor it did not issue and a bad limit", async () => {
            for (const bad of [
                "cursor=not-a-cursor",
                `cursor=${Buffer.from("{}").toString("base64url")}`,
                "limit=0",
                "limit=201",
                "limit=abc",
                "bogus=1",
            ]) {
                const res = await get(`/gateway/v1/items?${bad}`, readerA);
                assert.equal(res.status, 400, bad);
            }
        });

        it("encodes and decodes a position", () => {
            assert.equal(decodeCursor(encodeCursor("x-1")), "x-1");
        });
    });

    describe("caching", () => {
        it("sends an ETag and Cache-Control, and answers 304 to a matching If-None-Match", async () => {
            const first = await get("/gateway/v1/items?limit=3", readerA);
            assert.equal(first.status, 200);
            const etag = first.headers.get("etag");
            assert.match(etag ?? "", /^"[A-Za-z0-9_-]+"$/);
            assert.equal(
                first.headers.get("cache-control"),
                "private, max-age=60",
            );
            assert.match(first.headers.get("vary") ?? "", /Authorization/);
            const body = await first.text();

            const same = await get("/gateway/v1/items?limit=3", readerA, {
                "if-none-match": etag!,
            });
            assert.equal(same.status, 304);
            assert.equal(await same.text(), "");
            assert.equal(same.headers.get("etag"), etag);

            const weak = await get("/gateway/v1/items?limit=3", readerA, {
                "if-none-match": `W/"other", W/${etag}`,
            });
            assert.equal(weak.status, 304);

            const star = await get("/gateway/v1/items?limit=3", readerA, {
                "if-none-match": "*",
            });
            assert.equal(star.status, 304);

            const other = await get("/gateway/v1/items?limit=3", readerA, {
                "if-none-match": '"stale"',
            });
            assert.equal(other.status, 200);
            assert.equal(await other.text(), body);
        });

        it("changes the ETag when the data or the credential's view changes", async () => {
            const base = await get("/gateway/v1/items?limit=200", readerA);
            const etag = base.headers.get("etag")!;
            await base.text();

            const wide = await get("/gateway/v1/items?limit=200", readerAB);
            assert.notEqual(wide.headers.get("etag"), etag);
            await wide.text();

            await drizzleDB
                .update(catalogItemsTable)
                .set({ name: `Renamed ${suffix}` })
                .where(inArray(catalogItemsTable.id, [id("n01")]));
            await refresh();
            const changed = await get("/gateway/v1/items?limit=200", readerA, {
                "if-none-match": etag,
            });
            assert.equal(changed.status, 200, "the old ETag no longer matches");
            assert.notEqual(changed.headers.get("etag"), etag);
            await changed.text();
        });

        it("sends no Cache-Control on an error", async () => {
            const res = await get("/gateway/v1/items?cursor=bad", readerA);
            assert.equal(res.status, 400);
            assert.equal(res.headers.get("cache-control"), null);
        });

        it("works for a publishable credential from its origin", async () => {
            const res = await fetch(url + "/gateway/v1/items?limit=1", {
                headers: {
                    authorization: basic({ client_id: readerA.client_id }),
                    origin: ORIGIN,
                },
            });
            assert.equal(res.status, 200);
            const etag = res.headers.get("etag")!;
            await res.text();
            const again = await fetch(url + "/gateway/v1/items?limit=1", {
                headers: {
                    authorization: basic({ client_id: readerA.client_id }),
                    origin: ORIGIN,
                    "if-none-match": etag,
                },
            });
            assert.equal(again.status, 304);
        });
    });

    describe("get, search and categories", () => {
        it("gets one online item and 404s anything else", async () => {
            const ok = await get(
                `/gateway/v1/items/by-id/${id("n03")}`,
                readerA,
            );
            assert.equal(ok.status, 200);
            assert.equal(((await ok.json()) as Item).id, id("n03"));
            assert.ok(ok.headers.get("etag"));
            for (const hidden of ["n02", "n07", "nb1", "missing"]) {
                const res = await get(
                    `/gateway/v1/items/by-id/${id(hidden)}`,
                    readerA,
                );
                assert.equal(res.status, 404, hidden);
            }
        });

        it("searches by name and by the SKU of an online variation", async () => {
            const byName = await page(
                "/gateway/v1/items/search?q=item%20n04",
                readerA,
            );
            assert.deepEqual(ours(byName.items), [id("n04")]);
            const bySku = await page(
                `/gateway/v1/items/search?q=shown-${suffix}`,
                readerA,
            );
            assert.deepEqual(ours(bySku.items), [id("n08")]);
            const hiddenSku = await page(
                `/gateway/v1/items/search?q=hidden-${suffix}`,
                readerA,
            );
            assert.deepEqual(ours(hiddenSku.items), [], "pos-only variation");
            const pos = await page(
                "/gateway/v1/items/search?q=item%20n02",
                readerA,
            );
            assert.deepEqual(ours(pos.items), []);
            const missing = await get("/gateway/v1/items/search", readerA);
            assert.equal(missing.status, 400);
        });

        it("lists the categories of online items with their ancestors", async () => {
            const res = await get(
                "/gateway/v1/catalog/categories?limit=200",
                readerA,
            );
            assert.equal(res.status, 200);
            assert.ok(res.headers.get("etag"));
            const body = (await res.json()) as {
                categories: { id: string; name: string }[];
                next_cursor: string | null;
            };
            const mine = body.categories
                .map((c) => c.id)
                .filter((c) => c.startsWith(`gc-${suffix}-`));
            assert.deepEqual(mine, [id("cat-hot"), id("cat-tea")]);
        });

        it("filters by category, including descendants", async () => {
            const parent = await page(
                `/gateway/v1/items?category_id=${id("cat-hot")}&limit=200`,
                readerA,
            );
            assert.deepEqual(ours(parent.items), [id("n03")]);
            const none = await page(
                `/gateway/v1/items?category_id=${id("cat-pos")}&limit=200`,
                readerA,
            );
            assert.deepEqual(ours(none.items), []);
        });
    });

    describe("locations", () => {
        it("refuses a location the credential does not hold", async () => {
            const denied = await get(`/gateway/v1/items/${locB}`, readerA);
            assert.equal(denied.status, 403);
            const allowed = await page(`/gateway/v1/items/${locB}`, readerAB);
            assert.deepEqual(ours(allowed.items), [id("n08"), id("nb1")]);
            const own = await page(`/gateway/v1/items/${locA}`, readerAB);
            assert.ok(!ours(own.items).includes(id("nb1")));
        });

        it("hides another location's item from a pinned credential", async () => {
            const res = await get(
                `/gateway/v1/items/by-id/${id("nb1")}`,
                readerA,
            );
            assert.equal(res.status, 404);
            const wide = await get(
                `/gateway/v1/items/by-id/${id("nb1")}`,
                readerAB,
            );
            assert.equal(wide.status, 200);
        });

        it("still needs a credential and the catalog scope", async () => {
            assert.equal((await fetch(url + "/gateway/v1/items")).status, 401);
            const noScope = await createCredential(
                {
                    name: "No catalog",
                    scopes: ["locations:read"],
                    location_ids: [locA],
                    origins: [],
                } as never,
                "owner-user",
            );
            credentials.push(noScope.client_id);
            const res = await get("/gateway/v1/items", noScope);
            assert.equal(res.status, 403);
        });
    });

    it("documents the new operations, caching and paging in the OpenAPI document", async () => {
        const res = await fetch(url + "/gateway/v1/openapi.json");
        const doc = (await res.json()) as {
            paths: Record<
                string,
                Record<
                    string,
                    {
                        operationId: string;
                        parameters: { name: string; in: string }[];
                        responses: Record<string, unknown>;
                    }
                >
            >;
        };
        const list = doc.paths["/items"].get;
        const names = list.parameters.map((p) => p.name);
        for (const name of [
            "limit",
            "cursor",
            "category_id",
            "If-None-Match",
        ]) {
            assert.ok(names.includes(name), name);
        }
        assert.ok(list.responses["304"]);
        assert.equal(
            doc.paths["/items/search"].get.operationId,
            "items.search",
        );
        assert.equal(
            doc.paths["/items/by-id/{itemId}"].get.operationId,
            "items.get",
        );
        assert.equal(
            doc.paths["/catalog/categories"].get.operationId,
            "categories.list",
        );
        const body = JSON.stringify(doc.paths["/items"].get.responses["200"]);
        assert.match(body, /next_cursor/);
    });

    describe("order source", () => {
        const placeOrder = async () => {
            const res = await fetch(url + "/gateway/v1/orders", {
                method: "POST",
                headers: {
                    authorization: basic(writerA),
                    "content-type": "application/json",
                },
                body: JSON.stringify({
                    location_id: locA,
                    line_items: [
                        { variation_id: `${id("n01")}-v0`, quantity: "1" },
                    ],
                }),
            });
            assert.equal(res.status, 200, await res.clone().text());
            const order = (await res.json()) as {
                id: string;
                source?: { name?: string };
            };
            orderIds.push(order.id);
            return order;
        };

        it("records the credential name as the source of its orders", async () => {
            const order = await placeOrder();
            assert.deepEqual(order.source, { name: "Web Store" });
            const read = await get(`/gateway/v1/orders/${order.id}`, writerA);
            assert.deepEqual(
                ((await read.json()) as { source?: unknown }).source,
                { name: "Web Store" },
            );
            const [row] = await drizzleDB
                .select({ source: ordersTable.sourceName })
                .from(ordersTable)
                .where(inArray(ordersTable.referenceId, [order.id]));
            assert.equal(row.source, "Web Store");
        });

        it("leaves staff orders without a source", async () => {
            const app = express();
            app.use(express.json());
            app.use((req, _res, next) => {
                req.principal = {
                    kind: "user",
                    id: "staff",
                    display_name: "Staff Person",
                    roles: ["cashier"],
                    scopes: ["orders:write"],
                    location_ids: "all",
                } as typeof req.principal;
                next();
            });
            app.locals.pluginRegistry = new TessellatePluginRegistry();
            app.use("/orders", ordersv1Endpoint.router);
            const staff = await new Promise<Server>((resolve) => {
                const s = app.listen(0, "127.0.0.1", () => resolve(s));
            });
            try {
                const base = `http://127.0.0.1:${(staff.address() as AddressInfo).port}`;
                const res = await fetch(`${base}/orders/create`, {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({
                        locationId: locA,
                        discounts: [],
                        lineItems: [
                            {
                                name: "Tea",
                                quantity: 1,
                                priceMoney: { amount: "350", currency: "CAD" },
                            },
                        ],
                    }),
                });
                assert.equal(res.status, 200);
                const order = (await res.json()) as {
                    id: string;
                    source?: unknown;
                };
                orderIds.push(order.id);
                assert.equal(order.source, undefined);
                const [row] = await drizzleDB
                    .select({ source: ordersTable.sourceName })
                    .from(ordersTable)
                    .where(inArray(ordersTable.referenceId, [order.id]));
                assert.equal(row.source, null);
            } finally {
                staff.closeAllConnections();
                await new Promise<void>((resolve) =>
                    staff.close(() => resolve()),
                );
            }
        });
    });
});
