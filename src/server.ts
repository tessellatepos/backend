import { createApp, mountApiRoutes } from "@/app";
import { getRedisClient } from "@/services/redis";
import { pool, runMigrations } from "@/services/db/postgres";
import {
    startCatalogSyncInterval,
    updateCatalogInCache,
} from "@/services/catalogSync";
import { Logger } from "tslog";
import * as http from "node:http";
import { setupWebSocket } from "@/services/websocket/websocket";
import { refreshIfNeeded } from "@/services/squareOauth";
import { TessellatePluginRegistry } from "@/utils/registry/plugin/pluginRegistry";
import { loadPlugins } from "@/plugin/lifecycle/lifecycleManager";
import { rebuildAuth } from "@/services/authProviders";
import { hasUsers } from "@/services/setup";
import { initActiveProvider } from "@/services/providers";
import { initSetupToken } from "@/services/setupToken";
import { runDevSeed } from "@/services/devSeed";

const app = createApp();

const logger = new Logger();

async function start() {
    try {
        const pluginRegistry = new TessellatePluginRegistry();
        await loadPlugins(pluginRegistry);
        logger.debug("Loaded plugins:", [
            ...pluginRegistry.getPlugins().keys(),
        ]);

        // Attach the plugin registry to app.locals so endpoint handlers
        // (e.g. orders.ts) can access it for hook dispatch and event emission
        // without a factory or module-level mutable state.
        app.locals.pluginRegistry = pluginRegistry;

        const redis = await getRedisClient(); // await the async function

        if (!redis) {
            throw new Error("Redis client not available");
        }

        await runMigrations();
        // Restores the provider chosen at runtime (PROVIDER only seeds the default).
        await initActiveProvider();

        // Built after plugins load and migrations run, so the tables exist
        // and plugin contributions are known. Rebuilt when the owner changes
        // a sign-in method.
        await rebuildAuth();

        // Development only (DEV_SEED=true): on an empty instance, create the
        // admin/password owner and a test store. Runs before the setup token
        // is decided, and refuses itself under production or a SETUP_TOKEN.
        await runDevSeed(process.env);

        // The owner step needs a token only when SETUP_TOKEN is set.
        initSetupToken(!(await hasUsers()));

        // Renew the stored Square token before anything tries to use it. A
        // failure here isn't fatal — the deployment may not be connected yet.
        try {
            await refreshIfNeeded();
        } catch (err) {
            logger.warn("Could not refresh the Square OAuth token:", err);
        }

        // Initial catalog update, then keep it in sync on an hourly interval.
        // Not fatal — the deployment may not be connected to Square yet.
        try {
            await updateCatalogInCache();
        } catch (err) {
            logger.warn("Could not sync catalog on startup:", err);
        }
        startCatalogSyncInterval();

        // register all the routes in routes.ts and load them all in.
        // This process should be the last thing before the server loads
        // to ensure that plugin routes are loaded
        mountApiRoutes(app, pluginRegistry.apiRegistry);

        const httpServer = http.createServer(app);
        setupWebSocket(httpServer);
        // start server after redis is ready
        const port = Number(process.env.PORT) || 3000;
        httpServer.listen(port, () => {
            logger.info(`Server listening on ${port}`);
        });

        let shuttingDown = false;
        const shutdown = async (signal: NodeJS.Signals) => {
            if (shuttingDown) return;
            shuttingDown = true;
            logger.info(`Received ${signal}, shutting down...`);

            await new Promise<void>((resolve) =>
                httpServer.close(() => resolve()),
            );

            await Promise.allSettled([pool.end(), redis.quit()]);

            process.exit(0);
        };

        process.on("SIGINT", (signal) => void shutdown(signal));
        process.on("SIGTERM", (signal) => void shutdown(signal));
    } catch (err) {
        logger.error("Startup error:", err);
        process.exit(1);
    }
}

void start();
