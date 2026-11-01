import "@/test/localProvider";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import http from "node:http";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { eq, inArray } from "drizzle-orm";
import type { Customer, InvoiceStatus } from "@tessellatepos/sdk";
import type { PluginManifest } from "@tessellatepos/plugin-sdk";
import { events, hooks } from "@tessellatepos/plugin-sdk/server";
import { drizzleDB, pool } from "@/services/db/postgres";
import { createLocalLocation, removeLocation } from "@/services/db/locations";
import { createCredential } from "@/services/credentials";
import { createCustomer, deleteCustomer } from "@/services/customers";
import { getRedisClient } from "@/services/redis";
import {
    catalogItemVariationsTable,
    catalogItemsTable,
    ordersTable,
} from "@/services/db/schema";
import { insertOrder } from "@/services/db/orders";
import { listOnlinePayments } from "@/services/db/onlinePayments";
import { listDeliveries } from "@/services/db/webhookDeliveries";
import { createApp, mountApiRoutes } from "@/app";
import { Plugin } from "@/plugin/plugin";
import { grantedPermissions } from "@/plugin/lifecycle/manifest";
import { TessellatePluginRegistry } from "@/utils/registry/plugin/pluginRegistry";
import { processorRegistry } from "@/services/processors/registry";
import { updateProcessorSettings } from "@/services/processors/settings";
import { checkoutDeps } from "@/services/onlineOrders";
import { markOverdueInvoices, nextInvoiceStatus } from "@/services/invoices";
import { expireStaleOrders } from "@/gateway/orderExpiry";
import { paymentsv1Endpoint } from "@/endpoints/v1/payments";
import { migrateTestDb } from "./helpers/db";
import {
    createTestProcessor,
    signTestWebhook,
    type TestProcessorCalls,
} from "./fixtures/testProcessor";

const suffix = randomUUID().slice(0, 8);
const ORIGIN = "https://shop.example.test";
const INV = "inv";
const PLAIN = "plain";
const DAY = 24 * 60 * 60_000;

after(async () => {
    await pool.end();
    await (await getRedisClient())?.quit();
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- responses are untyped JSON
type Json = Record<string, any>;
type Cred = { client_id: string; client_secret: string };
type HookMode = "none" | "bump" | "block" | "tamper";

const dateIn = (days: number) =>
    new Date(Date.now() + days * DAY).toISOString().slice(0, 10);

describe("nextInvoiceStatus", () => {
    const all: InvoiceStatus[] = [
        "draft",
        "sent",
        "viewed",
        "paid",
        "overdue",
        "canceled",
        "refunded",
    ];

    it("only moves open invoices forward", () => {
        assert.equal(nextInvoiceStatus("draft", "sent"), "sent");
        assert.equal(nextInvoiceStatus("sent", "viewed"), "viewed");
        assert.equal(nextInvoiceStatus("viewed", "overdue"), "overdue");
        assert.equal(nextInvoiceStatus("viewed", "sent"), null);
        assert.equal(nextInvoiceStatus("overdue", "viewed"), null);
        assert.equal(nextInvoiceStatus("sent", "draft"), null);
        assert.equal(nextInvoiceStatus("sent", "sent"), null);
    });

    it("lets paid and canceled end an open invoice from any state", () => {
        for (const from of ["draft", "sent", "viewed", "overdue"] as const) {
            assert.equal(nextInvoiceStatus(from, "paid"), "paid");
            assert.equal(nextInvoiceStatus(from, "canceled"), "canceled");
        }
    });

    it("never moves a paid invoice anywhere but refunded", () => {
        for (const to of all) {
            assert.equal(
                nextInvoiceStatus("paid", to),
                to === "refunded" ? "refunded" : null,
                to,
            );
        }
    });

    it("treats refunded as final and canceled as final except for a real payment", () => {
        for (const to of all) {
            assert.equal(nextInvoiceStatus("refunded", to), null, to);
        }
        for (const to of all) {
            assert.equal(
                nextInvoiceStatus("canceled", to),
                to === "paid" ? "paid" : null,
                to,
            );
        }
    });
});

describe("invoices", () => {
    let server: Server;
    let url: string;
    let locA: string;
    let locB: string;
    let registry: TessellatePluginRegistry;
    let hookServer: http.Server;
    let hookUrl: string;
    const emitted: { name: string; args: unknown[] }[] = [];
    const calls: TestProcessorCalls = { invoices: [], canceled: [] };
    const credentials: string[] = [];
    const orderRefs: string[] = [];
    const customerIds: string[] = [];
    const itemId = `inv-item-${suffix}`;
    const VARIATION = `inv-var-${suffix}`;
    let writer: Cred;
    let narrow: Cred;
    let other: Cred;
    let atB: Cred;
    let reader: Cred;
    let withEmail: Customer;
    let withPhone: Customer;
    let withNothing: Customer;
    let hookMode: HookMode = "none";
    const hookSeen: unknown[] = [];
    const blindSeen: unknown[] = [];
    const realAvailable = checkoutDeps.available;
    const realOverdue = process.env.INVOICE_OVERDUE_DAYS;

    before(async () => {
        await migrateTestDb();
        locA = (
            await createLocalLocation({
                name: `Inv A ${suffix}`,
                currency: "CAD",
                country: "CA",
            })
        ).id;
        locB = (
            await createLocalLocation({
                name: `Inv B ${suffix}`,
                currency: "CAD",
                country: "CA",
            })
        ).id;
        await drizzleDB.insert(catalogItemsTable).values({
            id: itemId,
            name: "catering",
            origin: "local",
            channels: ["pos", "online"],
        });
        await drizzleDB.insert(catalogItemVariationsTable).values({
            variationId: VARIATION,
            itemId,
            pricingType: "FIXED",
            priceMoney: { amount: "5000", currency: "CAD" },
        });

        const make = async (input: Partial<Customer>) => {
            const created = await createCustomer({
                given_name: "Ada",
                family_name: suffix,
                ...input,
            });
            customerIds.push(created.id);
            return created;
        };
        withEmail = await make({ email: `ada-${suffix}@example.test` });
        withPhone = await make({ phone_number: "+15555550123" });
        withNothing = await make({});

        processorRegistry.register(
            createTestProcessor(INV, { invoice: true, calls }),
        );
        processorRegistry.register(createTestProcessor(PLAIN));
        for (const id of [INV, PLAIN]) {
            await updateProcessorSettings(id, locA, { enabled: true });
        }
        checkoutDeps.available = () => true;

        registry = new TessellatePluginRegistry();
        const emit = registry.emit.bind(registry);
        registry.emit = ((def: { name: string }, ...args: unknown[]) => {
            emitted.push({ name: def.name, args });
            (emit as (d: unknown, ...a: unknown[]) => void)(def, ...args);
        }) as typeof registry.emit;

        const manifest = (name: string, permissions: string[]) =>
            ({
                name,
                version: "0.0.2-alpha",
                main: "index.js",
                engines: { tessellate: "0.0.2-alpha" },
                tessellate: { permissions },
            }) as unknown as PluginManifest;
        const hooker = new Plugin(
            manifest("invhook", ["CUSTOMER"]),
            grantedPermissions(manifest("invhook", ["CUSTOMER"])),
        );
        hooker.hook(hooks.beforeInvoiceCreate, (input, ctx) => {
            hookSeen.push({ input, ctx });
            if (hookMode === "block") {
                return { ok: false, reason: "No invoices today" };
            }
            if (hookMode === "bump") {
                return {
                    ok: true,
                    value: {
                        ...input,
                        dueDate: dateIn(30),
                        message: "Net 30, thank you",
                    },
                };
            }
            if (hookMode === "tamper") {
                return {
                    ok: true,
                    value: {
                        ...input,
                        customer: { ...input.customer, email: "evil@x.test" },
                        order: { ...input.order, referenceId: "other" },
                        dueDate: "not a date",
                    },
                };
            }
            return { ok: true, value: input };
        });
        await registry.loadPlugin("invhook", hooker);
        const blind = new Plugin(
            manifest("invblind", ["ORDER"]),
            grantedPermissions(manifest("invblind", ["ORDER"])),
        );
        blind.hook(hooks.beforeInvoiceCreate, (input) => {
            blindSeen.push(input);
            return { ok: true, value: input };
        });
        await registry.loadPlugin("invblind", blind);

        hookServer = http.createServer((_req, res) => res.end("ok"));
        await new Promise<void>((r) => hookServer.listen(0, "127.0.0.1", r));
        hookUrl = `http://127.0.0.1:${(hookServer.address() as AddressInfo).port}/h`;

        const app = createApp();
        app.locals.pluginRegistry = registry;
        mountApiRoutes(app, registry.apiRegistry);
        server = await new Promise((resolve) => {
            const s = app.listen(0, "127.0.0.1", () => resolve(s));
        });
        url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

        const scopes = ["orders:read", "orders:write", "customers:read"];
        writer = await makeCred("Invoice store", [locA], scopes, {
            webhook_url: hookUrl,
        });
        narrow = await makeCred(
            "Narrow store",
            [locA],
            ["orders:read", "orders:write"],
        );
        other = await makeCred("Other store", [locA], scopes);
        atB = await makeCred("B store", [locB], scopes);
        reader = await makeCred("Reader", [locA], ["orders:read"]);
    });

    after(async () => {
        checkoutDeps.available = realAvailable;
        if (realOverdue === undefined) delete process.env.INVOICE_OVERDUE_DAYS;
        else process.env.INVOICE_OVERDUE_DAYS = realOverdue;
        server.closeAllConnections();
        await new Promise<void>((r) => server.close(() => r()));
        await new Promise((r) => hookServer.close(r));
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
            .where(eq(catalogItemVariationsTable.itemId, itemId));
        await drizzleDB
            .delete(catalogItemsTable)
            .where(eq(catalogItemsTable.id, itemId));
        for (const id of customerIds) await deleteCustomer(id);
    });

    async function makeCred(
        name: string,
        locations: string[],
        scopes: string[],
        overrides: Record<string, unknown> = {},
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

    async function place(
        c: Cred = writer,
        customer: Customer | null = withEmail,
    ) {
        const result = await call("POST", "/orders", c, {
            line_items: [{ variation_id: VARIATION, quantity: "2" }],
            ...(customer ? { customer_id: customer.id } : {}),
        });
        assert.equal(result.status, 200, JSON.stringify(result.json));
        orderRefs.push(result.json.id);
        return result.json.id as string;
    }

    const invoiceBody = (overrides: Record<string, unknown> = {}) => ({
        processor: INV,
        delivery: "EMAIL",
        due_date: dateIn(10),
        message: "Thanks for your order",
        ...overrides,
    });

    async function invoice(
        ref: string,
        c: Cred = writer,
        overrides: Record<string, unknown> = {},
    ) {
        return call(
            "POST",
            `/orders/${ref}/invoice`,
            c,
            invoiceBody(overrides),
        );
    }

    async function invoiced(c: Cred = writer, customer = withEmail) {
        const ref = await place(c, customer);
        const res = await invoice(ref, c);
        assert.equal(res.status, 200, JSON.stringify(res.json));
        const row = (await listOnlinePayments(ref)).find(
            (a) => a.kind === "invoice",
        )!;
        return { ref, row, json: res.json };
    }

    async function webhook(
        externalId: string,
        status: string,
        id = `evt_${randomUUID()}`,
    ) {
        const raw = JSON.stringify({
            id,
            external_id: externalId,
            status,
            kind: "invoice",
        });
        return fetch(`${url}/webhooks/${INV}`, {
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

    const statusOf = async (ref: string) =>
        (await listOnlinePayments(ref)).filter((a) => a.kind === "invoice");

    /** Plugin events for one order's invoices, as `name` or `name:status`. */
    const invoiceEvents = (ref: string) =>
        emitted
            .filter(
                (e) =>
                    e.name.startsWith("invoice") &&
                    (e.args[0] as { order_reference: string })
                        .order_reference === ref,
            )
            .map((e) => e.name);

    async function deliveriesOfType(type: string, ref: string) {
        let matching: Json[] = [];
        for (let i = 0; i < 40; i++) {
            const rows = await listDeliveries(writer.client_id, 200);
            matching = rows
                .filter((d) => d.event_type === type)
                .map((d) => JSON.parse(d.body))
                .filter((b) => b.data.order_id === ref);
            if (matching.length > 0) break;
            await new Promise((r) => setTimeout(r, 50));
        }
        // Give a stray duplicate time to show up.
        await new Promise((r) => setTimeout(r, 100));
        const rows = await listDeliveries(writer.client_id, 200);
        return rows
            .filter((d) => d.event_type === type)
            .map((d) => JSON.parse(d.body) as Json)
            .filter((b) => b.data.order_id === ref);
    }

    describe("creating an invoice", () => {
        it("issues the invoice, keeps the order open and reports it on the order", async () => {
            const ref = await place();
            const res = await invoice(ref);
            assert.equal(res.status, 200, JSON.stringify(res.json));
            assert.equal(res.json.status, "sent");
            assert.equal(res.json.order_id, ref);
            assert.equal(res.json.processor, INV);
            assert.match(res.json.url, /^https:\/\/pay\.example\.test\/inv_/);
            assert.equal(res.json.due_date, dateIn(10));
            assert.deepEqual(res.json.amount, {
                amount: "10000",
                currency: "CAD",
            });
            assert.equal(res.json.external_id, undefined);

            const sent = calls.invoices.at(-1)!.request as Json;
            assert.equal(sent.customer.id, withEmail.id);
            assert.equal(sent.delivery, "EMAIL");
            assert.equal(sent.message, "Thanks for your order");
            assert.equal(sent.dueDate, dateIn(10));
            assert.equal(sent.order.referenceId, ref);

            const row = await rowOf(ref);
            assert.ok(row.invoicedAt);
            assert.equal(row.state, "OPEN");

            const got = await call("GET", `/orders/${ref}`, writer);
            assert.equal(got.json.payment_status, "processing");
            assert.equal(got.json.invoice.id, res.json.id);
            assert.equal(got.json.invoice.status, "sent");
            assert.equal(got.json.latest_payment.kind, "invoice");
            assert.equal(got.json.latest_payment.due_date, dateIn(10));
        });

        it("emits invoiceCreated and invoiceSent once, with the credential as context", async () => {
            const { ref } = await invoiced();
            assert.deepEqual(invoiceEvents(ref), [
                events.invoiceCreated.name,
                events.invoiceSent.name,
            ]);
            const created = emitted.find(
                (e) =>
                    e.name === events.invoiceCreated.name &&
                    (e.args[0] as { order_reference: string })
                        .order_reference === ref,
            )!;
            const [invoiceArg, orderArg, ctx] = created.args as [
                { status: string; kind: string },
                { referenceId: string },
                { principal: { kind: string }; source: string },
            ];
            assert.equal(invoiceArg.kind, "invoice");
            assert.equal(orderArg.referenceId, ref);
            assert.equal(ctx.principal.kind, "credential");
            assert.equal(ctx.source, `Invoice store ${suffix}`);

            assert.equal(
                (await deliveriesOfType("invoice.created", ref)).length,
                1,
            );
            const sentHooks = await deliveriesOfType("invoice.sent", ref);
            assert.equal(sentHooks.length, 1);
            assert.equal(sentHooks[0].data.status, "sent");
            assert.equal(sentHooks[0].data.amount.amount, "10000");
        });

        it("refuses when the customer lacks the contact the delivery needs, and calls nothing", async () => {
            const before = calls.invoices.length;
            const ref = await place(writer, withNothing);
            const email = await invoice(ref, writer, { delivery: "EMAIL" });
            assert.equal(email.status, 422);
            assert.equal(email.json.code, "customer_contact_missing");
            assert.match(email.json.message, /no email address.*EMAIL/);
            const sms = await invoice(ref, writer, { delivery: "SMS" });
            assert.equal(sms.status, 422);
            assert.match(sms.json.message, /no phone number.*SMS/);

            const emailOnly = await place(writer, withEmail);
            const smsToEmailOnly = await invoice(emailOnly, writer, {
                delivery: "SMS",
            });
            assert.equal(smsToEmailOnly.status, 422);
            const emailToPhoneOnly = await place(writer, withPhone);
            assert.equal(
                (await invoice(emailToPhoneOnly, writer, { delivery: "EMAIL" }))
                    .status,
                422,
            );
            assert.equal(
                (await invoice(emailToPhoneOnly, writer, { delivery: "SMS" }))
                    .status,
                200,
            );

            assert.equal(calls.invoices.length, before + 1);
            assert.equal((await statusOf(ref)).length, 0);
            assert.equal((await rowOf(ref)).invoicedAt, null);

            const manual = await invoice(ref, writer, {
                delivery: "SHARE_MANUALLY",
            });
            assert.equal(manual.status, 200, JSON.stringify(manual.json));
        });

        it("needs a customer, from the order or the request", async () => {
            const ref = await place(writer, null);
            const none = await invoice(ref);
            assert.equal(none.status, 422);
            assert.equal(none.json.code, "customer_required");

            const unknown = await invoice(ref, writer, {
                customer_id: `nope-${suffix}`,
            });
            assert.equal(unknown.status, 422);
            assert.equal(unknown.json.code, "customer_not_found");

            const given = await invoice(ref, writer, {
                customer_id: withEmail.id,
            });
            assert.equal(given.status, 200, JSON.stringify(given.json));
            const sent = calls.invoices.at(-1)!.request as Json;
            assert.equal(sent.customer.id, withEmail.id);

            const withOwn = await place(writer, withEmail);
            const mismatch = await invoice(withOwn, writer, {
                customer_id: withPhone.id,
            });
            assert.equal(mismatch.status, 409);
            assert.equal(mismatch.json.code, "customer_mismatch");
        });

        it("only lets a credential name a customer if it may read customers", async () => {
            const ref = await place(narrow, null);
            const res = await invoice(ref, narrow, {
                customer_id: withEmail.id,
            });
            assert.equal(res.status, 403);
            assert.equal(res.json.code, "customer_scope_required");

            const own = await place(narrow, withEmail);
            assert.equal((await invoice(own, narrow)).status, 200);
        });

        it("validates the due date and the body", async () => {
            const ref = await place();
            const past = await invoice(ref, writer, { due_date: dateIn(-2) });
            assert.equal(past.status, 400);
            assert.equal(past.json.code, "invalid_due_date");
            const notADate = await invoice(ref, writer, {
                due_date: "2030-02-31",
            });
            assert.equal(notADate.status, 400);
            const shape = await invoice(ref, writer, { due_date: "soon" });
            assert.equal(shape.status, 400);
            const extra = await invoice(ref, writer, { reminders: [1] });
            assert.equal(extra.status, 400);
            const delivery = await invoice(ref, writer, { delivery: "POST" });
            assert.equal(delivery.status, 400);
            assert.equal((await statusOf(ref)).length, 0);
            assert.equal(
                (await invoice(ref, writer, { due_date: dateIn(0) })).status,
                200,
            );
        });

        it("refuses unknown, unsupported and unavailable processors", async () => {
            const ref = await place();
            const unknown = await invoice(ref, writer, { processor: "nope" });
            assert.equal(unknown.status, 400);
            assert.equal(unknown.json.code, "unknown_processor");
            const plain = await invoice(ref, writer, { processor: PLAIN });
            assert.equal(plain.status, 409);
            assert.equal(plain.json.code, "invoice_not_supported");

            checkoutDeps.available = () => false;
            try {
                const off = await invoice(ref);
                assert.equal(off.status, 409);
                assert.equal(off.json.code, "online_payments_unavailable");
            } finally {
                checkoutDeps.available = () => true;
            }
        });

        it("refuses a second open payment, a paid order and a processor that fails", async () => {
            const { ref } = await invoiced();
            const twice = await invoice(ref);
            assert.equal(twice.status, 409);
            assert.equal(twice.json.code, "payment_in_progress");

            const checkingOut = await place();
            const checkout = await call(
                "POST",
                `/orders/${checkingOut}/checkout`,
                writer,
                {
                    processor: PLAIN,
                    success_url: `${ORIGIN}/ok`,
                    cancel_url: `${ORIGIN}/no`,
                },
            );
            assert.equal(checkout.status, 200, JSON.stringify(checkout.json));
            const blocked = await invoice(checkingOut);
            assert.equal(blocked.status, 409);
            assert.equal(blocked.json.code, "payment_in_progress");

            const paid = await place();
            await drizzleDB
                .update(ordersTable)
                .set({ state: "COMPLETED" })
                .where(eq(ordersTable.referenceId, paid));
            const done = await invoice(paid);
            assert.equal(done.status, 409);
            assert.equal(done.json.code, "order_not_payable");

            const failing = createTestProcessor("boom", { invoice: true });
            failing.createInvoice = async () => {
                throw new Error("upstream said: secret detail");
            };
            processorRegistry.register(failing);
            await updateProcessorSettings("boom", locA, { enabled: true });
            const fresh = await place();
            const broken = await invoice(fresh, writer, { processor: "boom" });
            assert.equal(broken.status, 502);
            assert.equal(broken.json.code, "processor_error");
            assert.doesNotMatch(JSON.stringify(broken.json), /secret detail/);
            assert.equal((await rowOf(fresh)).invoicedAt, null);
            processorRegistry.unregister("boom");
        });
    });

    describe("the beforeInvoiceCreate hook", () => {
        it("lets a CUSTOMER plugin change the terms, but never the order or customer", async () => {
            hookMode = "bump";
            try {
                const ref = await place();
                const res = await invoice(ref, writer, {
                    message: "original",
                    due_date: dateIn(5),
                });
                assert.equal(res.status, 200, JSON.stringify(res.json));
                assert.equal(res.json.due_date, dateIn(30));
                const sent = calls.invoices.at(-1)!.request as Json;
                assert.equal(sent.message, "Net 30, thank you");
                assert.equal(sent.dueDate, dateIn(30));
                const seen = hookSeen.at(-1) as Json;
                assert.equal(seen.input.customer.email, withEmail.email);
                assert.equal(seen.ctx.principal.kind, "credential");
                assert.equal(seen.ctx.source, `Invoice store ${suffix}`);
            } finally {
                hookMode = "none";
            }
        });

        it("ignores a hook's changes to the order and customer, and refuses an invalid result", async () => {
            hookMode = "tamper";
            try {
                const ref = await place();
                const res = await invoice(ref);
                assert.equal(res.status, 400);
                assert.equal(res.json.code, "invoice_blocked");
                assert.equal((await statusOf(ref)).length, 0);
            } finally {
                hookMode = "none";
            }
        });

        it("can block an invoice", async () => {
            hookMode = "block";
            try {
                const before = calls.invoices.length;
                const ref = await place();
                const res = await invoice(ref);
                assert.equal(res.status, 400);
                assert.equal(res.json.code, "invoice_blocked");
                assert.equal(res.json.message, "No invoices today");
                assert.equal(calls.invoices.length, before);
            } finally {
                hookMode = "none";
            }
        });

        it("is not shown to plugins without the CUSTOMER permission", async () => {
            const ref = await place();
            await invoice(ref);
            assert.equal(blindSeen.length, 0);
        });
    });

    describe("status changes from the processor", () => {
        it("follows sent -> viewed -> paid, completes the order and announces each once", async () => {
            const { ref, row } = await invoiced();
            assert.equal(
                (await webhook(row.external_id, "viewed")).status,
                200,
            );
            assert.equal((await statusOf(ref))[0].status, "viewed");

            // Stale: an earlier state arrives late.
            assert.equal((await webhook(row.external_id, "sent")).status, 200);
            assert.equal((await webhook(row.external_id, "draft")).status, 200);
            assert.equal((await statusOf(ref))[0].status, "viewed");

            const paidId = `evt_${randomUUID()}`;
            assert.equal(
                (await webhook(row.external_id, "paid", paidId)).status,
                200,
            );
            // Same event again, and the same fact under a new event id.
            assert.equal(
                (await webhook(row.external_id, "paid", paidId)).status,
                200,
            );
            assert.equal((await webhook(row.external_id, "paid")).status, 200);

            const order = await rowOf(ref);
            assert.equal(order.state, "COMPLETED");
            assert.equal((order.tenders as unknown[]).length, 1);
            const got = await call("GET", `/orders/${ref}`, writer);
            assert.equal(got.json.payment_status, "paid");
            assert.equal(got.json.invoice.status, "paid");

            assert.deepEqual(invoiceEvents(ref), [
                events.invoiceCreated.name,
                events.invoiceSent.name,
                events.invoiceViewed.name,
                events.invoicePaid.name,
            ]);
            assert.equal(
                emitted.filter(
                    (e) =>
                        e.name === events.paymentCompleted.name &&
                        (e.args[0] as { id?: string }).id === ref,
                ).length,
                1,
            );
            assert.equal(
                (await deliveriesOfType("invoice.paid", ref)).length,
                1,
            );
            assert.equal(
                (await deliveriesOfType("invoice.viewed", ref)).length,
                1,
            );
        });

        it("never moves a paid invoice back, except to refunded", async () => {
            const { ref, row } = await invoiced();
            await webhook(row.external_id, "paid");
            for (const late of ["viewed", "sent", "canceled", "overdue"]) {
                await webhook(row.external_id, late);
            }
            assert.equal((await statusOf(ref))[0].status, "paid");
            assert.equal((await rowOf(ref)).state, "COMPLETED");

            await webhook(row.external_id, "refunded");
            await webhook(row.external_id, "paid");
            await webhook(row.external_id, "refunded");
            assert.equal((await statusOf(ref))[0].status, "refunded");
            const got = await call("GET", `/orders/${ref}`, writer);
            assert.equal(got.json.payment_status, "refunded");
            assert.deepEqual(
                invoiceEvents(ref).filter(
                    (n) => n === events.invoiceRefunded.name,
                ),
                [events.invoiceRefunded.name],
            );
            assert.equal(
                invoiceEvents(ref).filter((n) => n === events.invoicePaid.name)
                    .length,
                1,
            );
            assert.equal(
                (await deliveriesOfType("invoice.refunded", ref)).length,
                1,
            );
        });

        it("accepts payment straight from sent, and from overdue", async () => {
            const direct = await invoiced();
            await webhook(direct.row.external_id, "paid");
            assert.equal((await statusOf(direct.ref))[0].status, "paid");
            assert.equal((await rowOf(direct.ref)).state, "COMPLETED");

            const late = await invoiced();
            await markOverdueInvoices({
                registry,
                now: () => new Date(Date.now() + 30 * DAY),
            });
            assert.equal((await statusOf(late.ref))[0].status, "overdue");
            await webhook(late.row.external_id, "paid");
            assert.equal((await statusOf(late.ref))[0].status, "paid");
            assert.equal((await rowOf(late.ref)).state, "COMPLETED");
        });

        it("announces a payment once when several deliveries arrive at the same time", async () => {
            const { ref, row } = await invoiced();
            const results = await Promise.all(
                Array.from({ length: 6 }, () =>
                    webhook(row.external_id, "paid"),
                ),
            );
            for (const res of results) assert.equal(res.status, 200);
            assert.equal(
                invoiceEvents(ref).filter((n) => n === events.invoicePaid.name)
                    .length,
                1,
            );
            assert.equal(
                emitted.filter(
                    (e) =>
                        e.name === events.paymentCompleted.name &&
                        (e.args[0] as { id?: string }).id === ref,
                ).length,
                1,
            );
        });

        it("ignores events for invoices it does not know, and unsigned ones", async () => {
            assert.equal(
                (await webhook(`inv_unknown_${suffix}`, "paid")).status,
                200,
            );
            const raw = JSON.stringify({
                id: "x",
                external_id: "y",
                status: "paid",
                kind: "invoice",
            });
            const res = await fetch(`${url}/webhooks/${INV}`, {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    "x-test-signature": "bad",
                },
                body: raw,
            });
            assert.equal(res.status, 401);
        });
    });

    describe("overdue", () => {
        it("marks an unpaid invoice overdue once the due date plus the window has passed, once", async () => {
            delete process.env.INVOICE_OVERDUE_DAYS;
            const ref = await place();
            const res = await invoice(ref, writer, { due_date: dateIn(3) });
            assert.equal(res.status, 200);
            const due = new Date(`${dateIn(3)}T00:00:00Z`).getTime();
            const edge = due + DAY + 7 * DAY;

            await markOverdueInvoices({
                registry,
                now: () => new Date(edge - 1000),
            });
            assert.equal((await statusOf(ref))[0].status, "sent");

            const first = await markOverdueInvoices({
                registry,
                now: () => new Date(edge),
            });
            assert.ok(first >= 1);
            assert.equal((await statusOf(ref))[0].status, "overdue");
            const again = await markOverdueInvoices({
                registry,
                now: () => new Date(edge + DAY),
            });
            assert.equal(again, 0);

            assert.equal(
                invoiceEvents(ref).filter(
                    (n) => n === events.invoiceOverdue.name,
                ).length,
                1,
            );
            assert.equal(
                (await deliveriesOfType("invoice.overdue", ref)).length,
                1,
            );

            const order = await rowOf(ref);
            assert.equal(order.state, "OPEN");
            const got = await call("GET", `/orders/${ref}`, writer);
            assert.equal(got.json.payment_status, "processing");
            assert.equal(got.json.invoice.status, "overdue");
        });

        it("reads the window from INVOICE_OVERDUE_DAYS, and 0 means the day after the due date", async () => {
            process.env.INVOICE_OVERDUE_DAYS = "0";
            try {
                const { ref } = await invoiced();
                const due = new Date(`${dateIn(10)}T00:00:00Z`).getTime();
                await markOverdueInvoices({
                    registry,
                    now: () => new Date(due + DAY - 1000),
                });
                assert.equal((await statusOf(ref))[0].status, "sent");
                await markOverdueInvoices({
                    registry,
                    now: () => new Date(due + DAY),
                });
                assert.equal((await statusOf(ref))[0].status, "overdue");
            } finally {
                delete process.env.INVOICE_OVERDUE_DAYS;
            }
        });

        it("leaves paid and canceled invoices alone", async () => {
            const paid = await invoiced();
            await webhook(paid.row.external_id, "paid");
            const canceled = await invoiced();
            await call(
                "POST",
                `/orders/${canceled.ref}/invoice/cancel`,
                writer,
            );
            await markOverdueInvoices({
                registry,
                now: () => new Date(Date.now() + 90 * DAY),
            });
            assert.equal((await statusOf(paid.ref))[0].status, "paid");
            assert.equal((await statusOf(canceled.ref))[0].status, "canceled");
        });
    });

    describe("cancelling", () => {
        it("cancels through the processor, once, and lets the order be invoiced again", async () => {
            const { ref, row } = await invoiced();
            const res = await call(
                "POST",
                `/orders/${ref}/invoice/cancel`,
                writer,
            );
            assert.equal(res.status, 200, JSON.stringify(res.json));
            assert.equal(res.json.status, "canceled");
            assert.ok(calls.canceled.includes(row.external_id));

            const again = await call(
                "POST",
                `/orders/${ref}/invoice/cancel`,
                writer,
            );
            assert.equal(again.status, 200);
            assert.equal(
                calls.canceled.filter((id) => id === row.external_id).length,
                1,
            );
            assert.equal(
                invoiceEvents(ref).filter(
                    (n) => n === events.invoiceCanceled.name,
                ).length,
                1,
            );
            assert.equal(
                (await deliveriesOfType("invoice.canceled", ref)).length,
                1,
            );

            // A late "sent" cannot revive it.
            await webhook(row.external_id, "sent");
            assert.equal((await statusOf(ref))[0].status, "canceled");

            const got = await call("GET", `/orders/${ref}`, writer);
            assert.equal(got.json.payment_status, "unpaid");
            assert.equal(got.json.state, "OPEN");

            const reissued = await invoice(ref);
            assert.equal(reissued.status, 200, JSON.stringify(reissued.json));
            assert.notEqual(reissued.json.id, res.json.id);
            const latest = await call("GET", `/orders/${ref}`, writer);
            assert.equal(latest.json.invoice.id, reissued.json.id);
            assert.equal((await statusOf(ref)).length, 2);
        });

        it("refuses to cancel a paid invoice or an order without one", async () => {
            const { ref, row } = await invoiced();
            await webhook(row.external_id, "paid");
            const paid = await call(
                "POST",
                `/orders/${ref}/invoice/cancel`,
                writer,
            );
            assert.equal(paid.status, 409);
            assert.equal(paid.json.code, "invoice_not_cancellable");
            assert.ok(!calls.canceled.includes(row.external_id));

            const bare = await place();
            const none = await call(
                "POST",
                `/orders/${bare}/invoice/cancel`,
                writer,
            );
            assert.equal(none.status, 404);
            assert.equal(none.json.code, "invoice_not_found");
        });

        it("answers 502 and keeps the invoice when the processor cannot cancel", async () => {
            const failing = createTestProcessor("stuck", { invoice: true });
            failing.cancelInvoice = async () => {
                throw new Error("nope");
            };
            processorRegistry.register(failing);
            await updateProcessorSettings("stuck", locA, { enabled: true });
            try {
                const ref = await place();
                assert.equal(
                    (await invoice(ref, writer, { processor: "stuck" })).status,
                    200,
                );
                const res = await call(
                    "POST",
                    `/orders/${ref}/invoice/cancel`,
                    writer,
                );
                assert.equal(res.status, 502);
                assert.equal((await statusOf(ref))[0].status, "sent");
            } finally {
                processorRegistry.unregister("stuck");
            }
        });
    });

    describe("the order around an invoice", () => {
        it("cannot be canceled while its invoice is open, and can be once it is canceled", async () => {
            const { ref } = await invoiced();
            const blocked = await call("POST", `/orders/${ref}/cancel`, writer);
            assert.equal(blocked.status, 409);
            assert.equal(blocked.json.code, "order_invoiced");

            await call("POST", `/orders/${ref}/invoice/cancel`, writer);
            const ok = await call("POST", `/orders/${ref}/cancel`, writer);
            assert.equal(ok.status, 200, JSON.stringify(ok.json));
            assert.equal(ok.json.state, "CANCELED");
        });

        it("is exempt from expiry while the invoice is live, even long after creation", async () => {
            const { ref } = await invoiced();
            await drizzleDB
                .update(ordersTable)
                .set({ createdAt: new Date(Date.now() - 400 * DAY) })
                .where(eq(ordersTable.referenceId, ref));
            const farFuture = () => new Date(Date.now() + 400 * DAY);
            await expireStaleOrders({ registry, now: farFuture });
            assert.equal((await rowOf(ref)).state, "OPEN");

            await markOverdueInvoices({ registry, now: farFuture });
            await expireStaleOrders({ registry, now: farFuture });
            assert.equal((await statusOf(ref))[0].status, "overdue");
            assert.equal((await rowOf(ref)).state, "OPEN");
        });

        it("expires like any unpaid order once its invoice was canceled and the window has run", async () => {
            const { ref } = await invoiced();
            await call("POST", `/orders/${ref}/invoice/cancel`, writer);
            await drizzleDB
                .update(ordersTable)
                .set({ createdAt: new Date(Date.now() - 400 * DAY) })
                .where(eq(ordersTable.referenceId, ref));

            await expireStaleOrders({ registry });
            assert.equal((await rowOf(ref)).state, "OPEN");

            await expireStaleOrders({
                registry,
                now: () => new Date(Date.now() + 2 * 60 * 60_000),
            });
            assert.equal((await rowOf(ref)).state, "CANCELED");
        });

        it("is not expired when an invoice was paid", async () => {
            const { ref, row } = await invoiced();
            await webhook(row.external_id, "paid");
            await drizzleDB
                .update(ordersTable)
                .set({ createdAt: new Date(Date.now() - 400 * DAY) })
                .where(eq(ordersTable.referenceId, ref));
            await expireStaleOrders({
                registry,
                now: () => new Date(Date.now() + DAY),
            });
            assert.equal((await rowOf(ref)).state, "COMPLETED");
        });
    });

    describe("access control", () => {
        it("answers 404 to another credential, another location and a staff order, and nothing is invoiced", async () => {
            const ref = await place();
            const before = calls.invoices.length;
            for (const c of [other, atB]) {
                const res = await invoice(ref, c);
                assert.equal(res.status, 404);
                assert.equal(
                    (await call("POST", `/orders/${ref}/invoice/cancel`, c))
                        .status,
                    404,
                );
            }
            const missing = await invoice(`missing-${suffix}`);
            assert.equal(missing.status, 404);
            assert.deepEqual(missing.json, (await invoice(ref, other)).json);

            const staffRef = randomUUID();
            await insertOrder({
                locationId: locA,
                referenceId: staffRef,
                discounts: [],
                state: "OPEN",
                totalMoney: { amount: 100n, currency: "CAD" },
                customerId: withEmail.id,
            } as never);
            orderRefs.push(staffRef);
            assert.equal((await invoice(staffRef)).status, 404);
            assert.equal(calls.invoices.length, before);
            assert.equal((await statusOf(ref)).length, 0);
        });

        it("needs orders:write and a credential", async () => {
            const ref = await place();
            assert.equal((await invoice(ref, reader)).status, 403);
            assert.equal(
                (await call("POST", `/orders/${ref}/invoice/cancel`, reader))
                    .status,
                403,
            );
            assert.equal((await invoice(ref, null)).status, 401);
        });

        it("does not let a staff session use the credential routes", async () => {
            const res = await fetch(
                `${url}/api/v1/orders/${randomUUID()}/online-invoice`,
                { method: "POST" },
            );
            assert.equal(res.status, 401);
        });
    });

    describe("documentation", () => {
        it("lists the invoice operations and the invoice in order responses", async () => {
            const res = await call("GET", "/openapi.json", writer);
            assert.equal(res.status, 200);
            const paths = res.json.paths as Json;
            assert.equal(
                paths["/orders/{orderId}/invoice"].post.operationId,
                "orders.invoice",
            );
            assert.equal(
                paths["/orders/{orderId}/invoice/cancel"].post.operationId,
                "orders.cancelInvoice",
            );
            assert.match(JSON.stringify(res.json), /customer_contact_missing/);
        });
    });

    describe("staff routes", () => {
        let staffServer: Server;
        let staffUrl: string;
        let principal: Json;

        before(async () => {
            const app = express();
            app.use(express.json());
            app.use((req, _res, next) => {
                req.principal = principal as typeof req.principal;
                next();
            });
            app.locals.pluginRegistry = registry;
            app.use("/payments", paymentsv1Endpoint.router);
            staffServer = await new Promise((resolve) => {
                const s = app.listen(0, "127.0.0.1", () => resolve(s));
            });
            staffUrl = `http://127.0.0.1:${(staffServer.address() as AddressInfo).port}`;
        });

        after(async () => {
            staffServer.closeAllConnections();
            await new Promise<void>((r) => staffServer.close(() => r()));
        });

        const as = (scopes: string[], locations: string[] | "all" = [locA]) => {
            principal = {
                kind: "user",
                id: "staff",
                display_name: "Staff",
                roles: [],
                scopes,
                location_ids: locations,
            };
        };

        async function staff(method: string, path: string, body?: unknown) {
            const res = await fetch(`${staffUrl}/payments${path}`, {
                method,
                headers: { "content-type": "application/json" },
                body: body === undefined ? undefined : JSON.stringify(body),
            });
            const text = await res.text();
            return {
                status: res.status,
                json: text ? (JSON.parse(text) as Json) : {},
            };
        }

        it("lists online orders at a location with payment status, invoice and filters", async () => {
            const { ref } = await invoiced();
            const plainRef = await place();
            as(["payments:read"]);

            // A location-pinned principal must name a location; an
            // unrestricted one gets a 400 instead.
            const missing = await staff("GET", "/orders");
            assert.equal(missing.status, 403);
            as(["payments:read"], "all");
            assert.equal((await staff("GET", "/orders")).status, 400);
            as(["payments:read"]);
            const elsewhere = await staff("GET", `/orders?location_id=${locB}`);
            assert.equal(elsewhere.status, 403);

            const all = await staff(
                "GET",
                `/orders?location_id=${locA}&limit=200`,
            );
            assert.equal(all.status, 200, JSON.stringify(all.json));
            const found = (all.json.orders as Json[]).find(
                (o) => o.id === ref,
            )!;
            assert.equal(found.payment_status, "processing");
            assert.equal(found.invoice.status, "sent");
            assert.equal(found.source.name, `Invoice store ${suffix}`);

            const processing = await staff(
                "GET",
                `/orders?location_id=${locA}&payment_status=processing&limit=200`,
            );
            const ids = (processing.json.orders as Json[]).map((o) => o.id);
            assert.ok(ids.includes(ref));
            assert.ok(!ids.includes(plainRef));
            assert.ok(
                (processing.json.orders as Json[]).every(
                    (o) => o.payment_status === "processing",
                ),
            );

            const byProcessor = await staff(
                "GET",
                `/orders?location_id=${locA}&processor=${INV}&limit=200`,
            );
            const processorIds = (byProcessor.json.orders as Json[]).map(
                (o) => o.id,
            );
            assert.ok(processorIds.includes(ref));
            assert.ok(!processorIds.includes(plainRef));

            const bySource = await staff(
                "GET",
                `/orders?location_id=${locA}&source=${encodeURIComponent(`Other store ${suffix}`)}&limit=200`,
            );
            assert.equal(
                (bySource.json.orders as Json[]).some((o) => o.id === ref),
                false,
            );

            const bad = await staff(
                "GET",
                `/orders?location_id=${locA}&payment_status=nope`,
            );
            assert.equal(bad.status, 400);
            const badCursor = await staff(
                "GET",
                `/orders?location_id=${locA}&cursor=junk`,
            );
            assert.equal(badCursor.status, 400);
        });

        it("pages with a cursor", async () => {
            as(["payments:read"]);
            const first = await staff(
                "GET",
                `/orders?location_id=${locA}&limit=2`,
            );
            assert.equal(first.status, 200);
            assert.equal((first.json.orders as Json[]).length, 2);
            assert.ok(first.json.next_cursor);
            const second = await staff(
                "GET",
                `/orders?location_id=${locA}&limit=2&cursor=${first.json.next_cursor}`,
            );
            const firstIds = (first.json.orders as Json[]).map((o) => o.id);
            for (const o of second.json.orders as Json[]) {
                assert.ok(!firstIds.includes(o.id));
            }
        });

        it("shows an order with every attempt and the processor's id", async () => {
            const { ref, row } = await invoiced();
            as(["payments:read"]);
            const res = await staff("GET", `/orders/${ref}`);
            assert.equal(res.status, 200, JSON.stringify(res.json));
            assert.equal(res.json.invoice.id, row.id);
            assert.ok(res.json.invoiced_at);
            assert.equal(res.json.payments.length, 1);
            assert.equal(res.json.payments[0].external_id, row.external_id);
            assert.equal(res.json.payments[0].kind, "invoice");

            as(["payments:read"], [locB]);
            assert.equal((await staff("GET", `/orders/${ref}`)).status, 404);
            as(["orders:read"]);
            assert.equal((await staff("GET", `/orders/${ref}`)).status, 403);
            as(["payments:read"]);
            assert.equal(
                (await staff("GET", `/orders/missing-${suffix}`)).status,
                404,
            );
        });

        it("lets staff invoice and cancel, including an order taken at the till", async () => {
            const tillRef = randomUUID();
            await insertOrder({
                locationId: locA,
                referenceId: tillRef,
                discounts: [],
                state: "OPEN",
                totalMoney: { amount: 2500n, currency: "CAD" },
            } as never);
            orderRefs.push(tillRef);

            as(["payments:write"]);
            const noCustomer = await staff(
                "POST",
                `/orders/${tillRef}/invoice`,
                invoiceBody(),
            );
            assert.equal(noCustomer.status, 422);
            assert.equal(noCustomer.json.code, "customer_required");

            const created = await staff(
                "POST",
                `/orders/${tillRef}/invoice`,
                invoiceBody({ customer_id: withEmail.id }),
            );
            assert.equal(created.status, 201, JSON.stringify(created.json));
            assert.equal(created.json.status, "sent");
            assert.deepEqual(created.json.amount, {
                amount: "2500",
                currency: "CAD",
            });
            const ctx = emitted.find(
                (e) =>
                    e.name === events.invoiceCreated.name &&
                    (e.args[0] as { order_reference: string })
                        .order_reference === tillRef,
            )!.args[2] as { principal: { kind: string }; source: unknown };
            assert.equal(ctx.principal.kind, "user");
            assert.equal(ctx.source, null);

            as(["payments:read"]);
            const listed = await staff(
                "GET",
                `/orders?location_id=${locA}&processor=${INV}&limit=200`,
            );
            assert.ok(
                (listed.json.orders as Json[]).some(
                    (o) => o.referenceId === tillRef,
                ),
            );

            as(["payments:write"]);
            const canceled = await staff(
                "POST",
                `/orders/${tillRef}/invoice/cancel`,
            );
            assert.equal(canceled.status, 200, JSON.stringify(canceled.json));
            assert.equal(canceled.json.status, "canceled");
        });

        it("guards by scope and by the order's location", async () => {
            const { ref } = await invoiced();
            const body = invoiceBody({ customer_id: withEmail.id });
            as(["orders:write", "payments:read"]);
            assert.equal(
                (await staff("POST", `/orders/${ref}/invoice`, body)).status,
                403,
            );
            assert.equal(
                (await staff("POST", `/orders/${ref}/invoice/cancel`)).status,
                403,
            );
            as(["payments:write"], [locB]);
            assert.equal(
                (await staff("POST", `/orders/${ref}/invoice`, body)).status,
                404,
            );
            assert.equal(
                (await staff("POST", `/orders/${ref}/invoice/cancel`)).status,
                404,
            );
            assert.equal(
                (await staff("GET", "/orders?location_id=x")).status,
                403,
            );
            as(["payments:write"]);
            assert.equal(
                (await staff("POST", `/orders/${ref}/invoice`, { nope: 1 }))
                    .status,
                400,
            );
        });
    });
});
