import "@/test/localProvider";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { eq, inArray } from "drizzle-orm";
import { events } from "@tessellatepos/plugin-sdk/server";
import { drizzleDB, pool } from "@/services/db/postgres";
import { createLocalLocation, removeLocation } from "@/services/db/locations";
import { createCredential } from "@/services/credentials";
import { getRedisClient } from "@/services/redis";
import {
    catalogItemVariationsTable,
    catalogItemsTable,
    ordersTable,
} from "@/services/db/schema";
import { insertOrder } from "@/services/db/orders";
import { listDeliveries } from "@/services/db/webhookDeliveries";
import { createApp, mountApiRoutes } from "@/app";
import { gatewayRateLimit } from "@/gateway/guards";
import { expireStaleOrders } from "@/gateway/orderExpiry";
import { TessellatePluginRegistry } from "@/utils/registry/plugin/pluginRegistry";
import { getActiveProvider } from "@/services/providers";
import { migrateTestDb } from "./helpers/db";

const suffix = randomUUID().slice(0, 8);
const MINUTE = 60_000;

after(async () => {
    await pool.end();
    await (await getRedisClient())?.quit();
});

describe("gateway order lifecycle", () => {
    let server: Server;
    let url: string;
    let loc: string;
    let registry: TessellatePluginRegistry;
    let hook: http.Server;
    let hookUrl: string;
    const emitted: { name: string; orderId?: string }[] = [];
    const credentials: string[] = [];
    const orderRefs: string[] = [];

    before(async () => {
        await migrateTestDb();
        loc = (
            await createLocalLocation({
                name: `Lifecycle ${suffix}`,
                currency: "CAD",
                country: "CA",
            })
        ).id;
        await drizzleDB.insert(catalogItemsTable).values({
            id: `life-${suffix}`,
            name: "life",
            origin: "local",
            channels: ["online"],
        });
        await drizzleDB.insert(catalogItemVariationsTable).values({
            variationId: `life-var-${suffix}`,
            itemId: `life-${suffix}`,
            pricingType: "FIXED",
            priceMoney: { amount: "500", currency: "CAD" },
        });

        registry = new TessellatePluginRegistry();
        const emit = registry.emit.bind(registry);
        registry.emit = ((def: { name: string }, ...args: unknown[]) => {
            emitted.push({
                name: def.name,
                orderId: (args[0] as { id?: string } | undefined)?.id,
            });
            (emit as (d: unknown, ...a: unknown[]) => void)(def, ...args);
        }) as typeof registry.emit;

        hook = http.createServer((_req, res) => res.end("ok"));
        await new Promise<void>((r) => hook.listen(0, "127.0.0.1", r));
        hookUrl = `http://127.0.0.1:${(hook.address() as AddressInfo).port}/h`;

        const app = createApp();
        app.locals.pluginRegistry = registry;
        mountApiRoutes(app, registry.apiRegistry);
        server = await new Promise((resolve) => {
            const s = app.listen(0, "127.0.0.1", () => resolve(s));
        });
        url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    after(async () => {
        server.closeAllConnections();
        await new Promise<void>((r) => server.close(() => r()));
        await new Promise((r) => hook.close(r));
        if (orderRefs.length) {
            await drizzleDB
                .delete(ordersTable)
                .where(inArray(ordersTable.referenceId, orderRefs));
        }
        for (const id of credentials) {
            await pool.query(
                `DELETE FROM "tessellate-webhook-deliveries" WHERE credential_id = $1`,
                [id],
            );
            await pool.query(
                `DELETE FROM "tessellate-api-credentials" WHERE id = $1`,
                [id],
            );
        }
        await removeLocation(loc);
        await drizzleDB
            .delete(catalogItemVariationsTable)
            .where(eq(catalogItemVariationsTable.itemId, `life-${suffix}`));
        await drizzleDB
            .delete(catalogItemsTable)
            .where(eq(catalogItemsTable.id, `life-${suffix}`));
    });

    async function make(overrides: Record<string, unknown> = {}) {
        const result = await createCredential(
            {
                name: `Life ${suffix}`,
                scopes: ["orders:read", "orders:write"],
                location_ids: [loc],
                ...overrides,
            } as never,
            "owner-user",
        );
        credentials.push(result.client_id);
        return result;
    }

    const basic = (c: { client_id: string; client_secret: string }) =>
        `Basic ${Buffer.from(`${c.client_id}:${c.client_secret}`).toString("base64")}`;

    const body = (quantity = "1") => ({
        line_items: [{ variation_id: `life-var-${suffix}`, quantity }],
    });

    async function place(
        c: { client_id: string; client_secret: string },
        payload: unknown = body(),
        key?: string,
    ) {
        const res = await fetch(`${url}/gateway/v1/orders`, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                authorization: basic(c),
                ...(key ? { "idempotency-key": key } : {}),
            },
            body: JSON.stringify(payload),
        });
        const json = (await res.json()) as { id?: string; code?: string };
        if (json.id) orderRefs.push(json.id);
        return { res, json };
    }

    const stateOf = async (ref: string) =>
        (
            await drizzleDB
                .select()
                .from(ordersTable)
                .where(eq(ordersTable.referenceId, ref))
        )[0];

    const cancelsFor = (ids: string[]) =>
        emitted.filter(
            (e) =>
                e.name === events.orderCancelled.name &&
                e.orderId &&
                ids.includes(e.orderId),
        );

    describe("idempotency", () => {
        it("replays the first answer for the same key and body", async () => {
            const c = await make();
            const key = `k-${randomUUID()}`;
            const first = await place(c, body("2"), key);
            assert.equal(first.res.status, 200);
            const again = await place(c, body("2"), key);
            assert.equal(again.res.status, 200);
            assert.equal(again.json.id, first.json.id);
            assert.equal(again.res.headers.get("idempotent-replayed"), "true");
            assert.equal(first.res.headers.get("idempotent-replayed"), null);
            const rows = await drizzleDB
                .select()
                .from(ordersTable)
                .where(eq(ordersTable.createdByCredential, c.client_id));
            assert.equal(rows.length, 1);
        });

        it("treats key order in the body as the same request", async () => {
            const c = await make();
            const key = `k-${randomUUID()}`;
            const a = await place(c, { location_id: loc, ...body("3") }, key);
            const b = await place(
                c,
                { line_items: body("3").line_items, location_id: loc },
                key,
            );
            assert.equal(b.json.id, a.json.id);
        });

        it("refuses the same key with a different body (422)", async () => {
            const c = await make();
            const key = `k-${randomUUID()}`;
            await place(c, body("1"), key);
            const other = await place(c, body("2"), key);
            assert.equal(other.res.status, 422);
            assert.equal(other.json.code, "idempotency_key_reused");
        });

        it("scopes keys to the credential", async () => {
            const a = await make();
            const b = await make();
            const key = `k-${randomUUID()}`;
            const first = await place(a, body(), key);
            const second = await place(b, body(), key);
            assert.equal(second.res.status, 200);
            assert.notEqual(second.json.id, first.json.id);
        });

        it("creates one order when the same key arrives concurrently", async () => {
            const c = await make();
            const key = `k-${randomUUID()}`;
            const results = await Promise.all(
                Array.from({ length: 6 }, () => place(c, body(), key)),
            );
            const ids = new Set(
                results.filter((r) => r.res.ok).map((r) => r.json.id),
            );
            assert.equal(ids.size, 1);
            for (const r of results) {
                assert.ok(
                    r.res.ok ||
                        (r.res.status === 409 &&
                            r.json.code === "idempotency_in_progress"),
                );
            }
            const rows = await drizzleDB
                .select()
                .from(ordersTable)
                .where(eq(ordersTable.createdByCredential, c.client_id));
            assert.equal(rows.length, 1);
        });

        it("runs again after a failed attempt instead of replaying it", async () => {
            const c = await make();
            const key = `k-${randomUUID()}`;
            const bad = await place(
                c,
                { line_items: [{ variation_id: "nope", quantity: "1" }] },
                key,
            );
            assert.equal(bad.res.status, 400);
            const retry = await place(
                c,
                { line_items: [{ variation_id: "nope", quantity: "1" }] },
                key,
            );
            assert.equal(retry.res.status, 400);
            assert.equal(retry.res.headers.get("idempotent-replayed"), null);
        });

        it("rejects a malformed key", async () => {
            const c = await make();
            const res = await place(c, body(), "has space");
            assert.equal(res.res.status, 400);
            assert.equal(res.json.code, "invalid_idempotency_key");
        });
    });

    describe("open-order cap", () => {
        const withCap = async (cap: number, fn: () => Promise<void>) => {
            process.env.MAX_OPEN_ORDERS_PER_CREDENTIAL = String(cap);
            try {
                await fn();
            } finally {
                delete process.env.MAX_OPEN_ORDERS_PER_CREDENTIAL;
            }
        };

        it("answers 429 with a stable code past the cap", async () => {
            await withCap(2, async () => {
                const c = await make();
                assert.equal((await place(c)).res.status, 200);
                assert.equal((await place(c)).res.status, 200);
                const over = await place(c);
                assert.equal(over.res.status, 429);
                assert.equal(over.json.code, "open_order_limit");
                // Another credential is unaffected.
                assert.equal((await place(await make())).res.status, 200);
            });
        });

        it("holds under concurrent creates", async () => {
            await withCap(3, async () => {
                const c = await make();
                const results = await Promise.all(
                    Array.from({ length: 8 }, () => place(c)),
                );
                assert.equal(results.filter((r) => r.res.ok).length, 3);
                assert.equal(
                    results.filter((r) => r.res.status === 429).length,
                    5,
                );
            });
        });

        it("frees a slot when an order is canceled, and replays at the cap", async () => {
            await withCap(1, async () => {
                const c = await make();
                const key = `k-${randomUUID()}`;
                const first = await place(c, body(), key);
                assert.equal((await place(c)).res.status, 429);
                assert.equal((await place(c, body(), key)).res.status, 200);
                await getActiveProvider().cancelOrder(first.json.id!);
                assert.equal((await place(c)).res.status, 200);
            });
        });
    });

    describe("expiry", () => {
        const at = (minutes: number) => () =>
            new Date(Date.now() + minutes * MINUTE);

        it("cancels past the window only, and emits once", async () => {
            const c = await make();
            const { json } = await place(c);
            const id = json.id!;
            await expireStaleOrders({ registry, now: at(29) });
            assert.equal((await stateOf(id)).state, "OPEN");
            await expireStaleOrders({ registry, now: at(31) });
            assert.equal((await stateOf(id)).state, "CANCELED");
            await expireStaleOrders({ registry, now: at(60) });
            assert.equal(cancelsFor([id]).length, 1);
        });

        it("reads the window from ORDER_EXPIRY_MINUTES", async () => {
            const c = await make();
            const { json } = await place(c);
            process.env.ORDER_EXPIRY_MINUTES = "5";
            try {
                await expireStaleOrders({ registry, now: at(6) });
            } finally {
                delete process.env.ORDER_EXPIRY_MINUTES;
            }
            assert.equal((await stateOf(json.id!)).state, "CANCELED");
        });

        it("skips an invoiced order", async () => {
            const c = await make();
            const { json } = await place(c);
            await drizzleDB
                .update(ordersTable)
                .set({ invoicedAt: new Date() })
                .where(eq(ordersTable.referenceId, json.id!));
            await expireStaleOrders({ registry, now: at(120) });
            assert.equal((await stateOf(json.id!)).state, "OPEN");
            assert.equal(cancelsFor([json.id!]).length, 0);
        });

        it("never expires a staff order or a paid one", async () => {
            const staffRef = `staff-${randomUUID()}`;
            orderRefs.push(staffRef);
            await insertOrder({
                id: staffRef,
                referenceId: staffRef,
                locationId: loc,
                state: "OPEN",
                lineItems: [],
                totalMoney: { amount: 500n, currency: "CAD" },
            });
            const c = await make();
            const { json } = await place(c);
            const paid = await getActiveProvider().payCash(
                json.id!,
                { amount: 500n, currency: "CAD" },
                { amount: 500n, currency: "CAD" },
            );
            assert.ok(paid);
            await expireStaleOrders({ registry, now: at(120) });
            assert.equal((await stateOf(staffRef)).state, "OPEN");
            assert.equal((await stateOf(json.id!)).state, "COMPLETED");
            assert.equal(cancelsFor([staffRef, json.id!]).length, 0);
        });

        it("skips an order with a paid online attempt", async () => {
            const c = await make();
            const { json } = await place(c);
            await pool.query(
                `INSERT INTO "tessellate-online-payments" (id, order_reference, processor_id, kind, external_id, status, amount)
                 VALUES ($1, $2, 'test', 'checkout', $3, 'paid', '{}'::jsonb)`,
                [randomUUID(), json.id, randomUUID()],
            );
            await expireStaleOrders({ registry, now: at(120) });
            assert.equal((await stateOf(json.id!)).state, "OPEN");
        });

        it("cancels once when two passes race", async () => {
            const c = await make();
            const ids = (
                await Promise.all(Array.from({ length: 4 }, () => place(c)))
            ).map((r) => r.json.id!);
            const counts = await Promise.all(
                Array.from({ length: 4 }, () =>
                    expireStaleOrders({ registry, now: at(120) }),
                ),
            );
            assert.ok(counts.reduce((a, b) => a + b, 0) >= ids.length);
            for (const id of ids) {
                assert.equal((await stateOf(id)).state, "CANCELED");
                assert.equal(cancelsFor([id]).length, 1, id);
            }
        });

        it("lets only one concurrent provider cancel win", async () => {
            const c = await make();
            const { json } = await place(c);
            const provider = getActiveProvider();
            const results = await Promise.all([
                provider.cancelOrder(json.id!),
                provider.cancelOrder(json.id!),
                provider.cancelOrder(json.id!),
            ]);
            assert.equal(results.filter(Boolean).length, 1);
        });

        it("queues one order.canceled webhook for subscribers", async () => {
            const hooked = await make({
                scopes: ["orders:read", "orders:write"],
                webhook_url: hookUrl,
            });
            const { json } = await place(hooked);
            await expireStaleOrders({ registry, now: at(120) });
            await expireStaleOrders({ registry, now: at(120) });
            let types: string[] = [];
            for (let i = 0; i < 40; i++) {
                types = (await listDeliveries(hooked.client_id, 10)).map(
                    (d) => d.event_type,
                );
                if (types.includes("order.canceled")) break;
                await new Promise((r) => setTimeout(r, 50));
            }
            assert.equal(types.filter((t) => t === "order.canceled").length, 1);
            assert.equal(cancelsFor([json.id!]).length, 1);
        });
    });

    describe("per-IP limit behind a proxy", () => {
        const ips = ["198.51.100.7", "203.0.113.9", "127.0.0.1"];

        async function ipBuckets(trustProxy: boolean) {
            const app = express();
            app.set("trust proxy", trustProxy);
            app.use((req, _res, next) => {
                req.gatewayCredential = {
                    id: `ip-test-${suffix}`,
                    publishable: true,
                    origins: [],
                    rate_limit_per_minute: 1000,
                };
                next();
            });
            app.use(gatewayRateLimit());
            app.get("/", (_req, res) => {
                res.send("ok");
            });
            const s: Server = await new Promise((resolve) => {
                const x = app.listen(0, "127.0.0.1", () => resolve(x));
            });
            const redis = await getRedisClient();
            try {
                await fetch(
                    `http://127.0.0.1:${(s.address() as AddressInfo).port}/`,
                    { headers: { "x-forwarded-for": "198.51.100.7" } },
                );
                const found: string[] = [];
                for (const ip of ips) {
                    if (await redis!.exists(`gw:rl:ip:${ip}`)) found.push(ip);
                }
                return found;
            } finally {
                s.closeAllConnections();
                await new Promise<void>((r) => s.close(() => r()));
                for (const ip of ips) await redis!.del(`gw:rl:ip:${ip}`);
                await redis!.del(`gw:rl:cred:ip-test-${suffix}`);
            }
        }

        // Other test files share the loopback bucket, so only the forwarded
        // address is asserted exactly.
        it("keys the bucket on the forwarded client when the proxy is trusted", async () => {
            assert.ok((await ipBuckets(true)).includes("198.51.100.7"));
        });

        it("ignores X-Forwarded-For when no proxy is trusted", async () => {
            const found = await ipBuckets(false);
            assert.ok(!found.includes("198.51.100.7"));
            assert.ok(found.includes("127.0.0.1"));
        });
    });
});
