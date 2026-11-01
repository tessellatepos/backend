import { sql } from "drizzle-orm";
import { drizzleDB } from "@/services/db/postgres";

/** Where to look: a time window and, optionally, a set of locations. */
export interface SummaryQuery {
    from: Date;
    to: Date;
    /** Only these locations; null means every location. */
    locationIds: string[] | null;
}

export interface MoneyJson {
    /** Minor units as a string, since the amount is a bigint. */
    amount: string;
    currency: string;
}

export interface LocationTotals {
    locationId: string;
    currency: string;
    salesTotal: MoneyJson;
    orderCount: number;
    averageOrder: MoneyJson;
}

export interface PaymentSplit {
    type: string;
    currency: string;
    count: number;
    total: MoneyJson;
}

export interface RecentOrder {
    referenceId: string;
    locationId: string;
    source: string | null;
    state: string | null;
    totalMoney: MoneyJson | null;
    createdAt: string | null;
}

export interface DashboardSummary {
    from: string;
    to: string;
    /** Per location and currency; completed orders created in the window. */
    locations: LocationTotals[];
    /** Null when the locations sold in more than one currency. */
    totals: {
        currency: string;
        salesTotal: MoneyJson;
        orderCount: number;
        averageOrder: MoneyJson;
    } | null;
    paymentMethods: PaymentSplit[];
    /** OPEN orders right now, regardless of the window. */
    openOrders: number;
    recentOrders: RecentOrder[];
}

const RECENT_LIMIT = 10;

function money(amount: bigint | string, currency: string): MoneyJson {
    return { amount: String(amount), currency };
}

function locationFilter(ids: string[] | null) {
    if (ids === null) return sql`TRUE`;
    if (ids.length === 0) return sql`FALSE`;
    return sql`location_id IN (${sql.join(
        ids.map((id) => sql`${id}`),
        sql`, `,
    )})`;
}

// Money columns are jsonb { amount: "123", currency: "CAD" }
const AMOUNT = sql`(total_money->>'amount')::bigint`;
const CURRENCY = sql`COALESCE(total_money->>'currency', 'USD')`;

/**
 * Sales figures for the dashboard, computed in SQL. "Sales" are COMPLETED
 * orders whose created_at falls in the window (orders have no completed-at).
 * @param q the window and location restriction
 * @returns the aggregates and the latest orders
 */
export async function getDashboardSummary(
    q: SummaryQuery,
): Promise<DashboardSummary> {
    const where = locationFilter(q.locationIds);
    const inWindow = sql`state = 'COMPLETED' AND created_at >= ${q.from.toISOString()} AND created_at <= ${q.to.toISOString()}`;

    const [perLocation, tenders, open, recent] = await Promise.all([
        drizzleDB.execute<{
            location_id: string;
            currency: string;
            total: string;
            n: string;
        }>(sql`
            SELECT location_id, ${CURRENCY} AS currency,
                   COALESCE(SUM(${AMOUNT}), 0)::text AS total,
                   COUNT(*)::text AS n
            FROM "tessellate-orders"
            WHERE ${where} AND ${inWindow}
            GROUP BY location_id, ${CURRENCY}
            ORDER BY location_id, currency`),
        drizzleDB.execute<{
            type: string;
            currency: string;
            n: string;
            total: string;
        }>(sql`
            SELECT COALESCE(t->>'type', 'OTHER') AS type,
                   COALESCE(t->'amountMoney'->>'currency', 'USD') AS currency,
                   COUNT(*)::text AS n,
                   COALESCE(SUM((t->'amountMoney'->>'amount')::bigint), 0)::text AS total
            FROM "tessellate-orders",
                 jsonb_array_elements(
                     CASE WHEN jsonb_typeof(tenders) = 'array'
                          THEN tenders ELSE '[]'::jsonb END
                 ) AS t
            WHERE ${where} AND ${inWindow}
            GROUP BY 1, 2
            ORDER BY SUM((t->'amountMoney'->>'amount')::bigint) DESC, type`),
        drizzleDB.execute<{ n: string }>(sql`
            SELECT COUNT(*)::text AS n FROM "tessellate-orders"
            WHERE ${where} AND state = 'OPEN'`),
        drizzleDB.execute<{
            reference_id: string;
            location_id: string;
            source_name: string | null;
            state: string | null;
            total_money: { amount?: string; currency?: string } | null;
            created_at: Date | null;
        }>(sql`
            SELECT reference_id, location_id, source_name, state, total_money, created_at
            FROM "tessellate-orders"
            WHERE ${where} AND (state IS NULL OR state <> 'DRAFT')
            ORDER BY created_at DESC NULLS LAST
            LIMIT ${RECENT_LIMIT}`),
    ]);

    const locations: LocationTotals[] = perLocation.rows.map((r) => {
        const total = BigInt(r.total);
        const n = BigInt(r.n);
        return {
            locationId: r.location_id,
            currency: r.currency,
            salesTotal: money(total, r.currency),
            orderCount: Number(n),
            averageOrder: money(n === 0n ? 0n : total / n, r.currency),
        };
    });

    const currencies = new Set(locations.map((l) => l.currency));
    let totals: DashboardSummary["totals"] = null;
    if (currencies.size <= 1) {
        const currency = locations[0]?.currency ?? "USD";
        const total = locations.reduce(
            (sum, l) => sum + BigInt(l.salesTotal.amount),
            0n,
        );
        const n = locations.reduce((sum, l) => sum + l.orderCount, 0);
        totals = {
            currency,
            salesTotal: money(total, currency),
            orderCount: n,
            averageOrder: money(n === 0 ? 0n : total / BigInt(n), currency),
        };
    }

    return {
        from: q.from.toISOString(),
        to: q.to.toISOString(),
        locations,
        totals,
        paymentMethods: tenders.rows.map((r) => ({
            type: r.type,
            currency: r.currency,
            count: Number(r.n),
            total: money(r.total, r.currency),
        })),
        openOrders: Number(open.rows[0]?.n ?? 0),
        recentOrders: recent.rows.map((r) => ({
            referenceId: r.reference_id,
            locationId: r.location_id,
            source: r.source_name,
            state: r.state,
            totalMoney:
                r.total_money?.amount !== undefined
                    ? money(
                          r.total_money.amount,
                          r.total_money.currency ?? "USD",
                      )
                    : null,
            createdAt: r.created_at
                ? new Date(r.created_at).toISOString()
                : null,
        })),
    };
}

export interface DashboardHealth {
    provider: { id: string; connected: boolean };
    /** Latest catalog write; every sync touches every item. */
    catalogLastSyncedAt: string | null;
    devicesPaired: number;
    pluginsLoaded: number;
}

/**
 * Connection and sync state shown beside the sales figures.
 * @param provider the active provider id and whether it is connected
 * @param pluginsLoaded how many plugins the registry holds
 * @returns the health block
 */
export async function getDashboardHealth(
    provider: DashboardHealth["provider"],
    pluginsLoaded: number,
): Promise<DashboardHealth> {
    const [catalog, devices] = await Promise.all([
        drizzleDB.execute<{ at: Date | null }>(
            sql`SELECT MAX(updated_at) AS at FROM "tessellate-catalog-items"`,
        ),
        drizzleDB.execute<{ n: string }>(
            sql`SELECT COUNT(*)::text AS n FROM "tessellate-devices-config" WHERE paired_at IS NOT NULL`,
        ),
    ]);
    const at = catalog.rows[0]?.at;
    return {
        provider,
        catalogLastSyncedAt: at ? new Date(at).toISOString() : null,
        devicesPaired: Number(devices.rows[0]?.n ?? 0),
        pluginsLoaded,
    };
}
