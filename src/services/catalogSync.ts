import { Logger } from "tslog";
import { getRedisClient, setItemsByLocationID } from "@/services/redis";
import { activeProvider } from "@/services/providers";
import {
    getCatalogByLocation,
    importCatalogFromProvider,
} from "@/services/db/catalog";

const logger = new Logger();

const CATALOG_SYNC_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Imports the catalog from the active provider into Postgres, then
 * refreshes the Redis cache from Postgres.
 */
export async function updateCatalogInCache() {
    const redis = await getRedisClient();

    if (!redis) {
        throw new Error("Redis client not available");
    }

    logger.debug("updateCatalogInCache");

    const providerCatalog = await activeProvider.fetchCatalog();
    await importCatalogFromProvider(providerCatalog);

    const catalog = await getCatalogByLocation();
    await setItemsByLocationID(catalog.items);
}

/** Starts the hourly catalog sync after the initial one. */
export function startCatalogSyncInterval() {
    setInterval(() => void updateCatalogInCache(), CATALOG_SYNC_INTERVAL_MS);
}
