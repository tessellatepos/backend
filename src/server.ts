import express, { Router } from "express";
import {
    getRedisClient,
    setItemByItemID,
    setItemsByLocationID,
} from "./services/redis";
import { fetchItems } from "./services/square";
import { itemRouter } from "./endpoints/items";
import { configDeviceRouter } from "@/endpoints/config/devices";
import { configSettingRouter } from "@/endpoints/config/settings";
import { Logger } from "tslog";
//@ts-expect-error I'm not planning on fixing these imports, doesn't cause any issues when linting
import cors from "cors";
import { squareRouter } from "@/endpoints/square";
import { IServerAPIRouter } from "@tessellate-pos/common/src/types/endpoints";
import { baseRouter } from "@/endpoints/base";

const app = express();

const corsOptions = {
    origin: "*",
};

app.use(express.json());

app.use(cors(corsOptions));

const logger = new Logger();

/**
 *  Update the catalog in Redis cache
 */
export async function updateCatalogInCache() {
    const redis = await getRedisClient();

    if (!redis) {
        throw new Error("Redis client not available");
    }

    const catalog = await fetchItems();
    logger.debug("updateCatalogInCache");

    await setItemsByLocationID(catalog.items);

    // for (const item of catalog.items) {
    //     await setItemByItemID(item.id, item);
    //
    // }
}

async function start() {
    try {
        const redis = await getRedisClient(); // await the async function

        if (!redis) {
            throw new Error("Redis client not available");
        }

        // Initial catalog update
        await updateCatalogInCache();

        const routes: IServerAPIRouter<Router>[] = [
            { endpoint: "/", router: baseRouter },
            { endpoint: "/config/devices", router: configDeviceRouter },
            { endpoint: "/config/system", router: configSettingRouter },
            { endpoint: "/items", router: itemRouter },
            { endpoint: "/square", router: squareRouter },
        ];

        routes.forEach((route) => {
            app.use(route.endpoint, route.router);
        });
        // start server after redis is ready
        const port = Number(process.env.PORT) || 3000;
        app.listen(port, () => {
            logger.info(`Server listening on ${port}`);
        });
    } catch (err) {
        logger.error("Startup error:", err);
        process.exit(1);
    }
}

void start();
