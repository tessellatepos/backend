import "dotenv/config";
import { and, eq, inArray, notInArray } from "drizzle-orm";
import {
    catalogItemsTable,
    catalogItemVariationsTable,
    catalogCategoriesTable,
    catalogItemCategoriesTable,
    catalogItemLocationsTable,
} from "./schema";
import { drizzleDB } from "@/services/db/postgres";
import { parseMoney, stripBigints } from "@tessellatepos/sdk";
import type {
    Item,
    ItemCatalog,
    ItemCategory,
    ItemVariation,
    ItemVariationLocationOverrides,
} from "@tessellatepos/sdk";

type TDrizzleDB = typeof drizzleDB;

/**
 * Reverses serializeForJsonb for stored location overrides, reviving each
 * override's priceMoney.amount back to bigint.
 * @param raw the jsonb value read back from a locationOverrides column
 * @returns the parsed overrides, or null if raw wasn't an array
 */
function parseLocationOverrides(
    raw: unknown,
): ItemVariationLocationOverrides[] | null {
    if (!Array.isArray(raw)) return null;
    return raw.map((override: ItemVariationLocationOverrides) => ({
        ...override,
        priceMoney: override.priceMoney
            ? {
                  amount: BigInt(override.priceMoney.amount),
                  currency: override.priceMoney.currency,
              }
            : undefined,
    }));
}

export interface ProviderCatalogResult {
    items: Item[];
    itemLocationIds: Map<string, string[]>;
}

/**
 * Upserts a category and its ancestor chain. ItemCategory.parentCategory is
 * embedded rather than a bare id, so ancestors are upserted first to keep
 * parentCategoryId pointing at a row that already exists.
 * @param category the category to upsert, with its parent chain embedded
 * @param db the drizzle instance to run the upsert against
 */
async function upsertCategory(category: ItemCategory, db: TDrizzleDB) {
    if (!category.id) return;

    if (category.parentCategory) {
        await upsertCategory(category.parentCategory, db);
    }

    const values = {
        name: category.name ?? null,
        parentCategoryId: category.parentCategory?.id ?? null,
        imageId: category.imageId ?? null,
        imageURL: category.imageURL ?? null,
    };

    await db
        .insert(catalogCategoriesTable)
        .values({ id: category.id, ...values })
        .onConflictDoUpdate({
            target: catalogCategoriesTable.id,
            set: { ...values, updatedAt: new Date() },
        });
}

/**
 * Upserts a single variation. Note: ItemVariation.itemId is actually the
 * variation's own catalog id (see square.ts fetchItems) — the item it
 * belongs to comes from ItemVariation.parent.id instead.
 * @param itemId the id of the parent item this variation belongs to
 * @param variation the variation to upsert
 * @param db the drizzle instance to run the upsert against
 */
async function upsertVariation(
    itemId: string,
    variation: ItemVariation,
    db: TDrizzleDB,
) {
    const variationId = variation.itemId;
    if (!variationId) return;

    const values = {
        itemId,
        name: variation.name ?? null,
        sku: variation.sku ?? null,
        upc: variation.upc ?? null,
        ordinal: variation.ordinal ?? null,
        pricingType: variation.pricingType ?? null,
        priceMoney: stripBigints(variation.priceMoney ?? null),
        locationOverrides: stripBigints(variation.locationOverrides ?? null),
        trackInventory: variation.trackInventory ?? null,
    };

    await db
        .insert(catalogItemVariationsTable)
        .values({ variationId, ...values })
        .onConflictDoUpdate({
            target: catalogItemVariationsTable.variationId,
            set: { ...values, updatedAt: new Date() },
        });
}

/**
 * Persists a freshly-fetched provider catalog into Postgres. Items that
 * existed before this import but weren't in it get archived, not deleted,
 * so historical orders referencing them still resolve.
 * @param result the items and their per-item location ids fetched from a provider
 * @param db the drizzle instance to run the import against
 */
export async function importCatalogFromProvider(
    result: ProviderCatalogResult,
    db: TDrizzleDB = drizzleDB,
) {
    const { items, itemLocationIds } = result;

    for (const item of items) {
        const values = {
            name: item.name ?? null,
            displayName: item.displayName ?? null,
            labelColor: item.labelColor ?? null,
            isTaxable: item.isTaxable ?? null,
            isArchived: item.isArchived ?? false,
            image: item.image ?? null,
        };

        await db
            .insert(catalogItemsTable)
            .values({ id: item.id, ...values })
            .onConflictDoUpdate({
                target: catalogItemsTable.id,
                set: { ...values, updatedAt: new Date() },
            });

        for (const category of item.categories ?? []) {
            await upsertCategory(category, db);
            if (category.id) {
                await db
                    .insert(catalogItemCategoriesTable)
                    .values({ itemId: item.id, categoryId: category.id })
                    .onConflictDoNothing();
            }
        }

        for (const variation of item.variations ?? []) {
            await upsertVariation(item.id, variation, db);
        }

        for (const locationId of itemLocationIds.get(item.id) ?? []) {
            await db
                .insert(catalogItemLocationsTable)
                .values({ itemId: item.id, locationId })
                .onConflictDoNothing();
        }
    }

    const importedIds = items.map((item) => item.id);
    if (importedIds.length > 0) {
        await db
            .update(catalogItemsTable)
            .set({ isArchived: true, updatedAt: new Date() })
            .where(notInArray(catalogItemsTable.id, importedIds));
    }
}

/**
 * Rebuilds an ItemCategory (with its parent chain embedded) from a category
 * row and the set of category rows it might reference as a parent.
 * @param row the category row to convert
 * @param categoriesById all category rows fetched for this query, keyed by id
 * @returns the ItemCategory, with parentCategory populated recursively
 */
function toItemCategory(
    row: typeof catalogCategoriesTable.$inferSelect,
    categoriesById: Map<string, typeof catalogCategoriesTable.$inferSelect>,
): ItemCategory {
    const parentRow = row.parentCategoryId
        ? categoriesById.get(row.parentCategoryId)
        : undefined;

    return {
        id: row.id,
        name: row.name,
        parentCategory: parentRow
            ? toItemCategory(parentRow, categoriesById)
            : null,
        imageId: row.imageId,
        imageURL: row.imageURL,
    };
}

/**
 * Rebuilds an ItemCatalog from Postgres, optionally scoped to one location.
 * ItemVariation.parent and Item.locationIds are reconstructed at read time
 * rather than stored, the same way redis.ts stitches `parent` back on today.
 * @param locationId the location to scope the catalog to, or all items if omitted
 * @param db the drizzle instance to query against
 * @returns the item catalog for the given location
 */
export async function getCatalogByLocation(
    locationId?: string,
    db: TDrizzleDB = drizzleDB,
): Promise<ItemCatalog> {
    let itemIds: string[] | undefined;
    if (locationId) {
        const locationRows = await db
            .select({ itemId: catalogItemLocationsTable.itemId })
            .from(catalogItemLocationsTable)
            .where(eq(catalogItemLocationsTable.locationId, locationId));
        itemIds = locationRows.map((row) => row.itemId);
        if (itemIds.length === 0) return { items: [] };
    }

    const itemRows = await db
        .select()
        .from(catalogItemsTable)
        .where(
            itemIds
                ? and(
                      eq(catalogItemsTable.isArchived, false),
                      inArray(catalogItemsTable.id, itemIds),
                  )
                : eq(catalogItemsTable.isArchived, false),
        );

    if (itemRows.length === 0) return { items: [] };

    const allItemIds = itemRows.map((row) => row.id);
    const itemNameById = new Map(itemRows.map((row) => [row.id, row.name]));

    const [variationRows, categoryLinkRows, locationRows] = await Promise.all([
        db
            .select()
            .from(catalogItemVariationsTable)
            .where(inArray(catalogItemVariationsTable.itemId, allItemIds)),
        db
            .select()
            .from(catalogItemCategoriesTable)
            .where(inArray(catalogItemCategoriesTable.itemId, allItemIds)),
        db
            .select()
            .from(catalogItemLocationsTable)
            .where(inArray(catalogItemLocationsTable.itemId, allItemIds)),
    ]);

    const categoryIds = [
        ...new Set(categoryLinkRows.map((row) => row.categoryId)),
    ];
    const categoryRows =
        categoryIds.length > 0
            ? await db
                  .select()
                  .from(catalogCategoriesTable)
                  .where(inArray(catalogCategoriesTable.id, categoryIds))
            : [];
    const categoriesById = new Map(categoryRows.map((row) => [row.id, row]));

    const variationsByItem = new Map<string, ItemVariation[]>();
    for (const row of variationRows) {
        const list = variationsByItem.get(row.itemId) ?? [];
        list.push({
            itemId: row.variationId,
            name: row.name,
            sku: row.sku,
            upc: row.upc,
            ordinal: row.ordinal,
            pricingType: row.pricingType ?? undefined,
            priceMoney: parseMoney(row.priceMoney),
            locationOverrides: parseLocationOverrides(row.locationOverrides),
            trackInventory: row.trackInventory,
            parent: { id: row.itemId, name: itemNameById.get(row.itemId) },
        });
        variationsByItem.set(row.itemId, list);
    }

    const categoriesByItem = new Map<string, ItemCategory[]>();
    for (const link of categoryLinkRows) {
        const categoryRow = categoriesById.get(link.categoryId);
        if (!categoryRow) continue;
        const list = categoriesByItem.get(link.itemId) ?? [];
        list.push(toItemCategory(categoryRow, categoriesById));
        categoriesByItem.set(link.itemId, list);
    }

    const locationIdsByItem = new Map<string, string[]>();
    for (const row of locationRows) {
        const list = locationIdsByItem.get(row.itemId) ?? [];
        list.push(row.locationId);
        locationIdsByItem.set(row.itemId, list);
    }

    const items: Item[] = itemRows.map((row) => ({
        id: row.id,
        name: row.name,
        displayName: row.displayName,
        labelColor: row.labelColor,
        isTaxable: row.isTaxable,
        isArchived: row.isArchived,
        image: row.image,
        variations: variationsByItem.get(row.id) ?? [],
        categories: categoriesByItem.get(row.id) ?? [],
        locationIds: locationIdsByItem.get(row.id) ?? [],
    }));

    return { items };
}
