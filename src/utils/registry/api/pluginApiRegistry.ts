import { match, type MatchFunction } from "path-to-regexp";
import type { RequestHandler } from "express";
import { Logger } from "tslog";
import type {
    PluginApiAccess,
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
import { getMember, listMembers } from "@/services/members";
import { TessellatePluginDatabaseRegistry } from "@/utils/registry/database/pluginDatabaseRegistry";
import { pluginEntry, type GatewayEntry } from "@/gateway/registry";

const logger = new Logger();

interface RegisteredRoute {
    pluginName: string;
    access: PluginApiAccess;
    method: PluginApiMethod;
    matcher: MatchFunction<Record<string, string>>;
    handler: PluginApiMountDefinition["handler"];
    permissions: PluginPermissionProvider;
    gateway?: GatewayEntry;
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

    // Member data is PII: a plugin without MEMBER_AUTH gets a rejected
    // promise, and a plugin only ever sees members its own login created.
    const requireMemberAuth = () => {
        if (!permissions.memberAuth) {
            throw new Error(
                `Plugin "${pluginName}" lacks the MEMBER_AUTH permission`,
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
        members: {
            get: async (memberId: string) => {
                requireMemberAuth();
                const member = await getMember(memberId);
                return member?.plugin === pluginName ? member : null;
            },
            find: async (query) => {
                requireMemberAuth();
                return listMembers({ ...query, plugin: pluginName });
            },
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
            access: mount.access ?? "staff",
            method: mount.method,
            matcher: match(mount.route),
            handler: mount.handler,
            permissions,
            gateway: mount.gateway
                ? pluginEntry(
                      pluginName,
                      {
                          route: mount.route,
                          method: mount.method,
                          gateway: mount.gateway,
                      },
                      this.dispatch,
                  )
                : undefined,
        });
    }

    public unregister(pluginName: string) {
        this.routes = this.routes.filter((r) => r.pluginName !== pluginName);
    }

    /**
     * Gateway entries of every loaded plugin mount that opted in.
     * @returns the entries, in registration order
     */
    public gatewayEntries(): GatewayEntry[] {
        return this.routes.flatMap((r) => (r.gateway ? [r.gateway] : []));
    }

    /** Serves staff routes at /plugins/:pluginName/*. */
    public dispatch: RequestHandler = (req, res, next) =>
        this.dispatchAccess("staff", req, res, next);

    /**
     * Serves member routes at /member/:pluginName/*. Mounted behind the
     * member surface, so `req.principal` is a member of this plugin or null.
     */
    public dispatchMember: RequestHandler = (req, res, next) => {
        const principal = req.principal;
        if (
            principal?.kind !== "member" ||
            principal.plugin !== req.params.pluginName
        ) {
            res.status(401).json({ message: "Unauthorized" });
            return;
        }
        return this.dispatchAccess("member", req, res, next);
    };

    private dispatchAccess: (
        access: PluginApiAccess,
        ...args: Parameters<RequestHandler>
    ) => Promise<void> = async (access, req, res, next) => {
        // The dispatcher is mounted at /plugins/:pluginName, so
        // req.params.pluginName tells us which plugin's routes to check.
        // This scopes API calls so a plugin can only hit its own mounts.
        const pluginName = req.params.pluginName;

        for (const route of this.routes) {
            if (route.pluginName !== pluginName) continue;
            if (route.access !== access) continue;
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
