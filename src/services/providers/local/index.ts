import { and, eq, isNull } from "drizzle-orm";
import { parseMoney, stripBigints } from "@tessellatepos/sdk";
import type {
    Customer,
    CustomerInput,
    CustomerPage,
    CustomerQuery,
    CurrencyCode,
    Location,
    Money,
    Order,
    Tender,
} from "@tessellatepos/sdk";
import { drizzleDB } from "@/services/db/postgres";
import { catalogItemVariationsTable, ordersTable } from "@/services/db/schema";
import { getCatalogByLocation } from "@/services/db/catalog";
import { customerStore, searchCustomers } from "@/services/db/customers";
import { getLocations } from "@/services/db/locations";
import { getOrderById, rowToOrder } from "@/services/db/orders";
import {
    createCategory,
    createItem,
    deleteCategory,
    deleteItemHard,
    setItemArchived,
    updateCategory,
    updateItem,
} from "@/services/db/catalogManage";
import { importCatalogCsv } from "@/services/db/catalogImport";
import {
    OrderConflictError,
    type CatalogProvider,
    type CatalogWriteProvider,
    type CustomerProvider,
    type PaymentProvider,
} from "../types";

/**
 * Matches the order row only while its version is still the one we read.
 * Orders created through POST /orders/create are stored with a NULL version,
 * and `NULL = 0` is never true in SQL, so a null version needs IS NULL.
 * @param currentVersion the version read from the row, or null/undefined
 * @returns the where condition for the optimistic-lock update
 */
function versionMatches(currentVersion: number | null | undefined) {
    return currentVersion == null
        ? isNull(ordersTable.version)
        : eq(ordersTable.version, currentVersion);
}

/**
 * Marks an order paid with a card tender for its full total and returns
 * whether it succeeded. Uses optimistic locking via the `version` column
 * to prevent lost updates when concurrent payments race on the same order.
 * Shared by createTerminalCheckout and confirmMobileReaderPayment.
 * @param orderId the order to mark paid
 * @returns true if the order was found and marked paid
 */
async function markOrderPaidWithCard(orderId: string): Promise<boolean> {
    return drizzleDB.transaction(async (tx) => {
        const row = await getOrderById(orderId, tx);
        if (!row) return false;
        if (row.state === "COMPLETED") {
            throw new OrderConflictError("Order is already paid");
        }

        const orderAmount = parseMoney(row.totalMoney);
        if (!orderAmount?.amount) return false;

        const tender: Tender = {
            id: crypto.randomUUID(),
            locationId: row.locationId,
            transactionId: crypto.randomUUID(),
            type: "CARD",
            amountMoney: orderAmount,
        };

        const currentVersion = row.version ?? 0;
        const result = await tx
            .update(ordersTable)
            .set({
                state: "COMPLETED",
                tenders: stripBigints([
                    ...((row.tenders as Tender[] | null) ?? []),
                    tender,
                ]),
                version: currentVersion + 1,
                updatedAt: new Date(),
            })
            .where(
                and(
                    eq(ordersTable.referenceId, orderId),
                    versionMatches(row.version),
                ),
            )
            .returning({ id: ordersTable.id });

        if (result.length === 0) {
            throw new OrderConflictError(
                "Concurrent modification detected — order was updated by another payment",
            );
        }

        return true;
    });
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
 * Fetches the locations persisted in Postgres, e.g. by an earlier Square
 * sync, since there's no external system to list them from.
 * @returns the locations
 */
async function fetchLocations(): Promise<Location[]> {
    return getLocations();
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
    let currency: CurrencyCode = "CAD";

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
 * Uses optimistic locking via the `version` column to prevent lost updates.
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

    return drizzleDB.transaction(async (tx) => {
        const row = await getOrderById(orderId, tx);
        if (!row) return null;
        if (row.state === "COMPLETED") {
            throw new OrderConflictError("Order is already paid");
        }

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

        const currentVersion = row.version ?? 0;
        const result = await tx
            .update(ordersTable)
            .set({
                state: "COMPLETED",
                tenders: stripBigints([
                    ...((row.tenders as Tender[] | null) ?? []),
                    tender,
                ]),
                version: currentVersion + 1,
                updatedAt: new Date(),
            })
            .where(
                and(
                    eq(ordersTable.referenceId, orderId),
                    versionMatches(row.version),
                ),
            )
            .returning({ id: ordersTable.id });

        if (result.length === 0) {
            throw new OrderConflictError(
                "Concurrent modification detected — order was updated by another payment",
            );
        }

        return changeBackMoney;
    });
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

/**
 * Lists the customers in Postgres, which is the source of truth here.
 * @param query text search, filters and paging
 * @returns a page of customers
 */
async function listCustomers(query: CustomerQuery): Promise<CustomerPage> {
    return searchCustomers(query);
}

/**
 * Fetches one customer from Postgres.
 * @param id the customer id
 * @returns the customer, or null if it doesn't exist
 */
async function getCustomer(id: string): Promise<Customer | null> {
    return customerStore.get(id);
}

/**
 * Creates a customer in Postgres with a generated id.
 * @param input the customer's details
 * @returns the created customer
 */
async function createCustomer(input: CustomerInput): Promise<Customer> {
    const now = new Date().toISOString();
    const customer: Customer = {
        ...input,
        id: crypto.randomUUID(),
        created_at: now,
        updated_at: now,
    };
    await customerStore.upsert(customer);
    return (await customerStore.get(customer.id)) ?? customer;
}

/**
 * Replaces a customer's details in Postgres.
 * @param id the customer id
 * @param input the customer's new details
 * @returns the updated customer, or null if it doesn't exist
 */
async function updateCustomer(
    id: string,
    input: CustomerInput,
): Promise<Customer | null> {
    const existing = await customerStore.get(id);
    if (!existing) return null;
    await customerStore.upsert({
        ...input,
        id,
        created_at: existing.created_at,
        updated_at: existing.updated_at,
    });
    return customerStore.get(id);
}

/**
 * Soft deletes a customer in Postgres.
 * @param id the customer id
 * @returns true if a customer was deleted
 */
async function deleteCustomer(id: string): Promise<boolean> {
    return customerStore.remove(id);
}

/**
 * Fetches every customer in Postgres. Nothing external to list from, so a
 * sync of the local provider changes nothing.
 * @returns all customers
 */
async function fetchCustomers(): Promise<Customer[]> {
    return (await customerStore.list()).items;
}

export const localProvider: CatalogProvider &
    CatalogWriteProvider &
    PaymentProvider &
    CustomerProvider = {
    createItem,
    updateItem,
    archiveItem: setItemArchived,
    deleteItem: deleteItemHard,
    createCategory,
    updateCategory,
    deleteCategory,
    importCatalog: importCatalogCsv,
    listCustomers,
    getCustomer,
    createCustomer,
    updateCustomer,
    deleteCustomer,
    fetchCustomers,
    fetchCatalog,
    fetchLocations,
    createOrder,
    fetchOrder,
    createTerminalCheckout,
    getTerminalCheckoutStatus,
    payCash,
    confirmMobileReaderPayment,
};
