import { match, type MatchFunction } from "path-to-regexp";
import type { RequestHandler } from "express";
import { Logger } from "tslog";
import type {
    PluginApiMountDefinition,
    PluginApiMethod,
    PluginApiRequest,
} from "@tessellatepos/plugin-sdk";
import type { PluginServerContext } from "@tessellatepos/plugin-sdk/server";
import { activeProvider } from "@/services/providers";
import { getItemById } from "@/services/redis";
import { TessellatePluginDatabaseRegistry } from "@/utils/registry/database/pluginDatabaseRegistry";

const logger = new Logger();

interface RegisteredRoute {
    pluginName: string;
    method: PluginApiMethod;
    matcher: MatchFunction<Record<string, string>>;
    handler: PluginApiMountDefinition["handler"];
}

// Builds the PluginServerContext passed to plugin API mount handlers.
// Provider/cache failures are normalized to the null the SDK promises,
// rather than throwing through into plugin code that never asked for
// host-provider error handling.
function buildPluginServerContext(
    pluginName: string,
    databaseRegistry: TessellatePluginDatabaseRegistry,
): PluginServerContext {
    return {
        db: databaseRegistry.getRepository(pluginName),
        session: {
            deviceId: "",
            locationId: "",
        },
        getOrder: async (orderId: string) => {
            try {
                const order = await activeProvider.fetchOrder(orderId);
                return order ?? null;
            } catch (err) {
                logger.warn(
                    `Failed to fetch order "${orderId}" for plugin "${pluginName}":`,
                    err,
                );
                return null;
            }
        },
        lookupItem: async (itemId: string) => {
            try {
                return await getItemById(itemId);
            } catch (err) {
                logger.warn(
                    `Failed to look up item "${itemId}" for plugin "${pluginName}":`,
                    err,
                );
                return null;
            }
        },
    };
}

export class TessellatePluginApiRegistry {
    private routes: RegisteredRoute[] = [];
    private databaseRegistry: TessellatePluginDatabaseRegistry;

    constructor(databaseRegistry: TessellatePluginDatabaseRegistry) {
        this.databaseRegistry = databaseRegistry;
    }

    public register(pluginName: string, mount: PluginApiMountDefinition) {
        this.routes.push({
            pluginName,
            method: mount.method,
            matcher: match(mount.route),
            handler: mount.handler,
        });
    }

    public unregister(pluginName: string) {
        this.routes = this.routes.filter((r) => r.pluginName !== pluginName);
    }

    public dispatch: RequestHandler = async (req, res, next) => {
        // The dispatcher is mounted at /plugins/:pluginName, so
        // req.params.pluginName tells us which plugin's routes to check.
        // This scopes API calls so a plugin can only hit its own mounts.
        const pluginName = req.params.pluginName;

        for (const route of this.routes) {
            if (route.pluginName !== pluginName) continue;
            if (route.method !== req.method) continue;
            const matched = route.matcher(req.path);
            if (!matched) continue;

            const apiReq: PluginApiRequest = {
                params: matched.params,
                query: req.query as Record<string, string>,
                body: req.body,
            };
            const ctx = buildPluginServerContext(
                route.pluginName,
                this.databaseRegistry,
            );

            try {
                const response = await route.handler(apiReq, ctx);
                res.status(response.status ?? 200).json(response.body);
            } catch (err) {
                logger.error(
                    `Plugin "${route.pluginName}" handler threw for ${req.method} ${req.path}:`,
                    err,
                );
                res.status(500).json({ error: "Internal plugin error" });
            }
            return;
        }
        next(); // no plugin claimed this request
    };
}
