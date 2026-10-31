import { Logger } from "tslog";
import { publishGatewayEvent } from "@/gateway/webhooks/dispatch";
import { getRedisClient, rebuildItemCache } from "@/services/redis";
import {
    getActiveProvider,
    getActiveProviderId,
    visibleCatalogScope,
} from "@/services/providers";
import { catalogStore, getCatalogByLocation } from "@/services/db/catalog";
import { customerStore } from "@/services/db/customers";
import { locationStore } from "@/services/db/locations";
import { syncResource } from "@/services/store";

const logger = new Logger();

const CATALOG_SYNC_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Rebuilds the till's item cache from Postgres as the active provider shows
 * it: archived items and, under Square, locally created ones are left out.
 */
export async function refreshCatalogCache() {
    const catalog = await getCatalogByLocation(
        undefined,
        undefined,
        visibleCatalogScope(),
    );
    await rebuildItemCache(catalog.items);
}

/**
 * Imports the locations and catalog from the active provider into Postgres, then
 * refreshes the Redis cache from Postgres.
 */
export async function updateCatalogInCache() {
    const redis = await getRedisClient();

    if (!redis) {
        throw new Error("Redis client not available");
    }

    logger.debug("updateCatalogInCache");

    await syncResource({
        name: "locations",
        fetchRemote: () => getActiveProvider().fetchLocations(),
        store: locationStore,
        // orders and devices keep referencing a location a provider drops
        removeMissing: false,
    });

    // The local provider's catalog is Postgres itself, edited through the
    // catalog endpoints: there is nothing to pull, and a pull must not
    // overwrite or archive what users created. Under Square, catalogStore
    // only sees synced rows, so locally created items are never touched.
    if (getActiveProviderId() !== "local") {
        await syncResource({
            name: "catalog",
            fetchRemote: async () => {
                const { items, itemLocationIds } =
                    await getActiveProvider().fetchCatalog();
                return items.map((item) => ({
                    ...item,
                    locationIds: itemLocationIds.get(item.id) ?? [],
                }));
            },
            store: catalogStore,
        });
    }

    // A provider without customer access (e.g. a Square token missing the
    // customers scope) must not stop the catalog refresh.
    // Customers are hard deleted. syncResource keeps local records when the
    // remote returns nothing, so a seller deleting their LAST customer in
    // Square leaves the local copy until the next non-empty sync or a delete
    // through our service.
    try {
        await syncResource({
            name: "customers",
            fetchRemote: () => getActiveProvider().fetchCustomers(),
            store: customerStore,
        });
    } catch (err) {
        logger.error("Customer sync failed:", err);
    }

    await refreshCatalogCache();
    publishGatewayEvent("catalogSynced", []);
}

/** Starts the hourly catalog sync after the initial one. */
export function startCatalogSyncInterval() {
    setInterval(() => {
        void updateCatalogInCache().catch((err) => {
            logger.error("Catalog sync interval error:", err);
        });
    }, CATALOG_SYNC_INTERVAL_MS);
}
