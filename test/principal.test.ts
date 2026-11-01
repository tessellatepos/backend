import { after, afterEach, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Request } from "express";
import type { Principal } from "@tessellatepos/sdk";
import { pool } from "@/services/db/postgres";
import { createAuth } from "@/services/auth";
import { registerPrincipalResolver } from "@/auth/principal";
import { requireLocation, requireScope } from "@/middleware/authenticate";
import { startTestApp, type TestApp } from "./helpers/app";
import { migrateTestDb } from "./helpers/db";

const suffix = randomUUID().slice(0, 8);
const PASSWORD = "correct-horse-battery";

const credential: Principal = {
    kind: "credential",
    id: "cred-1",
    roles: [],
    scopes: ["catalog:read", "plugin:acme:sync"],
    location_ids: ["L1"],
};

async function signIn(email: string) {
    const { headers } = await createAuth().api.signInEmail({
        body: { email, password: PASSWORD },
        returnHeaders: true,
    });
    const cookie = (headers.get("set-cookie") ?? "").split(";")[0];
    const token = headers.get("set-auth-token") ?? "";
    return { cookie, token };
}

describe("principal resolution and guards", () => {
    let server: TestApp;
    const unregister: (() => void)[] = [];
    const sessions: Record<string, { cookie: string; token: string }> = {};

    before(async () => {
        await migrateTestDb();
        const auth = createAuth();
        for (const role of ["owner", "viewer", "banned"] as const) {
            const email = `${role}-${suffix}@example.test`;
            const { user } = await auth.api.createUser({
                body: {
                    email,
                    password: PASSWORD,
                    name: `${role} user`,
                    role: role === "banned" ? "owner" : role,
                },
            });
            sessions[role] = await signIn(email);
            if (role === "banned") {
                await pool.query(
                    `UPDATE "tessellate-auth-user" SET banned = true WHERE id = $1`,
                    [user.id],
                );
            }
        }
        server = await startTestApp((app) => {
            app.get("/me", (req, res) => {
                res.json(req.principal);
            });
            app.get("/orders", requireScope("orders:write"), (_req, res) => {
                res.json({ ok: true });
            });
            app.get(
                "/either",
                requireScope("orders:write", "catalog:read"),
                (_req, res) => {
                    res.json({ ok: true });
                },
            );
            app.get(
                "/plugin",
                requireScope("plugin:acme:sync"),
                (_req, res) => {
                    res.json({ ok: true });
                },
            );
            app.get(
                "/gateway/orders",
                requireScope("catalog:read"),
                (_req, res) => {
                    res.json({ ok: true });
                },
            );
            app.get(
                "/loc/:id",
                requireScope("catalog:read"),
                requireLocation((req) => String(req.params.id)),
                (_req, res) => {
                    res.json({ ok: true });
                },
            );
        });
    });

    afterEach(() => {
        unregister.splice(0).forEach((fn) => fn());
    });

    after(async () => {
        await server.close();
        await pool.query(
            `DELETE FROM "tessellate-auth-user" WHERE email LIKE $1`,
            [`%-${suffix}@example.test`],
        );
        await pool.end();
    });

    const get = (path: string, headers: Record<string, string> = {}) =>
        fetch(server.url + path, { headers });

    it("is unauthenticated (null principal) without credentials", async () => {
        const res = await get("/me");
        assert.equal(res.status, 200);
        assert.equal(await res.json(), null);
    });

    it("resolves a session cookie to a user principal", async () => {
        const res = await get("/me", { cookie: sessions.viewer.cookie });
        const p = (await res.json()) as Principal;
        assert.equal(p.kind, "user");
        assert.deepEqual(p.roles, ["viewer"]);
        assert.equal(p.location_ids, "all");
        assert.equal(p.display_name, "viewer user");
        assert.ok(p.scopes.includes("catalog:read"));
        assert.ok(!p.scopes.includes("orders:write"));
    });

    it("resolves a bearer token to the same user as the cookie", async () => {
        const viaCookie = await get("/me", { cookie: sessions.owner.cookie });
        const viaBearer = await get("/me", {
            authorization: `Bearer ${sessions.owner.token}`,
        });
        const a = (await viaCookie.json()) as Principal;
        const b = (await viaBearer.json()) as Principal;
        assert.equal(a.id, b.id);
        assert.deepEqual(b.scopes, ["*"]);
    });

    it("resolves a banned user to null", async () => {
        const res = await get("/me", { cookie: sessions.banned.cookie });
        assert.equal(await res.json(), null);
    });

    it("ignores a garbage bearer token", async () => {
        const res = await get("/me", { authorization: "Bearer nonsense" });
        assert.equal(await res.json(), null);
    });

    it("requireScope: 401 without a principal", async () => {
        const res = await get("/orders");
        assert.equal(res.status, 401);
        assert.deepEqual(await res.json(), { message: "Unauthorized" });
    });

    it("requireScope: 403 when the scope is missing, 200 when held", async () => {
        const viewer = await get("/orders", {
            cookie: sessions.viewer.cookie,
        });
        assert.equal(viewer.status, 403);
        assert.deepEqual(await viewer.json(), { message: "Forbidden" });
        const either = await get("/either", {
            cookie: sessions.viewer.cookie,
        });
        assert.equal(either.status, 200);
    });

    it("requireScope: '*' satisfies everything, including plugin scopes", async () => {
        const o = { cookie: sessions.owner.cookie };
        assert.equal((await get("/orders", o)).status, 200);
        assert.equal((await get("/plugin", o)).status, 200);
    });

    it("requireScope: plugin scopes need that exact scope", async () => {
        const v = { cookie: sessions.viewer.cookie };
        assert.equal((await get("/plugin", v)).status, 403);
        unregister.push(
            registerPrincipalResolver("service", async () => ({
                ...credential,
                kind: "service",
                scopes: ["plugin:acme:other"],
            })),
        );
        assert.equal((await get("/plugin")).status, 403);
    });

    it("requireLocation restricts by location_ids", async () => {
        assert.equal((await get("/loc/L9")).status, 401);
        const o = { cookie: sessions.owner.cookie };
        assert.equal((await get("/loc/L9", o)).status, 200);
        unregister.push(
            registerPrincipalResolver("service", async () => ({
                ...credential,
                kind: "service",
            })),
        );
        assert.equal((await get("/loc/L1")).status, 200);
        assert.equal((await get("/loc/L2")).status, 403);
    });

    it("gateway surface only runs credential resolvers", async () => {
        const seen: string[] = [];
        const sessionHeaders = { cookie: sessions.owner.cookie };
        assert.equal(
            (await get("/gateway/orders", sessionHeaders)).status,
            401,
        );
        unregister.push(
            registerPrincipalResolver("credential", async (req: Request) => {
                seen.push(req.surface);
                return credential;
            }),
        );
        assert.equal(
            (await get("/gateway/orders", sessionHeaders)).status,
            200,
        );
        assert.deepEqual(seen, ["gateway"]);
    });

    it("internal surface never runs credential resolvers", async () => {
        let called = false;
        unregister.push(
            registerPrincipalResolver("credential", async () => {
                called = true;
                return credential;
            }),
        );
        assert.equal(await (await get("/me")).json(), null);
        assert.equal(called, false);
    });

    it("runs extra resolvers after sessions, first match wins", async () => {
        unregister.push(
            registerPrincipalResolver("service", async () => ({
                kind: "service",
                id: "svc",
                roles: [],
                scopes: [],
                location_ids: "all",
            })),
        );
        const withSession = (await (
            await get("/me", { cookie: sessions.owner.cookie })
        ).json()) as Principal;
        assert.equal(withSession.kind, "user");
        const without = (await (await get("/me")).json()) as Principal;
        assert.equal(without.kind, "service");
    });

    it("a throwing resolver authenticates nobody", async () => {
        unregister.push(
            registerPrincipalResolver("service", async () => {
                throw new Error("boom");
            }),
        );
        assert.equal(await (await get("/me")).json(), null);
    });
});
