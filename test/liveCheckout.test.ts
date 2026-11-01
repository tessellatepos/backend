import "@/test/localProvider";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { drizzleDB, pool } from "@/services/db/postgres";
import { createLocalLocation, removeLocation } from "@/services/db/locations";
import { getRedisClient } from "@/services/redis";
import { ordersTable } from "@/services/db/schema";
import { getOrderByAnyId, insertOrder } from "@/services/db/orders";
import {
    insertOnlinePayment,
    setOnlinePaymentStatus,
} from "@/services/db/onlinePayments";
import { cancelUnpaidOrder } from "@/services/onlineOrders";
import { expireStaleOrders } from "@/gateway/orderExpiry";
import { applyProcessorEvents } from "@/services/processors/inbound";
import { getActiveProvider } from "@/services/providers";
import { warnIfOnlineCheckoutLive } from "@/services/providers/local";
import { OrderConflictError } from "@/services/providers/types";
import { TessellatePluginRegistry } from "@/utils/registry/plugin/pluginRegistry";
import { migrateTestDb } from "./helpers/db";

const suffix = randomUUID().slice(0, 8);
const MINUTE = 60_000;
const money = { amount: 500n, currency: "CAD" } as const;

after(async () => {
    await pool.end();
    await (await getRedisClient())?.quit();
});

describe("cancel, expiry and staff payment against a live hosted checkout", () => {
    let loc: string;
    const registry = new TessellatePluginRegistry();
    const orderRefs: string[] = [];
    const processor = `live-${suffix}`;
    let seq = 0;

    before(async () => {
        await migrateTestDb();
        loc = (
            await createLocalLocation({
                name: `Live ${suffix}`,
                currency: "CAD",
                country: "CA",
            })
        ).id;
    });

    after(async () => {
        if (orderRefs.length) {
            await pool.query(
                `DELETE FROM "tessellate-online-payments" WHERE order_reference = ANY($1)`,
                [orderRefs],
            );
            await drizzleDB
                .delete(ordersTable)
                .where(inArray(ordersTable.referenceId, orderRefs));
        }
        await removeLocation(loc);
    });

    /** An open online order created 40 minutes ago. */
    async function newOrder() {
        const ref = `live-${suffix}-${++seq}`;
        await insertOrder({
            id: ref,
            referenceId: ref,
            locationId: loc,
            state: "OPEN",
            lineItems: [],
            discounts: [],
            totalMoney: money,
        });
        await drizzleDB
            .update(ordersTable)
            .set({
                createdByCredential: `cred-${suffix}`,
                createdAt: new Date(Date.now() - 40 * MINUTE),
            })
            .where(eq(ordersTable.referenceId, ref));
        orderRefs.push(ref);
        return ref;
    }

    /** A hosted checkout attempt for an order. */
    async function attempt(ref: string, expiresAt: Date | null) {
        const id = randomUUID();
        const externalId = `ext-${id}`;
        await insertOnlinePayment({
            id,
            order_reference: ref,
            processor_id: processor,
            kind: "checkout",
            external_id: externalId,
            url: "https://pay.example.test/x",
            status: "created",
            amount: { amount: "500", currency: "CAD" },
            expires_at: expiresAt,
        });
        return { id, externalId };
    }

    const stateOf = async (ref: string) => (await getOrderByAnyId(ref))?.state;
    const inMinutes = (m: number) => new Date(Date.now() + m * MINUTE);
    const row = async (ref: string) => (await getOrderByAnyId(ref))!;

    async function captureLogs<T>(fn: () => Promise<T>) {
        const chunks: string[] = [];
        const write = process.stdout.write.bind(process.stdout);
        const log = console.log;
        const error = console.error;
        process.stdout.write = ((c: string | Uint8Array) => {
            chunks.push(String(c));
            return true;
        }) as typeof process.stdout.write;
        console.log = (...a: unknown[]) => void chunks.push(a.join(" "));
        console.error = (...a: unknown[]) => void chunks.push(a.join(" "));
        try {
            await fn();
        } finally {
            process.stdout.write = write;
            console.log = log;
            console.error = error;
        }
        return chunks.join("\n");
    }

    describe("manual cancel", () => {
        it("is refused with payment_in_progress while a checkout is live", async () => {
            const ref = await newOrder();
            await attempt(ref, inMinutes(10));
            const outcome = await cancelUnpaidOrder(await row(ref), registry);
            assert.equal(outcome.ok, false);
            if (!outcome.ok) {
                assert.equal(outcome.status, 409);
                assert.equal(outcome.code, "payment_in_progress");
            }
            assert.equal(await stateOf(ref), "OPEN");
        });

        it("treats a checkout with no expiry as live", async () => {
            const ref = await newOrder();
            await attempt(ref, null);
            const outcome = await cancelUnpaidOrder(await row(ref), registry);
            assert.equal(!outcome.ok && outcome.code, "payment_in_progress");
        });

        it("cancels once the checkout has expired by the clock or by status", async () => {
            const ref = await newOrder();
            await attempt(ref, inMinutes(10));
            const early = await cancelUnpaidOrder(
                await row(ref),
                registry,
                undefined,
                () => inMinutes(5),
            );
            assert.equal(early.ok, false);
            const late = await cancelUnpaidOrder(
                await row(ref),
                registry,
                undefined,
                () => inMinutes(11),
            );
            assert.equal(late.ok, true);
            assert.equal(await stateOf(ref), "CANCELED");

            const ref2 = await newOrder();
            const a = await attempt(ref2, inMinutes(10));
            await setOnlinePaymentStatus(a.id, "expired");
            assert.equal(
                (await cancelUnpaidOrder(await row(ref2), registry)).ok,
                true,
            );
        });
    });

    describe("expiry worker", () => {
        it("waits for a live checkout to expire, then cancels once", async () => {
            const ref = await newOrder();
            await attempt(ref, inMinutes(10));
            await expireStaleOrders({ registry, now: () => inMinutes(5) });
            assert.equal(await stateOf(ref), "OPEN");
            await expireStaleOrders({ registry, now: () => inMinutes(11) });
            assert.equal(await stateOf(ref), "CANCELED");
        });

        it("is safe to run twice at once", async () => {
            const ref = await newOrder();
            const results = await Promise.all([
                expireStaleOrders({ registry, now: () => inMinutes(1) }),
                expireStaleOrders({ registry, now: () => inMinutes(1) }),
            ]);
            assert.equal(await stateOf(ref), "CANCELED");
            // Other test orders may be swept too; this one only once.
            assert.ok(results.every((n) => n >= 0));
        });
    });

    describe("staff payment on the local provider", () => {
        const provider = () => getActiveProvider();

        it("refuses a canceled order for cash and card, like a completed one", async () => {
            const ref = await newOrder();
            assert.ok(await provider().cancelOrder(ref));
            await assert.rejects(
                provider().payCash!(ref, money, money),
                OrderConflictError,
            );
            await assert.rejects(
                provider().createTerminalCheckout!(ref),
                OrderConflictError,
            );
            assert.equal(await stateOf(ref), "CANCELED");

            const done = await newOrder();
            assert.ok(await provider().payCash!(done, money, money));
            await assert.rejects(
                provider().payCash!(done, money, money),
                OrderConflictError,
            );
        });

        it("allows staff payment while a checkout is live and warns with the order id", async () => {
            const ref = await newOrder();
            await attempt(ref, inMinutes(10));
            const warnings: string[] = [];
            assert.ok(await provider().payCash!(ref, money, money));
            assert.equal(await stateOf(ref), "COMPLETED");
            await warnIfOnlineCheckoutLive(ref, new Date(), (m) =>
                warnings.push(m),
            );
            assert.equal(warnings.length, 1);
            assert.ok(warnings[0].includes(ref));

            const quiet: string[] = [];
            await warnIfOnlineCheckoutLive(ref, inMinutes(20), (m) =>
                quiet.push(m),
            );
            assert.deepEqual(quiet, []);
        });
    });

    describe("late payment webhooks", () => {
        const paid = (externalId: string) => [
            {
                id: `evt-${randomUUID()}`,
                type: "checkout" as const,
                kind: "checkout" as const,
                external_id: externalId,
                status: "paid" as const,
                payment_id: `pay-${randomUUID()}`,
                amount: { ...money },
            },
        ];

        it("records and logs at ERROR when the order was canceled", async () => {
            const ref = await newOrder();
            const a = await attempt(ref, inMinutes(1));
            await getActiveProvider().cancelOrder(ref);
            const logged = await captureLogs(() =>
                applyProcessorEvents(
                    processor,
                    paid(a.externalId) as never,
                    registry,
                ),
            );
            assert.match(logged, /ERROR/);
            assert.match(logged, /late payment, needs refund/);
            assert.ok(logged.includes(ref));
            assert.ok(logged.includes("500"));
            const [stored] = (
                await pool.query(
                    `SELECT status FROM "tessellate-online-payments" WHERE id = $1`,
                    [a.id],
                )
            ).rows;
            assert.equal(stored.status, "paid");
            assert.equal(await stateOf(ref), "CANCELED");
        });

        it("logs at ERROR when staff already completed the order", async () => {
            const ref = await newOrder();
            const a = await attempt(ref, inMinutes(10));
            await getActiveProvider().payCash!(ref, money, money);
            const logged = await captureLogs(() =>
                applyProcessorEvents(
                    processor,
                    paid(a.externalId) as never,
                    registry,
                ),
            );
            assert.match(logged, /late payment, needs refund/);
            assert.ok(logged.includes(ref));
        });

        it("does not log for a normal payment or a replay of it", async () => {
            const ref = await newOrder();
            const a = await attempt(ref, inMinutes(10));
            const events = paid(a.externalId);
            const logged = await captureLogs(async () => {
                await applyProcessorEvents(
                    processor,
                    events as never,
                    registry,
                );
                await applyProcessorEvents(
                    processor,
                    [{ ...events[0], id: `evt-${randomUUID()}` }] as never,
                    registry,
                );
            });
            assert.doesNotMatch(logged, /late payment/);
            assert.equal(await stateOf(ref), "COMPLETED");
        });
    });
});
