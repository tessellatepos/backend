import "@/test/localProvider";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import type { Item, Location, Principal } from "@tessellatepos/sdk";
import { createAuth } from "@/services/auth";
import { drizzleDB, pool } from "@/services/db/postgres";
import { catalogItemsTable, ordersTable } from "@/services/db/schema";
import { catalogStore } from "@/services/db/catalog";
import { EMPTY_HOURS, locationStore } from "@/services/db/locations";
import { getItemsByLocationID, getRedisClient } from "@/services/redis";
import { setActiveProvider } from "@/services/providers";
import { syncResource } from "@/services/store";
import { appEvents, type DatabaseEvent } from "@/services/websocket/events";
import { catalogv1Endpoint } from "@/endpoints/v1/catalog";
import { itemsv1Endpoint } from "@/endpoints/v1/items";
import { truncate } from "@/test/db";
import { migrateTestDb } from "./helpers/db";
import { startTestApp, type TestApp } from "./helpers/app";

const suffix = randomUUID().slice(0, 8);
const L1 = `catL1-${suffix}`;
const L2 = `catL2-${suffix}`;
const location = (id: string): Location => ({
    id,
    name: `Store ${id}`,
    address: { country: "CA", address_line_1: "1 Main St" },
    currency: "CAD",
    phone_number: "",
    website_url: "",
    email: "",
    hours: EMPTY_HOURS,
    logo_url: "",
});
const money = (amount: number) => ({ amount, currency: "CAD" });

interface Reply {
    status: number;
    body: any; // eslint-disable-line @typescript-eslint/no-explicit-any -- tests inspect arbitrary JSON
    text: string;
    headers: Headers;
}

describe("catalog management", () => {
    let server: TestApp;
    let pinnedServer: Server;
    let pinnedUrl: string;
    let owner: string;
    let manager: string;
    let cashier: string;
    let viewer: string;
    const orderRefs: string[] = [];

    async function call(
        base: string,
        method: string,
        path: string,
        options: { cookie?: string; json?: unknown; csv?: string } = {},
    ): Promise<Reply> {
        const headers: Record<string, string> = {};
        if (options.cookie) headers.cookie = options.cookie;
        let body: string | undefined;
        if (options.json !== undefined) {
            headers["content-type"] = "application/json";
            body = JSON.stringify(options.json);
        } else if (options.csv !== undefined) {
            headers["content-type"] = "text/csv";
            body = options.csv;
        }
        const res = await fetch(`${base}/api/v1/catalog${path}`, {
            method,
            headers,
            body,
        });
        const text = await res.text();
        let parsed: unknown = null;
        try {
            parsed = text ? JSON.parse(text) : null;
        } catch {
            // CSV and other non-JSON replies
        }
        return { status: res.status, body: parsed, text, headers: res.headers };
    }
    const api = (
        method: string,
        path: string,
        options?: { cookie?: string; json?: unknown; csv?: string },
    ) => call(server.url, method, path, { cookie: owner, ...options });

    const itemBody = (name: string, extra: Record<string, unknown> = {}) => ({
        name,
        locationIds: [L1],
        variations: [
            {
                name: "Small",
                sku: `${name}-S-${suffix}`,
                priceMoney: money(450),
            },
            {
                name: "Large",
                sku: `${name}-L-${suffix}`,
                priceMoney: money(550),
            },
        ],
        ...extra,
    });

    async function signIn(role: string): Promise<string> {
        const auth = createAuth();
        const email = `${role}-${suffix}@example.test`;
        await auth.api.createUser({
            body: {
                email,
                password: "correct-horse-battery",
                name: role,
                role,
            },
        });
        const { headers } = await auth.api.signInEmail({
            body: { email, password: "correct-horse-battery" },
            returnHeaders: true,
        });
        return (headers.get("set-cookie") ?? "").split(";")[0];
    }

    before(async () => {
        await migrateTestDb();
        // Item names are matched on import, so start from an empty catalog.
        await truncate(
            "tessellate-catalog-items",
            "tessellate-catalog-categories",
            "tessellate-catalog-item-locations",
        );
        owner = await signIn("owner");
        manager = await signIn("manager");
        cashier = await signIn("cashier");
        viewer = await signIn("viewer");
        await locationStore.upsertMany([location(L1), location(L2)]);
        await setActiveProvider("local");

        server = await startTestApp((app) => {
            app.use("/api/v1/catalog", catalogv1Endpoint.router);
            app.use("/api/v1/items", itemsv1Endpoint.router);
        });

        const pinned = express();
        pinned.use(express.json());
        pinned.use((req, _res, next) => {
            const principal: Principal = {
                kind: "credential",
                id: "pinned",
                roles: [],
                scopes: ["catalog:read", "catalog:write"],
                location_ids: [L1],
            };
            req.principal = principal;
            next();
        });
        pinned.use("/api/v1/catalog", catalogv1Endpoint.router);
        pinnedServer = await new Promise<Server>((resolve) => {
            const s = pinned.listen(0, "127.0.0.1", () => resolve(s));
        });
        pinnedUrl = `http://127.0.0.1:${(pinnedServer.address() as AddressInfo).port}`;
    });

    after(async () => {
        await setActiveProvider("local");
        for (const ref of orderRefs) {
            await drizzleDB
                .delete(ordersTable)
                .where(eq(ordersTable.referenceId, ref));
        }
        await server.close();
        pinnedServer.closeAllConnections();
        await new Promise((resolve) => pinnedServer.close(resolve));
        await pool.query(
            `DELETE FROM "tessellate-auth-user" WHERE email LIKE $1`,
            [`%-${suffix}@example.test`],
        );
        const redis = await getRedisClient();
        await pool.end();
        await redis.quit();
    });

    describe("access", () => {
        const writes: [string, string, unknown?][] = [
            ["POST", "/items", { name: "x" }],
            ["PUT", "/items/abc", { name: "x" }],
            ["PATCH", "/items/abc", { name: "x" }],
            ["DELETE", "/items/abc"],
            ["POST", "/categories", { name: "x" }],
            ["PUT", "/categories/abc", { name: "x" }],
            ["PATCH", "/categories/abc", { name: "x" }],
            ["DELETE", "/categories/abc"],
        ];
        const reads: [string, string][] = [
            ["GET", "/items"],
            ["GET", "/items/abc"],
            ["GET", "/categories"],
            ["GET", "/export"],
        ];

        it("answers 401 to an anonymous request on every route", async () => {
            for (const [method, path, json] of [
                ...writes,
                ...reads.map(([m, p]) => [m, p] as [string, string]),
            ]) {
                const res = await call(server.url, method, path, { json });
                assert.equal(res.status, 401, `${method} ${path}`);
            }
            const imported = await call(server.url, "POST", "/import", {
                csv: "item name\r\nx\r\n",
            });
            assert.equal(imported.status, 401);
        });

        it("lets a cashier and viewer read but not write", async () => {
            for (const cookie of [cashier, viewer]) {
                for (const [method, path] of reads.slice(0, 3)) {
                    const res = await call(server.url, method, path, {
                        cookie,
                    });
                    assert.notEqual(res.status, 401, path);
                    assert.notEqual(res.status, 403, path);
                }
                for (const [method, path, json] of writes) {
                    const res = await call(server.url, method, path, {
                        cookie,
                        json,
                    });
                    assert.equal(res.status, 403, `${method} ${path}`);
                }
                const imported = await call(server.url, "POST", "/import", {
                    cookie,
                    csv: "item name\r\nx\r\n",
                });
                assert.equal(imported.status, 403);
            }
        });

        it("lets a manager write", async () => {
            const res = await call(server.url, "POST", "/items", {
                cookie: manager,
                json: itemBody("ManagerMade"),
            });
            assert.equal(res.status, 201);
        });
    });

    describe("items", () => {
        it("creates, reads, searches, replaces and merges an item", async () => {
            const events: DatabaseEvent[] = [];
            const listener = (e: DatabaseEvent) => events.push(e);
            appEvents.on("db_update", listener);

            const created = await api("POST", "/items", {
                json: itemBody("Latte", {
                    displayName: "Latte!",
                    labelColor: "#aabbcc",
                    image: "https://example.test/latte.png",
                }),
            });
            assert.equal(created.status, 201, created.text);
            const item: Item = created.body;
            assert.equal(item.variations?.length, 2);
            assert.deepEqual(
                item.variations?.map((v) => v.name),
                ["Small", "Large"],
            );
            assert.equal(item.variations?.[0].priceMoney?.amount, "450");
            assert.ok(item.variations?.[0].id);
            assert.deepEqual(item.locationIds, [L1]);
            assert.ok(
                events.some(
                    (e) =>
                        e.type === "catalog_updated" &&
                        e.payload.locationId === L1,
                ),
                "emits catalog_updated for the storefront",
            );

            const got = await api("GET", `/items/${item.id}`);
            assert.equal(got.status, 200);
            assert.equal(got.body.name, "Latte");

            const found = await api(
                "GET",
                `/items?q=${`Latte-S-${suffix}`.toLowerCase()}`,
            );
            assert.equal(found.status, 200);
            assert.equal(found.body.total, 1, "search matches a variation SKU");
            assert.equal(found.body.canManage, true);

            // the till sees it
            const seen = await api("GET", `/items`);
            assert.equal(seen.status, 200);
            const byLocation = await getItemsByLocationID(L1);
            const cached = byLocation.find((i) => i.id === item.id);
            assert.equal(cached?.variations?.length, 2);

            // PUT replaces: drop Large, change Small's price, keep its id
            const small = item.variations![0];
            const replaced = await api("PUT", `/items/${item.id}`, {
                json: {
                    name: "Latte",
                    locationIds: [L1, L2],
                    variations: [
                        {
                            id: small.id,
                            name: "Small",
                            sku: small.sku,
                            priceMoney: money(475),
                        },
                    ],
                },
            });
            assert.equal(replaced.status, 200, replaced.text);
            assert.equal(replaced.body.variations.length, 1);
            assert.equal(replaced.body.variations[0].id, small.id);
            assert.equal(replaced.body.variations[0].priceMoney.amount, "475");
            assert.equal(
                replaced.body.displayName,
                null,
                "PUT clears omitted fields",
            );
            assert.deepEqual(
                [...replaced.body.locationIds].sort(),
                [L1, L2].sort(),
            );
            const cachedAfter = (await getItemsByLocationID(L2)).find(
                (i) => i.id === item.id,
            );
            assert.equal(
                cachedAfter?.variations?.[0].priceMoney?.amount,
                "475",
            );

            // PATCH merges: only the named fields change
            const patched = await api("PATCH", `/items/${item.id}`, {
                json: {
                    displayName: "Big Latte",
                    variations: [{ id: small.id, priceMoney: money(500) }],
                },
            });
            assert.equal(patched.status, 200, patched.text);
            assert.equal(patched.body.displayName, "Big Latte");
            assert.equal(patched.body.name, "Latte");
            assert.equal(patched.body.variations[0].name, "Small");
            assert.equal(patched.body.variations[0].sku, small.sku);
            assert.equal(patched.body.variations[0].priceMoney.amount, "500");

            // reordering: a new variation, then swap
            const added = await api("PATCH", `/items/${item.id}`, {
                json: {
                    variations: [
                        { name: "Tiny", priceMoney: money(300) },
                        { id: small.id },
                    ],
                },
            });
            assert.equal(added.status, 200, added.text);
            assert.deepEqual(
                added.body.variations.map((v: { name: string }) => v.name),
                ["Tiny", "Small"],
            );

            appEvents.off("db_update", listener);
        });

        it("404s an unknown item", async () => {
            assert.equal((await api("GET", "/items/nope")).status, 404);
            assert.equal(
                (await api("PUT", "/items/nope", { json: itemBody("Ghost") }))
                    .status,
                404,
            );
            assert.equal((await api("DELETE", "/items/nope")).status, 404);
        });

        it("rejects invalid input with 400 and never echoes values", async () => {
            const marker = `LEAK-${suffix}`;
            const bad: Record<string, unknown>[] = [
                { ...itemBody("Bad"), name: "" },
                { ...itemBody("Bad"), name: "n".repeat(300) },
                { ...itemBody("Bad"), labelColor: marker },
                { ...itemBody("Bad"), image: `javascript:${marker}` },
                { ...itemBody("Bad"), origin: marker },
                { ...itemBody("Bad"), variations: [] },
                {
                    ...itemBody("Bad"),
                    variations: [
                        {
                            name: "V",
                            priceMoney: { amount: -5, currency: "CAD" },
                        },
                    ],
                },
                {
                    ...itemBody("Bad"),
                    variations: [
                        {
                            name: "V",
                            priceMoney: { amount: 1.5, currency: "CAD" },
                        },
                    ],
                },
                {
                    ...itemBody("Bad"),
                    variations: [
                        {
                            name: "V",
                            priceMoney: { amount: marker, currency: "CAD" },
                        },
                    ],
                },
                {
                    ...itemBody("Bad"),
                    variations: [
                        {
                            name: "V",
                            priceMoney: { amount: 5, currency: marker },
                        },
                    ],
                },
                { ...itemBody("Bad"), variations: [{ name: "V" }] },
                {
                    ...itemBody("Bad"),
                    variations: [
                        { name: "A", sku: marker, priceMoney: money(1) },
                        { name: "B", sku: marker, priceMoney: money(1) },
                    ],
                },
                {
                    ...itemBody("Bad"),
                    variations: [
                        { name: "A", upc: marker, priceMoney: money(1) },
                    ],
                },
            ];
            for (const body of bad) {
                const res = await api("POST", "/items", { json: body });
                assert.equal(
                    res.status,
                    400,
                    JSON.stringify(Object.keys(body)) + res.text,
                );
                assert.ok(
                    !res.text.includes(marker),
                    "error body echoed input",
                );
                assert.ok(
                    Array.isArray(res.body.errors) &&
                        res.body.errors.length > 0,
                );
            }
            const notAnObject = await api("POST", "/items", { json: [1, 2] });
            assert.equal(notAnObject.status, 400);
            const badQuery = await api("GET", "/items?limit=9999");
            assert.equal(badQuery.status, 400);
        });

        it("rejects a SKU another item already uses", async () => {
            const first = await api("POST", "/items", {
                json: itemBody("SkuOwner"),
            });
            assert.equal(first.status, 201);
            const clash = await api("POST", "/items", {
                json: {
                    name: "SkuThief",
                    variations: [
                        {
                            name: "X",
                            sku: `SkuOwner-S-${suffix}`,
                            priceMoney: money(1),
                        },
                    ],
                },
            });
            assert.equal(clash.status, 409);
            assert.equal(clash.body.code, "sku_conflict");
            assert.ok(!clash.text.includes(`SkuOwner-S-${suffix}`));
        });

        it("only accepts storefronts that exist and are not deleted", async () => {
            const unknown = await api("POST", "/items", {
                json: itemBody("Nowhere", { locationIds: [`ghost-${suffix}`] }),
            });
            assert.equal(unknown.status, 400);
            assert.ok(!unknown.text.includes(`ghost-${suffix}`));

            const gone = `catGone-${suffix}`;
            await locationStore.upsertMany([location(gone)]);
            await locationStore.remove(gone);
            const deleted = await api("POST", "/items", {
                json: itemBody("Deleted", { locationIds: [gone] }),
            });
            assert.equal(deleted.status, 400);
        });

        it("validates per-location overrides", async () => {
            const ok = await api("POST", "/items", {
                json: {
                    name: "Override",
                    locationIds: [L1, L2],
                    variations: [
                        {
                            name: "Reg",
                            priceMoney: money(400),
                            locationOverrides: [
                                { locationId: L2, priceMoney: money(450) },
                            ],
                        },
                    ],
                },
            });
            assert.equal(ok.status, 201, ok.text);
            assert.equal(
                ok.body.variations[0].locationOverrides[0].priceMoney.amount,
                "450",
            );
            const outside = await api("PUT", `/items/${ok.body.id}`, {
                json: {
                    name: "Override",
                    locationIds: [L1],
                    variations: [
                        {
                            id: ok.body.variations[0].id,
                            name: "Reg",
                            priceMoney: money(400),
                            locationOverrides: [
                                { locationId: L2, priceMoney: money(450) },
                            ],
                        },
                    ],
                },
            });
            assert.equal(outside.status, 400);
        });

        it("pages and filters the list", async () => {
            const cat = await api("POST", "/categories", {
                json: { name: `Pg ${suffix}` },
            });
            assert.equal(cat.status, 201);
            for (const n of ["PageA", "PageB", "PageC"]) {
                const res = await api("POST", "/items", {
                    json: {
                        name: `${n}${suffix}`,
                        categoryIds: n === "PageC" ? [cat.body.id] : [],
                        locationIds: n === "PageB" ? [L2] : [L1],
                        variations: [{ name: "R", priceMoney: money(100) }],
                    },
                });
                assert.equal(res.status, 201, res.text);
            }
            const page1 = await api("GET", `/items?q=Page&limit=2&offset=0`);
            const mine = (r: Reply) =>
                r.body.items.filter((i: Item) => i.name?.endsWith(suffix));
            assert.equal(page1.body.limit, 2);
            assert.equal(page1.body.items.length <= 2, true);
            const total = (await api("GET", `/items?q=${suffix}`)).body.total;
            assert.ok(total >= 3);
            const page2 = await api("GET", `/items?q=Page&limit=2&offset=2`);
            const seen = new Set(
                [...mine(page1), ...mine(page2)].map((i: Item) => i.id),
            );
            assert.ok(seen.size >= 2, "pages do not repeat");

            const byCategory = await api(
                "GET",
                `/items?category=${cat.body.id}`,
            );
            assert.deepEqual(
                byCategory.body.items.map((i: Item) => i.name),
                [`PageC${suffix}`],
            );
            const byLocation = await api(
                "GET",
                `/items?q=Page${suffix.slice(0, 0)}&location=${L2}`,
            );
            assert.ok(
                byLocation.body.items.every((i: Item) =>
                    i.locationIds?.includes(L2),
                ),
            );
            assert.ok(
                byLocation.body.items.some(
                    (i: Item) => i.name === `PageB${suffix}`,
                ),
            );
        });
    });

    describe("archive and delete", () => {
        it("archives by default, hides from the till, and restores", async () => {
            const created = await api("POST", "/items", {
                json: itemBody("Archivable"),
            });
            const id = created.body.id;
            const archived = await api("DELETE", `/items/${id}`);
            assert.equal(archived.status, 200);
            assert.equal(archived.body.isArchived, true);

            const normal = await api("GET", `/items?q=Archivable-S-${suffix}`);
            assert.equal(normal.body.total, 0);
            const withArchived = await api(
                "GET",
                `/items?q=Archivable-S-${suffix}&archived=true`,
            );
            assert.equal(withArchived.body.total, 1);
            const all = await api(
                "GET",
                `/items?q=Archivable-S-${suffix}&archived=all`,
            );
            assert.equal(all.body.total, 1);
            assert.ok(
                !(await getItemsByLocationID(L1)).some((i) => i.id === id),
                "archived items leave the till",
            );

            const restored = await api("PATCH", `/items/${id}`, {
                json: { isArchived: false },
            });
            assert.equal(restored.status, 200);
            assert.equal(restored.body.isArchived, false);
            assert.ok(
                (await getItemsByLocationID(L1)).some((i) => i.id === id),
            );
        });

        it("hard-deletes only when no order references the item", async () => {
            const free = await api("POST", "/items", {
                json: itemBody("Disposable"),
            });
            const gone = await api(
                "DELETE",
                `/items/${free.body.id}?hard=true`,
            );
            assert.equal(gone.status, 204);
            assert.equal(
                (await api("GET", `/items/${free.body.id}`)).status,
                404,
            );

            const ordered = await api("POST", "/items", {
                json: itemBody("Ordered"),
            });
            const variationId = ordered.body.variations[0].id;
            const ref = `cat-order-${suffix}`;
            orderRefs.push(ref);
            await drizzleDB.insert(ordersTable).values({
                id: ref,
                referenceId: ref,
                locationId: L1,
                discounts: [],
                lineItems: [
                    { itemId: variationId, name: "Small", quantity: "1" },
                ],
            });
            const refused = await api(
                "DELETE",
                `/items/${ordered.body.id}?hard=true`,
            );
            assert.equal(refused.status, 409);
            assert.equal(refused.body.code, "item_ordered");
            assert.equal(
                (await api("GET", `/items/${ordered.body.id}`)).status,
                200,
            );

            const archived = await api("DELETE", `/items/${ordered.body.id}`);
            assert.equal(archived.status, 200, "archiving is still allowed");

            const badFlag = await api(
                "DELETE",
                `/items/${ordered.body.id}?hard=maybe`,
            );
            assert.equal(badFlag.status, 400);
        });
    });

    describe("categories", () => {
        it("builds a tree, rejects cycles and guards deletes", async () => {
            const parent = (
                await api("POST", "/categories", {
                    json: { name: `Parent ${suffix}` },
                })
            ).body;
            const child = (
                await api("POST", "/categories", {
                    json: {
                        name: `Child ${suffix}`,
                        parentCategoryId: parent.id,
                    },
                })
            ).body;
            assert.equal(child.parentCategoryId, parent.id);

            const list = await api("GET", "/categories");
            assert.equal(list.body.canManage, true);
            assert.ok(
                list.body.categories.some(
                    (c: { id: string }) => c.id === child.id,
                ),
            );

            const selfParent = await api("PATCH", `/categories/${parent.id}`, {
                json: { parentCategoryId: parent.id },
            });
            assert.equal(selfParent.status, 400);
            assert.equal(selfParent.body.code, "category_cycle");
            const cycle = await api("PATCH", `/categories/${parent.id}`, {
                json: { parentCategoryId: child.id },
            });
            assert.equal(cycle.status, 400);
            assert.equal(cycle.body.code, "category_cycle");

            const missingParent = await api("POST", "/categories", {
                json: { name: "x", parentCategoryId: `none-${suffix}` },
            });
            assert.equal(missingParent.status, 400);
            const badName = await api("POST", "/categories", {
                json: { name: "A > B" },
            });
            assert.equal(badName.status, 400);

            const renamed = await api("PATCH", `/categories/${child.id}`, {
                json: { name: `Kid ${suffix}` },
            });
            assert.equal(renamed.body.name, `Kid ${suffix}`);
            assert.equal(renamed.body.parentCategoryId, parent.id);
            const replaced = await api("PUT", `/categories/${child.id}`, {
                json: { name: `Kid ${suffix}` },
            });
            assert.equal(
                replaced.body.parentCategoryId,
                null,
                "PUT clears the parent",
            );
            await api("PATCH", `/categories/${child.id}`, {
                json: { parentCategoryId: parent.id },
            });

            assert.equal(
                (await api("DELETE", `/categories/${parent.id}`)).status,
                409,
            );

            const item = await api("POST", "/items", {
                json: itemBody("Categorised", { categoryIds: [child.id] }),
            });
            assert.equal(item.body.categories[0].id, child.id);
            assert.equal(item.body.categories[0].parentCategory.id, parent.id);

            assert.equal(
                (await api("DELETE", `/categories/${child.id}`)).status,
                204,
            );
            const after = await api("GET", `/items/${item.body.id}`);
            assert.deepEqual(after.body.categories, []);
            assert.equal(
                (await api("DELETE", `/categories/${parent.id}`)).status,
                204,
            );
            assert.equal(
                (await api("DELETE", `/categories/${parent.id}`)).status,
                404,
            );
        });
    });

    describe("location pinning", () => {
        const pin = (method: string, path: string, json?: unknown) =>
            call(pinnedUrl, method, path, { json });

        it("lets a pinned principal manage items at its own storefront only", async () => {
            const own = await pin("POST", "/items", itemBody("PinnedOwn"));
            assert.equal(own.status, 201, own.text);
            assert.equal(
                (
                    await pin(
                        "POST",
                        "/items",
                        itemBody("PinnedElsewhere", { locationIds: [L2] }),
                    )
                ).status,
                403,
            );
            assert.equal(
                (
                    await pin(
                        "POST",
                        "/items",
                        itemBody("PinnedBoth", { locationIds: [L1, L2] }),
                    )
                ).status,
                403,
            );
            assert.equal(
                (
                    await pin(
                        "POST",
                        "/items",
                        itemBody("PinnedNowhere", { locationIds: [] }),
                    )
                ).status,
                403,
            );

            const widen = await pin("PATCH", `/items/${own.body.id}`, {
                locationIds: [L1, L2],
            });
            assert.equal(widen.status, 403);
            const rename = await pin("PATCH", `/items/${own.body.id}`, {
                displayName: "mine",
            });
            assert.equal(rename.status, 200);
            assert.equal(
                (await pin("DELETE", `/items/${own.body.id}`)).status,
                200,
            );
        });

        it("hides and protects other storefronts' items", async () => {
            const shared = (
                await api("POST", "/items", {
                    json: itemBody("SharedItem", { locationIds: [L1, L2] }),
                })
            ).body;
            const other = (
                await api("POST", "/items", {
                    json: itemBody("OtherItem", { locationIds: [L2] }),
                })
            ).body;

            assert.equal((await pin("GET", `/items/${other.id}`)).status, 404);
            assert.equal(
                (await pin("PATCH", `/items/${other.id}`, { displayName: "x" }))
                    .status,
                404,
            );
            assert.equal(
                (await pin("DELETE", `/items/${other.id}?hard=true`)).status,
                404,
            );

            assert.equal((await pin("GET", `/items/${shared.id}`)).status, 200);
            assert.equal(
                (
                    await pin("PATCH", `/items/${shared.id}`, {
                        displayName: "x",
                    })
                ).status,
                403,
            );
            assert.equal(
                (await pin("DELETE", `/items/${shared.id}`)).status,
                403,
            );

            const list = await pin("GET", "/items?limit=200");
            assert.ok(
                list.body.items.every((i: Item) => i.locationIds?.includes(L1)),
            );
            assert.ok(!list.body.items.some((i: Item) => i.id === other.id));
        });

        it("keeps categories and import for unrestricted principals", async () => {
            assert.equal(
                (await pin("POST", "/categories", { name: "x" })).status,
                403,
            );
            const imported = await call(pinnedUrl, "POST", "/import", {
                csv: "item name\r\nx\r\n",
            });
            assert.equal(imported.status, 403);
        });
    });

    describe("import and export", () => {
        const header =
            "item name,variation name,sku,upc,price,currency,category,locations,taxable,archived";
        const good = [
            header,
            `Mocha ${suffix},Small,MO-S-${suffix},,4.50,CAD,Drinks ${suffix} > Hot,${L1},true,false`,
            `Mocha ${suffix},Large,MO-L-${suffix},,5.50,CAD,Drinks ${suffix} > Hot,,,`,
            `Scone ${suffix},,SC-${suffix},,3.00,CAD,Food ${suffix},${L1};${L2},,`,
        ].join("\r\n");

        const lookup = async (q: string) =>
            (await api("GET", `/items?q=${encodeURIComponent(q)}&archived=all`))
                .body;

        it("dry-runs without writing", async () => {
            const res = await api("POST", "/import?dryRun=true", { csv: good });
            assert.equal(res.status, 200, res.text);
            assert.equal(res.body.dryRun, true);
            assert.equal(res.body.applied, false);
            assert.deepEqual(res.body.summary, {
                rows: 3,
                errors: 0,
                itemsCreated: 2,
                itemsUpdated: 0,
                variationsCreated: 3,
                variationsUpdated: 0,
                categoriesCreated: 3,
            });
            assert.deepEqual(
                res.body.rows.map((r: { status: string }) => r.status),
                ["create", "create", "create"],
            );
            assert.equal((await lookup(`Mocha ${suffix}`)).total, 0);
            const cats = (await api("GET", "/categories")).body.categories;
            assert.ok(
                !cats.some(
                    (c: { name: string }) => c.name === `Drinks ${suffix}`,
                ),
            );
        });

        it("imports for real, then upserts by SKU on a second run", async () => {
            const res = await api("POST", "/import", { csv: good });
            assert.equal(res.status, 200, res.text);
            assert.equal(res.body.applied, true);
            const mocha = (await lookup(`Mocha ${suffix}`)).items[0];
            assert.equal(mocha.variations.length, 2);
            assert.equal(mocha.variations[0].priceMoney.amount, "450");
            assert.equal(mocha.categories[0].name, "Hot");
            assert.equal(
                mocha.categories[0].parentCategory.name,
                `Drinks ${suffix}`,
            );
            assert.deepEqual(mocha.locationIds, [L1]);
            const scone = (await lookup(`Scone ${suffix}`)).items[0];
            assert.equal(scone.variations[0].name, "Regular");
            assert.deepEqual([...scone.locationIds].sort(), [L1, L2].sort());
            assert.ok(
                (await getItemsByLocationID(L1)).some((i) => i.id === mocha.id),
                "imported items reach the till",
            );

            const repriced = good.replace("4.50", "4.75");
            const again = await api("POST", "/import", { csv: repriced });
            assert.equal(again.status, 200, again.text);
            assert.deepEqual(again.body.summary, {
                rows: 3,
                errors: 0,
                itemsCreated: 0,
                itemsUpdated: 2,
                variationsCreated: 0,
                variationsUpdated: 3,
                categoriesCreated: 0,
            });
            const updated = (await lookup(`Mocha ${suffix}`)).items;
            assert.equal(updated.length, 1, "no duplicate item");
            assert.equal(updated[0].id, mocha.id);
            assert.equal(updated[0].variations[0].priceMoney.amount, "475");
        });

        it("matches by item name when there is no SKU", async () => {
            const csv = `${header}\r\nScone ${suffix},Regular,,,3.25,CAD,,,,`;
            const res = await api("POST", "/import", { csv });
            assert.equal(res.status, 200, res.text);
            assert.equal(res.body.summary.itemsUpdated, 1);
            const scone = (await lookup(`Scone ${suffix}`)).items;
            assert.equal(scone.length, 1);
            assert.equal(scone[0].variations.length, 1);
            assert.equal(scone[0].variations[0].priceMoney.amount, "325");
        });

        it("rolls everything back when any row is bad, and never echoes values", async () => {
            const marker = `LEAK-${suffix}`;
            const csv = [
                header,
                `Fresh ${suffix},Reg,FR-${suffix},,2.00,CAD,NewCat ${suffix},${L1},,`,
                `Broken ${suffix},Reg,BR-${suffix},,${marker},CAD,,,,`,
                `Lost ${suffix},Reg,,,1.00,CAD,,${marker},,`,
                `Mocha ${suffix},Small,MO-S-${suffix},,9.99,CAD,,,,`,
            ].join("\r\n");
            const dry = await api("POST", "/import?dryRun=true", { csv });
            assert.equal(dry.status, 200);
            assert.deepEqual(
                dry.body.rows.map((r: { status: string }) => r.status),
                ["create", "error", "error", "update"],
            );
            assert.ok(!dry.text.includes(marker));

            const real = await api("POST", "/import", { csv });
            assert.equal(real.status, 422);
            assert.equal(real.body.applied, false);
            assert.ok(!real.text.includes(marker));
            assert.equal(real.body.rows[1].errors[0].path, "price");
            assert.equal(
                (await lookup(`Fresh ${suffix}`)).total,
                0,
                "the good row was not written",
            );
            const mocha = (await lookup(`Mocha ${suffix}`)).items[0];
            assert.equal(
                mocha.variations[0].priceMoney.amount,
                "475",
                "existing items were not touched",
            );
            const cats = (await api("GET", "/categories")).body.categories;
            assert.ok(
                !cats.some(
                    (c: { name: string }) => c.name === `NewCat ${suffix}`,
                ),
            );
        });

        it("rejects a SKU repeated in the file", async () => {
            const dupFile = `${header}\r\nA${suffix},R,DUP-${suffix},,1.00,CAD,,,,\r\nB${suffix},R,DUP-${suffix},,1.00,CAD,,,,`;
            const dup = await api("POST", "/import", { csv: dupFile });
            assert.equal(dup.status, 422);
        });

        it("rejects malformed files, bad headers, and oversize input", async () => {
            const unknownColumn = await api("POST", "/import?dryRun=true", {
                csv: "item name,secret\r\nx,y\r\n",
            });
            assert.equal(unknownColumn.status, 200);
            assert.equal(unknownColumn.body.summary.errors, 1);
            const noName = await api("POST", "/import?dryRun=true", {
                csv: "sku\r\nx\r\n",
            });
            assert.equal(noName.body.summary.errors, 1);
            const unterminated = await api("POST", "/import?dryRun=true", {
                csv: `${header}\r\n"open,1\r\n`,
            });
            assert.equal(unterminated.body.summary.errors, 1);
            const empty = await api("POST", "/import?dryRun=true", { csv: "" });
            assert.equal(empty.status, 200);
            assert.equal(empty.body.summary.errors, 1);
            assert.equal(
                (await api("POST", "/import?dryRun=maybe", { csv: good }))
                    .status,
                400,
            );
            assert.equal(
                (await api("POST", "/import", { json: { nope: 1 } })).status,
                400,
            );

            const manyRows = [
                header,
                ...Array.from(
                    { length: 5001 },
                    (_, i) => `Bulk${i},R,,,1.00,CAD,,,,`,
                ),
            ].join("\r\n");
            const tooMany = await api("POST", "/import?dryRun=true", {
                csv: manyRows,
            });
            assert.equal(tooMany.status, 413);
            assert.equal(tooMany.body.code, "import_too_large");

            const big = `${header}\r\n${"x".repeat(1024 * 1024 + 10)}`;
            const tooBig = await api("POST", "/import?dryRun=true", {
                csv: big,
            });
            assert.equal(tooBig.status, 413);
            assert.equal(tooBig.body.code, "import_too_large");
        });

        it("exports in the import format and round-trips", async () => {
            const formula = await api("POST", "/items", {
                json: {
                    name: `=HYPERLINK("x") ${suffix}`,
                    locationIds: [L1],
                    variations: [
                        { name: 'Say "hi", ok', priceMoney: money(1234) },
                    ],
                },
            });
            assert.equal(formula.status, 201, formula.text);

            const first = await api("GET", "/export?archived=all");
            assert.equal(first.status, 200);
            assert.match(first.headers.get("content-type") ?? "", /text\/csv/);
            const lines = first.text.split("\r\n");
            assert.equal(lines[0], `${header},channels,variation channels`);
            assert.ok(first.text.includes(`Mocha ${suffix}`));
            assert.ok(
                first.text.includes(`'=HYPERLINK`),
                "formulas are neutralised",
            );
            assert.ok(first.text.includes("12.34"));

            const dry = await api("POST", "/import?dryRun=true", {
                csv: first.text,
            });
            assert.equal(dry.status, 200);
            assert.equal(
                dry.body.summary.errors,
                0,
                JSON.stringify(
                    dry.body.rows
                        .filter((r: { status: string }) => r.status === "error")
                        .slice(0, 3),
                ),
            );
            assert.equal(dry.body.summary.itemsCreated, 0);
            assert.equal(dry.body.summary.variationsCreated, 0);
            assert.equal(dry.body.summary.categoriesCreated, 0);

            const before = (await api("GET", "/items?limit=200&archived=all"))
                .body.total;
            const real = await api("POST", "/import", { csv: first.text });
            assert.equal(real.status, 200, real.text);
            assert.equal(
                (await api("GET", "/items?limit=200&archived=all")).body.total,
                before,
            );

            const second = await api("GET", "/export?archived=all");
            assert.equal(
                second.text,
                first.text,
                "export is stable across a round trip",
            );
            const formulaAfter = await lookup(`HYPERLINK`);
            assert.equal(
                formulaAfter.items.filter((i: Item) => i.name?.endsWith(suffix))
                    .length,
                1,
            );
            assert.equal(
                formulaAfter.items.find((i: Item) => i.name?.endsWith(suffix))
                    .name,
                `=HYPERLINK("x") ${suffix}`,
            );
        });
    });

    describe("channels", () => {
        after(async () => {
            const mine = `SELECT id FROM "tessellate-catalog-items" WHERE name LIKE $1`;
            const like = [`Chan% ${suffix}`];
            for (const table of [
                "tessellate-catalog-item-variations",
                "tessellate-catalog-item-categories",
                "tessellate-catalog-item-locations",
            ]) {
                await pool.query(
                    `DELETE FROM "${table}" WHERE item_id IN (${mine})`,
                    like,
                );
            }
            await pool.query(
                `DELETE FROM "tessellate-catalog-items" WHERE name LIKE $1`,
                like,
            );
        });

        const variationIds = (item: Item) =>
            (item.variations ?? []).map((v) => v.id as string);

        it("defaults to pos, and a variation follows its item", async () => {
            const res = await api("POST", "/items", {
                json: itemBody(`ChanDefault ${suffix}`),
            });
            assert.equal(res.status, 201, res.text);
            assert.deepEqual(res.body.channels, ["pos"]);
            assert.ok(
                res.body.variations.every(
                    (v: { channels?: string[] }) => v.channels === undefined,
                ),
            );
        });

        it("stores channels on create, replace and patch", async () => {
            const created = await api("POST", "/items", {
                json: itemBody(`ChanOn ${suffix}`, {
                    channels: ["pos", "online"],
                }),
            });
            assert.equal(created.status, 201, created.text);
            assert.deepEqual(created.body.channels, ["pos", "online"]);

            const [small, large] = variationIds(created.body);
            const patched = await api("PATCH", `/items/${created.body.id}`, {
                json: {
                    variations: [
                        { id: small, channels: ["pos"] },
                        { id: large },
                    ],
                },
            });
            assert.equal(patched.status, 200, patched.text);
            assert.deepEqual(patched.body.channels, ["pos", "online"]);
            assert.deepEqual(patched.body.variations[0].channels, ["pos"]);
            assert.equal(patched.body.variations[1].channels, undefined);

            const replaced = await api("PUT", `/items/${created.body.id}`, {
                json: itemBody(`ChanOn ${suffix}`, { channels: ["online"] }),
            });
            assert.equal(replaced.status, 200, replaced.text);
            assert.deepEqual(replaced.body.channels, ["online"]);
        });

        it("rejects unknown, empty and repeated channels without echoing them", async () => {
            const marker = `LEAK-${suffix}`;
            for (const channels of [[marker], [], ["pos", "pos"], "online"]) {
                const res = await api("POST", "/items", {
                    json: itemBody(`ChanBad ${suffix}`, { channels }),
                });
                assert.equal(res.status, 400, JSON.stringify(channels));
                assert.equal(res.body.errors[0].path, "channels");
                assert.ok(!res.text.includes(marker));
            }
        });

        it("changes only channels through the channels endpoint", async () => {
            const created = await api("POST", "/items", {
                json: itemBody(`ChanOnly ${suffix}`),
            });
            const [small] = variationIds(created.body);
            const res = await api("PUT", `/items/${created.body.id}/channels`, {
                json: {
                    channels: ["online"],
                    variations: { [small]: ["online"] },
                },
            });
            assert.equal(res.status, 200, res.text);
            assert.deepEqual(res.body.channels, ["online"]);
            assert.deepEqual(res.body.variations[0].channels, ["online"]);
            assert.equal(res.body.name, created.body.name);

            const unfollow = await api(
                "PUT",
                `/items/${created.body.id}/channels`,
                {
                    json: {
                        channels: ["online"],
                        variations: { [small]: null },
                    },
                },
            );
            assert.equal(unfollow.body.variations[0].channels, undefined);

            const foreign = await api(
                "PUT",
                `/items/${created.body.id}/channels`,
                { json: { channels: ["pos"], variations: { nope: ["pos"] } } },
            );
            assert.equal(foreign.status, 400);
            assert.equal(
                (await api("GET", `/items/${created.body.id}`)).body
                    .channels[0],
                "online",
                "a refused change writes nothing",
            );
            assert.equal(
                (
                    await api("PUT", "/items/missing/channels", {
                        json: { channels: ["pos"] },
                    })
                ).status,
                404,
            );
            assert.equal(
                (
                    await call(
                        server.url,
                        "PUT",
                        `/items/${created.body.id}/channels`,
                        {
                            cookie: viewer,
                            json: { channels: ["pos"] },
                        },
                    )
                ).status,
                403,
            );
            assert.equal(
                (
                    await call(
                        server.url,
                        "PUT",
                        `/items/${created.body.id}/channels`,
                        {
                            json: { channels: ["pos"] },
                        },
                    )
                ).status,
                401,
            );
        });

        it("carries channels through CSV export and import", async () => {
            const name = `ChanCsv ${suffix}`;
            const csv = [
                "item name,variation name,sku,price,currency,channels,variation channels",
                `${name},Small,CSV-S-${suffix},1.00,CAD,pos; online,pos`,
                `${name},Large,CSV-L-${suffix},2.00,CAD,pos; online,`,
            ].join("\r\n");
            const imported = await api("POST", "/import", { csv });
            assert.equal(imported.status, 200, imported.text);
            const item = (
                await api("GET", `/items?q=${encodeURIComponent(name)}`)
            ).body.items[0];
            assert.deepEqual(item.channels, ["pos", "online"]);
            const byName = Object.fromEntries(
                item.variations.map(
                    (
                        v: Item["variations"] extends (infer V)[] | null
                            ? V
                            : never,
                    ) => [v.name, v],
                ),
            );
            assert.deepEqual(byName.Small.channels, ["pos"]);
            assert.equal(byName.Large.channels, undefined);

            const exported = (await api("GET", "/export")).text;
            assert.match(
                exported.split("\r\n")[0],
                /,archived,channels,variation channels$/,
            );
            assert.ok(exported.includes(`CSV-S-${suffix}`));
            assert.ok(
                exported.includes(`pos; online,pos\r\n`),
                "item and variation channels are exported",
            );

            const bad = await api("POST", "/import?dryRun=true", {
                csv: `item name,channels\r\n${name},shop\r\n`,
            });
            assert.equal(bad.body.rows[0].errors[0].path, "channels");

            const kept = await api("POST", "/import", {
                csv: `item name,sku\r\n${name},CSV-S-${suffix}\r\n`,
            });
            assert.equal(kept.status, 200, kept.text);
            const again = (
                await api("GET", `/items?q=${encodeURIComponent(name)}`)
            ).body.items[0];
            assert.deepEqual(again.channels, ["pos", "online"], "left alone");
        });

        it("survives a Square sync, which never writes channels", async () => {
            const id = `sqchan-${suffix}`;
            const synced = (name: string): Item => ({
                id,
                name,
                variations: [],
                locationIds: [L1],
            });
            await setActiveProvider("square");
            try {
                await syncResource({
                    name: "catalog",
                    fetchRemote: async () => [synced("Before")],
                    store: catalogStore,
                });
                const before = await api("GET", `/items/${id}`);
                assert.deepEqual(before.body.channels, ["pos"]);

                const set = await api("PUT", `/items/${id}/channels`, {
                    json: { channels: ["pos", "online"] },
                });
                assert.equal(set.status, 200, set.text);

                await syncResource({
                    name: "catalog",
                    fetchRemote: async () => [synced("After")],
                    store: catalogStore,
                });
                const after = await api("GET", `/items/${id}`);
                assert.equal(after.body.name, "After");
                assert.deepEqual(after.body.channels, ["pos", "online"]);
            } finally {
                await setActiveProvider("local");
                await pool.query(
                    `DELETE FROM "tessellate-catalog-item-locations" WHERE item_id = $1`,
                    [id],
                );
                await pool.query(
                    `DELETE FROM "tessellate-catalog-items" WHERE id = $1`,
                    [id],
                );
            }
        });
    });

    describe("under the Square provider", () => {
        it("is read-only, hides local items and answers 409 to writes", async () => {
            const local = await api("POST", "/items", {
                json: itemBody("LocalOnly"),
            });
            assert.equal(local.status, 201);
            const cat = await api("POST", "/categories", {
                json: { name: `LocalCat ${suffix}` },
            });

            await setActiveProvider("square");
            try {
                const list = await api(
                    "GET",
                    `/items?q=LocalOnly&archived=all`,
                );
                assert.equal(list.status, 200);
                assert.equal(list.body.canManage, false);
                assert.equal(list.body.total, 0, "local items are not shown");
                assert.equal(
                    (await api("GET", `/items/${local.body.id}`)).status,
                    404,
                );
                const cats = (await api("GET", "/categories")).body;
                assert.equal(cats.canManage, false);
                assert.ok(
                    !cats.categories.some(
                        (c: { id: string }) => c.id === cat.body.id,
                    ),
                );

                const writes: [string, string, unknown?][] = [
                    ["POST", "/items", itemBody("Nope")],
                    ["PUT", `/items/${local.body.id}`, itemBody("Nope")],
                    ["PATCH", `/items/${local.body.id}`, { name: "Nope" }],
                    ["DELETE", `/items/${local.body.id}`],
                    ["DELETE", `/items/${local.body.id}?hard=true`],
                    ["POST", "/categories", { name: "Nope" }],
                    ["PATCH", `/categories/${cat.body.id}`, { name: "Nope" }],
                    ["DELETE", `/categories/${cat.body.id}`],
                ];
                for (const [method, path, json] of writes) {
                    const res = await api(method, path, { json });
                    assert.equal(res.status, 409, `${method} ${path}`);
                    assert.equal(res.body.code, "provider_readonly");
                    assert.match(res.body.message, /Square/);
                }
                assert.equal(
                    (await api("POST", "/import", { csv: good() })).status,
                    409,
                );
                assert.equal(
                    (
                        await call(server.url, "POST", "/items", {
                            json: itemBody("Anon"),
                        })
                    ).status,
                    401,
                    "anonymous callers still get 401",
                );
                assert.equal(
                    (
                        await call(server.url, "POST", "/items", {
                            cookie: viewer,
                            json: itemBody("V"),
                        })
                    ).status,
                    403,
                );

                // A Square sync neither overwrites nor archives local items.
                const synced: Item = {
                    id: `sq-${suffix}`,
                    name: `Synced ${suffix}`,
                    variations: [],
                    locationIds: [L1],
                };
                await syncResource({
                    name: "catalog",
                    fetchRemote: async () => [synced],
                    store: catalogStore,
                });
                const [row] = await drizzleDB
                    .select()
                    .from(catalogItemsTable)
                    .where(eq(catalogItemsTable.id, local.body.id));
                assert.equal(row.isArchived, false);
                assert.equal(row.origin, "local");
                const shown = await api(
                    "GET",
                    `/items?q=${encodeURIComponent(`Synced ${suffix}`)}`,
                );
                assert.equal(shown.body.total, 1);
            } finally {
                await setActiveProvider("local");
            }
            const back = await api("GET", `/items/${local.body.id}`);
            assert.equal(
                back.status,
                200,
                "local items return when switching back",
            );
            assert.equal(back.body.name, "LocalOnly");
        });

        function good() {
            return "item name\r\nx\r\n";
        }
    });
});
