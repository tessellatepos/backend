/**
 * Tunables for online-order lifecycle. Read at call time so a restart is the
 * only thing a change needs, and tests can set the environment per case.
 */

function positiveInt(name: string, fallback: number): number {
    const parsed = Number.parseInt(process.env[name] ?? "", 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** How long an online order may stay open and unpaid, in milliseconds. */
export function orderExpiryMs(): number {
    return positiveInt("ORDER_EXPIRY_MINUTES", 30) * 60_000;
}

/** Most open unpaid orders one credential may hold at once. */
export function openOrderCap(): number {
    return positiveInt("MAX_OPEN_ORDERS_PER_CREDENTIAL", 50);
}

/**
 * How long after the end of its due date an unpaid invoice is marked overdue,
 * in milliseconds. 0 is allowed: overdue as soon as the due date has passed.
 */
export function invoiceOverdueMs(): number {
    const parsed = Number.parseInt(process.env.INVOICE_OVERDUE_DAYS ?? "", 10);
    const days = Number.isFinite(parsed) && parsed >= 0 ? parsed : 7;
    return days * 24 * 60 * 60_000;
}
