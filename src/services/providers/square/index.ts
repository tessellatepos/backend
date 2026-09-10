import { Currency, OrderLineItem, SquareClient } from "square";
import type {
    Item,
    ItemVariation,
    ItemCategory,
    ItemVariationLocationOverrides,
    squareHelperCategory,
    squareHelperItemVariation,
    Order,
    Money,
} from "@tessellatepos/sdk";
import { configDotenv } from "dotenv";
import type {
    CatalogProvider,
    PaymentProvider,
    DevicePairingProvider,
    DeviceCodePairing,
} from "../types";
import {
    getDecryptedAccessToken,
    getSquareEnvironment,
} from "@/services/squareOauth";

configDotenv();

/**
 * Resolves the token each request goes out with: the seller's stored OAuth
 * access token, refreshed on demand. SQUARE_TOKEN remains a development
 * fallback for a deployment that hasn't been through the OAuth flow yet.
 * @returns a Square access token
 */
async function resolveAccessToken(): Promise<string> {
    const oauthToken = await getDecryptedAccessToken();
    if (oauthToken) {
        return oauthToken;
    }

    if (process.env.SQUARE_TOKEN) {
        return process.env.SQUARE_TOKEN;
    }

    throw new Error(
        "Square is not connected — complete the OAuth flow in Settings or set SQUARE_TOKEN",
    );
}

/**
 * Square Client instance. The token is supplied per request rather than
 * captured at startup so a newly-completed authorization (or a refresh) takes
 * effect without restarting the server.
 */
const client = new SquareClient({
    token: () => resolveAccessToken(),
    environment: getSquareEnvironment(),
});

function mapPricingType(
    pricingType?: string,
): "FIXED" | "VARIABLE" | undefined {
    if (pricingType === "FIXED_PRICING") return "FIXED";
    if (pricingType === "VARIABLE_PRICING") return "VARIABLE";
    return undefined;
}

/**
 * Fetches the item catalog from Square.
 * @returns the items and, for each item id, the location ids it's present at
 */
async function fetchCatalog(): ReturnType<CatalogProvider["fetchCatalog"]> {
    const response = await client.catalog.list();
    const items: Item[] = [];
    const itemLocationIds = new Map<string, string[]>();

    // Iterate through the Page results
    for await (const item of response) {
        if (item.type === "ITEM") {
            if (!item.itemData) continue;

            const imageId = item.itemData.imageIds?.[0];
            const image = imageId ? await fetchSquareImage(imageId) : null;

            const rawVariations = item.itemData.variations as
                squareHelperItemVariation[] | undefined;
            const variations: ItemVariation[] = [];
            // prepare a minimal parent summary (id + name) to attach to each variation
            const parentSummary = {
                id: item.id,
                name: item.itemData.name,
            };

            for (const varItem of rawVariations || []) {
                if (!varItem.itemVariationData) continue;
                const variation: ItemVariation = {
                    itemId: varItem.id,
                    name: varItem.itemVariationData.name,
                    sku: varItem.itemVariationData.sku,
                    upc: varItem.itemVariationData.upc,
                    ordinal: varItem.itemVariationData.ordinal,
                    pricingType: mapPricingType(
                        varItem.itemVariationData.pricingType,
                    ),
                    priceMoney: varItem.itemVariationData.priceMoney,
                    locationOverrides:
                        varItem.itemVariationData.locationOverrides?.map(
                            (lo) =>
                                ({
                                    locationId: lo.locationId,
                                    priceMoney: lo.priceMoney,
                                    pricingType: mapPricingType(lo.pricingType),
                                    trackInventory: lo.trackInventory,
                                }) as ItemVariationLocationOverrides,
                        ),
                    trackInventory: varItem.itemVariationData.trackInventory,
                    parent: parentSummary,
                };
                variations.push(variation);
            }

            //get categories
            const rawCategories = item.itemData.categories as
                squareHelperCategory[] | undefined;
            const categories: ItemCategory[] = [];
            for (const cat of rawCategories || []) {
                if (!cat.id) continue;
                const category = await fetchSquareCategory(cat.id);
                categories.push(category);
            }

            //Construct the catalog item
            const catalogItem: Item = {
                id: item.id,
                name: item.itemData.name,
                displayName: item.itemData.buyerFacingName,
                labelColor: item.itemData.labelColor,
                isTaxable: item.itemData.isTaxable,
                variations: variations,
                categories: categories,
                isArchived: item.itemData.isArchived,
                image: image,
            };
            items.push(catalogItem);

            if (item.presentAtLocationIds) {
                itemLocationIds.set(item.id, item.presentAtLocationIds);
            }
        }
    }
    return { items, itemLocationIds };
}

/**
 * Fetches the image URL for a given Square image ID.
 * @param id The id of the image object
 * @returns {Promise<string>} The image URL.
 */
async function fetchSquareImage(id: string): Promise<string> {
    const response = await client.catalog.object.get({ objectId: id });
    if (response.object?.type === "IMAGE") {
        return response.object.imageData?.url || "";
    }
    return "";
}

/**
 * Fetches the category for a given Square image ID.
 * @param id The id of the category object
 * @returns {Promise<ItemCategory>} The Square Item Category.
 */
async function fetchSquareCategory(id: string): Promise<ItemCategory> {
    const response = await client.catalog.object.get({ objectId: id });
    if (response.object?.type === "CATEGORY") {
        const resp = response.object;

        let parentCategory: ItemCategory = {};
        const parentId = resp.categoryData?.parentCategory?.id;
        if (parentId) {
            parentCategory = await fetchSquareCategory(parentId);
        }

        const category: ItemCategory = {
            id: resp.id,
            name: resp.categoryData?.name,
            parentCategory,
            imageId: resp.categoryData?.imageIds
                ? resp.categoryData.imageIds[0]
                : null,
            imageURL: resp.categoryData?.imageIds
                ? await fetchSquareImage(resp.categoryData.imageIds[0])
                : null,
        };
        return category;
    }
    return {};
}

/**
 * Creates an order with square
 * @param order the order to create
 * @returns the created order
 */
async function createOrder(order: Order): Promise<Order | undefined | null> {
    if (!order.lineItems) {
        return null;
    }

    const idempotencyKey = crypto.randomUUID();
    const response = await client.orders.create({
        idempotencyKey: idempotencyKey,
        order: {
            locationId: order.locationId,
            lineItems: order.lineItems.map((li) => {
                const lineItem: OrderLineItem = {
                    quantity: li.quantity!.toString(),
                    catalogObjectId: li.itemId,
                };
                return lineItem;
            }),
            referenceId: order.referenceId,
            source: order.source,
        },
    });

    if (response) {
        return response.order as Order;
    }
}

/**
 * Fetches an order from Square by ID
 * @param orderId the id of the order to fetch
 * @returns the order, or null if it doesn't exist
 */
async function fetchOrder(orderId: string): Promise<Order | undefined | null> {
    if (!orderId) {
        return null;
    }

    const response = await client.orders.get({ orderId });

    if (response) {
        return response.order as Order;
    }
}

/**
 * Creates a terminal checkour
 * @param orderId the order id for the checkout process
 * @param amount the amount to check out with a square terminal
 * @param deviceId the device id to create the order on
 * @returns the terminal checkout id
 */
async function createTerminalCheckout(
    orderId: string,
    amount: Money,
    deviceId: string,
) {
    if (!orderId || !amount || !deviceId) {
        return null;
    }

    const idempotencyKey = crypto.randomUUID();
    const response = await client.terminal.checkouts.create({
        idempotencyKey: idempotencyKey,
        checkout: {
            amountMoney: {
                currency: amount.currency as Currency,
                amount: amount.amount,
            },
            deviceOptions: {
                deviceId: deviceId,
                showItemizedCart: true,
            },
            orderId: orderId,
        },
    });

    if (response) {
        return response.checkout?.id;
    }
}

/**
 * Checks the status of a terminal order
 * @param checkoutId the id of the checkout
 * @returns the status of the checkout
 */
async function getTerminalCheckoutStatus(checkoutId: string) {
    if (!checkoutId) {
        return null;
    }

    const response = await client.terminal.checkouts.get({
        checkoutId: checkoutId,
    });

    if (response) {
        return response.checkout?.status;
    }
}

/**
 * Verifies a payment taken by the Square Mobile Payments SDK (phone-attached
 * Reader) actually belongs to the given order before we trust it. We never
 * see a card nonce for this path — the mobile app hands us a paymentId and
 * we confirm it here.
 * @param orderId the order the payment should be for
 * @param paymentId the Square payment id returned by the Mobile Payments SDK
 * @returns true if the payment is COMPLETED, for this order, and its amount matches the order total
 */
async function confirmMobileReaderPayment(
    orderId: string,
    paymentId: string,
): Promise<boolean> {
    if (!orderId || !paymentId) {
        return false;
    }

    const response = await client.payments.get({ paymentId });
    const payment = response.payment;
    if (!payment) {
        return false;
    }

    if (payment.orderId !== orderId) {
        return false;
    }

    if (payment.status !== "COMPLETED") {
        return false;
    }

    const order = await fetchOrder(orderId);
    if (!order?.totalMoney?.amount || !payment.amountMoney?.amount) {
        return false;
    }

    return payment.amountMoney.amount === order.totalMoney.amount;
}

/**
 * Pays an order with cash. Square requires amountMoney to equal the order
 * total when a payment is attached to an orderId — what the customer
 * actually handed over goes in cashDetails.buyerSuppliedMoney, and Square
 * computes changeBackMoney as the difference itself.
 * @param orderId the order to pay
 * @param amountTendered the cash amount the customer handed over
 * @param orderAmount the order's total (must match amountMoney sent to Square)
 * @returns the change due back to the customer
 */
async function payCash(
    orderId: string,
    amountTendered: Money,
    orderAmount: Money,
) {
    if (!orderId || !amountTendered || !orderAmount) {
        return null;
    }

    const idempotencyKey = crypto.randomUUID();
    const response = await client.payments.create({
        idempotencyKey: idempotencyKey,
        sourceId: "CASH",
        amountMoney: {
            amount: orderAmount.amount,
            currency: orderAmount.currency as Currency,
        },
        autocomplete: true,
        cashDetails: {
            buyerSuppliedMoney: {
                amount: amountTendered.amount,
                currency: amountTendered.currency as Currency,
            },
        },
        orderId: orderId,
    });

    return response.payment?.cashDetails?.changeBackMoney as Money;
}

export const squareProvider: CatalogProvider & PaymentProvider = {
    fetchCatalog,
    createOrder,
    fetchOrder,
    createTerminalCheckout,
    getTerminalCheckoutStatus,
    payCash,
    confirmMobileReaderPayment,
};
