import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import type { PluginPermissionProvider } from "@tessellatepos/plugin-sdk";
import { routes } from "@/utils/registry/api/routes";
import { TessellatePluginApiRegistry } from "@/utils/registry/api/pluginApiRegistry";
import { TessellatePluginDatabaseRegistry } from "@/utils/registry/database/pluginDatabaseRegistry";
import {
    buildGatewayRegistry,
    coreEntries,
    GatewayRegistry,
    pluginEntry,
    type GatewayEntry,
} from "./registry";

const response = z.object({});
const op = (
    operationId: string,
    extra: Partial<GatewayEntry["operation"]> = {},
): GatewayEntry => ({
    owner: { kind: "core" },
    operation: {
        method: "GET",
        path: "/",
        operationId,
        scope: "catalog:read",
        summary: "test",
        location: "none",
        response,
        ...extra,
    },
    publicPath: "/gateway/v1/x",
    invokeTemplate: "/x",
    invokeParams: {},
    handle: (() => undefined) as never,
});

describe("gateway registry", () => {
    it("rejects a duplicate operationId", () => {
        const registry = new GatewayRegistry();
        registry.add(op("items.list"));
        assert.throws(
            () =>
                registry.add({
                    ...op("items.list"),
                    publicPath: "/gateway/v1/y",
                }),
            /Duplicate gateway operationId "items.list"/,
        );
    });

    it("rejects two operations on the same method and path", () => {
        const registry = new GatewayRegistry();
        registry.add(op("a.one"));
        assert.throws(
            () => registry.add(op("a.two")),
            /Duplicate gateway route GET \/gateway\/v1\/x/,
        );
    });

    it("keeps a core operation off plugin scopes", () => {
        const registry = new GatewayRegistry();
        assert.throws(
            () =>
                registry.add(op("core.bad", { scope: "plugin:loyalty:read" })),
            /cannot use plugin scope/,
        );
    });

    it("requires plugin operations to use their own scope and id prefix", () => {
        const owner = { kind: "plugin" as const, name: "loyalty" };
        const registry = new GatewayRegistry();
        const base = op("loyalty.points", {
            scope: "plugin:loyalty:read",
        });
        registry.add({ ...base, owner });
        assert.throws(
            () =>
                registry.add({
                    ...op("loyalty.other", { scope: "orders:read" }),
                    owner,
                    publicPath: "/gateway/v1/z",
                }),
            /must use a "plugin:loyalty:<verb>" scope/,
        );
        assert.throws(
            () =>
                registry.add({
                    ...op("points", { scope: "plugin:loyalty:read" }),
                    owner,
                    publicPath: "/gateway/v1/w",
                }),
            /must start with "loyalty."/,
        );
    });

    it("rejects a path without a leading slash and an unknown method", () => {
        const registry = new GatewayRegistry();
        assert.throws(
            () => registry.add(op("a.path", { path: "items" })),
            /must start with "\/"/,
        );
        assert.throws(
            () => registry.add(op("a.method", { method: "TRACE" as never })),
            /Unsupported gateway method/,
        );
    });

    it("maps a router's operations to public and internal paths", () => {
        const [entry] = coreEntries({
            route_path: "/items",
            version: "v1",
            router: (() => undefined) as never,
            gateway: [
                {
                    method: "GET",
                    path: "/",
                    internalPath: "/by-location/",
                    operationId: "items.list",
                    scope: "catalog:read",
                    summary: "list",
                    location: "none",
                    response,
                },
            ],
        });
        assert.equal(entry.publicPath, "/gateway/v1/items");
        assert.equal(entry.invokeTemplate, "/by-location/");
    });

    it("keeps an override_default router at its own mount", () => {
        const [entry] = coreEntries({
            route_path: "/auth/special",
            version: "v1",
            override_default: true,
            router: (() => undefined) as never,
            gateway: [
                {
                    method: "GET",
                    path: "/ping",
                    operationId: "special.ping",
                    scope: "catalog:read",
                    summary: "ping",
                    location: "none",
                    response,
                },
            ],
        });
        assert.equal(entry.invokeTemplate, "/ping");
    });
});

describe("gateway registry from the real routers", () => {
    const registry = buildGatewayRegistry(routes);

    it("declares the core operations", () => {
        const ids = registry.list().map((e) => e.operation.operationId);
        for (const id of [
            "items.list",
            "items.listAtLocation",
            "locations.list",
            "locations.get",
            "orders.create",
            "orders.get",
            "customers.list",
            "customers.get",
            "customers.create",
            "customers.update",
        ]) {
            assert.ok(ids.includes(id), id);
        }
    });

    it("serves catalog items at /gateway/v1/items", () => {
        const entry = registry.find("GET", "/gateway/v1/items");
        assert.equal(entry?.operation.operationId, "items.list");
        assert.equal(entry?.operation.scope, "catalog:read");
    });

    it("exposes no route that has no descriptor (deny by default)", () => {
        // Internal routes that must never be reachable through the gateway.
        for (const [method, path] of [
            ["GET", "/gateway/v1/items/update"],
            ["GET", "/gateway/v1/items/update/"],
            ["GET", "/gateway/v1/items/by-device-id/abc"],
            ["POST", "/gateway/v1/orders/abc/pay-cash"],
            ["GET", "/gateway/v1/config/settings"],
            ["GET", "/gateway/v1/setup/status"],
            ["POST", "/gateway/v1/customers/abc/export"],
            ["GET", "/gateway/v1/customers/abc/orders"],
        ]) {
            assert.equal(
                registry.find(method, path),
                undefined,
                `${method} ${path}`,
            );
        }
    });

    it("does not treat a trailing slash as a different route", () => {
        assert.ok(registry.find("GET", "/gateway/v1/locations/"));
    });
});

describe("plugin gateway declarations", () => {
    const none: PluginPermissionProvider = {
        cart: false,
        catalog: false,
        checkout: false,
        device: false,
        order: false,
        customer: false,
        auth: false,
    };

    it("builds the public path from the plugin name and route", () => {
        const entry = pluginEntry(
            "loyalty",
            {
                route: "/points/:customerId",
                method: "GET" as never,
                gateway: {
                    operationId: "loyalty.points",
                    scope: "plugin:loyalty:read",
                    summary: "points",
                    location: "none",
                    response,
                },
            },
            (() => undefined) as never,
        );
        assert.equal(
            entry.publicPath,
            "/gateway/v1/plugins/loyalty/points/:customerId",
        );
        assert.equal(entry.invokeTemplate, "/points/:customerId");
    });

    it("collects only the mounts that opted in", () => {
        const api = new TessellatePluginApiRegistry(
            new TessellatePluginDatabaseRegistry(),
        );
        api.register(
            "loyalty",
            {
                route: "/points",
                method: "GET" as never,
                handler: () => ({ body: {} }),
                gateway: {
                    operationId: "loyalty.points",
                    scope: "plugin:loyalty:read",
                    summary: "points",
                    location: "none",
                    response,
                },
            },
            none,
        );
        api.register(
            "loyalty",
            {
                route: "/internal",
                method: "GET" as never,
                handler: () => ({ body: {} }),
            },
            none,
        );
        const entries = api.gatewayEntries();
        assert.deepEqual(
            entries.map((e) => e.publicPath),
            ["/gateway/v1/plugins/loyalty/points"],
        );
        const full = buildGatewayRegistry(routes, entries);
        assert.ok(full.find("GET", "/gateway/v1/plugins/loyalty/points"));
        assert.equal(
            full.find("GET", "/gateway/v1/plugins/loyalty/internal"),
            undefined,
        );
    });

    it("refuses a plugin operation id outside its own namespace", () => {
        const api = new TessellatePluginApiRegistry(
            new TessellatePluginDatabaseRegistry(),
        );
        api.register(
            "loyalty",
            {
                route: "/points",
                method: "GET" as never,
                handler: () => ({ body: {} }),
                gateway: {
                    operationId: "catalog.list",
                    scope: "plugin:loyalty:read",
                    summary: "points",
                    location: "none",
                    response,
                },
            },
            none,
        );
        assert.throws(
            () => buildGatewayRegistry(routes, api.gatewayEntries()),
            /must start with "loyalty."/,
        );
    });
});
