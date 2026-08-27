import express, { Router } from "express";
import { getRedisClient, setItemsByLocationID } from "@/services/redis";
import { activeProvider } from "@/services/providers";
import { runMigrations } from "@/services/db/postgres";
import {
    getCatalogByLocation,
    importCatalogFromProvider,
} from "@/services/db/catalog";
import { itemRouter } from "@/endpoints/v1/items";
import { configDeviceRouter } from "@/endpoints/v1/config/devices";
import { configSettingRouter } from "@/endpoints/v1/config/settings";
import { Logger } from "tslog";
import cors from "cors";
import { squareRouter } from "@/endpoints/v1/square";
import { type IServerAPIRouter } from "@/types/endpoints";
import { baseRouter } from "@/endpoints/base";
import * as http from "node:http";
import { setupWebSocket } from "@/services/websocket/websocket";
import { orderRouter } from "@/endpoints/v1/orders";

const app = express();
const corsOptions = {
    origin: "*",
};

app.use(cors(corsOptions));
app.use(express.json());

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

async function start() {
    try {
        const redis = await getRedisClient(); // await the async function

        if (!redis) {
            throw new Error("Redis client not available");
        }

        await runMigrations();

        // Initial catalog update, then keep it in sync on an hourly interval
        await updateCatalogInCache();
        setInterval(
            () => void updateCatalogInCache(),
            CATALOG_SYNC_INTERVAL_MS,
        );

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
