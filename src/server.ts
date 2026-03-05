import express, { Router } from "express";
import { getRedisClient, setItemsByLocationID } from "./services/redis";
import { fetchItems } from "./services/square";
import { itemRouter } from "@/endpoints/v1/items";
import { configDeviceRouter } from "@/endpoints/v1/config/devices";
import { configSettingRouter } from "@/endpoints/v1/config/settings";
import { Logger } from "tslog";
import cors from "cors";
import { squareRouter } from "@/endpoints/v1/square";
import { IServerAPIRouter } from "@tessellate-pos/common/src/types/endpoints";
import { baseRouter } from "@/endpoints/base";
import * as http from "node:http";
import { setupWebSocket } from "@/services/websocket/websocket";
import { orderRouter } from "@/endpoints/v1/orders";

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
            { endpoint: "/api/v1/config/devices", router: configDeviceRouter },
            { endpoint: "/api/v1/config/system", router: configSettingRouter },
            { endpoint: "/api/v1/items", router: itemRouter },
            { endpoint: "/api/v1/square", router: squareRouter },
            { endpoint: "/api/v1/orders", router: orderRouter },
        ];

        routes.forEach((route) => {
            app.use(route.endpoint, route.router);
        });

        const httpServer = http.createServer(app);
        setupWebSocket(httpServer);
        // start server after redis is ready
        const port = Number(process.env.PORT) || 3000;
        httpServer.listen(port, () => {
            logger.info(`Server listening on ${port}`);
        });
    } catch (err) {
        logger.error("Startup error:", err);
        process.exit(1);
    }
}

void start();
