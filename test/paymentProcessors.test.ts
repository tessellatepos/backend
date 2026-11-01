import "@/test/localProvider";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { pool } from "@/services/db/postgres";
import { getRedisClient } from "@/services/redis";
import { createAuth } from "@/services/auth";
import { createApp, mountApiRoutes } from "@/app";
import { TessellatePluginRegistry } from "@/utils/registry/plugin/pluginRegistry";
import { createLocalLocation, removeLocation } from "@/services/db/locations";
import { PaymentProcessorRegistry } from "@/services/processors/registry";
import { processorRegistry } from "@/services/processors/registry";
import { urlConfig } from "@/config/urls";
import { getEnabledProcessorConfig } from "@/services/processors/settings";
import {
    findOnlinePayment,
    insertOnlinePayment,
    listOnlinePayments,
} from "@/services/db/onlinePayments";
import { createTestProcessor, signTestWebhook } from "./fixtures/testProcessor";
import { migrateTestDb } from "./helpers/db";

after(async () => {
    await pool.end();
    await (await getRedisClient())?.quit();
});

const suffix = randomUUID().slice(0, 8);
const SECRET = `sk_live_${randomUUID()}`;

describe("PaymentProcessorRegistry", () => {
    it("registers, gets and lists processors", () => {
        const registry = new PaymentProcessorRegistry();
        registry.register(createTestProcessor("one"));
        registry.register(createTestProcessor("two"));
        assert.equal(registry.get("one")?.id, "one");
        assert.equal(registry.get("missing"), undefined);
        assert.deepEqual(
            registry.list().map((p) => p.id),
            ["one", "two"],
        );
    });

    it("rejects a duplicate id and a malformed id", () => {
        const registry = new PaymentProcessorRegistry();
        registry.register(createTestProcessor("one"));
        assert.throws(
            () => registry.register(createTestProcessor("one")),
            /already registered/,
        );
        assert.throws(
            () => registry.register(createTestProcessor("Bad Id")),
            /Invalid payment processor id/,
        );
    });

    it("lists capabilities without leaking the processor object", () => {
        const registry = new PaymentProcessorRegistry();
        registry.register(createTestProcessor("one"));
        assert.deepEqual(registry.list()[0], {
            id: "one",
            label: "Test processor",
            capabilities: { checkout: true, invoice: false },
        });
    });
});

describe("test processor contract", () => {
    const processor = createTestProcessor();
    const webhook = (body: object, signature?: string) => {
        const raw = JSON.stringify(body);
        return {
            headers: { "x-test-signature": signature ?? signTestWebhook(raw) },
            rawBody: Buffer.from(raw),
            url: "https://shop.example.test/webhooks/test",
        };
    };

    it("creates a hosted checkout without card data", async () => {
        const result = await processor.createCheckout!({
            order: { locationId: "L1", discounts: [] },
            successUrl: "https://shop.example.test/done",
            cancelUrl: "https://shop.example.test/cancel",
        });
        assert.match(result.externalId, /^chk_/);
        assert.ok(result.url.startsWith("https://"));
    });

    it("turns a signed webhook into events", async () => {
        const events = await processor.handleWebhook(
            webhook({ id: "evt_1", external_id: "chk_1", status: "paid" }),
        );
        assert.deepEqual(events, [
            {
                id: "evt_1",
                type: "payment.updated",
                kind: "checkout",
                external_id: "chk_1",
                status: "paid",
            },
        ]);
    });

    it("rejects unsigned and wrongly signed webhooks", async () => {
        await assert.rejects(
            processor.handleWebhook({
                headers: {},
                rawBody: Buffer.from("{}"),
                url: "",
            }),
            /Invalid webhook signature/,
        );
        await assert.rejects(
            processor.handleWebhook(webhook({ id: "evt_2" }, "00")),
            /Invalid webhook signature/,
        );
    });

    it("gives a redelivered webhook the same event id, so the host can dedupe", async () => {
        const body = { id: "evt_3", external_id: "chk_3", status: "paid" };
        const first = await processor.handleWebhook(webhook(body));
        const second = await processor.handleWebhook(webhook(body));
        assert.equal(first[0].id, second[0].id);
    });
});

describe("payment processor settings and payments table", () => {
    let server: Server;
    let url: string;
    let locationId: string;
    let otherLocationId: string;
    const cookies: Record<string, string> = {};
    const orderRefs: string[] = [];

    before(async () => {
        await migrateTestDb();
        if (!processorRegistry.get("test")) {
            processorRegistry.register(createTestProcessor());
        }
        locationId = (
            await createLocalLocation({
                name: `Payments ${suffix}`,
                currency: "CAD",
                country: "CA",
            })
        ).id;
        otherLocationId = (
            await createLocalLocation({
                name: `Payments other ${suffix}`,
                currency: "CAD",
                country: "CA",
            })
        ).id;
        const auth = createAuth();
        for (const role of ["viewer", "manager", "owner"]) {
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
        server = await new Promise((resolve) => {
            const s = app.listen(0, "127.0.0.1", () => resolve(s));
        });
        url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    after(async () => {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        for (const ref of orderRefs) {
            await pool.query(
                `DELETE FROM "tessellate-orders" WHERE reference_id = $1`,
                [ref],
            );
        }
        await pool.query(
            `DELETE FROM "tessellate-payment-processor-settings" WHERE location_id = ANY($1)`,
            [[locationId, otherLocationId]],
        );
        await pool.query(
            `DELETE FROM "tessellate-auth-user" WHERE email LIKE $1`,
            [`%-${suffix}@example.test`],
        );
        await removeLocation(locationId);
        await removeLocation(otherLocationId);
    });

    const call = (method: string, path: string, role?: string, body?: object) =>
        fetch(url + path, {
            method,
            headers: {
                "content-type": "application/json",
                ...(role ? { cookie: cookies[role] } : {}),
            },
            body: body === undefined ? undefined : JSON.stringify(body),
        });

    const configure = (role?: string, body: object = {}) =>
        call(
            "PUT",
            `/api/v1/payments/processors/test/locations/${locationId}`,
            role,
            body,
        );

    it("answers 401 without a session and 403 below owner for writes", async () => {
        assert.equal(
            (
                await call(
                    "GET",
                    `/api/v1/payments/processors?location_id=${locationId}`,
                )
            ).status,
            401,
        );
        assert.equal(
            (await configure(undefined, { enabled: true })).status,
            401,
        );
        assert.equal(
            (await configure("manager", { enabled: true })).status,
            403,
        );
        assert.equal(
            (await configure("viewer", { enabled: true })).status,
            403,
        );
    });

    it("reports the webhook URL and availability only over https", async () => {
        const list = `/api/v1/payments/processors?location_id=${locationId}`;
        const original = urlConfig.publicUrl;
        try {
            urlConfig.publicUrl = null;
            let status = await (
                await call("GET", "/api/v1/payments/status", "manager")
            ).json();
            assert.deepEqual(status, {
                online_payments_available: false,
                public_url: null,
            });
            let items = await (await call("GET", list, "owner")).json();
            assert.equal(items[0].webhook_url, null);

            urlConfig.publicUrl = "http://shop.example.test";
            status = await (
                await call("GET", "/api/v1/payments/status", "manager")
            ).json();
            assert.equal(status.online_payments_available, false);

            urlConfig.publicUrl = "https://shop.example.test";
            status = await (
                await call("GET", "/api/v1/payments/status", "manager")
            ).json();
            assert.deepEqual(status, {
                online_payments_available: true,
                public_url: "https://shop.example.test",
            });
            items = await (await call("GET", list, "owner")).json();
            assert.equal(
                items[0].webhook_url,
                `https://shop.example.test/webhooks/${items[0].id}`,
            );
        } finally {
            urlConfig.publicUrl = original;
        }
        assert.equal(
            (await call("GET", "/api/v1/payments/status")).status,
            401,
        );
        assert.equal(
            (await call("GET", "/api/v1/payments/status", "viewer")).status,
            403,
        );
    });

    it("lets a manager list but a viewer not", async () => {
        const path = `/api/v1/payments/processors?location_id=${locationId}`;
        assert.equal((await call("GET", path, "manager")).status, 200);
        assert.equal((await call("GET", path, "viewer")).status, 403);
    });

    it("requires a location and answers 404 for unknown ones", async () => {
        assert.equal(
            (await call("GET", "/api/v1/payments/processors", "owner")).status,
            400,
        );
        assert.equal(
            (
                await call(
                    "GET",
                    "/api/v1/payments/processors?location_id=nope",
                    "owner",
                )
            ).status,
            404,
        );
        const res = await call(
            "PUT",
            `/api/v1/payments/processors/missing/locations/${locationId}`,
            "owner",
            { enabled: true },
        );
        assert.equal(res.status, 404);
    });

    it("stores config encrypted and never returns it", async () => {
        const res = await configure("owner", {
            enabled: true,
            config: { apiKey: SECRET },
        });
        assert.equal(res.status, 200);
        const text = await res.text();
        assert.ok(!text.includes(SECRET), "secret leaked in PUT response");
        const body = JSON.parse(text);
        assert.equal(body.enabled, true);
        assert.equal(body.configured, true);
        assert.deepEqual(body.configured_keys, ["apiKey"]);

        const list = await call(
            "GET",
            `/api/v1/payments/processors?location_id=${locationId}`,
            "owner",
        );
        assert.ok(!(await list.text()).includes(SECRET));

        const { rows } = await pool.query(
            `SELECT config_encrypted FROM "tessellate-payment-processor-settings" WHERE location_id = $1`,
            [locationId],
        );
        assert.ok(rows[0].config_encrypted);
        assert.ok(!rows[0].config_encrypted.includes(SECRET));

        assert.deepEqual(await getEnabledProcessorConfig("test", locationId), {
            apiKey: SECRET,
        });
    });

    it("merges config keys and keeps them when only toggling", async () => {
        await configure("owner", { config: { webhookKey: "wk" } });
        const res = await configure("owner", { enabled: false });
        const body = await res.json();
        assert.deepEqual(body.configured_keys.sort(), ["apiKey", "webhookKey"]);
        assert.equal(await getEnabledProcessorConfig("test", locationId), null);
    });

    it("does not log the secret", async () => {
        const lines: string[] = [];
        const original = process.stdout.write.bind(process.stdout);
        process.stdout.write = ((chunk: string | Uint8Array) => {
            lines.push(String(chunk));
            return true;
        }) as typeof process.stdout.write;
        try {
            await configure("owner", { config: { apiKey: SECRET } });
            await configure("owner", { config: { apiKey: "" } });
        } finally {
            process.stdout.write = original;
        }
        assert.ok(!lines.join("").includes(SECRET));
    });

    it("rejects bad input", async () => {
        for (const body of [
            { enabled: "yes" },
            { config: "x" },
            { config: { "bad key": "v" } },
            { config: { apiKey: 5 } },
            { config: { apiKey: "" } },
            { extra: 1 },
        ]) {
            assert.equal(
                (await configure("owner", body)).status,
                400,
                JSON.stringify(body),
            );
        }
    });

    describe("online payments table", () => {
        async function makeOrder(): Promise<string> {
            const ref = `ord-${randomUUID()}`;
            await pool.query(
                `INSERT INTO "tessellate-orders" (reference_id, location_id, discounts) VALUES ($1, $2, '[]')`,
                [ref, locationId],
            );
            orderRefs.push(ref);
            return ref;
        }
        const attempt = (
            order: string,
            externalId: string,
            processor = "test",
        ) => ({
            id: `pay-${randomUUID()}`,
            order_reference: order,
            processor_id: processor,
            kind: "checkout",
            external_id: externalId,
            status: "created",
            amount: { amount: "1250", currency: "CAD" },
        });

        it("stores several attempts per order", async () => {
            const order = await makeOrder();
            await insertOnlinePayment(attempt(order, `chk_${randomUUID()}`));
            await insertOnlinePayment(attempt(order, `chk_${randomUUID()}`));
            assert.equal((await listOnlinePayments(order)).length, 2);
        });

        it("rejects a duplicate (processor, external id) but allows it across processors", async () => {
            const order = await makeOrder();
            const external = `chk_${randomUUID()}`;
            await insertOnlinePayment(attempt(order, external));
            await assert.rejects(insertOnlinePayment(attempt(order, external)));
            await insertOnlinePayment(attempt(order, external, "other"));
            assert.equal(
                (await findOnlinePayment("test", external))?.order_reference,
                order,
            );
        });

        it("rejects an attempt for an unknown order", async () => {
            await assert.rejects(
                insertOnlinePayment(
                    attempt("no-such-order", `chk_${randomUUID()}`),
                ),
            );
        });

        it("deletes attempts with their order", async () => {
            const order = await makeOrder();
            const external = `chk_${randomUUID()}`;
            await insertOnlinePayment(attempt(order, external));
            await pool.query(
                `DELETE FROM "tessellate-orders" WHERE reference_id = $1`,
                [order],
            );
            assert.equal(await findOnlinePayment("test", external), null);
        });
    });
});
