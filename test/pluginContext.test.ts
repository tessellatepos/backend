import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Request, Response } from "express";
import type { Principal } from "@tessellatepos/sdk";
import { TessellatePluginApiRegistry } from "@/utils/registry/api/pluginApiRegistry";
import type { TessellatePluginDatabaseRegistry } from "@/utils/registry/database/pluginDatabaseRegistry";

const noPermissions = {
    cart: false,
    catalog: false,
    checkout: false,
    device: false,
    order: false,
    auth: false,
    customer: false,
};

const databases = {
    getRepository: () => ({}),
} as unknown as TessellatePluginDatabaseRegistry;

async function dispatch(principal: Principal | null) {
    const registry = new TessellatePluginApiRegistry(databases);
    registry.register(
        "acme",
        {
            method: "GET",
            route: "/who",
            handler: async (_req, ctx) => ({
                body: { principal: ctx.principal },
            }),
        },
        noPermissions,
    );
    let body: unknown;
    const res = {
        status: () => res,
        json: (b: unknown) => {
            body = b;
        },
    } as unknown as Response;
    await registry.dispatch(
        {
            params: { pluginName: "acme" },
            method: "GET",
            path: "/who",
            query: {},
            body: {},
            principal,
        } as unknown as Request,
        res,
        () => assert.fail("route should match"),
    );
    return body;
}

describe("plugin server context", () => {
    it("passes the request principal to handlers", async () => {
        const principal: Principal = {
            kind: "user",
            id: "u1",
            roles: ["cashier"],
            scopes: ["orders:read"],
            location_ids: "all",
        };
        assert.deepEqual(await dispatch(principal), { principal });
    });

    it("passes null when the request is unauthenticated", async () => {
        assert.deepEqual(await dispatch(null), { principal: null });
    });
});
