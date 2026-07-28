import {
    Currency,
    OrderLineItem,
    SquareClient,
    SquareEnvironment,
} from "square";
import type {
    Item,
    ItemCatalog,
    ItemVariation,
    ItemCategory,
    ItemVariationLocationOverrides,
    squareHelperCategory,
    squareHelperItemVariation,
    Order,
    Money,
} from "@tessellatepos/sdk";
import { configDotenv } from "dotenv";
configDotenv();

/**
 * Square Client instance.
 */
const client = new SquareClient({
    token: process.env.SQUARE_TOKEN,
    environment: SquareEnvironment.Production,
});

/**
 * Fetches the item catalog from Square.
 *
 * @returns {Promise<ItemCatalog>} The item catalog.
 */
export async function fetchItems(): Promise<ItemCatalog> {
    const response = await client.catalog.list();
    // const itemsMap = new Map<string, ISquareItem>();
    const itemCatalog: ItemCatalog = {
        items: [],
    };

    // Iterate through the Page results
    for await (const item of response) {
        if (item.type === "ITEM") {
            if (!item.itemData) continue;
            //Gets the image URLs if there are any images
            const imageURLs: string[] = [];
            if (item.itemData.imageIds) {
                if (item.itemData.imageIds?.length > 0) {
                    if (item.itemData.imageIds?.length > 1) {
                        for (const imageId of item.itemData.imageIds) {
                            if (!imageId) continue;
                            const imageURL = await fetchSquareImage(imageId);
                            imageURLs.push(imageURL);
                        }
                    } else {
                        const imageURL = await fetchSquareImage(
                            item.itemData.imageIds[0],
                        );
                        imageURLs.push(imageURL);
                    }
                }
            }

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
                    pricingType: varItem.itemVariationData.pricingType,
                    priceMoney: varItem.itemVariationData.priceMoney,
                    locationOverrides:
                        varItem.itemVariationData.locationOverrides?.map(
                            (lo) =>
                                ({
                                    locationId: lo.locationId,
                                    priceMoney: lo.priceMoney,
                                    pricingType: lo.pricingType,
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

            //get categories
            const reportingCategory: ItemCategory[] = [];
            for (const cat of rawCategories || []) {
                if (!cat.id) continue;
                const category = await fetchSquareCategory(cat.id);
                reportingCategory.push(category);
            }

            //Construct the catalog item
            const catalogItem: Item = {
                id: item.id,
                name: item.itemData.name,
                buyerFacingName: item.itemData.buyerFacingName,
                labelColor: item.itemData.labelColor,
                isTaxable: item.itemData.isTaxable,
                variations: variations,
                categories: categories,
                isArchived: item.itemData.isArchived,
                reportingCategoryIds: reportingCategory,
                presentAtAllLocations: item.presentAtAllLocations,
                presentAtLocationsIds: item.presentAtLocationIds,
                imageIds: item.itemData.imageIds,
                imageURLs: imageURLs,
            };
            //Add the item to the catalog
            itemCatalog.items.push(catalogItem);
        }
    }
    return itemCatalog;
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
            presentAtAllLocations: resp.presentAtAllLocations,
            presentAtLocationsIds: resp.presentAtLocationIds,
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
export async function createSquareOrder(
    order: Order,
): Promise<Order | undefined | null> {
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
export async function fetchSquareOrder(
    orderId: string,
): Promise<Order | undefined | null> {
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
export async function createTerminalCheckout(
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
export async function getTerminalCheckoutStatus(checkoutId: string) {
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

export async function paySquareOrderWithCash(
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
            amount: amountTendered.amount,
            currency: amountTendered.currency as Currency,
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
