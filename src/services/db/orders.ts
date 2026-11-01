import "dotenv/config";
import {
    and,
    desc,
    eq,
    inArray,
    isNotNull,
    or,
    sql,
    type SQL,
} from "drizzle-orm";
import { onlinePaymentsTable, ordersTable } from "./schema";
import { drizzleDB } from "@/services/db/postgres";
import { parseMoney, stripBigints } from "@tessellatepos/sdk";
import type {
    CartItem,
    Discount,
    Order,
    OrderState,
    Tender,
} from "@tessellatepos/sdk";

// The db or a transaction: only the query builders are used
type TDrizzleDB = Pick<
    typeof drizzleDB,
    "select" | "insert" | "update" | "delete"
>;

/**
 * Converts a persisted orders row back into an Order.
 * @param row the persisted order row
 * @returns the order, including its customerId
 */
export function rowToOrder(row: typeof ordersTable.$inferSelect): Order {
    return {
        id: row.id ?? undefined,
        locationId: row.locationId,
        referenceId: row.referenceId,
        source: row.sourceName ? { name: row.sourceName } : undefined,
        customerId: row.customerId ?? undefined,
        lineItems: (row.lineItems as CartItem[] | null) ?? undefined,
        discounts: (row.discounts as Discount[] | null) ?? [],
        netAmount: row.netAmount as Order["netAmount"],
        tenders: (row.tenders as Tender[] | null) ?? undefined,
        state: (row.state as OrderState | null) ?? undefined,
        version: row.version ?? undefined,
        createdAt: row.createdAt?.toISOString(),
        updatedAt: row.updatedAt?.toISOString(),
        totalMoney: parseMoney(row.totalMoney),
        totalTaxMoney: parseMoney(row.totalTaxMoney),
        totalDiscountMoney: parseMoney(row.totalDiscountMoney),
        totalTipMoney: parseMoney(row.totalTipMoney),
        totalServiceChargeMoney: parseMoney(row.totalServiceChargeMoney),
    };
}

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
 * SQL condition for an order that is open and has no tender: the only orders
 * the open-order cap counts and the expiry job may cancel.
 */
export const openUnpaidOrder = sql`${ordersTable.state} = 'OPEN' and coalesce(jsonb_array_length(case when jsonb_typeof(${ordersTable.tenders}) = 'array' then ${ordersTable.tenders} else '[]'::jsonb end), 0) = 0`;

/**
 * Persists a Square order locally, keyed by its referenceId.
 * @param order the Square order to persist
 * @param db the db or a transaction
 * @param createdByCredential the gateway credential that created the order
 * @returns the inserted row, or null if the order has no referenceId
 */
export async function insertOrder(
    order: Order,
    db: TDrizzleDB = drizzleDB,
    createdByCredential?: string,
) {
    if (!order.referenceId) {
        return null;
    }

    const dbOrder = {
        ...toDbOrder(order),
        createdByCredential: createdByCredential ?? null,
    };
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

/** Thrown when a paging cursor isn't one this module issued. */
export class InvalidCursorError extends Error {
    constructor() {
        super("Invalid cursor");
        this.name = "InvalidCursorError";
    }
}

function decodeCursor(cursor: string): [string, string] {
    try {
        const parsed: unknown = JSON.parse(
            Buffer.from(cursor, "base64url").toString(),
        );
        if (
            Array.isArray(parsed) &&
            typeof parsed[0] === "string" &&
            /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(parsed[0]) &&
            typeof parsed[1] === "string"
        ) {
            return [parsed[0], parsed[1]];
        }
    } catch {
        // fall through
    }
    throw new InvalidCursorError();
}

/** A page of orders; `nextCursor` is null on the last page. */
export interface OrderPage {
    orders: Order[];
    nextCursor: string | null;
}

async function pageOrders(
    base: SQL[],
    options: { limit?: number; cursor?: string },
    db: TDrizzleDB,
): Promise<OrderPage> {
    const limit = Math.min(Math.max(Math.floor(options.limit ?? 50), 1), 200);
    const filters = [...base];
    if (options.cursor) {
        const [ts, ref] = decodeCursor(options.cursor);
        filters.push(
            sql`(${ordersTable.createdAt}, ${ordersTable.referenceId}) < (${ts}::timestamptz, ${ref})`,
        );
    }
    const rows = await db
        .select({
            order: ordersTable,
            ts: sql<string>`to_char(${ordersTable.createdAt} at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
        })
        .from(ordersTable)
        .where(and(...filters))
        .orderBy(desc(ordersTable.createdAt), desc(ordersTable.referenceId))
        .limit(limit + 1);
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
        orders: page.map((row) => rowToOrder(row.order)),
        nextCursor:
            rows.length > limit && last
                ? Buffer.from(
                      JSON.stringify([last.ts, last.order.referenceId]),
                  ).toString("base64url")
                : null,
    };
}

/**
 * Lists the orders placed for a customer, newest first. The cursor encodes
 * the last row's created_at (microsecond precision) and reference id.
 * @param customerId the customer to list orders for
 * @param options page size (default 50, max 200) and cursor from a previous page
 * @returns a page of orders
 */
export async function listOrdersByCustomer(
    customerId: string,
    options: { limit?: number; cursor?: string } = {},
    db: TDrizzleDB = drizzleDB,
): Promise<OrderPage> {
    return pageOrders([eq(ordersTable.customerId, customerId)], options, db);
}

/**
 * Lists the orders a gateway credential created, newest first, restricted to
 * the locations it may act on.
 * @param credentialId the credential that created the orders
 * @param locationIds the credential's location ids, or "all"
 * @param options page size (default 50, max 200) and cursor from a previous page
 * @returns a page of orders
 */
export async function listOrdersByCredential(
    credentialId: string,
    locationIds: string[] | "all",
    options: { limit?: number; cursor?: string } = {},
    db: TDrizzleDB = drizzleDB,
): Promise<OrderPage> {
    const filters = [eq(ordersTable.createdByCredential, credentialId)];
    if (locationIds !== "all") {
        filters.push(inArray(ordersTable.locationId, locationIds));
    }
    return pageOrders(filters, options, db);
}

/**
 * Lists the online orders at one location for staff, newest first: orders a
 * credential created, plus any order that has a payment attempt (a till order
 * that was invoiced, say).
 * @param locationId the location
 * @param filter `source` is the order's source name (the credential's name);
 * `processor` keeps orders with an attempt at that processor
 * @param options page size (default 50, max 200) and cursor
 * @returns a page of orders
 */
export async function listOnlineOrdersAtLocation(
    locationId: string,
    filter: { source?: string; processor?: string } = {},
    options: { limit?: number; cursor?: string } = {},
    db: TDrizzleDB = drizzleDB,
): Promise<OrderPage> {
    const attempt = (extra?: SQL) =>
        sql`exists (select 1 from ${onlinePaymentsTable} where ${onlinePaymentsTable.order_reference} = ${ordersTable.referenceId}${extra ? sql` and ${extra}` : sql``})`;
    const filters: SQL[] = [
        eq(ordersTable.locationId, locationId),
        or(isNotNull(ordersTable.createdByCredential), attempt())!,
    ];
    if (filter.source) filters.push(eq(ordersTable.sourceName, filter.source));
    if (filter.processor) {
        filters.push(
            attempt(eq(onlinePaymentsTable.processor_id, filter.processor)),
        );
    }
    return pageOrders(filters, options, db);
}

/**
 * Finds an order by the id the provider gave it or by its reference id.
 * @param id either id
 * @returns the row, or null
 */
export async function getOrderByAnyId(id: string, db: TDrizzleDB = drizzleDB) {
    const [row] = await db
        .select()
        .from(ordersTable)
        .where(or(eq(ordersTable.referenceId, id), eq(ordersTable.id, id)))
        .limit(1);
    return row ?? null;
}
