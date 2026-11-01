/**
 * Cancels online orders nobody paid for. Only orders created through a
 * gateway credential are candidates, never staff orders; an order with a live
 * invoice, a live hosted checkout (until it expires) or a paid online attempt
 * is skipped. Safe to run twice or on several
 * instances: a per-order Redis lock avoids duplicate provider calls, and the
 * provider's cancel is atomic, so the cancel event fires once per order.
 */
import { pluginContext } from "@/utils/pluginContext";
import { randomUUID } from "node:crypto";
import { and, asc, gt, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { Logger } from "tslog";
import { events } from "@tessellatepos/plugin-sdk/server";
import { drizzleDB } from "@/services/db/postgres";
import { onlinePaymentsTable, ordersTable } from "@/services/db/schema";
import { openUnpaidOrder } from "@/services/db/orders";
import { listLiveCheckouts } from "@/services/db/onlinePayments";
import { withRedisLock } from "@/gateway/createGuard";
import { getActiveProvider } from "@/services/providers";
import { getRedisClient } from "@/services/redis";
import { orderExpiryMs } from "@/gateway/lifecycleConfig";
import type { TessellatePluginRegistry } from "@/utils/registry/plugin/pluginRegistry";

const logger = new Logger({ name: "order-expiry" });

const PAGE = 100;
const CLAIM_TTL_MS = 60_000;

/** How often the worker looks for expired orders. */
export const EXPIRY_INTERVAL_MS = 60_000;

/** What a pass needs from the host. */
export interface ExpiryOptions {
    /** Receives `orderCancelled`; plugins and outbound webhooks observe it. */
    registry: Pick<TessellatePluginRegistry, "emit">;
    /** The clock; tests inject one. */
    now?: () => Date;
    /** Overrides the configured window. */
    windowMs?: number;
}

const RELEASE_CLAIM = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

/**
 * Cancels every expired open unpaid online order once.
 * @param options the registry to notify and optional clock and window
 * @returns how many orders this call canceled
 */
export async function expireStaleOrders(
    options: ExpiryOptions,
): Promise<number> {
    const now = options.now ?? (() => new Date());
    const cutoff = new Date(
        now().getTime() - (options.windowMs ?? orderExpiryMs()),
    );
    const redis = await getRedisClient();
    const provider = getActiveProvider();
    let canceled = 0;
    let after: string | null = null;

    for (;;) {
        const page: { id: string | null; referenceId: string }[] =
            await drizzleDB
                .select({
                    id: ordersTable.id,
                    referenceId: ordersTable.referenceId,
                })
                .from(ordersTable)
                .where(
                    and(
                        isNotNull(ordersTable.createdByCredential),
                        // An order with a live invoice is exempt. Once every
                        // invoice has been canceled and the window has run
                        // from the last change, it is an ordinary unpaid order.
                        or(
                            isNull(ordersTable.invoicedAt),
                            sql`exists (select 1 from ${onlinePaymentsTable} where ${onlinePaymentsTable.order_reference} = ${ordersTable.referenceId} and ${onlinePaymentsTable.kind} = 'invoice') and not exists (select 1 from ${onlinePaymentsTable} where ${onlinePaymentsTable.order_reference} = ${ordersTable.referenceId} and ${onlinePaymentsTable.kind} = 'invoice' and (${onlinePaymentsTable.status} in ('draft', 'sent', 'viewed', 'overdue') or ${onlinePaymentsTable.updated_at} >= ${cutoff}))`,
                        ),
                        openUnpaidOrder,
                        lt(ordersTable.createdAt, cutoff),
                        sql`not exists (select 1 from ${onlinePaymentsTable} where ${onlinePaymentsTable.order_reference} = ${ordersTable.referenceId} and ${onlinePaymentsTable.status} = 'paid')`,
                        // A shopper may still be paying on the processor's page:
                        // wait until that checkout expires, then cancel as usual.
                        sql`not exists (select 1 from ${onlinePaymentsTable} where ${onlinePaymentsTable.order_reference} = ${ordersTable.referenceId} and ${onlinePaymentsTable.kind} = 'checkout' and ${onlinePaymentsTable.status} = 'created' and (${onlinePaymentsTable.expires_at} is null or ${onlinePaymentsTable.expires_at} > ${now()}))`,
                        after ? gt(ordersTable.referenceId, after) : undefined,
                    ),
                )
                .orderBy(asc(ordersTable.referenceId))
                .limit(PAGE);

        for (const row of page) {
            const claimKey = `gw:expire:${row.referenceId}`;
            const token = randomUUID();
            try {
                const won = await redis.set(claimKey, token, {
                    condition: "NX",
                    expiration: { type: "PX", value: CLAIM_TTL_MS },
                });
                if (!won) continue;
                try {
                    // Same lock startCheckout and a manual cancel take, and a
                    // fresh look at the attempts: one may have started since
                    // the page was read.
                    const locked = await withRedisLock(
                        `gw:checkout-lock:${row.referenceId}`,
                        async () =>
                            (await listLiveCheckouts(row.referenceId, now()))
                                .length > 0
                                ? null
                                : provider.cancelOrder(
                                      row.id ?? row.referenceId,
                                  ),
                    );
                    const order = locked?.value;
                    if (order) {
                        canceled++;
                        options.registry.emit(
                            events.orderCancelled,
                            order,
                            pluginContext(undefined, order),
                        );
                    }
                } finally {
                    await redis.eval(RELEASE_CLAIM, {
                        keys: [claimKey],
                        arguments: [token],
                    });
                }
            } catch (err) {
                logger.error(`Could not expire order ${row.referenceId}`, err);
            }
        }

        const last = page[page.length - 1];
        if (page.length < PAGE || !last) break;
        after = last.referenceId;
    }
    return canceled;
}

/**
 * Runs {@link expireStaleOrders} on an interval, one pass at a time.
 * @param registry the plugin registry that receives the cancel events
 * @param intervalMs how often to run
 * @returns a function that stops it
 */
export function startOrderExpiryWorker(
    registry: ExpiryOptions["registry"],
    intervalMs = EXPIRY_INTERVAL_MS,
): () => void {
    let running = false;
    const timer = setInterval(() => {
        if (running) return;
        running = true;
        expireStaleOrders({ registry })
            .catch((err) => logger.error("Order expiry pass failed", err))
            .finally(() => {
                running = false;
            });
    }, intervalMs);
    timer.unref();
    return () => clearInterval(timer);
}
