import { eq } from "drizzle-orm";
import { parseMoney, stripBigints } from "@tessellatepos/sdk";
import type {
    CartItem,
    Discount,
    Money,
    Order,
    OrderState,
    Tender,
} from "@tessellatepos/sdk";
import { drizzleDB } from "@/services/db/postgres";
import {
    catalogItemVariationsTable,
    ordersTable,
} from "@/services/db/schema";
import { getCatalogByLocation } from "@/services/db/catalog";
import { getOrderById, updateOrder } from "@/services/db/orders";
import type { CatalogProvider, PaymentProvider } from "../types";

/**
 * Converts a persisted square-orders row back into an Order.
 * @param row the persisted order row
 * @returns the order
 */
function rowToOrder(row: typeof ordersTable.$inferSelect): Order {
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
        totalMoney: parseMoney(row.totalMoney),
        totalTaxMoney: parseMoney(row.totalTaxMoney),
        totalDiscountMoney: parseMoney(row.totalDiscountMoney),
        totalTipMoney: parseMoney(row.totalTipMoney),
        totalServiceChargeMoney: parseMoney(row.totalServiceChargeMoney),
    };
}

/**
 * Marks an order paid with a card tender for its full total and returns
 * whether it succeeded. Shared by createTerminalCheckout and
 * confirmMobileReaderPayment, since neither talks to real hardware here —
 * both just record a completed card tender immediately.
 * @param orderId the order to mark paid
 * @returns true if the order was found and marked paid
 */
async function markOrderPaidWithCard(orderId: string): Promise<boolean> {
    const row = await getOrderById(orderId);
    if (!row) return false;

    const orderAmount = parseMoney(row.totalMoney);
    if (!orderAmount?.amount) return false;

    const tender: Tender = {
        id: crypto.randomUUID(),
        locationId: row.locationId,
        transactionId: crypto.randomUUID(),
        type: "CARD",
        amountMoney: orderAmount,
    };

    await updateOrder(orderId, {
        state: "COMPLETED",
        tenders: stripBigints([
            ...((row.tenders as Tender[] | null) ?? []),
            tender,
        ]),
    });

    return true;
}

/**
 * Fetches the item catalog from Postgres.
 * @returns the items and, for each item id, the location ids it's present at
 */
async function fetchCatalog(): ReturnType<CatalogProvider["fetchCatalog"]> {
    const catalog = await getCatalogByLocation();
    const itemLocationIds = new Map<string, string[]>();
    for (const item of catalog.items) {
        itemLocationIds.set(item.id, item.locationIds ?? []);
    }
    return { items: catalog.items, itemLocationIds };
}

/**
 * Computes order totals from the local catalog.
 * @param order the order to price, with lineItems already set
 * @returns the priced order, or null if it has no line items
 */
async function createOrder(order: Order): Promise<Order | undefined | null> {
    if (!order.lineItems || order.lineItems.length === 0) {
        return null;
    }

    let totalAmount = 0n;
    let currency = "CAD";

    for (const lineItem of order.lineItems) {
        const quantity = BigInt(lineItem.quantity ?? 1n);
        let unitPrice = lineItem.priceMoney
            ? parseMoney(lineItem.priceMoney)
            : undefined;

        if (!unitPrice?.amount && lineItem.itemId) {
            const [variationRow] = await drizzleDB
                .select({ priceMoney: catalogItemVariationsTable.priceMoney })
                .from(catalogItemVariationsTable)
                .where(
                    eq(catalogItemVariationsTable.variationId, lineItem.itemId),
                )
                .limit(1);
            unitPrice = parseMoney(variationRow?.priceMoney);
        }

        if (!unitPrice?.amount) continue;
        currency = unitPrice.currency ?? currency;
        totalAmount += unitPrice.amount * quantity;
    }

    const id = order.referenceId ?? crypto.randomUUID();
    const totalMoney: Money = { amount: totalAmount, currency };

    return {
        ...order,
        id,
        referenceId: order.referenceId ?? id,
        state: "OPEN",
        totalMoney,
        netAmount: { totalMoney },
    };
}

/**
 * Fetches a persisted order from Postgres.
 * @param orderId the id of the order to fetch (same as its referenceId)
 * @returns the order, or null if it doesn't exist
 */
async function fetchOrder(orderId: string): Promise<Order | undefined | null> {
    if (!orderId) return null;
    const row = await getOrderById(orderId);
    return row ? rowToOrder(row) : null;
}

/**
 * Marks an order paid with cash and returns the change due.
 * @param orderId the order to pay
 * @param amountTendered the cash amount the customer handed over
 * @param orderAmount the order's total
 * @returns the change due back to the customer, or null if the order can't be found or the tender is short
 */
async function payCash(
    orderId: string,
    amountTendered: Money,
    orderAmount: Money,
): Promise<Money | null> {
    if (!amountTendered.amount || !orderAmount.amount) return null;

    const changeAmount = amountTendered.amount - orderAmount.amount;
    if (changeAmount < 0n) return null;

    const row = await getOrderById(orderId);
    if (!row) return null;

    const changeBackMoney: Money = {
        amount: changeAmount,
        currency: orderAmount.currency,
    };
    const tender: Tender = {
        id: crypto.randomUUID(),
        locationId: row.locationId,
        transactionId: crypto.randomUUID(),
        type: "CASH",
        amountMoney: orderAmount,
        cashDetails: {
            buyerTenderedMoney: amountTendered,
            changeBackMoney,
        },
    };

    await updateOrder(orderId, {
        state: "COMPLETED",
        tenders: stripBigints([
            ...((row.tenders as Tender[] | null) ?? []),
            tender,
        ]),
    });

    return changeBackMoney;
}

/**
 * Marks the order paid immediately with a card tender and hands back a
 * synthetic checkout id. There's no physical Terminal here, so the checkout
 * completes at creation time instead of waiting on a device.
 * @param orderId the order to check out
 * @returns a checkout id, or null if the order couldn't be marked paid
 */
async function createTerminalCheckout(
    orderId: string,
): Promise<string | null | undefined> {
    const paid = await markOrderPaidWithCard(orderId);
    return paid ? crypto.randomUUID() : null;
}

/**
 * Reports the status of a checkout created by createTerminalCheckout. Since
 * that checkout completes synchronously at creation, this always reports
 * COMPLETED.
 * @param checkoutId the id of the checkout
 * @returns the checkout status
 */
async function getTerminalCheckoutStatus(
    checkoutId: string,
): Promise<string | null | undefined> {
    if (!checkoutId) return null;
    return "COMPLETED";
}

/**
 * Marks the order paid with a card tender. There's no physical Mobile
 * Reader here, so the payment is recorded immediately rather than verified
 * against a real payment object.
 * @param orderId the order the payment is for
 * @param paymentId the payment id supplied by the caller (unused, no external payment to verify)
 * @returns true if the order was found and marked paid
 */
async function confirmMobileReaderPayment(
    orderId: string,
    paymentId: string,
): Promise<boolean> {
    if (!orderId || !paymentId) return false;
    return markOrderPaidWithCard(orderId);
}

export const localProvider: CatalogProvider & PaymentProvider = {
    fetchCatalog,
    createOrder,
    fetchOrder,
    createTerminalCheckout,
    getTerminalCheckoutStatus,
    payCash,
    confirmMobileReaderPayment,
};
