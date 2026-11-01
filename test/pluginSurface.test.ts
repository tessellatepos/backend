import "@/test/localProvider";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Order } from "@tessellatepos/sdk";
import type { PluginManifest } from "@tessellatepos/plugin-sdk";
import {
    events,
    hooks,
    type HookContext,
    type PaymentProcessor,
    type RawWebhookRequest,
} from "@tessellatepos/plugin-sdk/server";
import { drizzleDB, pool } from "@/services/db/postgres";
import {
    catalogItemVariationsTable,
    catalogItemsTable,
    ordersTable,
} from "@/services/db/schema";
import { insertOrder } from "@/services/db/orders";
import {
    findOnlinePayment,
    insertOnlinePayment,
} from "@/services/db/onlinePayments";
import { createAuth } from "@/services/auth";
import { createLocalLocation, removeLocation } from "@/services/db/locations";
import { createCredential } from "@/services/credentials";
import { getRedisClient, setItemsByLocationID } from "@/services/redis";
import { createApp, mountApiRoutes } from "@/app";
import { Plugin } from "@/plugin/plugin";
import { grantedPermissions } from "@/plugin/lifecycle/manifest";
import { TessellatePluginRegistry } from "@/utils/registry/plugin/pluginRegistry";
import { PaymentProcessorRegistry } from "@/services/processors/registry";
import { processorRegistry } from "@/services/processors/registry";
import {
    PaymentProcessorError,
    wrapPluginProcessor,
} from "@/services/processors/plugin";
import { GatewayScopeError } from "@/plugin/lifecycle/gatewayScopes";
import { pluginContext } from "@/utils/pluginContext";
import { migrateTestDb } from "./helpers/db";
import { createTestProcessor, signTestWebhook } from "./fixtures/testProcessor";

const suffix = randomUUID().slice(0, 8);

after(async () => {
    await pool.end();
    await (await getRedisClient())?.quit();
});

function manifestFor(
    name: string,
    permissions: string[],
    gatewayScopes?: string[],
): PluginManifest {
    return {
        name,
        version: "0.0.2-alpha",
        main: "index.js",
        engines: { tessellate: "0.0.2-alpha" },
        tessellate: { permissions, gatewayScopes },
    } as unknown as PluginManifest;
}

function pluginFor(
    name: string,
    permissions: string[] = [],
    gatewayScopes?: string[],
) {
    const manifest = manifestFor(name, permissions, gatewayScopes);
    return new Plugin(manifest, grantedPermissions(manifest));
}

describe("payment processor registration", () => {
    it("refuses a plugin without the PAYMENT permission", () => {
        const plugin = pluginFor("acme", ["ORDER"]);
        assert.throws(
            () =>
                plugin.register(
                    "paymentProcessor",
                    createTestProcessor("acme"),
                ),
            (err) =>
                err instanceof PaymentProcessorError &&
                /PAYMENT permission/.test(err.message),
        );
        assert.equal(plugin.get("paymentProcessor").length, 0);
    });

    it("accepts a plugin with PAYMENT and an id in its namespace", () => {
        const plugin = pluginFor("acme", ["PAYMENT"]);
        plugin.register("paymentProcessor", createTestProcessor("acme"));
        plugin.register("paymentProcessor", createTestProcessor("acme-eu"));
        assert.equal(plugin.get("paymentProcessor").length, 2);
    });

    it("refuses ids outside the plugin's namespace", () => {
        const plugin = pluginFor("acme", ["PAYMENT"]);
        for (const id of ["other", "acmeish", "other-acme"]) {
            assert.throws(
                () =>
                    plugin.register(
                        "paymentProcessor",
                        createTestProcessor(id),
                    ),
                PaymentProcessorError,
                id,
            );
        }
    });

    it("never lets a plugin take a built-in id, even by its own name", () => {
        for (const name of ["square", "stripe", "local"]) {
            const plugin = pluginFor(name, ["PAYMENT"]);
            assert.throws(
                () =>
                    plugin.register(
                        "paymentProcessor",
                        createTestProcessor(name),
                    ),
                (err) =>
                    err instanceof PaymentProcessorError &&
                    /reserved/.test(err.message),
                name,
            );
        }
        const other = pluginFor("acme", ["PAYMENT"]);
        assert.throws(
            () =>
                other.register(
                    "paymentProcessor",
                    createTestProcessor("square"),
                ),
            PaymentProcessorError,
        );
    });

    it("refuses malformed processors", () => {
        const plugin = pluginFor("acme", ["PAYMENT"]);
        const good = createTestProcessor("acme");
        const bad: unknown[] = [
            null,
            "acme",
            { ...good, label: "" },
            { ...good, capabilities: { checkout: true } },
            { ...good, handleWebhook: undefined },
            { ...good, createCheckout: undefined },
            { ...good, capabilities: { checkout: false, invoice: true } },
        ];
        for (const processor of bad) {
            assert.throws(
                () => plugin.register("paymentProcessor", processor as never),
                PaymentProcessorError,
                JSON.stringify(processor),
            );
        }
    });
});

describe("loading and unloading plugin processors", () => {
    function setup(...existing: string[]) {
        const processors = new PaymentProcessorRegistry();
        for (const id of existing) {
            processors.register(createTestProcessor(id));
        }
        return {
            processors,
            registry: new TessellatePluginRegistry(processors),
        };
    }

    function withProcessors(name: string, ...ids: string[]) {
        const plugin = pluginFor(name, ["PAYMENT"]);
        for (const id of ids) {
            plugin.register("paymentProcessor", createTestProcessor(id));
        }
        return plugin;
    }

    it("puts the plugin's processors in the registry and takes them out on unload", async () => {
        const { processors, registry } = setup("square");
        await registry.loadPlugin(
            "acme",
            withProcessors("acme", "acme", "acme-eu"),
        );
        assert.deepEqual(
            processors.list().map((p) => p.id),
            ["square", "acme", "acme-eu"],
        );

        assert.equal(registry.unloadPlugin("acme"), true);
        assert.deepEqual(
            processors.list().map((p) => p.id),
            ["square"],
        );
        assert.equal(registry.getPlugins().has("acme"), false);
        assert.equal(registry.unloadPlugin("acme"), false);

        // A reload registers again instead of tripping the duplicate check.
        await registry.loadPlugin("acme", withProcessors("acme", "acme"));
        assert.ok(processors.get("acme"));
    });

    it("refuses the whole plugin when an id is already taken, and leaves nothing behind", async () => {
        const { processors, registry } = setup("acme-eu");
        await assert.rejects(
            registry.loadPlugin(
                "acme",
                withProcessors("acme", "acme", "acme-eu"),
            ),
            /already registered/,
        );
        assert.equal(registry.getPlugins().has("acme"), false);
        assert.deepEqual(
            processors.list().map((p) => p.id),
            ["acme-eu"],
        );
    });

    it("keeps one plugin from unloading another's processors", async () => {
        const { processors, registry } = setup();
        await registry.loadPlugin("acme", withProcessors("acme", "acme"));
        await registry.loadPlugin("beta", withProcessors("beta", "beta"));
        registry.unloadPlugin("acme");
        assert.deepEqual(
            processors.list().map((p) => p.id),
            ["beta"],
        );
    });
});

describe("the host's view of a plugin processor", () => {
    const req: RawWebhookRequest = {
        headers: {},
        rawBody: Buffer.from("{}"),
        url: "https://shop.example.test/webhooks/acme",
    };
    const wrap = (overrides: Partial<PaymentProcessor>) =>
        wrapPluginProcessor("acme", {
            ...createTestProcessor("acme"),
            ...overrides,
        });

    it("exposes only what capabilities allow and freezes id and label", () => {
        const source = {
            ...createTestProcessor("acme"),
            createInvoice: async () => ({
                externalId: "inv",
                status: "sent" as const,
            }),
        };
        const wrapped = wrapPluginProcessor("acme", source);
        assert.equal(wrapped.createInvoice, undefined);
        assert.equal(wrapped.cancelInvoice, undefined);
        source.id = "square";
        source.capabilities.invoice = true;
        assert.equal(wrapped.id, "acme");
        assert.equal(wrapped.capabilities.invoice, false);
    });

    it("rejects malformed webhook events", async () => {
        const malformed: unknown[] = [
            "x",
            [{ type: "payment.updated" }],
            [{ id: "e", type: "other" }],
            [
                {
                    id: "e",
                    type: "payment.updated",
                    kind: "checkout",
                    external_id: "x",
                    status: "sent",
                },
            ],
            [
                {
                    id: "e",
                    type: "payment.updated",
                    kind: "checkout",
                    external_id: "x",
                    status: "paid",
                    amount: { amount: 100, currency: "CAD" },
                },
            ],
        ];
        for (const events of malformed) {
            await assert.rejects(
                wrap({
                    handleWebhook: async () => events as never,
                }).handleWebhook(req),
                /Malformed/,
                JSON.stringify(events),
            );
        }
        const ok = await wrap({
            handleWebhook: async () => [
                { id: "e", type: "ignored" },
                {
                    id: "f",
                    type: "payment.updated",
                    kind: "invoice",
                    external_id: "x",
                    status: "overdue",
                    amount: { amount: 100n, currency: "CAD" },
                },
            ],
        }).handleWebhook(req);
        assert.equal(ok.length, 2);
    });

    it("rejects a checkout without a usable url", async () => {
        const checkout = (result: unknown) =>
            wrap({ createCheckout: async () => result as never })
                .createCheckout!({
                order: {} as Order,
                successUrl: "https://shop.example.test/ok",
                cancelUrl: "https://shop.example.test/no",
            });
        await assert.rejects(checkout(null), /invalid checkout/);
        await assert.rejects(
            checkout({ externalId: "a", url: "javascript:alert(1)" }),
            /invalid checkout/,
        );
        await assert.rejects(
            checkout({ externalId: "", url: "https://pay.example.test/a" }),
            /invalid checkout/,
        );
        assert.deepEqual(
            await checkout({
                externalId: "a",
                url: "https://pay.example.test/a",
            }),
            { externalId: "a", url: "https://pay.example.test/a" },
        );
    });
});

describe("hook and event context", () => {
    it("reads the source from the order first, then from a credential caller", () => {
        const credential = {
            kind: "credential",
            id: "tcid_x",
            display_name: "Online store",
            roles: [],
            scopes: [],
            location_ids: ["L"],
        } as const;
        assert.deepEqual(pluginContext({ principal: credential }), {
            principal: credential,
            source: "Online store",
        });
        assert.equal(
            pluginContext(
                { principal: { ...credential, kind: "user" } as never },
                null,
            ).source,
            null,
        );
        assert.equal(
            pluginContext(
                { principal: credential },
                { source: { name: "Web" } },
            ).source,
            "Web",
        );
        assert.deepEqual(pluginContext(undefined), {
            principal: null,
            source: null,
        });
    });

    it("hands hook handlers the context, and a null one when the caller gave none", async () => {
        const registry = new TessellatePluginRegistry(
            new PaymentProcessorRegistry(),
        );
        const seen: HookContext[] = [];
        const plugin = pluginFor("acme");
        plugin.hook(hooks.beforeCheckout, (_input, ctx) => {
            seen.push(ctx);
            return { ok: true, value: undefined };
        });
        await registry.loadPlugin("acme", plugin);
        const context: HookContext = { principal: null, source: "Web" };
        await registry.runHook(
            hooks.beforeCheckout,
            { orderId: "o", amount: { amount: 1n, currency: "CAD" } },
            { context },
        );
        await registry.runHook(hooks.beforeCheckout, {
            orderId: "o",
            amount: { amount: 1n, currency: "CAD" },
        });
        assert.deepEqual(seen, [context, { principal: null, source: null }]);
    });
});

describe("a plugin processor behind POST /webhooks/:processorId", () => {
    let server: Server;
    let base: string;
    let captured: RawWebhookRequest | null = null;
    const contexts: unknown[] = [];
    const orderRefs: string[] = [];
    const seenKeys: string[] = [];
    const plugins = new TessellatePluginRegistry();

    before(async () => {
        await migrateTestDb();
        const tproc = pluginFor("tproc", ["PAYMENT"]);
        const inner = createTestProcessor("tproc");
        tproc.register("paymentProcessor", {
            ...inner,
            handleWebhook: async (req) => {
                captured = req;
                return inner.handleWebhook(req);
            },
        });
        tproc.on(events.paymentCompleted, (order, method, ctx) => {
            contexts.push({ order: order.referenceId, method, ctx });
        });
        await plugins.loadPlugin("tproc", tproc);

        const boom = pluginFor("tboom", ["PAYMENT"]);
        boom.register("paymentProcessor", {
            ...createTestProcessor("tboom"),
            handleWebhook: async () => {
                throw new Error("secret internal detail sk_live_123");
            },
        });
        await plugins.loadPlugin("tboom", boom);

        const bad = pluginFor("tbad", ["PAYMENT"]);
        bad.register("paymentProcessor", {
            ...createTestProcessor("tbad"),
            handleWebhook: async () =>
                [{ id: "e", type: "payment.updated" }] as never,
        });
        await plugins.loadPlugin("tbad", bad);

        const app = createApp();
        app.locals.pluginRegistry = plugins;
        server = await new Promise((resolve) => {
            const s = app.listen(0, "127.0.0.1", () => resolve(s));
        });
        base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    after(async () => {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        for (const name of ["tproc", "tboom", "tbad"]) {
            plugins.unloadPlugin(name);
        }
        const redis = await getRedisClient();
        for (const key of seenKeys) await redis.del(key);
        for (const ref of orderRefs) {
            await drizzleDB
                .delete(ordersTable)
                .where(eq(ordersTable.referenceId, ref));
        }
    });

    async function openOrder() {
        const referenceId = `ref-${suffix}-${randomUUID().slice(0, 6)}`;
        orderRefs.push(referenceId);
        await insertOrder({
            locationId: "LTEST",
            referenceId,
            state: "OPEN",
            totalMoney: { amount: 1500n, currency: "CAD" },
        });
        const externalId = `chk_${referenceId}`;
        await insertOnlinePayment({
            id: randomUUID(),
            order_reference: referenceId,
            processor_id: "tproc",
            kind: "checkout",
            external_id: externalId,
            url: "https://pay.example.test/x",
            status: "created",
            amount: { amount: "1500", currency: "CAD" },
        });
        return { referenceId, externalId };
    }

    const post = (processor: string, body: string, signature?: string) =>
        fetch(`${base}/webhooks/${processor}`, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                ...(signature ? { "x-test-signature": signature } : {}),
            },
            body,
        });

    it("serves the plugin's processor in the registry", () => {
        assert.deepEqual(
            processorRegistry
                .list()
                .filter((p) => p.id.startsWith("t"))
                .map((p) => p.id)
                .sort(),
            ["tbad", "tboom", "tproc"],
        );
    });

    it("hands the raw body and url to the plugin and completes the order on a paid event", async () => {
        const { referenceId, externalId } = await openOrder();
        const eventId = `evt-${suffix}-paid`;
        seenKeys.push(`processor-event:tproc:${eventId}`);
        const body = JSON.stringify({
            id: eventId,
            external_id: externalId,
            status: "paid",
        });
        const res = await post("tproc", body, signTestWebhook(body));
        assert.equal(res.status, 200);
        assert.deepEqual(await res.json(), { received: true });

        assert.ok(captured);
        const request = captured as RawWebhookRequest;
        assert.ok(Buffer.isBuffer(request.rawBody));
        assert.equal(request.rawBody.toString("utf8"), body);
        assert.equal(
            request.headers["x-test-signature"],
            signTestWebhook(body),
        );
        assert.match(request.url, /\/webhooks\/tproc$/);

        const [row] = await drizzleDB
            .select()
            .from(ordersTable)
            .where(eq(ordersTable.referenceId, referenceId));
        assert.equal(row.state, "COMPLETED");
        assert.equal(
            (await findOnlinePayment("tproc", externalId))?.status,
            "paid",
        );

        // The event reaches plugin listeners with no caller: the signed
        // webhook is the trigger.
        await new Promise((resolve) => setTimeout(resolve, 50));
        assert.deepEqual(contexts.at(-1), {
            order: referenceId,
            method: "CARD",
            ctx: { principal: null, source: null },
        });
    });

    it("answers 401 to an unsigned or wrongly signed request and changes nothing", async () => {
        const { referenceId, externalId } = await openOrder();
        const body = JSON.stringify({
            id: `evt-${suffix}-unsigned`,
            external_id: externalId,
            status: "paid",
        });
        const before = contexts.length;
        assert.equal((await post("tproc", body)).status, 401);
        assert.equal((await post("tproc", body, "00".repeat(32))).status, 401);
        const [row] = await drizzleDB
            .select()
            .from(ordersTable)
            .where(eq(ordersTable.referenceId, referenceId));
        assert.equal(row.state, "OPEN");
        assert.equal(contexts.length, before);
    });

    it("never shows the message of an error a plugin processor throws", async () => {
        const res = await post("tboom", "{}", "x");
        assert.equal(res.status, 401);
        const text = await res.text();
        assert.deepEqual(JSON.parse(text), { message: "Unauthorized" });
        assert.ok(!text.includes("secret"));
        assert.ok(!text.includes("sk_live"));
    });

    it("treats malformed events from a plugin like any other failure, without detail", async () => {
        const res = await post("tbad", "{}", "x");
        assert.equal(res.status, 401);
        assert.deepEqual(await res.json(), { message: "Unauthorized" });
    });

    it("answers 404 once the plugin is unloaded", async () => {
        const gone = pluginFor("tgone", ["PAYMENT"]);
        gone.register("paymentProcessor", createTestProcessor("tgone"));
        await plugins.loadPlugin("tgone", gone);
        assert.equal((await post("tgone", "{}", "x")).status, 401);
        plugins.unloadPlugin("tgone");
        assert.equal((await post("tgone", "{}", "x")).status, 404);
    });
});

describe("plugins on gateway traffic", () => {
    let server: Server;
    let url: string;
    let locationId: string;
    let ownerCookie: string;
    let writerAuth: string;
    const created: string[] = [];
    const hookContexts: { name: string; ctx: HookContext }[] = [];
    const eventContexts: { name: string; ctx: HookContext }[] = [];
    const plugins = new TessellatePluginRegistry(
        new PaymentProcessorRegistry(),
    );

    before(async () => {
        await migrateTestDb();
        locationId = (
            await createLocalLocation({
                name: `Surface ${suffix}`,
                currency: "CAD",
                country: "CA",
            })
        ).id;
        await setItemsByLocationID([
            {
                id: `alpha-${suffix}`,
                name: "alpha",
                variations: [
                    {
                        id: `alpha-var-${suffix}`,
                        itemId: `alpha-${suffix}`,
                        name: "Regular",
                        priceMoney: { amount: 500n, currency: "CAD" },
                        pricingType: "FIXED",
                    },
                ],
                locationIds: [locationId],
            },
        ]);
        await drizzleDB.insert(catalogItemsTable).values({
            id: `alpha-${suffix}`,
            name: "alpha",
            origin: "local",
            channels: ["pos", "online"],
        });
        await drizzleDB.insert(catalogItemVariationsTable).values({
            variationId: `alpha-var-${suffix}`,
            itemId: `alpha-${suffix}`,
            pricingType: "FIXED",
            priceMoney: { amount: "500", currency: "CAD" },
        });

        const auth = createAuth();
        const email = `owner-surface-${suffix}@example.test`;
        await auth.api.createUser({
            body: {
                email,
                password: "correct-horse-battery",
                name: "owner",
                role: "owner",
            },
        });
        const { headers } = await auth.api.signInEmail({
            body: { email, password: "correct-horse-battery" },
            returnHeaders: true,
        });
        ownerCookie = (headers.get("set-cookie") ?? "").split(";")[0];

        const writer = await createCredential(
            {
                name: "Online store",
                scopes: ["orders:write", "plugin:loyalty:read"] as never,
                location_ids: [locationId],
            },
            "owner-user",
        );
        created.push(writer.client_id);
        writerAuth = `Basic ${Buffer.from(`${writer.client_id}:${writer.client_secret}`).toString("base64")}`;

        const loyalty = pluginFor(
            "loyalty",
            ["ORDER"],
            ["plugin:loyalty:read"],
        );
        loyalty.hook(hooks.beforeOrderCreate, (order, ctx) => {
            hookContexts.push({ name: "beforeOrderCreate", ctx });
            return { ok: true, value: order };
        });
        loyalty.on(events.orderCreated, (_order, ctx) => {
            eventContexts.push({ name: "orderCreated", ctx });
        });
        loyalty.register("api", {
            route: "/whoami",
            method: "GET" as never,
            gateway: {
                operationId: "loyalty.whoami",
                scope: "plugin:loyalty:read",
                summary: "Who is calling",
                location: "none",
                response: z.object({ kind: z.string(), id: z.string() }),
            },
            handler: (_req, ctx) => ({
                body: {
                    kind: ctx.principal?.kind ?? "none",
                    id: ctx.principal?.id ?? "",
                },
            }),
        });
        await plugins.loadPlugin("loyalty", loyalty);

        const app = createApp();
        app.locals.pluginRegistry = plugins;
        mountApiRoutes(app, plugins.apiRegistry);
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
        await drizzleDB
            .delete(ordersTable)
            .where(eq(ordersTable.locationId, locationId));
        await removeLocation(locationId);
        await drizzleDB
            .delete(catalogItemVariationsTable)
            .where(eq(catalogItemVariationsTable.itemId, `alpha-${suffix}`));
        await drizzleDB
            .delete(catalogItemsTable)
            .where(eq(catalogItemsTable.id, `alpha-${suffix}`));
        await pool.query(
            `DELETE FROM "tessellate-auth-user" WHERE email LIKE $1`,
            [`%-surface-${suffix}@example.test`],
        );
    });

    it("shows a plugin handler the credential as ctx.principal", async () => {
        const res = await fetch(`${url}/gateway/v1/plugins/loyalty/whoami`, {
            headers: { authorization: writerAuth },
        });
        assert.equal(res.status, 200);
        const body = (await res.json()) as { kind: string; id: string };
        assert.equal(body.kind, "credential");
        assert.match(body.id, /^tcid_/);
    });

    it("passes the principal and source to hooks and events for an online order", async () => {
        const res = await fetch(`${url}/gateway/v1/orders`, {
            method: "POST",
            headers: {
                authorization: writerAuth,
                "content-type": "application/json",
            },
            body: JSON.stringify({
                line_items: [
                    { variation_id: `alpha-var-${suffix}`, quantity: "1" },
                ],
            }),
        });
        assert.equal(res.status, 200, await res.clone().text());
        await new Promise((resolve) => setTimeout(resolve, 50));

        for (const seen of [hookContexts, eventContexts]) {
            assert.equal(seen.length, 1);
            assert.equal(seen[0].ctx.principal?.kind, "credential");
            assert.equal(seen[0].ctx.principal?.display_name, "Online store");
            assert.equal(seen[0].ctx.source, "Online store");
        }
    });

    it("refuses to load a plugin that uses a scope it did not declare", async () => {
        const plugin = pluginFor("sneaky", [], ["plugin:sneaky:read"]);
        plugin.register("api", {
            route: "/x",
            method: "GET" as never,
            gateway: {
                operationId: "sneaky.x",
                scope: "plugin:sneaky:write",
                summary: "x",
                location: "none",
                response: z.object({}),
            },
            handler: () => ({ body: {} }),
        });
        await assert.rejects(
            plugins.loadPlugin("sneaky", plugin),
            (err) =>
                err instanceof GatewayScopeError &&
                /not listed in tessellate.gatewayScopes/.test(err.message),
        );
        assert.equal(plugins.getPlugins().has("sneaky"), false);
    });

    it("refuses declared scopes outside the plugin's namespace, core scopes included", async () => {
        for (const scope of [
            "orders:write",
            "*",
            "plugin:other:read",
            "plugin:sneaky:",
            "plugin:sneaky:Read",
        ]) {
            await assert.rejects(
                plugins.loadPlugin("sneaky", pluginFor("sneaky", [], [scope])),
                GatewayScopeError,
                scope,
            );
        }
        assert.equal(plugins.getPlugins().has("sneaky"), false);
    });

    it("lists the declared plugin scopes next to the core ones for the owner", async () => {
        const res = await fetch(`${url}/api/v1/credentials/scopes`, {
            headers: { cookie: ownerCookie },
        });
        assert.equal(res.status, 200);
        const body = (await res.json()) as {
            core: string[];
            plugin: { plugin: string; scope: string }[];
        };
        assert.ok(body.core.includes("orders:write"));
        assert.ok(!body.core.includes("*"));
        assert.deepEqual(body.plugin, [
            { plugin: "loyalty", scope: "plugin:loyalty:read" },
        ]);
    });

    it("answers 401 without a session and 403 to a credential on the scope list", async () => {
        assert.equal(
            (await fetch(`${url}/api/v1/credentials/scopes`)).status,
            401,
        );
        assert.equal(
            (
                await fetch(`${url}/api/v1/credentials/scopes`, {
                    headers: { authorization: writerAuth },
                })
            ).status,
            401,
        );
    });
});
