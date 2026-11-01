import "@/test/localProvider";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { eq, inArray } from "drizzle-orm";
import { events, hooks } from "@tessellatepos/plugin-sdk/server";
import { drizzleDB, pool } from "@/services/db/postgres";
import { createLocalLocation, removeLocation } from "@/services/db/locations";
import { createCredential } from "@/services/credentials";
import { getRedisClient } from "@/services/redis";
import {
    catalogItemVariationsTable,
    catalogItemsTable,
    onlinePaymentsTable,
    ordersTable,
} from "@/services/db/schema";
import { insertOrder } from "@/services/db/orders";
import { listOnlinePayments } from "@/services/db/onlinePayments";
import { listDeliveries } from "@/services/db/webhookDeliveries";
import { createApp, mountApiRoutes } from "@/app";
import { TessellatePluginRegistry } from "@/utils/registry/plugin/pluginRegistry";
import { processorRegistry } from "@/services/processors/registry";
import { PaymentProcessorRegistry } from "@/services/processors/registry";
import { updateProcessorSettings } from "@/services/processors/settings";
import { checkoutDeps, startCheckout } from "@/services/onlineOrders";
import { migrateTestDb } from "./helpers/db";
import { createTestProcessor, signTestWebhook } from "./fixtures/testProcessor";

const suffix = randomUUID().slice(0, 8);
const ORIGIN = "https://shop.example.test";
const SUCCESS = `${ORIGIN}/thanks`;
const CANCEL = `${ORIGIN}/cart`;
const TEST_PROCESSOR = "test";
const BROKEN_PROCESSOR = "broken";

after(async () => {
    await pool.end();
    await (await getRedisClient())?.quit();
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- responses are untyped JSON
type Json = Record<string, any>;
type Cred = { client_id: string; client_secret: string };

describe("gateway online orders", () => {
    let server: Server;
    let url: string;
    let locA: string;
    let locB: string;
    let registry: TessellatePluginRegistry;
    let hook: http.Server;
    let hookUrl: string;
    const emitted: { name: string; args: unknown[] }[] = [];
    const checkoutHooks: unknown[] = [];
    let blockCheckout: string | null = null;
    const credentials: string[] = [];
    const orderRefs: string[] = [];
    const itemIds = [`on-${suffix}`, `pos-${suffix}`, `mixed-${suffix}`];
    let writer: Cred;
    let other: Cred;
    let atB: Cred;
    let reader: Cred;
    const realAvailable = checkoutDeps.available;

    const ON = `on-var-${suffix}`;
    const POS = `pos-var-${suffix}`;
    const MIXED = `mixed-var-${suffix}`;

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
        await drizzleDB.insert(catalogItemsTable).values([
            {
                id: itemIds[0],
                name: "online",
                origin: "local",
                channels: ["pos", "online"],
            },
            { id: itemIds[1], name: "pos only", origin: "local" },
            {
                id: itemIds[2],
                name: "mixed",
                origin: "local",
                channels: ["online"],
            },
        ]);
        const price = { amount: "500", currency: "CAD" };
        await drizzleDB.insert(catalogItemVariationsTable).values([
            {
                variationId: ON,
                itemId: itemIds[0],
                pricingType: "FIXED",
                priceMoney: price,
            },
            {
                variationId: POS,
                itemId: itemIds[1],
                pricingType: "FIXED",
                priceMoney: price,
            },
            {
                variationId: MIXED,
                itemId: itemIds[2],
                pricingType: "FIXED",
                priceMoney: price,
                channels: ["pos"],
            },
        ]);

        processorRegistry.register(createTestProcessor(TEST_PROCESSOR));
        processorRegistry.register({
            ...createTestProcessor(BROKEN_PROCESSOR),
            async createCheckout() {
                throw new Error("upstream said: secret detail");
            },
        });
        for (const id of [TEST_PROCESSOR, BROKEN_PROCESSOR]) {
            await updateProcessorSettings(id, locA, { enabled: true });
        }
        checkoutDeps.available = () => true;

        registry = new TessellatePluginRegistry();
        const emit = registry.emit.bind(registry);
        registry.emit = ((def: { name: string }, ...args: unknown[]) => {
            emitted.push({ name: def.name, args });
            (emit as (d: unknown, ...a: unknown[]) => void)(def, ...args);
        }) as typeof registry.emit;
        const runHook = registry.runHook.bind(registry);
        registry.runHook = (async (
            def: { name: string },
            input: unknown,
            ...rest: unknown[]
        ) => {
            if (def.name === hooks.beforeCheckout.name) {
                checkoutHooks.push(input);
                if (blockCheckout) {
                    return { ok: false, reason: blockCheckout };
                }
            }
            return (runHook as (...a: unknown[]) => unknown)(
                def,
                input,
                ...rest,
            );
        }) as typeof registry.runHook;

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

        writer = await make("Online store", [locA], {
            webhook_url: hookUrl,
        });
        other = await make("Other store", [locA]);
        atB = await make("B store", [locB]);
        reader = await make("Reader", [locA], {}, ["orders:read"]);
    });

    after(async () => {
        checkoutDeps.available = realAvailable;
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
        await pool.query(
            `DELETE FROM "tessellate-payment-processor-settings" WHERE location_id = ANY($1)`,
            [[locA, locB]],
        );
        await removeLocation(locA);
        await removeLocation(locB);
        await drizzleDB
            .delete(catalogItemVariationsTable)
            .where(inArray(catalogItemVariationsTable.itemId, itemIds));
        await drizzleDB
            .delete(catalogItemsTable)
            .where(inArray(catalogItemsTable.id, itemIds));
    });

    async function make(
        name: string,
        locations: string[],
        overrides: Record<string, unknown> = {},
        scopes: string[] = ["orders:read", "orders:write"],
    ): Promise<Cred> {
        const result = await createCredential(
            {
                name: `${name} ${suffix}`,
                scopes,
                location_ids: locations,
                origins: [ORIGIN],
                ...overrides,
            } as never,
            "owner-user",
        );
        credentials.push(result.client_id);
        return result;
    }

    const basic = (c: Cred) =>
        `Basic ${Buffer.from(`${c.client_id}:${c.client_secret}`).toString("base64")}`;

    async function call(
        method: string,
        path: string,
        c: Cred | null,
        body?: unknown,
    ) {
        const res = await fetch(`${url}/gateway/v1${path}`, {
            method,
            headers: {
                "content-type": "application/json",
                ...(c ? { authorization: basic(c) } : {}),
            },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        const text = await res.text();
        return {
            status: res.status,
            json: text ? (JSON.parse(text) as Json) : {},
        };
    }

    async function place(c: Cred = writer, variation = ON) {
        const result = await call("POST", "/orders", c, {
            line_items: [{ variation_id: variation, quantity: "2" }],
        });
        if (result.json.id) orderRefs.push(result.json.id);
        return result;
    }

    const checkoutBody = (processor = TEST_PROCESSOR) => ({
        processor,
        success_url: SUCCESS,
        cancel_url: CANCEL,
    });

    async function webhook(
        externalId: string,
        status: "paid" | "expired" | "failed",
        id = `evt_${randomUUID()}`,
    ) {
        const raw = JSON.stringify({ id, external_id: externalId, status });
        return fetch(`${url}/webhooks/${TEST_PROCESSOR}`, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "x-test-signature": signTestWebhook(raw),
            },
            body: raw,
        });
    }

    const rowOf = async (ref: string) =>
        (
            await drizzleDB
                .select()
                .from(ordersTable)
                .where(eq(ordersTable.referenceId, ref))
        )[0];

    const emittedFor = (name: string, ref: string) =>
        emitted.filter(
            (e) =>
                e.name === name &&
                (e.args[0] as { id?: string } | undefined)?.id === ref,
        );

    describe("creating an order", () => {
        it("refuses a variation that is not sold online, and creates nothing", async () => {
            const before = await drizzleDB.select().from(ordersTable);
            for (const variation of [POS, MIXED]) {
                const res = await place(writer, variation);
                assert.equal(res.status, 400);
                assert.equal(res.json.code, "item_not_online");
                assert.match(res.json.message, /not sold online/);
            }
            const unknown = await place(writer, `nope-${suffix}`);
            assert.equal(unknown.status, 400);
            assert.equal(unknown.json.code, "unknown_variation");
            const mixedLines = await call("POST", "/orders", writer, {
                line_items: [
                    { variation_id: ON, quantity: "1" },
                    { variation_id: POS, quantity: "1" },
                ],
            });
            assert.equal(mixedLines.status, 400);
            assert.equal(mixedLines.json.code, "item_not_online");
            assert.equal(
                (await drizzleDB.select().from(ordersTable)).length,
                before.length,
            );
        });

        it("answers with an unpaid payment status", async () => {
            const { status, json } = await place();
            assert.equal(status, 200);
            assert.equal(json.payment_status, "unpaid");
            assert.equal(json.latest_payment, null);
            assert.equal(json.source.name, `Online store ${suffix}`);
            assert.equal(json.totalMoney.amount, "1000");
        });
    });

    describe("hosted checkout to paid", () => {
        let ref: string;
        let externalId: string;

        it("starts a checkout and records the attempt", async () => {
            ref = (await place()).json.id;
            checkoutHooks.length = 0;
            const res = await call(
                "POST",
                `/orders/${ref}/checkout`,
                writer,
                checkoutBody(),
            );
            assert.equal(res.status, 200, JSON.stringify(res.json));
            assert.equal(res.json.processor, TEST_PROCESSOR);
            assert.equal(res.json.expires_at, null);
            const target = new URL(res.json.url);
            externalId = target.pathname.slice(1);
            const [attempt] = await listOnlinePayments(ref);
            assert.equal(attempt.external_id, externalId);
            assert.equal(attempt.processor_id, TEST_PROCESSOR);
            assert.equal(attempt.kind, "checkout");
            assert.equal(attempt.status, "created");
            assert.equal(attempt.url, res.json.url);
            assert.deepEqual(attempt.amount, {
                amount: "1000",
                currency: "CAD",
            });
            assert.equal(res.json.payment_id, attempt.id);
        });

        it("runs beforeCheckout with the principal and source", () => {
            assert.equal(checkoutHooks.length, 1);
            const input = checkoutHooks[0] as Json;
            assert.equal(input.orderId, ref);
            assert.equal(input.processor, TEST_PROCESSOR);
            assert.equal(input.source, `Online store ${suffix}`);
            assert.equal(input.principal.kind, "credential");
            assert.equal(input.principal.id, writer.client_id);
            assert.equal(input.amount.amount, 1000n);
        });

        it("shows the order as processing, with the latest attempt and no secrets", async () => {
            const res = await call("GET", `/orders/${ref}`, writer);
            assert.equal(res.status, 200);
            assert.equal(res.json.payment_status, "processing");
            assert.equal(res.json.state, "OPEN");
            const attempt = res.json.latest_payment;
            assert.equal(attempt.processor, TEST_PROCESSOR);
            assert.equal(attempt.status, "created");
            assert.equal(attempt.amount.amount, "1000");
            assert.equal("external_id" in attempt, false);
            assert.equal("tenders" in res.json, false);
        });

        it("completes the order on a signed paid webhook", async () => {
            const res = await webhook(externalId, "paid");
            assert.equal(res.status, 200);
            const got = await call("GET", `/orders/${ref}`, writer);
            assert.equal(got.json.state, "COMPLETED");
            assert.equal(got.json.payment_status, "paid");
            assert.equal(got.json.latest_payment.status, "paid");
            assert.equal(
                emittedFor(events.paymentCompleted.name, ref).length,
                1,
            );
        });

        it("queues one order.paid webhook for subscribers", async () => {
            let types: string[] = [];
            for (let i = 0; i < 40; i++) {
                types = (await listDeliveries(writer.client_id, 20)).map(
                    (d) => d.event_type,
                );
                if (types.includes("order.paid")) break;
                await new Promise((r) => setTimeout(r, 50));
            }
            assert.equal(types.filter((t) => t === "order.paid").length, 1);
        });

        it("does not complete or announce twice when the webhook repeats", async () => {
            await webhook(externalId, "paid");
            assert.equal(
                emittedFor(events.paymentCompleted.name, ref).length,
                1,
            );
        });

        it("refuses to cancel or check out a paid order", async () => {
            const cancel = await call("POST", `/orders/${ref}/cancel`, writer);
            assert.equal(cancel.status, 409);
            assert.equal(cancel.json.code, "order_not_cancellable");
            const again = await call(
                "POST",
                `/orders/${ref}/checkout`,
                writer,
                checkoutBody(),
            );
            assert.equal(again.status, 409);
            assert.equal(again.json.code, "order_not_payable");
            assert.equal((await rowOf(ref)).state, "COMPLETED");
        });
    });

    describe("checking out twice", () => {
        it("returns the live page again, and starts a new one after expiry", async () => {
            const ref = (await place()).json.id;
            const first = await call(
                "POST",
                `/orders/${ref}/checkout`,
                writer,
                checkoutBody(),
            );
            const second = await call(
                "POST",
                `/orders/${ref}/checkout`,
                writer,
                checkoutBody(),
            );
            assert.equal(second.status, 200);
            assert.equal(second.json.url, first.json.url);
            assert.equal(second.json.payment_id, first.json.payment_id);
            assert.equal((await listOnlinePayments(ref)).length, 1);

            await drizzleDB
                .update(onlinePaymentsTable)
                .set({ expires_at: new Date(Date.now() - 1000) })
                .where(eq(onlinePaymentsTable.order_reference, ref));
            const expired = await call("GET", `/orders/${ref}`, writer);
            assert.equal(expired.json.payment_status, "unpaid");

            const third = await call(
                "POST",
                `/orders/${ref}/checkout`,
                writer,
                checkoutBody(),
            );
            assert.equal(third.status, 200);
            assert.notEqual(third.json.url, first.json.url);
            const attempts = await listOnlinePayments(ref);
            assert.equal(attempts.length, 2);
            assert.notEqual(attempts[0].external_id, attempts[1].external_id);
        });

        it("keeps an order paid when a late event for an older attempt arrives", async () => {
            const ref = (await place()).json.id;
            await call(
                "POST",
                `/orders/${ref}/checkout`,
                writer,
                checkoutBody(),
            );
            const [old] = await listOnlinePayments(ref);
            await drizzleDB
                .update(onlinePaymentsTable)
                .set({ expires_at: new Date(Date.now() - 1000) })
                .where(eq(onlinePaymentsTable.id, old.id));
            await call(
                "POST",
                `/orders/${ref}/checkout`,
                writer,
                checkoutBody(),
            );
            await webhook(old.external_id, "paid");
            const got = await call("GET", `/orders/${ref}`, writer);
            assert.equal(got.json.payment_status, "paid");
            assert.equal(got.json.state, "COMPLETED");
        });

        it("reports a failed attempt as failed", async () => {
            const ref = (await place()).json.id;
            await call(
                "POST",
                `/orders/${ref}/checkout`,
                writer,
                checkoutBody(),
            );
            const [attempt] = await listOnlinePayments(ref);
            await webhook(attempt.external_id, "failed");
            const got = await call("GET", `/orders/${ref}`, writer);
            assert.equal(got.json.payment_status, "failed");
            assert.equal(got.json.state, "OPEN");
        });
    });

    describe("refusals", () => {
        let ref: string;
        before(async () => {
            ref = (await place()).json.id;
        });

        it("rejects return URLs outside the credential's origins", async () => {
            const bad = [
                "https://evil.example.test/thanks",
                "http://shop.example.test/thanks",
                "https://shop.example.test:8443/thanks",
                "https://user:pw@shop.example.test/thanks",
                "https://shop.example.test.evil.test/thanks",
            ];
            for (const target of bad) {
                for (const field of ["success_url", "cancel_url"]) {
                    const res = await call(
                        "POST",
                        `/orders/${ref}/checkout`,
                        writer,
                        { ...checkoutBody(), [field]: target },
                    );
                    assert.equal(res.status, 400, `${field} ${target}`);
                    assert.equal(res.json.code, "url_origin_not_allowed");
                }
            }
            assert.equal((await listOnlinePayments(ref)).length, 0);
        });

        it("rejects a malformed checkout request", async () => {
            for (const body of [
                {},
                { ...checkoutBody(), extra: 1 },
                { ...checkoutBody(), success_url: "not a url" },
                { ...checkoutBody(), processor: "Bad Id" },
            ]) {
                const res = await call(
                    "POST",
                    `/orders/${ref}/checkout`,
                    writer,
                    body,
                );
                assert.equal(res.status, 400);
                assert.equal(res.json.code, "invalid_request");
            }
        });

        it("rejects an unknown processor", async () => {
            const res = await call(
                "POST",
                `/orders/${ref}/checkout`,
                writer,
                checkoutBody("nope"),
            );
            assert.equal(res.status, 400);
            assert.equal(res.json.code, "unknown_processor");
        });

        it("says so when the processor is disabled at the order's location", async () => {
            await updateProcessorSettings(TEST_PROCESSOR, locA, {
                enabled: false,
            });
            try {
                const res = await call(
                    "POST",
                    `/orders/${ref}/checkout`,
                    writer,
                    checkoutBody(),
                );
                assert.equal(res.status, 409);
                assert.equal(res.json.code, "processor_disabled");
                assert.equal((await listOnlinePayments(ref)).length, 0);
            } finally {
                await updateProcessorSettings(TEST_PROCESSOR, locA, {
                    enabled: true,
                });
            }
        });

        it("says so when online payments are not available", async () => {
            checkoutDeps.available = () => false;
            try {
                const res = await call(
                    "POST",
                    `/orders/${ref}/checkout`,
                    writer,
                    checkoutBody(),
                );
                assert.equal(res.status, 409);
                assert.equal(res.json.code, "online_payments_unavailable");
                assert.match(res.json.message, /PUBLIC_URL/);
            } finally {
                checkoutDeps.available = () => true;
            }
        });

        it("answers pay at pickup when no processor is registered", async () => {
            const row = await rowOf(ref);
            const outcome = await startCheckout({
                row,
                processorId: TEST_PROCESSOR,
                successUrl: SUCCESS,
                cancelUrl: CANCEL,
                caller: {
                    credentialId: writer.client_id,
                    locationIds: [locA],
                    origins: [ORIGIN],
                    principal: { kind: "credential", id: writer.client_id },
                },
                plugins: registry,
                registry: new PaymentProcessorRegistry(),
            });
            assert.equal(outcome.ok, false);
            if (!outcome.ok) {
                assert.equal(outcome.status, 409);
                assert.equal(outcome.code, "pay_at_pickup");
            }
        });

        it("keeps a processor failure generic and records nothing", async () => {
            const res = await call(
                "POST",
                `/orders/${ref}/checkout`,
                writer,
                checkoutBody(BROKEN_PROCESSOR),
            );
            assert.equal(res.status, 502);
            assert.equal(res.json.code, "processor_error");
            assert.doesNotMatch(JSON.stringify(res.json), /secret detail/);
            assert.equal((await listOnlinePayments(ref)).length, 0);
        });

        it("lets a plugin block the checkout", async () => {
            blockCheckout = "Closed for stocktake";
            try {
                const res = await call(
                    "POST",
                    `/orders/${ref}/checkout`,
                    writer,
                    checkoutBody(),
                );
                assert.equal(res.status, 400);
                assert.equal(res.json.code, "checkout_blocked");
                assert.equal(res.json.message, "Closed for stocktake");
                assert.equal((await listOnlinePayments(ref)).length, 0);
            } finally {
                blockCheckout = null;
            }
        });

        it("needs a credential with the right scope", async () => {
            assert.equal(
                (
                    await call(
                        "POST",
                        `/orders/${ref}/checkout`,
                        null,
                        checkoutBody(),
                    )
                ).status,
                401,
            );
            for (const path of ["checkout", "cancel"]) {
                const res = await call(
                    "POST",
                    `/orders/${ref}/${path}`,
                    reader,
                    checkoutBody(),
                );
                assert.equal(res.status, 403, path);
                assert.equal(res.json.code, "missing_scope");
            }
            assert.equal((await call("GET", "/orders", reader)).status, 200);
        });
    });

    describe("who can reach an order", () => {
        let ref: string;
        let staffRef: string;
        before(async () => {
            ref = (await place()).json.id;
            staffRef = `staff-${suffix}`;
            await insertOrder({
                id: staffRef,
                referenceId: staffRef,
                locationId: locA,
                state: "OPEN",
                lineItems: [],
                discounts: [],
                totalMoney: { amount: 500n, currency: "CAD" },
            });
            orderRefs.push(staffRef);
        });

        it("hides the order from another credential, even at the same location", async () => {
            for (const who of [other, atB]) {
                assert.equal(
                    (await call("GET", `/orders/${ref}`, who)).status,
                    404,
                );
                assert.equal(
                    (
                        await call(
                            "POST",
                            `/orders/${ref}/checkout`,
                            who,
                            checkoutBody(),
                        )
                    ).status,
                    404,
                );
                assert.equal(
                    (await call("POST", `/orders/${ref}/cancel`, who)).status,
                    404,
                );
            }
            assert.equal((await rowOf(ref)).state, "OPEN");
            assert.equal((await listOnlinePayments(ref)).length, 0);
        });

        it("hides orders that staff or another system created", async () => {
            assert.equal(
                (await call("GET", `/orders/${staffRef}`, writer)).status,
                404,
            );
            assert.equal(
                (await call("POST", `/orders/${staffRef}/cancel`, writer))
                    .status,
                404,
            );
            assert.equal((await rowOf(staffRef)).state, "OPEN");
        });

        it("answers the same for a missing order", async () => {
            const missing = await call("GET", "/orders/does-not-exist", writer);
            const foreign = await call("GET", `/orders/${ref}`, other);
            assert.equal(missing.status, 404);
            assert.deepEqual(missing.json, foreign.json);
        });

        it("does not serve the gateway-only routes to a staff caller", async () => {
            for (const [method, path] of [
                ["GET", "/api/v1/orders/online"],
                ["POST", `/api/v1/orders/${ref}/cancel`],
                ["POST", `/api/v1/orders/${ref}/online-checkout`],
            ]) {
                const res = await fetch(`${url}${path}`, { method });
                assert.ok([401, 403, 404].includes(res.status), path);
            }
        });

        it("lists only the credential's own orders, newest first, in pages", async () => {
            const mine = [(await place()).json.id, (await place()).json.id];
            const theirs = (await place(other)).json.id;
            const seen: string[] = [];
            let cursor: string | null = null;
            let pages = 0;
            do {
                const query: string =
                    "?limit=2" + (cursor ? `&cursor=${cursor}` : "");
                const res = await call("GET", `/orders${query}`, writer);
                assert.equal(res.status, 200);
                assert.ok(res.json.orders.length <= 2);
                for (const order of res.json.orders) {
                    seen.push(order.id);
                    assert.ok(order.payment_status);
                }
                cursor = res.json.next_cursor;
                pages++;
            } while (cursor && pages < 20);
            assert.ok(pages > 1);
            assert.equal(new Set(seen).size, seen.length);
            for (const id of mine) assert.ok(seen.includes(id));
            assert.ok(!seen.includes(theirs));
            assert.ok(!seen.includes(staffRef));
            assert.ok(seen.indexOf(mine[1]) < seen.indexOf(mine[0]));

            const none = await call("GET", "/orders", atB);
            assert.deepEqual(none.json.orders, []);
            assert.equal(
                (await call("GET", "/orders?cursor=bad", writer)).status,
                400,
            );
            assert.equal(
                (await call("GET", "/orders?bogus=1", writer)).status,
                400,
            );
        });
    });

    describe("cancelling", () => {
        it("cancels an unpaid order once and announces it once", async () => {
            const ref = (await place()).json.id;
            const first = await call("POST", `/orders/${ref}/cancel`, writer);
            assert.equal(first.status, 200, JSON.stringify(first.json));
            assert.equal(first.json.state, "CANCELED");
            assert.equal(first.json.payment_status, "unpaid");
            const again = await call("POST", `/orders/${ref}/cancel`, writer);
            assert.equal(again.status, 200);
            assert.equal(again.json.state, "CANCELED");
            assert.equal(emittedFor(events.orderCancelled.name, ref).length, 1);

            const checkout = await call(
                "POST",
                `/orders/${ref}/checkout`,
                writer,
                checkoutBody(),
            );
            assert.equal(checkout.status, 409);
            assert.equal(checkout.json.code, "order_not_payable");
        });

        it("refuses an order that has a tender or was invoiced", async () => {
            const ref = (await place()).json.id;
            await drizzleDB
                .update(ordersTable)
                .set({ invoicedAt: new Date() })
                .where(eq(ordersTable.referenceId, ref));
            const invoiced = await call(
                "POST",
                `/orders/${ref}/cancel`,
                writer,
            );
            assert.equal(invoiced.status, 409);
            assert.equal(invoiced.json.code, "order_invoiced");

            await drizzleDB
                .update(ordersTable)
                .set({
                    invoicedAt: null,
                    tenders: [
                        {
                            id: "t1",
                            type: "CASH",
                            amountMoney: { amount: "1000", currency: "CAD" },
                        },
                    ],
                })
                .where(eq(ordersTable.referenceId, ref));
            const paid = await call("POST", `/orders/${ref}/cancel`, writer);
            assert.equal(paid.status, 409);
            assert.equal(paid.json.code, "order_not_cancellable");
            assert.equal((await rowOf(ref)).state, "OPEN");
        });
    });

    describe("documentation", () => {
        it("lists the new operations and the Idempotency-Key header", async () => {
            const res = await call("GET", "/openapi.json", writer);
            assert.equal(res.status, 200);
            const paths = res.json.paths as Json;
            assert.equal(paths["/orders"].get.operationId, "orders.list");
            assert.equal(
                paths["/orders/{orderId}"].get.operationId,
                "orders.get",
            );
            assert.equal(
                paths["/orders/{orderId}/checkout"].post.operationId,
                "orders.checkout",
            );
            assert.equal(
                paths["/orders/{orderId}/cancel"].post.operationId,
                "orders.cancel",
            );
            const create = paths["/orders"].post;
            const header = create.parameters.find(
                (p: { name: string }) => p.name === "Idempotency-Key",
            );
            assert.equal(header.in, "header");
            assert.ok(create.responses["422"]);
            assert.ok(create.responses["200"].headers["Idempotent-Replayed"]);
            const order =
                create.responses["200"].content["application/json"].schema;
            assert.ok(order.properties.payment_status);
            assert.ok(order.properties.latest_payment);
        });

        it("hides the write operations from a read-only credential", async () => {
            const res = await call("GET", "/openapi.json", reader);
            const paths = res.json.paths as Json;
            assert.ok(paths["/orders"].get);
            assert.equal(paths["/orders"].post, undefined);
            assert.equal(paths["/orders/{orderId}/checkout"], undefined);
        });
    });
});
