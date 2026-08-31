import express, { Router } from "express";
import { getRedisClient } from "@/services/redis";
import { runMigrations } from "@/services/db/postgres";
import {
    startCatalogSyncInterval,
    updateCatalogInCache,
} from "@/services/catalogSync";
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
import { authRouter } from "./endpoints/v1/auth";
import { refreshIfNeeded } from "@/services/squareOauth";

const app = express();
const corsOptions = {
    origin: "*",
};

app.use(cors(corsOptions));
app.use(express.json());

const logger = new Logger();

async function start() {
    try {
        const redis = await getRedisClient(); // await the async function

        if (!redis) {
            throw new Error("Redis client not available");
        }

        await runMigrations();

        // Renew the stored Square token before anything tries to use it. A
        // failure here isn't fatal — the deployment may not be connected yet.
        try {
            await refreshIfNeeded();
        } catch (err) {
            logger.warn("Could not refresh the Square OAuth token:", err);
        }

        // Initial catalog update, then keep it in sync on an hourly interval
        await updateCatalogInCache();
        startCatalogSyncInterval();

        const routes: IServerAPIRouter<Router>[] = [
            { endpoint: "/", router: baseRouter },
            { endpoint: "/api/v1/config/devices", router: configDeviceRouter },
            { endpoint: "/api/v1/config/system", router: configSettingRouter },
            { endpoint: "/api/v1/items", router: itemRouter },
            { endpoint: "/api/v1/square", router: squareRouter },
            { endpoint: "/api/v1/orders", router: orderRouter },
            { endpoint: "/api/v1/auth", router: authRouter },
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
