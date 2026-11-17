import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
    PluginApiMethod,
    type PluginManifest,
    type PluginPermissionProvider,
} from "@tessellatepos/plugin-sdk";
import type { Principal } from "@tessellatepos/sdk";
import { loadUrlConfig, evaluateHost } from "@/config/urls";
import { surfaceCors } from "@/middleware/cors";
import { surfaceMiddleware, surfaceOf } from "@/middleware/surface";
import { createMemberRouter } from "@/members/memberRouter";
import { memberScope, MemberAuthError } from "@/auth/members/providers";
import { Plugin } from "@/plugin/plugin";
import { TessellatePluginApiRegistry } from "@/utils/registry/api/pluginApiRegistry";
import { TessellatePluginDatabaseRegistry } from "@/utils/registry/database/pluginDatabaseRegistry";
import { buildPluginServerContext } from "@/utils/registry/api/pluginApiRegistry";

const perms = (overrides: Partial<PluginPermissionProvider> = {}) => ({
    cart: false,
    catalog: false,
    checkout: false,
    device: false,
    order: false,
    customer: false,
    auth: false,
    memberAuth: false,
    payment: false,
    ...overrides,
});

const manifest = (name: string): PluginManifest => ({
    name,
    version: "0.0.3-alpha",
    main: "index.js",
    engines: { tessellate: "0.0.3-alpha" },
    tessellate: { permissions: [] },
});

const memberOf = (plugin: string): Principal => ({
    kind: "member",
    id: `m-${plugin}`,
    display_name: "Sam",
    roles: [],
    scopes: [memberScope(plugin)],
    location_ids: [],
    plugin,
});

const staff: Principal = {
    kind: "user",
    id: "u1",
    roles: ["owner"],
    scopes: ["*"],
    location_ids: "all",
};

describe("member surface classification", () => {
    it("tags /member paths, whatever the case", () => {
        assert.equal(surfaceOf("/member/tab/auth/me"), "member");
        assert.equal(surfaceOf("/MEMBER/tab"), "member");
        assert.equal(surfaceOf("/members/x"), "internal");
        assert.equal(surfaceOf("/api/v1/members"), "internal");
    });

    it("is reachable on the public host while the admin API is not", () => {
        const config = loadUrlConfig(
            { PUBLIC_URL: "https://club.example.test" },
            () => {},
        );
        assert.equal(
            evaluateHost("club.example.test", "/member/tab/auth/me", config),
            "ok",
        );
        assert.equal(
            evaluateHost("club.example.test", "/api/v1/members", config),
            "not-found",
        );
    });
});

describe("member surface CORS", () => {
    let server: Server;
    let base: string;
    before(async () => {
        const config = loadUrlConfig(
            { MEMBER_ORIGINS: "https://club.example.test" },
            () => {},
        );
        const app = express();
        app.use(surfaceMiddleware);
        app.use(surfaceCors(config));
        app.use((_req, res) => res.json({ ok: true }));
        server = await new Promise((resolve) => {
            const s = app.listen(0, "127.0.0.1", () => resolve(s));
        });
        base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });
    after(() => {
        server.closeAllConnections();
        server.close();
    });

    it("lets a configured member site call with credentials", async () => {
        const res = await fetch(`${base}/member/tab/auth/me`, {
            headers: { origin: "https://club.example.test" },
        });
        assert.equal(
            res.headers.get("access-control-allow-origin"),
            "https://club.example.test",
        );
        assert.equal(
            res.headers.get("access-control-allow-credentials"),
            "true",
        );
    });

    it("gives any other origin nothing", async () => {
        const res = await fetch(`${base}/member/tab/auth/me`, {
            headers: { origin: "https://evil.example.test" },
        });
        assert.equal(res.headers.get("access-control-allow-origin"), null);
    });

    it("does not extend the member origins to internal routes", async () => {
        const res = await fetch(`${base}/api/v1/orders`, {
            headers: { origin: "https://club.example.test" },
        });
        assert.equal(res.headers.get("access-control-allow-origin"), null);
    });
});

describe("plugin registration of member routes", () => {
    const route = (extra: object = {}) => ({
        route: "/tab",
        method: PluginApiMethod.GET,
        access: "member" as const,
        handler: () => ({ body: {} }),
        ...extra,
    });

    it("needs the MEMBER_AUTH permission", () => {
        const plugin = new Plugin(manifest("p"), perms());
        assert.throws(
            () => plugin.register("api", route()),
            (e) =>
                e instanceof MemberAuthError && /MEMBER_AUTH/.test(e.message),
        );
    });

    it("cannot also be on the gateway or shadow /auth", () => {
        const plugin = new Plugin(manifest("p"), perms({ memberAuth: true }));
        assert.throws(
            () =>
                plugin.register(
                    "api",
                    route({
                        gateway: {
                            operationId: "x.y",
                            scope: "plugin:p:read",
                            summary: "s",
                        },
                    }),
                ),
            /gateway/,
        );
        assert.throws(
            () => plugin.register("api", route({ route: "/auth/me" })),
            /reserved/,
        );
        assert.doesNotThrow(() => plugin.register("api", route()));
    });

    it("rejects an unknown access value and leaves staff routes alone", () => {
        const plugin = new Plugin(manifest("p"), perms());
        assert.throws(
            () => plugin.register("api", route({ access: "public" })),
            MemberAuthError,
        );
        assert.doesNotThrow(() =>
            plugin.register("api", route({ access: undefined })),
        );
    });

    it("keeps member data behind the permission", async () => {
        const ctx = buildPluginServerContext(
            "p",
            new TessellatePluginDatabaseRegistry(),
            null,
            perms(),
        );
        await assert.rejects(ctx.members.get("m"), /MEMBER_AUTH permission/);
        await assert.rejects(ctx.members.find({}), /MEMBER_AUTH permission/);
    });
});

describe("member routes", () => {
    let server: Server;
    let base: string;
    let principal: Principal | null = null;

    before(async () => {
        const registry = new TessellatePluginApiRegistry(
            new TessellatePluginDatabaseRegistry(),
        );
        const seen: (Principal | null)[] = [];
        registry.register(
            "tab",
            {
                route: "/balance",
                method: PluginApiMethod.GET,
                access: "member",
                handler: (_req, ctx) => {
                    seen.push(ctx.principal);
                    return { body: { who: ctx.principal?.id } };
                },
            },
            perms({ memberAuth: true }),
        );
        registry.register(
            "tab",
            {
                route: "/staff-only",
                method: PluginApiMethod.GET,
                handler: () => ({ body: { staff: true } }),
            },
            perms({ memberAuth: true }),
        );
        const app = express();
        app.use((req, _res, next) => {
            req.principal = principal;
            next();
        });
        app.use(
            "/member/:pluginName",
            createMemberRouter({
                pluginApi: registry,
                limiter: async () => true,
            }),
        );
        app.use("/plugins/:pluginName", (req, res, next) => {
            if (!req.principal) {
                res.status(401).end();
                return;
            }
            registry.dispatch(req, res, next);
        });
        app.use((_req, res) => res.status(404).json({ fell: "through" }));
        server = await new Promise((resolve) => {
            const s = app.listen(0, "127.0.0.1", () => resolve(s));
        });
        base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });
    after(() => {
        server.closeAllConnections();
        server.close();
    });

    const get = async (path: string, as: Principal | null) => {
        principal = as;
        return fetch(base + path);
    };

    it("serves a member of the plugin", async () => {
        const res = await get("/member/tab/balance", memberOf("tab"));
        assert.equal(res.status, 200);
        assert.deepEqual(await res.json(), { who: "m-tab" });
    });

    it("refuses no principal, staff, and a member of another plugin", async () => {
        for (const as of [null, staff, memberOf("other")]) {
            const res = await get("/member/tab/balance", as);
            assert.equal(res.status, 401, JSON.stringify(as?.kind));
        }
    });

    it("never serves a staff route on the member surface, or the reverse", async () => {
        assert.equal(
            (await get("/member/tab/staff-only", memberOf("tab"))).status,
            404,
        );
        // A member route is not reachable at the staff path either.
        assert.equal((await get("/plugins/tab/balance", staff)).status, 404);
        assert.equal((await get("/plugins/tab/staff-only", staff)).status, 200);
    });

    it("answers /auth/me from the session and keeps /auth for the host", async () => {
        const me = await get("/member/tab/auth/me", memberOf("tab"));
        assert.equal(me.status, 200);
        assert.deepEqual(await me.json(), {
            id: "m-tab",
            display_name: "Sam",
            plugin: "tab",
        });
        assert.equal((await get("/member/tab/auth/me", staff)).status, 401);
        assert.equal((await get("/member/tab/auth/me", null)).status, 401);
        assert.equal(
            (await get("/member/tab/auth/whatever", memberOf("tab"))).status,
            404,
        );
    });
});
