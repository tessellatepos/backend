import type { Item, ItemCategory, SalesChannel } from "@tessellatepos/sdk";
import { getItemsByLocationID } from "@/services/redis";

/*
 * The catalog as the online store sees it: only what is sold on the "online"
 * channel, only at the locations the caller may act on, in a stable order that
 * can be paged with an opaque cursor.
 */

export const DEFAULT_ONLINE_PAGE = 50;
export const MAX_ONLINE_PAGE = 200;

/** The caller supplied a cursor this service did not issue. */
export class InvalidCursorError extends Error {
    constructor() {
        super("Invalid cursor");
        this.name = "InvalidCursorError";
    }
}

export interface OnlinePage<T> {
    items: T[];
    nextCursor: string | null;
}

/**
 * Reads the cached catalog at the locations a principal may see.
 * @param allowed the principal's `location_ids`
 * @param locationId one location to narrow to; the caller has already checked it
 * @returns the cached items, each once
 */
export async function cachedItemsFor(
    allowed: "all" | string[],
    locationId?: string,
): Promise<Item[]> {
    if (locationId) return getItemsByLocationID(locationId);
    if (allowed === "all") return getItemsByLocationID();
    const byId = new Map<string, Item>();
    for (const id of allowed) {
        for (const item of await getItemsByLocationID(id)) {
            byId.set(item.id, item);
        }
    }
    return [...byId.values()];
}

const sellsOnline = (channels: SalesChannel[] | undefined) =>
    channels?.includes("online") ?? false;

/**
 * Reduces an item to its online form: the item must be online, only variations
 * that are online too stay, and location data outside `allowed` is dropped so
 * a credential cannot read prices of locations it has no access to.
 * @param item an item from the catalog cache
 * @param allowed the principal's `location_ids`
 * @returns the item, or null when it is not for sale online
 */
export function toOnlineItem(
    item: Item,
    allowed: "all" | string[],
): Item | null {
    if (item.isArchived || !sellsOnline(item.channels)) return null;
    const itemChannels = item.channels ?? ["pos"];
    const visible = (locationId?: string | null) =>
        allowed === "all" || (!!locationId && allowed.includes(locationId));

    const variations = (item.variations ?? [])
        .filter((v) => sellsOnline(v.channels ?? itemChannels))
        .map((v) => ({
            ...v,
            channels: v.channels ?? itemChannels,
            locationOverrides: v.locationOverrides?.filter((o) =>
                visible(o.locationId),
            ),
        }));
    if (variations.length === 0) return null;
    return {
        ...item,
        variations,
        locationIds: (item.locationIds ?? []).filter(visible),
    };
}

function byId(a: { id: string }, b: { id: string }): number {
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * The online catalog for a principal, ordered by id.
 * @param allowed the principal's `location_ids`
 * @param locationId one location to narrow to
 * @returns the online items
 */
export async function onlineItems(
    allowed: "all" | string[],
    locationId?: string,
): Promise<Item[]> {
    const items: Item[] = [];
    for (const item of await cachedItemsFor(allowed, locationId)) {
        const online = toOnlineItem(item, allowed);
        if (online) items.push(online);
    }
    return items.sort(byId);
}

/**
 * Whether an item matches search text by name, display name, or a variation's
 * name or SKU.
 * @param item the item
 * @param text the search text
 * @returns true on a match
 */
export function matchesText(item: Item, text: string): boolean {
    const needle = text.trim().toLowerCase();
    if (!needle) return true;
    return [
        item.name,
        item.displayName,
        ...(item.variations ?? []).flatMap((v) => [v.name, v.sku]),
    ].some((field) => field?.toLowerCase().includes(needle));
}

/** Walks a category and its ancestors, guarding against a parent cycle. */
function chain(category: ItemCategory): ItemCategory[] {
    const out: ItemCategory[] = [];
    for (
        let c: ItemCategory | null | undefined = category;
        c && out.length < 20;
        c = c.parentCategory
    ) {
        out.push(c);
    }
    return out;
}

/**
 * Whether an item is in a category or in one of its descendants.
 * @param item the item
 * @param categoryId the category to look for
 * @returns true when the item is filed under it
 */
export function inCategory(item: Item, categoryId: string): boolean {
    return (item.categories ?? []).some((category) =>
        chain(category).some((c) => c.id === categoryId),
    );
}

/**
 * Every category the online items are filed under, with their ancestors, so
 * a store can build a tree. Ordered by id.
 * @param items the online items
 * @returns the categories, each once
 */
export function categoriesOf(items: Item[]): (ItemCategory & { id: string })[] {
    const seen = new Map<string, ItemCategory & { id: string }>();
    for (const item of items) {
        for (const category of item.categories ?? []) {
            for (const c of chain(category)) {
                if (c.id && !seen.has(c.id)) {
                    seen.set(c.id, { ...c, id: c.id });
                }
            }
        }
    }
    return [...seen.values()].sort(byId);
}

/**
 * Encodes the position after `id` as an opaque cursor.
 * @param id the last id of the page just served
 * @returns the cursor
 */
export function encodeCursor(id: string): string {
    return Buffer.from(JSON.stringify({ after: id })).toString("base64url");
}

/**
 * @param cursor a cursor issued by {@link encodeCursor}
 * @returns the id the page starts after
 * @throws {InvalidCursorError} when the cursor is not one this service issued
 */
export function decodeCursor(cursor: string): string {
    try {
        const parsed = JSON.parse(
            Buffer.from(cursor, "base64url").toString("utf8"),
        ) as { after?: unknown };
        if (typeof parsed.after === "string") return parsed.after;
    } catch {
        // falls through to the error below
    }
    throw new InvalidCursorError();
}

/**
 * Reads `limit` and `cursor` from a query. A cursor is a position, not an
 * offset: items added or removed between requests never repeat or skip an
 * item that stays.
 * @param query Express's query (or the gateway's validated one)
 * @returns the page size and the id to start after
 * @throws {InvalidCursorError} for a cursor that is not valid
 */
export function readPaging(query: Record<string, unknown>): {
    limit: number;
    after: string | null;
} {
    const rawLimit = Number(query.limit);
    const limit =
        Number.isInteger(rawLimit) && rawLimit >= 1
            ? Math.min(rawLimit, MAX_ONLINE_PAGE)
            : DEFAULT_ONLINE_PAGE;
    const cursor = typeof query.cursor === "string" ? query.cursor : null;
    return { limit, after: cursor ? decodeCursor(cursor) : null };
}

/**
 * Cuts one page out of id-ordered rows.
 * @param rows rows ordered by id
 * @param paging the page size and the id to start after
 * @param paging.limit the page size
 * @param paging.after the id the page starts after
 * @returns the page and the cursor for the next one, or null at the end
 */
export function pageOf<T extends { id: string }>(
    rows: T[],
    paging: { limit: number; after: string | null },
): OnlinePage<T> {
    const after = paging.after;
    const rest = after === null ? rows : rows.filter((row) => row.id > after);
    const items = rest.slice(0, paging.limit);
    const last = items[items.length - 1];
    return {
        items,
        nextCursor:
            rest.length > items.length && last ? encodeCursor(last.id) : null,
    };
}
