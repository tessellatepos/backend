import type {
    Address,
    CountryCode,
    CurrencyCode,
    Location,
    LocationHours,
} from "@tessellatepos/sdk";
import { and, isNull, eq } from "drizzle-orm";
import { createLocalStore, emptyIfNull, nullIfEmpty } from "@/services/store";
import { drizzleDB } from "@/services/db/postgres";
import { deleteLocalDevicesForLocation } from "./configDevice";
import { locationsTable } from "./schema";

/** Hours for a location with none set yet. */
export const EMPTY_HOURS: LocationHours = {
    sunday: [],
    monday: [],
    tuesday: [],
    wednesday: [],
    thursday: [],
    friday: [],
    saturday: [],
};

/**
 * Converts a persisted locations row back into a Location.
 * @param row the persisted location row
 * @returns the location
 */
function rowToLocation(row: typeof locationsTable.$inferSelect): Location {
    return {
        id: row.id,
        name: row.name,
        address: row.address as Address,
        currency: row.currency as CurrencyCode,
        phone_number: emptyIfNull(row.phoneNumber),
        website_url: emptyIfNull(row.websiteUrl),
        email: emptyIfNull(row.email),
        hours: (row.hours as LocationHours | null) ?? EMPTY_HOURS,
        logo_url: emptyIfNull(row.logoUrl),
    };
}

/**
 * Converts a Location into a locations row.
 * @param location the location
 * @returns the row to persist
 */
function locationToRow(location: Location): typeof locationsTable.$inferInsert {
    return {
        id: location.id,
        name: location.name,
        address: location.address,
        currency: location.currency,
        phoneNumber: nullIfEmpty(location.phone_number),
        websiteUrl: nullIfEmpty(location.website_url),
        email: nullIfEmpty(location.email),
        hours: location.hours,
        logoUrl: nullIfEmpty(location.logo_url),
    };
}

/**
 * The persisted locations, whichever provider supplied them. Locations a
 * provider stops returning are soft deleted by syncResource.
 */
export const locationStore = createLocalStore({
    table: locationsTable,
    toRow: locationToRow,
    fromRow: rowToLocation,
    searchColumns: [locationsTable.name, locationsTable.email],
    orderBy: locationsTable.name,
});

/**
 * Lists the persisted locations, whichever provider supplied them.
 * @returns the locations, sorted by name
 */
export async function getLocations(): Promise<Location[]> {
    return (await locationStore.list()).items;
}

/**
 * Fetches a single persisted location.
 * @param id the location id
 * @returns the location, or null if it doesn't exist
 */
export async function getLocationById(id: string): Promise<Location | null> {
    return locationStore.get(id);
}

/**
 * Creates a storefront owned by this deployment (the local provider's
 * locations). Its id has the `local-` prefix, which marks it as removable.
 * @param input the name, currency and country; the address is otherwise empty
 * @returns the created location
 */
export async function createLocalLocation(input: {
    name: string;
    currency: CurrencyCode;
    country: CountryCode;
}): Promise<Location> {
    const location: Location = {
        id: `local-${crypto.randomUUID().slice(0, 8)}`,
        name: input.name,
        address: { country: input.country, address_line_1: "" },
        currency: input.currency,
        phone_number: "",
        website_url: "",
        email: "",
        hours: EMPTY_HOURS,
        logo_url: "",
    };
    await locationStore.upsert(location);
    return location;
}

/**
 * Soft deletes a location. Orders and devices keep referencing it.
 * @param id the location id
 * @returns true if a live location was removed
 */
export async function removeLocation(id: string): Promise<boolean> {
    return locationStore.remove(id);
}

/**
 * Soft deletes a local storefront and deletes its LOCAL till in one
 * transaction, so neither is removed without the other.
 * @param id the location id
 * @returns true if a live location was removed
 */
export async function removeLocalStorefront(id: string): Promise<boolean> {
    return drizzleDB.transaction(async (tx) => {
        const removed = await tx
            .update(locationsTable)
            .set({ deletedAt: new Date(), updatedAt: new Date() })
            .where(
                and(
                    eq(locationsTable.id, id),
                    isNull(locationsTable.deletedAt),
                ),
            )
            .returning({ id: locationsTable.id });
        if (removed.length === 0) return false;
        await deleteLocalDevicesForLocation(id, tx);
        return true;
    });
}
