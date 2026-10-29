import type {
    Address,
    CurrencyCode,
    Location,
    LocationHours,
} from "@tessellatepos/sdk";
import { createLocalStore, emptyIfNull, nullIfEmpty } from "@/services/store";
import { locationsTable } from "./schema";

const EMPTY_HOURS: LocationHours = {
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
