import { match, type MatchFunction } from "path-to-regexp";
import type { RequestHandler } from "express";
import { Logger } from "tslog";
import type {
    PluginApiMountDefinition,
    PluginApiMethod,
    PluginApiRequest,
    PluginPermissionProvider,
} from "@tessellatepos/plugin-sdk";
import type { Principal } from "@tessellatepos/sdk";
import type { PluginServerContext } from "@tessellatepos/plugin-sdk/server";
import { getActiveProvider } from "@/services/providers";
import { getItemById } from "@/services/redis";
import { findCustomers, getCustomer } from "@/services/customers";
import { TessellatePluginDatabaseRegistry } from "@/utils/registry/database/pluginDatabaseRegistry";

const logger = new Logger();

interface RegisteredRoute {
    pluginName: string;
    method: PluginApiMethod;
    matcher: MatchFunction<Record<string, string>>;
    handler: PluginApiMountDefinition["handler"];
    permissions: PluginPermissionProvider;
}

// Builds the PluginServerContext passed to plugin API mount handlers.
// Provider/cache failures are normalized to the null the SDK promises,
// rather than throwing through into plugin code that never asked for
// host-provider error handling.
export function buildPluginServerContext(
    pluginName: string,
    databaseRegistry: TessellatePluginDatabaseRegistry,
    principal: Principal | null,
    permissions: PluginPermissionProvider,
): PluginServerContext {
    // Customer data is PII: a plugin without the CUSTOMER permission gets a
    // rejected promise, never an empty result it might mistake for "none".
    const requireCustomer = () => {
        if (!permissions.customer) {
            throw new Error(
                `Plugin "${pluginName}" lacks the CUSTOMER permission`,
            );
        }
    };

    return {
        db: databaseRegistry.getRepository(pluginName),
        session: {
            deviceId: "",
            locationId: "",
        },
        principal,
        getOrder: async (orderId: string) => {
            try {
                const order = await getActiveProvider().fetchOrder(orderId);
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
        getCustomer: async (customerId: string) => {
            requireCustomer();
            return getCustomer(customerId);
        },
        findCustomers: async (query) => {
            requireCustomer();
            return findCustomers(query);
        },
    };
}

export class TessellatePluginApiRegistry {
    private routes: RegisteredRoute[] = [];
    private databaseRegistry: TessellatePluginDatabaseRegistry;

    constructor(databaseRegistry: TessellatePluginDatabaseRegistry) {
        this.databaseRegistry = databaseRegistry;
    }

    public register(
        pluginName: string,
        mount: PluginApiMountDefinition,
        permissions: PluginPermissionProvider,
    ) {
        this.routes.push({
            pluginName,
            method: mount.method,
            matcher: match(mount.route),
            handler: mount.handler,
            permissions,
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
                req.principal ?? null,
                route.permissions,
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
