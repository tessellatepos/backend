import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { pool } from "@/services/db/postgres";
import { createLocalLocation, removeLocation } from "@/services/db/locations";
import { createCredential } from "@/services/credentials";
import { getRedisClient } from "@/services/redis";
import {
    MAX_ATTEMPTS,
    backoffMs,
    deliverDue,
    queueEvent,
    replayDelivery,
} from "@/gateway/webhooks/dispatch";
import { signWebhook } from "@/gateway/webhooks/sign";
import { getDelivery, listDeliveries } from "@/services/db/webhookDeliveries";
import { insertOrder } from "@/services/db/orders";
import { migrateTestDb } from "./helpers/db";

after(async () => {
    await pool.end();
    await (await getRedisClient())?.quit();
});

const suffix = randomUUID().slice(0, 8);

interface Received {
    body: string;
    signature: string | undefined;
}

describe("gateway outbound webhooks", () => {
    let locA: string;
    let locB: string;
    let receiver: http.Server;
    let url: string;
    let status = 200;
    const received: Received[] = [];
    const credentials: string[] = [];

    before(async () => {
        await migrateTestDb();
        locA = (
            await createLocalLocation({
                name: `WA ${suffix}`,
                currency: "CAD",
                country: "CA",
            })
        ).id;
        locB = (
            await createLocalLocation({
                name: `WB ${suffix}`,
                currency: "CAD",
                country: "CA",
            })
        ).id;
        receiver = http.createServer((req, res) => {
            const chunks: Buffer[] = [];
            req.on("data", (c: Buffer) => chunks.push(c));
            req.on("end", () => {
                received.push({
                    body: Buffer.concat(chunks).toString("utf8"),
                    signature: req.headers["tessellate-signature"] as
                        string | undefined,
                });
                res.statusCode = status;
                res.end("x");
            });
        });
        await new Promise<void>((r) => receiver.listen(0, "127.0.0.1", r));
        url = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/hook`;
    });

    after(async () => {
        await new Promise((r) => receiver.close(r));
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
        for (const ref of orderRefs) {
            await pool.query(
                `DELETE FROM "tessellate-orders" WHERE reference_id = $1`,
                [ref],
            );
        }
        await removeLocation(locA);
        await removeLocation(locB);
    });

    async function make(overrides: Record<string, unknown> = {}) {
        const result = await createCredential(
            {
                name: "Hooked",
                scopes: ["orders:read"],
                location_ids: [locA],
                webhook_url: url,
                ...overrides,
            } as never,
            "owner-user",
        );
        credentials.push(result.client_id);
        return result;
    }

    const orderRefs: string[] = [];
    /** An order stored as created by `credentialId` (none: a staff order). */
    async function order(locationId: string, credentialId?: string) {
        const ref = `ord-${randomUUID().slice(0, 6)}`;
        orderRefs.push(ref);
        await insertOrder(
            { referenceId: ref, locationId, state: "OPEN", lineItems: [] },
            undefined,
            credentialId,
        );
        return {
            id: ref,
            referenceId: ref,
            locationId,
            state: "OPEN",
            lineItems: [],
        };
    }

    it("signs as t=<ts>,v1=hmac(secret, ts.body)", () => {
        const header = signWebhook("whsec_x", 1700000000, '{"a":1}');
        const expected = createHmac("sha256", "whsec_x")
            .update('1700000000.{"a":1}')
            .digest("hex");
        assert.equal(header, `t=1700000000,v1=${expected}`);
        assert.notEqual(header, signWebhook("whsec_x", 1700000000, '{"a":2}'));
    });

    it("backs off exponentially up to a cap", () => {
        assert.equal(backoffMs(1), 60_000);
        assert.equal(backoffMs(2), 120_000);
        assert.equal(backoffMs(30), 6 * 60 * 60 * 1000);
    });

    it("queues only for credentials with the scope, location and a URL", async () => {
        const match = await make();
        const otherScope = await make({ scopes: ["catalog:read"] });
        const otherLocation = await make({ location_ids: [locB] });
        const noUrl = await make({ webhook_url: undefined });
        const queued = await queueEvent("orderCreated", [
            await order(locA, match.client_id),
        ]);
        assert.equal(queued, 1);
        assert.equal((await listDeliveries(match.client_id, 10)).length, 1);
        for (const other of [otherScope, otherLocation, noUrl]) {
            assert.equal((await listDeliveries(other.client_id, 10)).length, 0);
        }
    });

    it("ignores events it does not forward and malformed data", async () => {
        const c = await make();
        assert.equal(
            await queueEvent("somethingElse", [await order(locA, c.client_id)]),
            0,
        );
        assert.equal(await queueEvent("orderCreated", ["not an order"]), 0);
        assert.equal((await listDeliveries(c.client_id, 10)).length, 0);
    });

    it("delivers a signed body the receiver can verify, and tampering fails", async () => {
        const c = await make();
        await queueEvent("paymentCompleted", [await order(locA, c.client_id)]);
        received.length = 0;
        status = 200;
        await deliverDue({ limit: 100 });
        const [mine] = await listDeliveries(c.client_id, 1);
        const signs = (r: Received, secret: string, body = r.body) => {
            const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(r.signature ?? "");
            if (!m) return false;
            const mac = createHmac("sha256", secret)
                .update(`${m[1]}.${body}`)
                .digest("hex");
            return mac === m[2];
        };
        // Other credentials match the same event; pick the call signed with ours.
        const hit = received.find(
            (r) => r.body === mine.body && signs(r, c.webhook_secret),
        );
        assert.ok(hit);
        const parsed = JSON.parse(hit.body);
        assert.equal(parsed.type, "order.paid");
        assert.match(parsed.id, /^evt_/);
        assert.ok(!signs(hit, c.webhook_secret, `${hit.body}x`));
        assert.ok(!signs(hit, "whsec_wrong"));
        const [row] = await listDeliveries(c.client_id, 1);
        assert.equal(row.status, "delivered");
        assert.equal(row.last_status_code, 200);
    });

    it("retries a 500 with backoff and fails after the last attempt", async () => {
        const c = await make();
        await queueEvent("orderCancelled", [await order(locA, c.client_id)]);
        status = 500;
        const t0 = new Date();
        await deliverDue({ now: t0, limit: 100 });
        let [row] = await listDeliveries(c.client_id, 1);
        assert.equal(row.status, "pending");
        assert.equal(row.attempts, 1);
        assert.equal(row.last_status_code, 500);
        assert.ok(row.next_attempt_at.getTime() >= t0.getTime() + 60_000);

        // Not due yet: nothing is sent.
        received.length = 0;
        await deliverDue({ now: new Date(t0.getTime() + 1000), limit: 100 });
        assert.equal(received.length, 0);

        let t = t0.getTime();
        for (let i = 1; i < MAX_ATTEMPTS; i++) {
            t += 7 * 60 * 60 * 1000;
            await deliverDue({ now: new Date(t), limit: 100 });
        }
        [row] = await listDeliveries(c.client_id, 1);
        assert.equal(row.status, "failed");
        assert.equal(row.attempts, MAX_ATTEMPTS);
    });

    it("replays a delivery as a new row with the same event id and body", async () => {
        const c = await make();
        await queueEvent("orderCreated", [await order(locA, c.client_id)]);
        const [original] = await listDeliveries(c.client_id, 1);
        const copy = await replayDelivery(c.client_id, original.id);
        assert.ok(copy);
        assert.equal(copy.replay_of, original.id);
        const stored = await getDelivery(c.client_id, copy.id);
        assert.equal(stored?.event_id, original.event_id);
        assert.equal(stored?.body, original.body);
        assert.equal(await replayDelivery("tcid_other", original.id), null);
    });

    it("refuses to deliver to a host that resolves to a private address", async () => {
        const c = await make({ webhook_url: "https://hooks.example.test/in" });
        await queueEvent("orderCreated", [await order(locA, c.client_id)]);
        let fetched = 0;
        // Other tests leave loopback deliveries pending; count only ours.
        const fetchImpl = (async (target: string) => {
            if (target.startsWith("https://hooks.example.test")) fetched++;
            return new Response("ok");
        }) as unknown as typeof fetch;
        await deliverDue({
            limit: 100,
            fetchImpl,
            lookupAll: async () => [{ address: "10.0.0.5" }],
        });
        assert.equal(fetched, 0);
        const [row] = await listDeliveries(c.client_id, 1);
        assert.equal(row.status, "pending");
        assert.equal(row.attempts, 1);
        assert.equal(row.last_status_code, null);
    });

    it("delivers to a host that resolves to a public address, without following redirects", async () => {
        const c = await make({ webhook_url: "https://hooks.example.test/in" });
        await queueEvent("orderCreated", [await order(locA, c.client_id)]);
        let init: RequestInit | undefined;
        const fetchImpl = (async (_u: unknown, i: RequestInit) => {
            init = i;
            return new Response("moved", { status: 302 });
        }) as unknown as typeof fetch;
        await deliverDue({
            limit: 100,
            fetchImpl,
            lookupAll: async () => [{ address: "93.184.216.34" }],
        });
        assert.equal(init?.redirect, "manual");
        assert.ok(init?.signal);
        const [row] = await listDeliveries(c.client_id, 1);
        assert.equal(row.last_status_code, 302);
        assert.equal(row.status, "pending", "a redirect is a failed attempt");
    });

    it("sends an order's events only to the credential that created it", async () => {
        const owner = await make();
        const other = await make();
        const mine = await order(locA, owner.client_id);
        assert.equal(await queueEvent("orderCreated", [mine]), 1);
        assert.equal(await queueEvent("paymentCompleted", [mine]), 1);
        assert.equal((await listDeliveries(owner.client_id, 10)).length, 2);
        assert.equal((await listDeliveries(other.client_id, 10)).length, 0);
    });

    it("sends a staff order's events to no credential", async () => {
        const c = await make();
        const staff = await order(locA);
        assert.equal(await queueEvent("orderCreated", [staff]), 0);
        assert.equal(await queueEvent("orderCancelled", [staff]), 0);
        assert.equal(
            await queueEvent("orderCreated", [
                { ...staff, referenceId: "gone", id: "gone" },
            ]),
            0,
        );
        assert.equal((await listDeliveries(c.client_id, 10)).length, 0);
    });

    it("sends an invoice's events only to the credential that created its order", async () => {
        const owner = await make();
        const other = await make();
        const mine = await order(locA, owner.client_id);
        const invoice = {
            id: "inv-1",
            order_reference: mine.referenceId,
            processor_id: "stripe",
            status: "sent",
            amount: { amount: "100", currency: "CAD" },
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
        };
        assert.equal(await queueEvent("invoiceSent", [invoice, mine]), 1);
        assert.equal((await listDeliveries(owner.client_id, 10)).length, 1);
        assert.equal((await listDeliveries(other.client_id, 10)).length, 0);
    });

    it("still sends customer and catalog events to every subscriber", async () => {
        const a = await make({ scopes: ["catalog:read"] });
        const b = await make({ scopes: ["catalog:read"] });
        assert.ok((await queueEvent("catalogSynced", [])) >= 2);
        assert.equal((await listDeliveries(a.client_id, 10)).length, 1);
        assert.equal((await listDeliveries(b.client_id, 10)).length, 1);
    });
});
