import type { RequestHandler } from "express";
import type {
    GatewayMethod,
    GatewayOperation,
} from "@tessellatepos/plugin-sdk";
import type { Scope } from "@tessellatepos/sdk";

/** Where every gateway route lives. */
export const GATEWAY_PREFIX = "/gateway/v1";

/** Prefix the plugin-owned gateway routes live under. */
export const GATEWAY_PLUGIN_PREFIX = `${GATEWAY_PREFIX}/plugins`;

/**
 * A core operation: the public descriptor plus how it reaches the internal
 * route it wraps. `internalPath` defaults to `path`; `toInternal` maps the
 * validated request body to the internal body and defaults to identity.
 */
export interface CoreGatewayOperation extends GatewayOperation {
    internalPath?: string;
    toInternal?: (input: unknown) => unknown;
}

/** Who declared an operation. */
export type GatewayOwner = { kind: "core" } | { kind: "plugin"; name: string };

/**
 * One operation, resolved to what serves it. The gateway calls `handle` with
 * a request whose url is `invokeTemplate` with the route parameters filled
 * in: the internal router for a core operation, the plugin dispatcher for a
 * plugin one.
 */
export interface GatewayEntry {
    owner: GatewayOwner;
    operation: GatewayOperation;
    /** Public path under /gateway/v1, with `:params`. */
    publicPath: string;
    /** The internal path, as the handler matches it (relative to `handle`). */
    invokeTemplate: string;
    /** Fixed route parameters the handler needs, e.g. the plugin name. */
    invokeParams: Record<string, string>;
    handle: RequestHandler;
    toInternal?: (input: unknown) => unknown;
}

/**
 * Joins path segments into one normalised path: single slashes, no trailing
 * slash except at the root.
 * @param parts the segments, each may start or end with "/"
 * @returns the joined path
 */
export function joinPath(...parts: string[]): string {
    const joined = parts.join("/").replace(/\/{2,}/g, "/");
    const trimmed = joined.length > 1 ? joined.replace(/\/$/, "") : joined;
    return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

const METHODS: readonly GatewayMethod[] = [
    "GET",
    "POST",
    "PUT",
    "PATCH",
    "DELETE",
];

/**
 * Holds every declared gateway operation. Deny by default: a route that is
 * not registered here is not reachable through the gateway.
 */
export class GatewayRegistry {
    private readonly entries: GatewayEntry[] = [];

    /**
     * Adds an operation. Throws on an invalid descriptor so a bad declaration
     * fails at startup rather than being quietly missing.
     * @param entry the operation and its resolved paths
     */
    add(entry: GatewayEntry): void {
        const { operation } = entry;
        if (!METHODS.includes(operation.method)) {
            throw new Error(`Unsupported gateway method "${operation.method}"`);
        }
        if (!operation.path.startsWith("/")) {
            throw new Error(
                `Gateway path "${operation.path}" must start with "/"`,
            );
        }
        if (
            this.entries.some(
                (e) => e.operation.operationId === operation.operationId,
            )
        ) {
            throw new Error(
                `Duplicate gateway operationId "${operation.operationId}"`,
            );
        }
        if (
            this.entries.some(
                (e) =>
                    e.publicPath === entry.publicPath &&
                    e.operation.method === operation.method,
            )
        ) {
            throw new Error(
                `Duplicate gateway route ${operation.method} ${entry.publicPath}`,
            );
        }
        checkScopeOwner(operation.scope, operation.operationId, entry.owner);
        this.entries.push(entry);
    }

    /**
     * Every declared operation, in registration order.
     * @returns a read-only view
     */
    list(): readonly GatewayEntry[] {
        return this.entries;
    }

    /**
     * Finds the operation served at a method and public path.
     * @param method the HTTP method
     * @param publicPath the request path, without the query string
     * @returns the entry, or undefined when none is declared
     */
    find(method: string, publicPath: string): GatewayEntry | undefined {
        const path = joinPath(publicPath);
        return this.entries.find(
            (e) => e.operation.method === method && e.publicPath === path,
        );
    }
}

/**
 * Core operations may use only core scopes; plugin operations only their own
 * `plugin:<name>:<verb>` scopes, and their ids start with `<name>.`.
 * @param scope the operation's scope
 * @param operationId the operation id
 * @param owner who declared it
 */
function checkScopeOwner(
    scope: Scope,
    operationId: string,
    owner: GatewayOwner,
): void {
    if (owner.kind === "core") {
        if (scope.startsWith("plugin:")) {
            throw new Error(
                `Core operation "${operationId}" cannot use plugin scope "${scope}"`,
            );
        }
        return;
    }
    if (!scope.startsWith(`plugin:${owner.name}:`)) {
        throw new Error(
            `Plugin "${owner.name}" operation "${operationId}" must use a "plugin:${owner.name}:<verb>" scope`,
        );
    }
    if (!operationId.startsWith(`${owner.name}.`)) {
        throw new Error(
            `Plugin "${owner.name}" operation id must start with "${owner.name}."`,
        );
    }
}

/**
 * Builds the core registry entries for one internal router.
 * @param router the router's mount facts and handler
 * @param router.route_path the path the router is mounted at
 * @param router.version the API version, e.g. "v1"
 * @param router.override_default true when mounted without the /api prefix
 * @param router.gateway the router's declared operations
 * @param router.router the router itself
 * @returns the entries, ready for {@link GatewayRegistry.add}
 */
export function coreEntries(router: {
    route_path: string;
    version: string;
    override_default?: boolean;
    gateway?: CoreGatewayOperation[];
    router: unknown;
}): GatewayEntry[] {
    return (router.gateway ?? []).map((operation) => ({
        owner: { kind: "core" },
        operation,
        publicPath: joinPath(GATEWAY_PREFIX, router.route_path, operation.path),
        invokeTemplate: operation.internalPath ?? operation.path,
        invokeParams: {},
        handle: router.router as RequestHandler,
        toInternal: operation.toInternal,
    }));
}

/**
 * Builds the entry for one plugin mount that declared a gateway descriptor.
 * @param pluginName the plugin's name
 * @param mount the mount's method, route and gateway descriptor
 * @param mount.route the plugin route
 * @param mount.method the HTTP method
 * @param mount.gateway the descriptor without method and path
 * @param dispatch the plugin dispatcher that serves `/plugins/<name>/*`
 * @returns the entry
 */
export function pluginEntry(
    pluginName: string,
    mount: {
        route: string;
        method: GatewayMethod;
        gateway: Omit<GatewayOperation, "method" | "path">;
    },
    dispatch: RequestHandler,
): GatewayEntry {
    return {
        owner: { kind: "plugin", name: pluginName },
        operation: {
            ...mount.gateway,
            method: mount.method,
            path: mount.route,
        },
        publicPath: joinPath(GATEWAY_PLUGIN_PREFIX, pluginName, mount.route),
        invokeTemplate: mount.route,
        invokeParams: { pluginName },
        handle: dispatch,
    };
}

/**
 * Builds the registry from every internal router and every loaded plugin
 * mount. Throws if any declaration is invalid or duplicated.
 * @param routers the internal routers (routes.ts)
 * @param pluginEntries entries from the plugin API registry
 * @returns the populated registry
 */
export function buildGatewayRegistry(
    routers: readonly Parameters<typeof coreEntries>[0][],
    pluginEntries: readonly GatewayEntry[] = [],
): GatewayRegistry {
    const registry = new GatewayRegistry();
    for (const router of routers) {
        for (const entry of coreEntries(router)) registry.add(entry);
    }
    for (const entry of pluginEntries) registry.add(entry);
    return registry;
}
