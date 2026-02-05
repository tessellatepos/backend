import express from 'express';
import {getRedisClient, setItemByItemID, setItemsByLocationID} from './services/redis';
import {fetchItems} from "./services/square";
import {itemRouter} from "./endpoints/items";
import {Logger} from "@origranot/ts-logger";

const app = express();

const logger = new Logger();

/**
 *  Update the catalog in Redis cache
 */
export async function updateCatalogInCache() {
    const redis = await getRedisClient();

    if (!redis) {
        throw new Error('Redis client not available');
    }

    const catalog = await fetchItems()
    logger.debug('updateCatalogInCache');

    await setItemsByLocationID(catalog.items)

    // for (const item of catalog.items) {
    //     await setItemByItemID(item.id, item);
    //
    // }
}

async function start() {
    try {
        const redis = await getRedisClient(); // await the async function

        if (!redis) {
            throw new Error('Redis client not available');
        }

       // Initial catalog update
        await updateCatalogInCache();


        app.use('/items', itemRouter);
        // start server after redis is ready
        const port = Number(process.env.PORT) || 3000;
        app.listen(port, () => {
            logger.info(`Server listening on ${port}`);
        });

    } catch (err) {
        logger.error('Startup error:', err);
        process.exit(1);
    }
}

void start();