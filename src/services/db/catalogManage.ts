import { randomUUID } from "node:crypto";
import {
    and,
    asc,
    eq,
    ilike,
    inArray,
    isNull,
    notInArray,
    or,
    sql,
    type SQL,
} from "drizzle-orm";
import { stripBigints } from "@tessellatepos/sdk";
import type {
    CatalogFieldError,
    Item,
    ItemCategoryInput,
    ItemQuery,
} from "@tessellatepos/sdk";
import { drizzleDB } from "@/services/db/postgres";
import {
    catalogCategoriesTable,
    catalogItemCategoriesTable,
    catalogItemLocationsTable,
    catalogItemsTable,
    catalogItemVariationsTable,
    locationsTable,
    ordersTable,
} from "./schema";
import { hydrateItems, type CatalogScope } from "./catalog";
import {
    mergeVariations,
    type ItemDraft,
    type ItemPatch,
    type VariationDraft,
    type Validated,
} from "@/services/catalogValidation";

export type Tx = Parameters<Parameters<typeof drizzleDB.transaction>[0]>[0];
type Db = typeof drizzleDB | Tx;

/** Who is writing, so a location-pinned principal stays inside its stores. */
export interface WriteContext {
    allowedLocations: "all" | string[];
}

/** A failure the endpoint reports as-is. Its text never carries input values. */
export class CatalogError extends Error {
    readonly status: number;
    readonly code: string;
    readonly errors?: CatalogFieldError[];

    constructor(
        status: number,
        code: string,
        message: string,
        errors?: CatalogFieldError[],
    ) {
        super(message);
        this.status = status;
        this.code = code;
        this.errors = errors;
    }
}

export interface WriteResult {
    item: Item;
    /** Every storefront the write touched, before and after, for events. */
    locationIds: string[];
}

export interface CategoryNode {
    id: string;
    name: string;
    parentCategoryId: string | null;
    imageURL: string | null;
    itemCount: number;
}

const CATALOG_LOCK = 7351002;

/**
 * Runs catalog writes one at a time, in a transaction. The lock is what
 * makes the SKU-unique and cycle checks safe against concurrent writers.
 * @param fn the work to run
 * @returns whatever fn returns; a throw rolls everything back
 */
export async function withCatalogTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return drizzleDB.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(${CATALOG_LOCK})`);
        return fn(tx);
    });
}

function escapeLike(text: string): string {
    return text.replace(/[\\%_]/g, "\\$&");
}

/**
 * Converts an Item for the wire: money as digit strings and each variation
 * carrying its own `id` (ItemVariation.itemId is the variation's id).
 * @param item the item as read from Postgres
 * @returns the JSON-safe item
 */
export function toApiItem(item: Item): Item {
    const plain = stripBigints(item) as Item;
    return {
        ...plain,
        variations: (plain.variations ?? []).map((v) => ({
            ...v,
            id: v.itemId,
        })),
    };
}

/**
 * Turns a stored item back into the draft shape a write works on.
 * @param item the stored item
 * @returns the draft
 */
export function toDraft(item: Item): ItemDraft {
    return {
        name: item.name ?? "",
        displayName: item.displayName ?? null,
        labelColor: item.labelColor ?? null,
        isTaxable: item.isTaxable ?? true,
        isArchived: item.isArchived ?? false,
        image: item.image ?? null,
        categoryIds: (item.categories ?? []).flatMap((c) =>
            c.id ? [c.id] : [],
        ),
        locationIds: item.locationIds ?? [],
        variations: (item.variations ?? []).map((v) => ({
            id: v.itemId ?? undefined,
            name: v.name ?? "",
            sku: v.sku ?? null,
            upc: v.upc ?? null,
            pricingType: v.pricingType ?? "FIXED",
            priceMoney: v.priceMoney ?? null,
            trackInventory: v.trackInventory ?? false,
            locationOverrides: (v.locationOverrides ?? []).flatMap((o) =>
                o.locationId
                    ? [
                          {
                              locationId: o.locationId,
                              priceMoney: o.priceMoney,
                              pricingType: o.pricingType,
                              trackInventory: o.trackInventory,
                          },
                      ]
                    : [],
            ),
        })),
    };
}

/**
 * Loads one item of any origin, archived or not.
 * @param db the database or transaction
 * @param id the item id
 * @returns the item, or null
 */
export async function loadItem(db: Db, id: string): Promise<Item | null> {
    const rows = await db
        .select()
        .from(catalogItemsTable)
        .where(eq(catalogItemsTable.id, id))
        .limit(1);
    return (await hydrateItems(rows, {}, db as typeof drizzleDB))[0] ?? null;
}

function pinnedLocations(ctx: WriteContext): string[] | null {
    return ctx.allowedLocations === "all" ? null : ctx.allowedLocations;
}

/**
 * Whether a principal may see an item: unpinned sees all, pinned sees items
 * sold at one of its locations.
 * @param ctx the principal's location limit
 * @param item the item
 * @returns true when visible
 */
export function canSeeItem(ctx: WriteContext, item: Item): boolean {
    const allowed = pinnedLocations(ctx);
    return (
        !allowed || (item.locationIds ?? []).some((l) => allowed.includes(l))
    );
}

/**
 * A pinned principal may only change items sold exclusively at its own
 * locations, and may only sell in its own locations.
 * @param ctx the principal's location limit
 * @param current the item's locations now (empty for a new item)
 * @param next the locations after the write
 */
function assertWritableScope(
    ctx: WriteContext,
    current: string[],
    next: string[],
) {
    const allowed = pinnedLocations(ctx);
    if (!allowed) return;
    const inside = (ids: string[]) => ids.every((id) => allowed.includes(id));
    if (!inside(current)) {
        throw new CatalogError(
            403,
            "location_forbidden",
            "This item is also sold at storefronts outside your access",
        );
    }
    if (next.length === 0 || !inside(next)) {
        throw new CatalogError(
            403,
            "location_forbidden",
            "Items must be sold at your storefronts only",
        );
    }
}

/**
 * Checks everything a draft points at: storefronts and categories exist,
 * overrides are for storefronts the item is sold at, and no SKU is already
 * used by another item.
 * @param tx the transaction (holding the catalog lock)
 * @param draft the item to be written
 * @param itemId the item's id when it already exists
 */
async function assertReferences(tx: Tx, draft: ItemDraft, itemId?: string) {
    const errors: CatalogFieldError[] = [];

    if (draft.locationIds.length > 0) {
        const found = await tx
            .select({ id: locationsTable.id })
            .from(locationsTable)
            .where(
                and(
                    inArray(locationsTable.id, draft.locationIds),
                    isNull(locationsTable.deletedAt),
                ),
            );
        const live = new Set(found.map((row) => row.id));
        draft.locationIds.forEach((id, index) => {
            if (!live.has(id)) {
                errors.push({
                    path: `locationIds[${index}]`,
                    message: "is not an existing storefront",
                });
            }
        });
    }

    if (draft.categoryIds.length > 0) {
        const found = await tx
            .select({ id: catalogCategoriesTable.id })
            .from(catalogCategoriesTable)
            .where(inArray(catalogCategoriesTable.id, draft.categoryIds));
        const live = new Set(found.map((row) => row.id));
        draft.categoryIds.forEach((id, index) => {
            if (!live.has(id)) {
                errors.push({
                    path: `categoryIds[${index}]`,
                    message: "is not an existing category",
                });
            }
        });
    }

    draft.variations.forEach((variation, vIndex) => {
        variation.locationOverrides.forEach((override, oIndex) => {
            if (!draft.locationIds.includes(override.locationId)) {
                errors.push({
                    path: `variations[${vIndex}].locationOverrides[${oIndex}].locationId`,
                    message: "must be a storefront the item is sold at",
                });
            }
        });
    });

    if (errors.length > 0) {
        throw new CatalogError(
            400,
            "invalid_reference",
            "Invalid item",
            errors,
        );
    }

    const skus = draft.variations.flatMap((v) => (v.sku ? [v.sku] : []));
    if (skus.length > 0) {
        const taken = await tx
            .select({ sku: catalogItemVariationsTable.sku })
            .from(catalogItemVariationsTable)
            .where(
                and(
                    inArray(catalogItemVariationsTable.sku, skus),
                    itemId
                        ? sql`${catalogItemVariationsTable.itemId} <> ${itemId}`
                        : undefined,
                ),
            )
            .limit(1);
        if (taken.length > 0) {
            throw new CatalogError(
                409,
                "sku_conflict",
                "A SKU is already used by another item",
            );
        }
    }
}

/**
 * Persists a draft: the item row, its variations (in order), and its
 * category and storefront links. Variations missing from the draft are
 * deleted.
 * @param tx the transaction (holding the catalog lock)
 * @param id the item id
 * @param draft the complete item
 * @param isNew true to insert a locally owned item, false to update
 */
export async function writeItem(
    tx: Tx,
    id: string,
    draft: ItemDraft,
    isNew: boolean,
) {
    const values = {
        name: draft.name,
        displayName: draft.displayName,
        labelColor: draft.labelColor,
        isTaxable: draft.isTaxable,
        isArchived: draft.isArchived,
        image: draft.image,
        updatedAt: new Date(),
    };
    if (isNew) {
        await tx
            .insert(catalogItemsTable)
            .values({ id, ...values, origin: "local" });
    } else {
        await tx
            .update(catalogItemsTable)
            .set(values)
            .where(eq(catalogItemsTable.id, id));
    }

    const keep = draft.variations.flatMap((v) => (v.id ? [v.id] : []));
    await tx
        .delete(catalogItemVariationsTable)
        .where(
            and(
                eq(catalogItemVariationsTable.itemId, id),
                keep.length > 0
                    ? notInArray(catalogItemVariationsTable.variationId, keep)
                    : undefined,
            ),
        );
    for (const [index, variation] of draft.variations.entries()) {
        const row = {
            itemId: id,
            name: variation.name,
            sku: variation.sku,
            upc: variation.upc,
            ordinal: String(index),
            pricingType: variation.pricingType,
            priceMoney: stripBigints(variation.priceMoney),
            locationOverrides: stripBigints(
                variation.locationOverrides.length > 0
                    ? variation.locationOverrides
                    : null,
            ),
            trackInventory: variation.trackInventory,
        };
        await tx
            .insert(catalogItemVariationsTable)
            .values({ variationId: variation.id ?? randomUUID(), ...row })
            .onConflictDoUpdate({
                target: catalogItemVariationsTable.variationId,
                set: { ...row, updatedAt: new Date() },
            });
    }

    await tx
        .delete(catalogItemCategoriesTable)
        .where(eq(catalogItemCategoriesTable.itemId, id));
    if (draft.categoryIds.length > 0) {
        await tx.insert(catalogItemCategoriesTable).values(
            draft.categoryIds.map((categoryId) => ({
                itemId: id,
                categoryId,
            })),
        );
    }
    await tx
        .delete(catalogItemLocationsTable)
        .where(eq(catalogItemLocationsTable.itemId, id));
    if (draft.locationIds.length > 0) {
        await tx.insert(catalogItemLocationsTable).values(
            draft.locationIds.map((locationId) => ({
                itemId: id,
                locationId,
            })),
        );
    }
}

/**
 * Gives new variations an id and rejects ids that are not the item's own, so
 * a client cannot claim another item's variation.
 * @param draft the incoming draft
 * @param ownIds the variation ids the item already has
 * @returns the draft with every variation id set
 */
function assignVariationIds(draft: ItemDraft, ownIds: string[]): ItemDraft {
    const errors: CatalogFieldError[] = [];
    const variations = draft.variations.map((variation, index) => {
        if (variation.id && !ownIds.includes(variation.id)) {
            errors.push({
                path: `variations[${index}].id`,
                message: "does not match a variation of this item",
            });
        }
        return { ...variation, id: variation.id ?? randomUUID() };
    });
    if (errors.length > 0) {
        throw new CatalogError(
            400,
            "invalid_reference",
            "Invalid item",
            errors,
        );
    }
    return { ...draft, variations };
}

function union(...lists: string[][]): string[] {
    return [...new Set(lists.flat())];
}

/**
 * Creates a locally owned item.
 * @param draft the validated item
 * @param ctx the writer's location limit
 * @returns the stored item
 */
export async function createItem(
    draft: ItemDraft,
    ctx: WriteContext,
): Promise<WriteResult> {
    assertWritableScope(ctx, [], draft.locationIds);
    return withCatalogTx(async (tx) => {
        const id = randomUUID();
        const complete = assignVariationIds(draft, []);
        await assertReferences(tx, complete, id);
        await writeItem(tx, id, complete, true);
        return {
            item: (await loadItem(tx, id))!,
            locationIds: complete.locationIds,
        };
    });
}

/**
 * Replaces an item (PUT) or merges a patch onto it (PATCH).
 * @param id the item id
 * @param change a complete draft, or a patch to merge onto the stored item
 * @param ctx the writer's location limit
 * @returns the stored item, or null when it does not exist
 */
export async function updateItem(
    id: string,
    change: { draft: ItemDraft } | { patch: ItemPatch },
    ctx: WriteContext,
): Promise<WriteResult | null> {
    return withCatalogTx(async (tx) => {
        const current = await loadItem(tx, id);
        if (!current || !canSeeItem(ctx, current)) return null;
        const before = toDraft(current);

        let next: ItemDraft;
        if ("draft" in change) {
            next = change.draft;
        } else {
            const { variations, ...rest } = change.patch;
            next = { ...before };
            for (const [key, value] of Object.entries(rest)) {
                if (value !== undefined) {
                    (next as unknown as Record<string, unknown>)[key] = value;
                }
            }
            if (variations) {
                const merged: Validated<VariationDraft[]> = mergeVariations(
                    before.variations,
                    variations,
                );
                if (!merged.ok) {
                    throw new CatalogError(
                        400,
                        "invalid_request",
                        "Invalid item",
                        merged.errors,
                    );
                }
                next.variations = merged.value;
            }
        }

        assertWritableScope(ctx, before.locationIds, next.locationIds);
        const complete = assignVariationIds(
            next,
            before.variations.flatMap((v) => (v.id ? [v.id] : [])),
        );
        await assertReferences(tx, complete, id);
        await writeItem(tx, id, complete, false);
        return {
            item: (await loadItem(tx, id))!,
            locationIds: union(before.locationIds, complete.locationIds),
        };
    });
}

/**
 * Archives or restores an item. Archived items drop out of the till but stay
 * in the catalog so past orders still resolve.
 * @param id the item id
 * @param archived true to archive, false to restore
 * @param ctx the writer's location limit
 * @returns the stored item, or null when it does not exist
 */
export async function setItemArchived(
    id: string,
    archived: boolean,
    ctx: WriteContext,
): Promise<WriteResult | null> {
    return withCatalogTx(async (tx) => {
        const current = await loadItem(tx, id);
        if (!current || !canSeeItem(ctx, current)) return null;
        const locationIds = current.locationIds ?? [];
        assertWritableScope(ctx, locationIds, locationIds);
        await tx
            .update(catalogItemsTable)
            .set({ isArchived: archived, updatedAt: new Date() })
            .where(eq(catalogItemsTable.id, id));
        return { item: (await loadItem(tx, id))!, locationIds };
    });
}

/**
 * Whether any order has a line for the item or one of its variations.
 * @param db the database or transaction
 * @param item the item
 * @returns true when an order references it
 */
async function isOrdered(db: Db, item: Item): Promise<boolean> {
    const matches = [
        { parent: { id: item.id } },
        ...(item.variations ?? []).flatMap((v) =>
            v.itemId ? [{ itemId: v.itemId }] : [],
        ),
    ].map(
        (ref) =>
            sql`${ordersTable.lineItems} @> ${JSON.stringify([ref])}::jsonb`,
    );
    const rows = await db
        .select({ ref: ordersTable.referenceId })
        .from(ordersTable)
        .where(or(...matches))
        .limit(1);
    return rows.length > 0;
}

/**
 * Permanently deletes an item and its variations and links. Refused while any
 * order references the item.
 * @param id the item id
 * @param ctx the writer's location limit
 * @returns the deleted item's locations, or null when it does not exist
 */
export async function deleteItemHard(
    id: string,
    ctx: WriteContext,
): Promise<{ locationIds: string[] } | null> {
    return withCatalogTx(async (tx) => {
        const current = await loadItem(tx, id);
        if (!current || !canSeeItem(ctx, current)) return null;
        const locationIds = current.locationIds ?? [];
        assertWritableScope(ctx, locationIds, locationIds);
        if (await isOrdered(tx, current)) {
            throw new CatalogError(
                409,
                "item_ordered",
                "An order references this item. Archive it instead",
            );
        }
        await tx
            .delete(catalogItemVariationsTable)
            .where(eq(catalogItemVariationsTable.itemId, id));
        await tx
            .delete(catalogItemCategoriesTable)
            .where(eq(catalogItemCategoriesTable.itemId, id));
        await tx
            .delete(catalogItemLocationsTable)
            .where(eq(catalogItemLocationsTable.itemId, id));
        await tx.delete(catalogItemsTable).where(eq(catalogItemsTable.id, id));
        return { locationIds };
    });
}

/**
 * Lists items with search, filters and paging.
 * @param query the validated query
 * @param scope which items the active provider shows
 * @param ctx the reader's location limit
 * @returns one page of items and the total match count
 */
export async function listItems(
    query: Required<Pick<ItemQuery, "limit" | "offset" | "archived">> &
        Pick<ItemQuery, "q" | "categoryId" | "locationId">,
    scope: CatalogScope,
    ctx: WriteContext,
): Promise<{ items: Item[]; total: number }> {
    const link = catalogItemLocationsTable;
    const conditions: (SQL | undefined)[] = [
        scope.origin ? eq(catalogItemsTable.origin, scope.origin) : undefined,
    ];
    const archived = sql`coalesce(${catalogItemsTable.isArchived}, false)`;
    if (query.archived === "true") conditions.push(sql`${archived} = true`);
    if (query.archived === "false") conditions.push(sql`${archived} = false`);

    if (query.q) {
        const like = `%${escapeLike(query.q)}%`;
        conditions.push(
            or(
                ilike(catalogItemsTable.name, like),
                ilike(catalogItemsTable.displayName, like),
                sql`exists (select 1 from ${catalogItemVariationsTable} where ${catalogItemVariationsTable.itemId} = ${catalogItemsTable.id} and (${catalogItemVariationsTable.name} ilike ${like} or ${catalogItemVariationsTable.sku} ilike ${like}))`,
            ),
        );
    }
    if (query.categoryId) {
        conditions.push(
            sql`exists (select 1 from ${catalogItemCategoriesTable} where ${catalogItemCategoriesTable.itemId} = ${catalogItemsTable.id} and ${catalogItemCategoriesTable.categoryId} = ${query.categoryId})`,
        );
    }
    if (query.locationId) {
        conditions.push(
            sql`exists (select 1 from ${link} where ${link.itemId} = ${catalogItemsTable.id} and ${link.locationId} = ${query.locationId})`,
        );
    }
    const allowed = pinnedLocations(ctx);
    if (allowed) {
        if (allowed.length === 0) return { items: [], total: 0 };
        conditions.push(
            sql`exists (select 1 from ${link} where ${link.itemId} = ${catalogItemsTable.id} and ${inArray(link.locationId, allowed)})`,
        );
    }
    const where = and(...conditions);

    const [{ total }] = await drizzleDB
        .select({ total: sql<number>`count(*)::int` })
        .from(catalogItemsTable)
        .where(where);
    const rows = await drizzleDB
        .select()
        .from(catalogItemsTable)
        .where(where)
        .orderBy(
            sql`lower(${catalogItemsTable.name})`,
            asc(catalogItemsTable.id),
        )
        .limit(query.limit)
        .offset(query.offset);
    return { items: await hydrateItems(rows, scope), total };
}

/**
 * Reads one item as the active provider shows it.
 * @param id the item id
 * @param scope which items the active provider shows
 * @param ctx the reader's location limit
 * @returns the item, or null when it does not exist or is out of reach
 */
export async function getItem(
    id: string,
    scope: CatalogScope,
    ctx: WriteContext,
): Promise<Item | null> {
    const [row] = await drizzleDB
        .select()
        .from(catalogItemsTable)
        .where(
            and(
                eq(catalogItemsTable.id, id),
                scope.origin
                    ? eq(catalogItemsTable.origin, scope.origin)
                    : undefined,
            ),
        )
        .limit(1);
    if (!row) return null;
    const [item] = await hydrateItems([row], scope);
    return canSeeItem(ctx, item) ? item : null;
}

/**
 * Lists categories with how many items each holds.
 * @param scope which categories the active provider shows
 * @returns the categories, flat; parentCategoryId makes the tree
 */
export async function listCategories(
    scope: CatalogScope,
): Promise<CategoryNode[]> {
    const rows = await drizzleDB
        .select()
        .from(catalogCategoriesTable)
        .where(
            scope.origin
                ? eq(catalogCategoriesTable.origin, scope.origin)
                : undefined,
        )
        .orderBy(
            sql`lower(${catalogCategoriesTable.name})`,
            asc(catalogCategoriesTable.id),
        );
    const counts = await drizzleDB
        .select({
            categoryId: catalogItemCategoriesTable.categoryId,
            n: sql<number>`count(*)::int`,
        })
        .from(catalogItemCategoriesTable)
        .groupBy(catalogItemCategoriesTable.categoryId);
    const countById = new Map(counts.map((c) => [c.categoryId, c.n]));
    const visible = new Set(rows.map((r) => r.id));
    return rows.map((row) => ({
        id: row.id,
        name: row.name ?? "",
        parentCategoryId:
            row.parentCategoryId && visible.has(row.parentCategoryId)
                ? row.parentCategoryId
                : null,
        imageURL: row.imageURL,
        itemCount: countById.get(row.id) ?? 0,
    }));
}

/**
 * Rejects a parent that would put a category under itself or a descendant.
 * @param tx the transaction (holding the catalog lock)
 * @param id the category being moved (undefined for a new one)
 * @param parentId the proposed parent
 */
async function assertParent(tx: Tx, id: string | undefined, parentId: string) {
    const rows = await tx.select().from(catalogCategoriesTable);
    const byId = new Map(rows.map((row) => [row.id, row]));
    if (!byId.has(parentId)) {
        throw new CatalogError(400, "invalid_reference", "Invalid category", [
            {
                path: "parentCategoryId",
                message: "is not an existing category",
            },
        ]);
    }
    const seen = new Set<string>();
    for (
        let cursor: string | null | undefined = parentId;
        cursor && !seen.has(cursor);
        cursor = byId.get(cursor)?.parentCategoryId
    ) {
        if (cursor === id) {
            throw new CatalogError(
                400,
                "category_cycle",
                "A category cannot be moved under itself",
            );
        }
        seen.add(cursor);
    }
}

/**
 * Creates a locally owned category.
 * @param input the validated category
 * @returns the stored category
 */
export async function createCategory(
    input: Partial<ItemCategoryInput>,
): Promise<CategoryNode> {
    const id = randomUUID();
    await withCatalogTx(async (tx) => {
        if (input.parentCategoryId) {
            await assertParent(tx, undefined, input.parentCategoryId);
        }
        await tx.insert(catalogCategoriesTable).values({
            id,
            name: input.name,
            parentCategoryId: input.parentCategoryId ?? null,
            imageURL: input.imageURL ?? null,
            origin: "local",
        });
    });
    return (await listCategories({})).find((c) => c.id === id)!;
}

/**
 * Renames, moves or re-images a category.
 * @param id the category id
 * @param input the validated fields to change
 * @returns the stored category, or null when it does not exist
 */
export async function updateCategory(
    id: string,
    input: Partial<ItemCategoryInput>,
): Promise<CategoryNode | null> {
    const found = await withCatalogTx(async (tx) => {
        const [row] = await tx
            .select()
            .from(catalogCategoriesTable)
            .where(eq(catalogCategoriesTable.id, id));
        if (!row) return false;
        if (input.parentCategoryId) {
            await assertParent(tx, id, input.parentCategoryId);
        }
        await tx
            .update(catalogCategoriesTable)
            .set({
                ...(input.name !== undefined ? { name: input.name } : {}),
                ...(input.parentCategoryId !== undefined
                    ? { parentCategoryId: input.parentCategoryId }
                    : {}),
                ...(input.imageURL !== undefined
                    ? { imageURL: input.imageURL }
                    : {}),
                updatedAt: new Date(),
            })
            .where(eq(catalogCategoriesTable.id, id));
        return true;
    });
    return found
        ? ((await listCategories({})).find((c) => c.id === id) ?? null)
        : null;
}

/**
 * Deletes a category and unlinks it from items. Refused while it has
 * subcategories, so the tree never loses a branch by accident.
 * @param id the category id
 * @returns false when it does not exist
 */
export async function deleteCategory(id: string): Promise<boolean> {
    return withCatalogTx(async (tx) => {
        const [row] = await tx
            .select()
            .from(catalogCategoriesTable)
            .where(eq(catalogCategoriesTable.id, id));
        if (!row) return false;
        const children = await tx
            .select({ id: catalogCategoriesTable.id })
            .from(catalogCategoriesTable)
            .where(eq(catalogCategoriesTable.parentCategoryId, id))
            .limit(1);
        if (children.length > 0) {
            throw new CatalogError(
                409,
                "category_has_children",
                "Move or delete the subcategories first",
            );
        }
        await tx
            .delete(catalogItemCategoriesTable)
            .where(eq(catalogItemCategoriesTable.categoryId, id));
        await tx
            .delete(catalogCategoriesTable)
            .where(eq(catalogCategoriesTable.id, id));
        return true;
    });
}
