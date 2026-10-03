import "dotenv/config";
import { eq } from "drizzle-orm";
import { ordersTable } from "./schema";
import { drizzleDB } from "@/services/db/postgres";
import { stripBigints } from "@tessellatepos/sdk";
import type { Order } from "@tessellatepos/sdk";

// The db or a transaction: only the query builders are used
type TDrizzleDB = Pick<
    typeof drizzleDB,
    "select" | "insert" | "update" | "delete"
>;

function toDbOrder(order: Order): typeof ordersTable.$inferInsert {
    return {
        id: order.id ?? null,
        locationId: order.locationId,
        referenceId: order.referenceId!,
        sourceName: order.source?.name ?? null,
        customerId: order.customerId ?? null,
        lineItems: stripBigints(order.lineItems ?? null),
        taxes: stripBigints(order.taxes ?? null),
        discounts: stripBigints(order.discounts ?? []),
        netAmount: stripBigints(order.netAmount ?? null),
        roundingAdjustment: stripBigints(order.roundingAdjustment ?? null),
        tenders: stripBigints(order.tenders ?? null),
        state: order.state ?? null,
        version: order.version ?? null,
        totalMoney: stripBigints(order.totalMoney ?? null),
        totalTaxMoney: stripBigints(order.totalTaxMoney ?? null),
        totalDiscountMoney: stripBigints(order.totalDiscountMoney ?? null),
        totalTipMoney: stripBigints(order.totalTipMoney ?? null),
        totalServiceChargeMoney: stripBigints(
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
    await db.insert(ordersTable).values(dbOrder);
    return dbOrder;
}

/**
 * Overwrites the locally persisted order with the latest state fetched from
 * Square — used after a payment (cash, terminal, or mobile reader) completes
 * so tenders/state stay in sync.
 * @param order the up-to-date Square order
 * @returns the updated row, or null if the order has no referenceId
 */
export async function syncOrderFromSquare(
    order: Order,
    db: TDrizzleDB = drizzleDB,
) {
    if (!order.referenceId) {
        return null;
    }

    const dbOrder = toDbOrder(order);
    await db
        .update(ordersTable)
        .set({ ...dbOrder, updatedAt: new Date() })
        .where(eq(ordersTable.referenceId, order.referenceId));
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
        .from(ordersTable)
        .where(eq(ordersTable.referenceId, referenceId))
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
    updates: Partial<typeof ordersTable.$inferInsert>,
    db: TDrizzleDB = drizzleDB,
) {
    await db
        .update(ordersTable)
        .set(updates)
        .where(eq(ordersTable.referenceId, referenceId));
}
