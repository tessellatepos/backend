import { eq } from "drizzle-orm";
import { parseMoney, stripBigints } from "@tessellatepos/sdk";
import type { Money, Order, Tender } from "@tessellatepos/sdk";
import { events } from "@tessellatepos/plugin-sdk/server";
import { drizzleDB } from "@/services/db/postgres";
import { ordersTable } from "@/services/db/schema";
import { rowToOrder } from "@/services/db/orders";
import {
    emitDatabaseEvent,
    emitPaymentStatusEvent,
} from "@/services/websocket/events";
import { pluginContext } from "@/utils/pluginContext";
import type { TessellatePluginRegistry } from "@/utils/registry/plugin/pluginRegistry";

export type CompleteOrderResult =
    /** This call moved the order to COMPLETED and emitted the events. */
    | { outcome: "completed"; order: Order }
    /** A concurrent or earlier call already did; nothing was emitted. */
    | { outcome: "already_completed"; transactionIds: string[] }
    /** Canceled (e.g. expired) before the money arrived; left as it is. */
    | { outcome: "canceled" }
    | { outcome: "amount_mismatch" }
    | { outcome: "not_found" };

/**
 * Marks an online order paid after a processor confirmed the money moved, and
 * announces it exactly as the in-person payment paths do: the
 * `paymentCompleted` plugin event (which also feeds outbound webhooks as
 * `order.paid`) and the websocket updates the dashboard listens to. The tender
 * records the amount only; no card details ever reach this backend.
 *
 * Idempotent: the row is locked while it is read, so of any number of
 * concurrent or repeated calls exactly one completes the order and emits.
 * @param orderReference the order's reference id
 * @param payment what the processor reported
 * @param payment.paymentId the processor's payment id, when it has one
 * @param payment.amount the amount the processor says it collected; when
 * present it must equal the order total or the order is not completed
 * @param registry the plugin registry to emit on
 * @returns what happened
 */
export async function completeOrderFromPayment(
    orderReference: string,
    payment: { paymentId?: string; amount?: Money },
    registry: TessellatePluginRegistry,
): Promise<CompleteOrderResult> {
    const result = await drizzleDB.transaction(
        async (tx): Promise<CompleteOrderResult> => {
            const [row] = await tx
                .select()
                .from(ordersTable)
                .where(eq(ordersTable.referenceId, orderReference))
                .limit(1)
                .for("update");
            if (!row) return { outcome: "not_found" };
            if (row.state === "COMPLETED") {
                return {
                    outcome: "already_completed",
                    transactionIds: (
                        (row.tenders as Tender[] | null) ?? []
                    ).map((t) => t.transactionId),
                };
            }
            if (row.state === "CANCELED") return { outcome: "canceled" };

            const total = parseMoney(row.totalMoney);
            if (!total) return { outcome: "amount_mismatch" };
            if (
                payment.amount &&
                (payment.amount.amount !== total.amount ||
                    payment.amount.currency !== total.currency)
            ) {
                return { outcome: "amount_mismatch" };
            }

            const tender: Tender = {
                id: crypto.randomUUID(),
                locationId: row.locationId,
                transactionId: payment.paymentId ?? crypto.randomUUID(),
                createdAt: new Date().toISOString(),
                type: "CARD",
                amountMoney: total,
            };
            const [updated] = await tx
                .update(ordersTable)
                .set({
                    state: "COMPLETED",
                    tenders: stripBigints([
                        ...((row.tenders as Tender[] | null) ?? []),
                        tender,
                    ]),
                    version: (row.version ?? 0) + 1,
                    updatedAt: new Date(),
                })
                .where(eq(ordersTable.referenceId, orderReference))
                .returning();
            return { outcome: "completed", order: rowToOrder(updated) };
        },
    );

    if (result.outcome === "completed") {
        const { order } = result;
        emitPaymentStatusEvent({
            type: "payment_status",
            payload: {
                orderId: orderReference,
                locationId: order.locationId,
                status: "COMPLETED",
                paymentMethod: "ONLINE",
                paymentId: payment.paymentId,
            },
        });
        emitDatabaseEvent({
            type: "order_updated",
            payload: { orderId: orderReference, locationId: order.locationId },
        });
        // No caller: the processor's signed webhook is the trigger.
        registry.emit(
            events.paymentCompleted,
            order,
            "CARD",
            pluginContext(undefined, order),
        );
    }
    return result;
}
