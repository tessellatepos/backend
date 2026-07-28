import "dotenv/config";
import { eq } from "drizzle-orm";
import { squareOrdersTable } from "./schema";
import { drizzleDB } from "@/services/db/postgres";
import { bigintReplacer } from "@tessellatepos/sdk";
import type { Order } from "@tessellatepos/sdk";

type TDrizzleDB = typeof drizzleDB;

/**
 * Recursively converts bigints (e.g. Money amounts, item quantities) into
 * strings so the value can be stored in a jsonb column.
 */
function serializeForJsonb<T>(value: T): T {
    return JSON.parse(JSON.stringify(value, bigintReplacer));
}

function toDbOrder(order: Order): typeof squareOrdersTable.$inferInsert {
    return {
        id: order.id ?? null,
        locationId: order.locationId,
        referenceId: order.referenceId!,
        sourceName: order.source?.name ?? null,
        customerId: order.customerId ?? null,
        lineItems: serializeForJsonb(order.lineItems ?? null),
        taxes: serializeForJsonb(order.taxes ?? null),
        discounts: serializeForJsonb(order.discounts),
        netAmount: serializeForJsonb(order.netAmount ?? null),
        roundingAdjustment: serializeForJsonb(order.roundingAdjustment ?? null),
        tenders: serializeForJsonb(order.tenders ?? null),
        state: order.state ?? null,
        version: order.version ?? null,
        totalMoney: serializeForJsonb(order.totalMoney ?? null),
        totalTaxMoney: serializeForJsonb(order.totalTaxMoney ?? null),
        totalDiscountMoney: serializeForJsonb(order.totalDiscountMoney ?? null),
        totalTipMoney: serializeForJsonb(order.totalTipMoney ?? null),
        totalServiceChargeMoney: serializeForJsonb(
            order.totalServiceChargeMoney ?? null,
        ),
    };
}

/**
 * Persists a Square order locally, keyed by its referenceId.
 * @param order the Square order to persist
 * @returns the inserted row, or null if the order has no referenceId
 */
export async function insertOrder(order: Order, db: TDrizzleDB = drizzleDB) {
    if (!order.referenceId) {
        return null;
    }

    const dbOrder = toDbOrder(order);
    await db.insert(squareOrdersTable).values(dbOrder);
    return dbOrder;
}

/**
 * Fetches a locally persisted order by its referenceId.
 * @param referenceId the reference id of the order
 * @returns the order, or null if it doesn't exist
 */
export async function getOrderById(
    referenceId: string,
    db: TDrizzleDB = drizzleDB,
) {
    const order = await db
        .select()
        .from(squareOrdersTable)
        .where(eq(squareOrdersTable.referenceId, referenceId))
        .limit(1);
    return order[0] || null;
}

/**
 * Updates a locally persisted order.
 * @param referenceId the reference id of the order to update
 * @param updates the fields to update
 */
export async function updateOrder(
    referenceId: string,
    updates: Partial<typeof squareOrdersTable.$inferInsert>,
    db: TDrizzleDB = drizzleDB,
) {
    await db
        .update(squareOrdersTable)
        .set(updates)
        .where(eq(squareOrdersTable.referenceId, referenceId));
}
