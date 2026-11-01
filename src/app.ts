import express, { type Express } from "express";
import { routes } from "@/utils/registry/api/routes";
import {
    TessellateApiRegistry,
    type ITessellateApiRouter,
} from "@/utils/registry/api/apiRegistry";
import type { TessellatePluginApiRegistry } from "@/utils/registry/api/pluginApiRegistry";
import { urlConfig } from "@/config/urls";
import { hostGuard } from "@/middleware/hostGuard";
import { surfaceMiddleware } from "@/middleware/surface";
import { surfaceCors } from "@/middleware/cors";
import { authenticate } from "@/middleware/authenticate";
import { installGatewayPrincipals } from "@/gateway/principal";
import { buildGatewayRegistry } from "@/gateway/registry";
import { populateGatewayRouter } from "@/gateway/router";
import { processorWebhookHandler } from "@/services/processors/inbound";

/**
 * Builds the Express app with the middleware every request goes through and
 * the public liveness probe. Routes are added by {@link mountApiRoutes}.
 * server.ts and the route inventory test both build the app this way.
 * @returns the app, without routes
 */
export function createApp(): Express {
    installGatewayPrincipals();
    const app = express();
    app.set("trust proxy", urlConfig.trustProxy);

    app.use(hostGuard());
    app.use(surfaceMiddleware);
    app.use(surfaceCors());
    // Inbound payment webhooks are signed over the exact bytes, so this route
    // takes the raw body and is mounted before express.json() and
    // authenticate. It is public by design; the processor's signature check
    // is the only way in.
    app.post(
        "/webhooks/:processorId",
        express.raw({ type: () => true, limit: "256kb" }),
        processorWebhookHandler(),
    );
    app.use(express.json());
    // Resolves req.principal; guards (requireScope) decide what to reject.
    app.use(authenticate);

    // Public, minimal liveness probe. Reachable on the public host.
    app.get("/health", (_req, res) => {
        res.json({ status: "ok" });
    });
    return app;
}

/**
 * Registers every router in `routes.ts` (or the given list) plus the plugin
 * asset and API dispatchers. This must be the last thing before the server
 * listens so plugin routes are loaded.
 * @param app the app from {@link createApp}
 * @param pluginApi the plugin API registry that dispatches `/plugins/:name/*`
 * @param list routers to mount, defaults to the real ones
 * @returns the registry that mounted them
 */
export function mountApiRoutes(
    app: Express,
    pluginApi: TessellatePluginApiRegistry,
    list: ITessellateApiRouter[] = routes,
): TessellateApiRegistry {
    const apiRegistry = new TessellateApiRegistry(app, pluginApi);
    for (const route of list) apiRegistry.registerRouter(route);
    apiRegistry.loadRoutes();
    // Generated from the declarations, so it runs after plugins have loaded.
    populateGatewayRouter(
        buildGatewayRegistry(list, pluginApi.gatewayEntries()),
    );
    return apiRegistry;
}
