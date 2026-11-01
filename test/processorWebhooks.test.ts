import "@/test/localProvider";
import { after, afterEach, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import { drizzleDB, pool } from "@/services/db/postgres";
import { ordersTable } from "@/services/db/schema";
import { insertOrder } from "@/services/db/orders";
import {
    findOnlinePayment,
    insertOnlinePayment,
} from "@/services/db/onlinePayments";
import { getRedisClient } from "@/services/redis";
import { createApp } from "@/app";
import { TessellatePluginRegistry } from "@/utils/registry/plugin/pluginRegistry";
import { processorRegistry } from "@/services/processors/registry";
import { createSquareProcessor } from "@/services/processors/square";
import { appEvents } from "@/services/websocket/events";
import { migrateTestDb } from "./helpers/db";
import {
    SQUARE_SIGNATURE_KEY,
    squareOrderUpdated,
    squarePaymentUpdated,
} from "./fixtures/squareWebhooks";

const suffix = randomUUID().slice(0, 8);
const seenKeys: string[] = [];
const orderRefs: string[] = [];

let server: Server;
let base: string;
let emitted: unknown[][];
let paymentEvents: unknown[];

const onPayment = (e: unknown) => paymentEvents.push(e);

before(async () => {
    await migrateTestDb();
    processorRegistry.register(
        createSquareProcessor({
            createPaymentLink: async () => ({}),
            locationIdFor: async () => "LTEST",
            signatureKeys: async () => [SQUARE_SIGNATURE_KEY],
        }),
    );
    const app = createApp();
    const plugins = new TessellatePluginRegistry();
    emitted = [];
    plugins.emit = ((def: { name: string }, ...args: unknown[]) => {
        emitted.push([def.name, ...args]);
    }) as typeof plugins.emit;
    app.locals.pluginRegistry = plugins;
    server = await new Promise((resolve) => {
        const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    paymentEvents = [];
    appEvents.on("payment_status", onPayment);
});

after(async () => {
    appEvents.off("payment_status", onPayment);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const redis = await getRedisClient();
    for (const key of seenKeys) await redis.del(key);
    for (const ref of orderRefs) {
        await drizzleDB
            .delete(ordersTable)
            .where(eq(ordersTable.referenceId, ref));
    }
    await pool.end();
    await redis.quit();
});

afterEach(() => {
    emitted.length = 0;
    paymentEvents.length = 0;
});

const signFor = (body: string, key = SQUARE_SIGNATURE_KEY) =>
    createHmac("sha256", key)
        .update(`${base}/webhooks/square` + body)
        .digest("base64");

function post(body: string, signature?: string, processor = "square") {
    return fetch(`${base}/webhooks/${processor}`, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            ...(signature
                ? { "x-square-hmacsha256-signature": signature }
                : {}),
        },
        body,
    });
}

const postSigned = (body: string) => post(body, signFor(body));

function eventId(label: string) {
    const id = `${label}-${suffix}-${randomUUID().slice(0, 6)}`;
    seenKeys.push(`processor-event:square:${id}`);
    return id;
}

/** An OPEN order of 15.00 CAD with a checkout attempt for it. */
async function setup(
    opts: { state?: "OPEN" | "CANCELED"; attempt?: boolean } = {},
) {
    const referenceId = `ref-${suffix}-${randomUUID().slice(0, 6)}`;
    const squareOrderId = `SQ-${referenceId}`;
    orderRefs.push(referenceId);
    await insertOrder({
        locationId: "LTEST",
        referenceId,
        state: opts.state ?? "OPEN",
        totalMoney: { amount: 1500n, currency: "CAD" },
    });
    const addAttempt = () =>
        insertOnlinePayment({
            id: randomUUID(),
            order_reference: referenceId,
            processor_id: "square",
            kind: "checkout",
            external_id: squareOrderId,
            url: "https://square.link/u/x",
            status: "created",
            amount: { amount: "1500", currency: "CAD" },
        });
    if (opts.attempt !== false) await addAttempt();
    return { referenceId, squareOrderId, addAttempt };
}

async function orderRow(referenceId: string) {
    const [row] = await drizzleDB
        .select()
        .from(ordersTable)
        .where(eq(ordersTable.referenceId, referenceId));
    return row;
}

const paidBody = (squareOrderId: string, id = eventId("paid"), amount = 1500) =>
    squarePaymentUpdated({
        eventId: id,
        orderId: squareOrderId,
        status: "COMPLETED",
        amount,
    });

describe("POST /webhooks/:processorId", () => {
    it("answers 401 to an unsigned, tampered or wrongly signed request and changes nothing", async () => {
        const { referenceId, squareOrderId } = await setup();
        const body = paidBody(squareOrderId);
        assert.equal((await post(body)).status, 401);
        assert.equal((await post(body + " ", signFor(body))).status, 401);
        assert.equal(
            (await post(body, signFor(body, "wrong-key"))).status,
            401,
        );
        assert.equal((await post("")).status, 401);
        assert.equal((await orderRow(referenceId)).state, "OPEN");
        assert.equal(emitted.length, 0);
    });

    it("answers 404 for a processor that is not registered", async () => {
        assert.equal((await post("{}", "x", "nope")).status, 404);
    });

    it("completes the order on a paid event and emits what in-person payments emit", async () => {
        const { referenceId, squareOrderId } = await setup();
        const res = await postSigned(paidBody(squareOrderId));
        assert.equal(res.status, 200);

        const row = await orderRow(referenceId);
        assert.equal(row.state, "COMPLETED");
        const tenders = row.tenders as Record<string, unknown>[];
        assert.equal(tenders.length, 1);
        assert.equal(tenders[0].type, "CARD");
        assert.equal(tenders[0].transactionId, "PAYTEST1");
        assert.equal(tenders[0].cardDetails, undefined);

        assert.equal(
            (await findOnlinePayment("square", squareOrderId))?.status,
            "paid",
        );
        assert.equal(emitted.length, 1);
        assert.equal(emitted[0][0], "paymentCompleted");
        assert.equal(
            (emitted[0][1] as { referenceId: string }).referenceId,
            referenceId,
        );
        assert.equal(emitted[0][2], "CARD");
        assert.equal(paymentEvents.length, 1);
    });

    it("does nothing on a replayed event, a second event for the same payment, or a burst", async () => {
        const { referenceId, squareOrderId } = await setup();
        const body = paidBody(squareOrderId);
        const results = await Promise.all(
            Array.from({ length: 5 }, () => postSigned(body)),
        );
        assert.deepEqual(
            results.map((r) => r.status),
            [200, 200, 200, 200, 200],
        );
        assert.equal((await postSigned(body)).status, 200);
        const second = squareOrderUpdated({
            eventId: eventId("order"),
            orderId: squareOrderId,
            state: "COMPLETED",
        });
        assert.equal((await postSigned(second)).status, 200);

        assert.equal(emitted.length, 1);
        assert.equal(paymentEvents.length, 1);
        assert.equal(
            ((await orderRow(referenceId)).tenders as unknown[]).length,
            1,
        );
    });

    it("answers 200 and does nothing for an unknown attempt, without leaking", async () => {
        const res = await postSigned(paidBody("SQ-unknown-" + suffix));
        assert.equal(res.status, 200);
        assert.deepEqual(await res.json(), { received: true });
        assert.equal(emitted.length, 0);
    });

    it("handles a paid event that arrives before the attempt exists once it is sent again", async () => {
        const { referenceId, squareOrderId, addAttempt } = await setup({
            attempt: false,
        });
        const body = paidBody(squareOrderId);
        assert.equal((await postSigned(body)).status, 200);
        assert.equal((await orderRow(referenceId)).state, "OPEN");

        await addAttempt();
        assert.equal((await postSigned(body)).status, 200);
        assert.equal((await orderRow(referenceId)).state, "COMPLETED");
        assert.equal(emitted.length, 1);
    });

    it("lets a failed attempt be paid later, but never undoes a paid one", async () => {
        const { referenceId, squareOrderId } = await setup();
        const failed = squarePaymentUpdated({
            eventId: eventId("failed"),
            orderId: squareOrderId,
            status: "FAILED",
        });
        await postSigned(failed);
        assert.equal(
            (await findOnlinePayment("square", squareOrderId))?.status,
            "failed",
        );
        assert.equal((await orderRow(referenceId)).state, "OPEN");

        await postSigned(paidBody(squareOrderId));
        assert.equal(
            (await findOnlinePayment("square", squareOrderId))?.status,
            "paid",
        );

        await postSigned(
            squareOrderUpdated({
                eventId: eventId("late"),
                orderId: squareOrderId,
                state: "CANCELED",
            }),
        );
        assert.equal(
            (await findOnlinePayment("square", squareOrderId))?.status,
            "paid",
        );
        assert.equal((await orderRow(referenceId)).state, "COMPLETED");
    });

    it("marks an unpaid attempt expired when Square cancels the order", async () => {
        const { referenceId, squareOrderId } = await setup();
        await postSigned(
            squareOrderUpdated({
                eventId: eventId("cancel"),
                orderId: squareOrderId,
                state: "CANCELED",
            }),
        );
        assert.equal(
            (await findOnlinePayment("square", squareOrderId))?.status,
            "expired",
        );
        assert.equal((await orderRow(referenceId)).state, "OPEN");
        assert.equal(emitted.length, 0);
    });

    it("does not complete an order when the paid amount differs from the total", async () => {
        const { referenceId, squareOrderId } = await setup();
        const res = await postSigned(
            paidBody(squareOrderId, eventId("short"), 100),
        );
        assert.equal(res.status, 200);
        assert.equal((await orderRow(referenceId)).state, "OPEN");
        assert.equal(emitted.length, 0);
    });

    it("leaves a canceled order canceled when money arrives late", async () => {
        const { referenceId, squareOrderId } = await setup({
            state: "CANCELED",
        });
        assert.equal((await postSigned(paidBody(squareOrderId))).status, 200);
        assert.equal((await orderRow(referenceId)).state, "CANCELED");
        assert.equal(emitted.length, 0);
        assert.equal(
            (await findOnlinePayment("square", squareOrderId))?.status,
            "paid",
        );
    });

    it("does not log or return the key, the signature or the body", async () => {
        const { squareOrderId } = await setup();
        const body = paidBody(squareOrderId);
        const signature = signFor(body);
        const chunks: string[] = [];
        const out = process.stdout.write.bind(process.stdout);
        const err = process.stderr.write.bind(process.stderr);
        const capture = (chunk: unknown) => {
            chunks.push(String(chunk));
            return true;
        };
        process.stdout.write = capture as typeof process.stdout.write;
        process.stderr.write = capture as typeof process.stderr.write;
        const texts: string[] = [];
        try {
            for (const res of [
                await post(body),
                await post(body + " ", signature),
                await post(body, signature),
                await postSigned(paidBody("SQ-unknown-" + suffix)),
            ]) {
                texts.push(await res.text());
            }
        } finally {
            process.stdout.write = out;
            process.stderr.write = err;
        }
        const everything = [...chunks, ...texts].join("\n");
        for (const secret of [SQUARE_SIGNATURE_KEY, signature, "PAYTEST1"]) {
            assert.ok(!everything.includes(secret), secret);
        }
    });
});
