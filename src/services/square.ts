import { OrderLineItem, SquareClient, SquareEnvironment } from "square";
import type {
    squareItem,
    squareItemCatalog,
    squareItemVariation,
    squareItemCategory,
    squareItemVariationLocationOverrides,
    squareHelperCategory,
    squareHelperItemVariation,
} from "@tessellate-pos/common/src/types/squareTypes";
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
 * @returns {Promise<squareItemCatalog>} The item catalog.
 */
export async function fetchItems(): Promise<squareItemCatalog> {
    const response = await client.catalog.list();
    // const itemsMap = new Map<string, ISquareItem>();
    const itemCatalog: squareItemCatalog = {
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
                | squareHelperItemVariation[]
                | undefined;
            const variations: squareItemVariation[] = [];
            // prepare a minimal parent summary (id + name) to attach to each variation
            const parentSummary = {
                id: item.id,
                name: item.itemData.name,
            };

            for (const varItem of rawVariations || []) {
                if (!varItem.itemVariationData) continue;
                const variation: squareItemVariation = {
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
                                }) as squareItemVariationLocationOverrides,
                        ),
                    trackInventory: varItem.itemVariationData.trackInventory,
                    parent: parentSummary,
                };
                variations.push(variation);
            }

            //get categories
            const rawCategories = item.itemData.categories as
                | squareHelperCategory[]
                | undefined;
            const categories: squareItemCategory[] = [];
            for (const cat of rawCategories || []) {
                if (!cat.id) continue;
                const category = await fetchSquareCategory(cat.id);
                categories.push(category);
            }

            //get categories
            const rawReportingCategories = item.itemData.reportingCategory as
                | squareHelperCategory[]
                | undefined;
            const reportingCategory: squareItemCategory[] = [];
            for (const cat of rawCategories || []) {
                if (!cat.id) continue;
                const category = await fetchSquareCategory(cat.id);
                reportingCategory.push(category);
            }

            //Construct the catalog item
            const catalogItem: squareItem = {
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
 * @returns {Promise<squareItemCategory>} The Square Item Category.
 */
async function fetchSquareCategory(id: string): Promise<squareItemCategory> {
    const response = await client.catalog.object.get({ objectId: id });
    if (response.object?.type === "CATEGORY") {
        const resp = response.object;

        let parentCategory: squareItemCategory = {};
        const parentId = resp.categoryData?.parentCategory?.id;
        if (parentId) {
            parentCategory = await fetchSquareCategory(parentId);
        }

        const category: squareItemCategory = {
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
