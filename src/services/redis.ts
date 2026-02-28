import { createClient } from "redis";
import { Logger } from "tslog";
import { configDotenv } from "dotenv";
import { squareItem } from "@tessellate-pos/common/src/types/squareTypes";

configDotenv();

const logger = new Logger();

// Keys used for item / location storage
const ITEM_KEY = (itemId: string) => `square:item:${itemId}`;
const LOCATION_ITEMS_SET = (locationID: string) =>
    `square:items:location:${locationID}`;
const GLOBAL_ITEMS_SET = `square:items:all`;

let redis: ReturnType<typeof createClient> | undefined;

/**
 * Gets or Creates the Redis Client connection.
 *
 * @returns {Promise<ReturnType<typeof createClient>>} The Redis Client instance.
 */
export async function getRedisClient(): Promise<
    ReturnType<typeof createClient>
> {
    if (redis?.isOpen) return redis;

    if (redis && !redis.isOpen) {
        try {
            await redis.connect();
            return redis;
        } catch (err) {
            logger.error("Error reconnecting to Redis:", err);
            try {
                await redis.quit();
            } catch (_) {}
            redis = undefined;
        }
    }

    if (!process.env.REDIS_URL) {
        logger.error("No REDIS_URL found in environment variables");
        throw new Error("No REDIS_URL found in environment variables");
    }

    logger.debug("Redis Client Connecting...");
    const client = createClient({
        url: process.env.REDIS_URL,
        // password: process.env.REDIS_PASSWORD,
        socket: {
            // @ts-ignore, supposed to be a number, trust
            keepAlive: 5000,
        },
    });

    client.on("error", (err: unknown) =>
        logger.error("Redis Client Error:", err),
    );

    redis = client;

    try {
        await client.connect();
        logger.debug("Redis Client Connected");
        return client;
    } catch (err) {
        logger.error("Redis connection error:", err);
        try {
            await client.quit();
        } catch (_) {}
        redis = undefined;
        throw err;
    }
}

/**
 * Sets a value in the Redis cache using the provided key.
 * @param key
 * @param value
 */
export const setItemByItemID = async (
    key: string,
    value: squareItem,
): Promise<void> => {
    if (!redis) {
        redis = await getRedisClient();
    }
    await redis.set(
        key,
        JSON.stringify(value, (_, v) =>
            typeof v === "bigint" ? v.toString() : v,
        ),
    );
};

/**
 * Gets a value from the Redis cache using the provided key.
 * @param key The item id to retrieve.
 *
 * @returns {Promise<squareItem | null>} The retrieved value or null if not found.
 */
export const getItemByItemID = async (
    key: string,
): Promise<squareItem | null> => {
    if (!redis) {
        redis = await getRedisClient();
    }

    try {
        const data = await redis.get(key);
        if (data) {
            return JSON.parse(data) as squareItem;
        } else {
            return null;
        }
    } catch (err) {
        logger.error(`No data found in cache for key: ${key}`, err);
        return null;
    }
};

/**
 * Stores items and indexes them by parent item id for locations when any variation applies to that location.
 * Behavior:
 * - Stores the full item under `square:item:{itemId}` (JSON)
 * - Adds the parent item id to the location set when any of its variations apply to the supplied location
 * - Adds the parent item id to a global set of item ids
 *
 * Note: We do not store per-variation keys anymore. Variations are filtered at read-time.
 * Assumption: the connector (square.ts) is responsible for ensuring variation metadata (e.g. itemId/parentId) is set. We do not generate ids.
 */
export const setItemsByLocationID = async (
    items: squareItem[],
): Promise<void> => {
    if (!redis) redis = await getRedisClient();

    if (!items || items.length === 0) {
        logger.debug(
            "No items provided to setItemsByLocationID; skipping set updates.",
        );
        return;
    }

    const locationToMembers = new Map<string, Set<string>>();
    const globalMembers = new Set<string>();

    for (const item of items) {
        try {
            await redis.set(
                ITEM_KEY(item.id),
                JSON.stringify(item, (_, v) =>
                    typeof v === "bigint" ? v.toString() : v,
                ),
            );
        } catch (err) {
            logger.error(`Failed to set item ${item.id} in redis:`, err);
        }

        globalMembers.add(item.id);

        if (item.presentAtLocationsIds) {
            for (const locId of item.presentAtLocationsIds) {
                const set = locationToMembers.get(locId);
                if (set) {
                    if (!set.has(item.id)) set.add(item.id);
                } else {
                    locationToMembers.set(locId, new Set<string>([item.id]));
                }
            }
        }
    }

    try {
        for (const [loc, idsSet] of locationToMembers) {
            const members = Array.from(idsSet);
            if (members.length > 0) {
                await redis.sAdd(LOCATION_ITEMS_SET(loc), members);
            }
        }

        const globalArray = Array.from(globalMembers);
        if (globalArray.length > 0) {
            await redis.sAdd(GLOBAL_ITEMS_SET, globalArray);
        }
    } catch (err) {
        logger.error("Error updating item sets from catalog:", err);
    }
};

/**
 * Retrieves all items (with only the variations that apply) for the provided locationID.
 * If no locationID is provided, the global set of items is used.
 *
 * Returns an array of squareItem where the `variations` array contains only the variations present for that location.
 */
export const getItemsByLocationID = async (
    locationID?: string,
): Promise<squareItem[]> => {
    if (!redis) redis = await getRedisClient();
    const client = redis!;

    const setKey = locationID
        ? LOCATION_ITEMS_SET(locationID)
        : GLOBAL_ITEMS_SET;

    try {
        const itemIds = await client.sMembers(setKey);
        if (!itemIds || itemIds.length === 0) return [];

        // fetch all item JSONs in parallel
        const itemPromises = itemIds.map((id) => client.get(ITEM_KEY(id)));
        const itemJsons = await Promise.all(itemPromises);

        const results: squareItem[] = [];

        for (let i = 0; i < itemJsons.length; i++) {
            const raw = itemJsons[i];
            if (!raw) continue;
            try {
                const parsed = JSON.parse(raw) as squareItem;
                const parentSummary = {
                    id: parsed.id,
                    name: parsed.name ?? null,
                };

                if (Array.isArray(parsed.variations)) {
                    for (const v of parsed.variations) {
                        v.parent = parentSummary as any;
                    }
                }

                // Return the parent item as-stored. The client is responsible for filtering out any
                // variations that are not applicable to the client's context (e.g. by location).
                results.push(parsed);
            } catch (err) {
                logger.error(
                    `Failed to parse stored item JSON for id ${itemIds[i]}:`,
                    err,
                );
            }
        }

        return results;
    } catch (err) {
        logger.error(
            `Error retrieving items for location ${locationID ?? "GLOBAL"}:`,
            err,
        );
        return [];
    }
};
