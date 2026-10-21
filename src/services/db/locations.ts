import { eq } from "drizzle-orm";
import type {
    Address,
    CurrencyCode,
    Location,
    LocationHours,
} from "@tessellatepos/sdk";
import { drizzleDB } from "@/services/db/postgres";
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
        phone_number: row.phoneNumber ?? "",
        website_url: row.websiteUrl ?? "",
        email: row.email ?? "",
        hours: (row.hours as LocationHours | null) ?? EMPTY_HOURS,
        logo_url: row.logoUrl ?? "",
    };
}

/**
 * Lists the persisted locations, whichever provider supplied them.
 * @returns the locations, sorted by name
 */
export async function getLocations(): Promise<Location[]> {
    const rows = await drizzleDB
        .select()
        .from(locationsTable)
        .orderBy(locationsTable.name);
    return rows.map(rowToLocation);
}

/**
 * Fetches a single persisted location.
 * @param id the location id
 * @returns the location, or null if it doesn't exist
 */
export async function getLocationById(id: string): Promise<Location | null> {
    const [row] = await drizzleDB
        .select()
        .from(locationsTable)
        .where(eq(locationsTable.id, id))
        .limit(1);
    return row ? rowToLocation(row) : null;
}

/**
 * Upserts locations fetched from a provider. Locations missing from the
 * import are kept, so orders and devices referencing them still resolve.
 * @param locations the locations fetched from a provider
 */
export async function importLocationsFromProvider(
    locations: Location[],
): Promise<void> {
    await drizzleDB.transaction(async (tx) => {
        for (const location of locations) {
            const values = {
                name: location.name,
                address: location.address,
                currency: location.currency,
                phoneNumber: location.phone_number || null,
                websiteUrl: location.website_url || null,
                email: location.email || null,
                hours: location.hours,
                logoUrl: location.logo_url || null,
            };
            await tx
                .insert(locationsTable)
                .values({ id: location.id, ...values })
                .onConflictDoUpdate({
                    target: locationsTable.id,
                    set: { ...values, updatedAt: new Date() },
                });
        }
    });
}
