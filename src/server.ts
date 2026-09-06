import express from "express";
import { getRedisClient } from "@/services/redis";
import { runMigrations } from "@/services/db/postgres";
import {
    startCatalogSyncInterval,
    updateCatalogInCache,
} from "@/services/catalogSync";
import { Logger } from "tslog";
import cors from "cors";
import * as http from "node:http";
import { setupWebSocket } from "@/services/websocket/websocket";
import { refreshIfNeeded } from "@/services/squareOauth";
import { routes } from "@/utils/registry/api/routes";
import { TessellateApiRegistry } from "@/utils/registry/api/apiRegistry";
import { TessellatePluginRegistry } from "@/utils/registry/plugin/pluginRegistry";
import { loadPlugins } from "@/plugin/lifecycle/lifecycleManager";

const app = express();
const corsOptions = {
    origin: "*",
};

app.use(cors(corsOptions));
app.use(express.json());

const logger = new Logger();

async function start() {
    try {
        const pluginRegistry = new TessellatePluginRegistry();
        await loadPlugins(pluginRegistry);
        const apiRegistry = new TessellateApiRegistry(app, pluginRegistry.apiRegistry);
        logger.debug("Loaded plugins:", [...pluginRegistry.getPlugins().keys()]);


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

        // register all the routes in routes.ts and load them all in. 
        // This process should be the last thing before the server loads 
        // to ensure that plugin routes are loaded
        for (const route of routes) {
            apiRegistry.registerRouter(route);
        }
        apiRegistry.loadRoutes();

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
