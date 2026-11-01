import { z } from "zod";
import type { Item, ItemCategory, ItemVariation } from "@tessellatepos/sdk";
import { moneySchema } from "./common.js";

// Parent categories are shown one level deep: a recursive schema would need
// $ref targets, which do not survive being embedded in the OpenAPI document.
const parentCategorySchema = z.object({
    id: z.string().optional(),
    name: z.string().nullish(),
    imageId: z.string().nullish(),
    imageURL: z.string().nullish(),
});

const categorySchema = z.object({
    id: z.string().optional(),
    name: z.string().nullish(),
    parentCategory: parentCategorySchema.nullish(),
    imageId: z.string().nullish(),
    imageURL: z.string().nullish(),
}) satisfies z.ZodType<ItemCategory>;

const variationSchema = z.object({
    id: z.string().nullish(),
    itemId: z.string().nullish(),
    name: z.string().nullish(),
    sku: z.string().nullish(),
    upc: z.string().nullish(),
    ordinal: z.string().nullish(),
    pricingType: z.enum(["FIXED", "VARIABLE"]).optional(),
    priceMoney: moneySchema.optional(),
    locationOverrides: z
        .array(
            z.object({
                locationId: z.string().nullish(),
                priceMoney: moneySchema.optional(),
                pricingType: z.enum(["FIXED", "VARIABLE"]).optional(),
                trackInventory: z.boolean().nullish(),
            }),
        )
        .nullish(),
    trackInventory: z.boolean().nullish(),
    parent: z.object({ id: z.string(), name: z.string().nullish() }).nullish(),
}) satisfies z.ZodType<ItemVariation>;

/** A catalog item as the gateway returns it. */
export const itemSchema = z.object({
    id: z.string(),
    name: z.string().nullish(),
    displayName: z.string().nullish(),
    labelColor: z.string().nullish(),
    isTaxable: z.boolean().nullish(),
    variations: z.array(variationSchema).nullable(),
    categories: z.array(categorySchema).optional(),
    isArchived: z.boolean().nullish(),
    locationIds: z.array(z.string()).nullish(),
    image: z.string().nullish(),
}) satisfies z.ZodType<Item>;

export const itemListSchema = z.array(itemSchema);
