import "@/test/localProvider";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { ProcessorEvent } from "@tessellatepos/sdk";
import { drizzleDB, pool } from "@/services/db/postgres";
import { ordersTable } from "@/services/db/schema";
import { insertOrder } from "@/services/db/orders";
import {
    applyCheckoutStatus,
    findOnlinePayment,
    insertOnlinePayment,
    nextCheckoutStatus,
} from "@/services/db/onlinePayments";
import { applyProcessorEvents } from "@/services/processors/inbound";
import { getRedisClient } from "@/services/redis";
import type { TessellatePluginRegistry } from "@/utils/registry/plugin/pluginRegistry";
import { migrateTestDb } from "./helpers/db";

const suffix = randomUUID().slice(0, 8);
const orderRefs: string[] = [];
const eventIds: string[] = [];
const registry = {
    emit: () => undefined,
} as unknown as TessellatePluginRegistry;

after(async () => {
    const redis = await getRedisClient();
    for (const id of eventIds) await redis.del(`processor-event:square:${id}`);
    for (const ref of orderRefs) {
        await drizzleDB
            .delete(ordersTable)
            .where(eq(ordersTable.referenceId, ref));
    }
    await pool.end();
    await redis.quit();
});

async function attempt() {
    const referenceId = `cs-${suffix}-${randomUUID().slice(0, 6)}`;
    orderRefs.push(referenceId);
    await insertOrder({
        locationId: "LTEST",
        referenceId,
        state: "OPEN",
        totalMoney: { amount: 1500n, currency: "CAD" },
    });
    const external_id = `SQ-${referenceId}`;
    await insertOnlinePayment({
        id: randomUUID(),
        order_reference: referenceId,
        processor_id: "square",
        kind: "checkout",
        external_id,
        status: "created",
        amount: { amount: "1500", currency: "CAD" },
    });
    return external_id;
}

async function send(external_id: string, status: string, payment_id?: string) {
    const id = `${status}-${randomUUID().slice(0, 8)}`;
    eventIds.push(id);
    const event = {
        id,
        type: "payment.updated",
        kind: "checkout",
        external_id,
        status,
        payment_id,
        amount: { amount: 1500n, currency: "CAD" },
    } as ProcessorEvent;
    await applyProcessorEvents("square", [event], registry);
    return (await findOnlinePayment("square", external_id))?.status;
}

describe("checkout attempt status", () => {
    before(migrateTestDb);

    it("keeps refunded final: a late paid event with a new id does not undo it", async () => {
        const ext = await attempt();
        assert.equal(await send(ext, "paid", "pay-1"), "paid");
        assert.equal(await send(ext, "refunded"), "refunded");
        assert.equal(await send(ext, "paid", "pay-1"), "refunded");
        assert.equal(await send(ext, "failed"), "refunded");
        assert.equal(await send(ext, "expired"), "refunded");
    });

    it("keeps a paid attempt paid except for a refund", async () => {
        const ext = await attempt();
        await send(ext, "paid", "pay-2");
        assert.equal(await send(ext, "expired"), "paid");
        assert.equal(await send(ext, "failed"), "paid");
        assert.equal(await send(ext, "refunded"), "refunded");
    });

    it("lets failed or expired become paid, but not move sideways", async () => {
        const ext = await attempt();
        assert.equal(await send(ext, "failed"), "failed");
        assert.equal(await send(ext, "expired"), "failed");
        assert.equal(await send(ext, "refunded"), "failed");
        assert.equal(await send(ext, "paid", "pay-3"), "paid");
        const other = await attempt();
        assert.equal(await send(other, "expired"), "expired");
        assert.equal(await send(other, "failed"), "expired");
        assert.equal(await send(other, "paid", "pay-4"), "paid");
    });

    it("decides each transition from the status under the lock", async () => {
        assert.equal(nextCheckoutStatus("created", "paid"), "paid");
        assert.equal(nextCheckoutStatus("paid", "paid"), null);
        const ext = await attempt();
        const row = await findOnlinePayment("square", ext);
        // Two writers race from "created": exactly one wins, the other sees
        // the winner's status rather than a stale "created".
        const results = await Promise.all([
            applyCheckoutStatus(row!.id, "failed"),
            applyCheckoutStatus(row!.id, "expired"),
        ]);
        assert.equal(results.filter(Boolean).length, 1);
        assert.equal(
            (await findOnlinePayment("square", ext))?.status,
            results.find(Boolean),
        );
    });
});
