import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pool } from "@/services/db/postgres";
import { createAuth } from "@/services/auth";
import { registerPrincipalResolver } from "@/auth/principal";
import { usersv1Endpoint } from "@/endpoints/v1/users";
import { startTestApp, type TestApp } from "./helpers/app";
import { migrateTestDb } from "./helpers/db";

const suffix = randomUUID().slice(0, 8);
const PASSWORD = "correct-horse-battery";
const NEW_PASSWORD = "another-long-password";

async function signIn(email: string, password = PASSWORD) {
    const { headers } = await createAuth().api.signInEmail({
        body: { email, password },
        returnHeaders: true,
    });
    return (headers.get("set-cookie") ?? "").split(";")[0];
}

describe("users API", () => {
    let server: TestApp;
    let unregister: () => void;
    let ownerCookie: string;
    let ownerId: string;
    let managerCookie: string;

    before(async () => {
        await migrateTestDb();
        // Owner counting needs a table with no other owners in it.
        await pool.query(`TRUNCATE "tessellate-auth-user" CASCADE`);
        const auth = createAuth();
        const mk = async (role: string) => {
            const email = `${role}-${suffix}@example.test`;
            const { user } = await auth.api.createUser({
                body: {
                    email,
                    password: PASSWORD,
                    name: role,
                    role: role as "owner",
                    data: { username: `${role}${suffix}` },
                },
            });
            return { id: user.id, cookie: await signIn(email) };
        };
        const owner = await mk("owner");
        ownerId = owner.id;
        ownerCookie = owner.cookie;
        managerCookie = (await mk("manager")).cookie;
        // A service principal that is not a user, so it can act on the last owner.
        unregister = registerPrincipalResolver("service", async (req) =>
            req.headers["x-service"] === "1"
                ? {
                      kind: "service",
                      id: "svc",
                      roles: [],
                      scopes: ["users:admin"],
                      location_ids: "all",
                  }
                : null,
        );
        server = await startTestApp((app) => {
            app.use("/api/v1/users", usersv1Endpoint.router);
        });
    });

    after(async () => {
        unregister();
        await server.close();
        await pool.query(
            `DELETE FROM "tessellate-auth-user" WHERE email LIKE $1`,
            [`%${suffix}@example.test`],
        );
        await pool.end();
    });

    async function call(
        method: string,
        path: string,
        opts: { cookie?: string; body?: unknown; service?: boolean } = {},
    ) {
        const res = await fetch(`${server.url}/api/v1/users${path}`, {
            method,
            headers: {
                "content-type": "application/json",
                ...(opts.cookie ? { cookie: opts.cookie } : {}),
                ...(opts.service ? { "x-service": "1" } : {}),
            },
            body:
                opts.body === undefined ? undefined : JSON.stringify(opts.body),
        });
        const text = await res.text();
        return {
            status: res.status,
            text,
            body: text ? JSON.parse(text) : undefined,
        };
    }

    const newUser = (name: string, extra: Record<string, unknown> = {}) => ({
        name,
        username: `${name}${suffix}`,
        email: `${name}-${suffix}@example.test`,
        password: PASSWORD,
        role: "cashier",
        ...extra,
    });

    it("needs users:admin", async () => {
        assert.equal((await call("GET", "/")).status, 401);
        assert.equal(
            (await call("GET", "/", { cookie: managerCookie })).status,
            403,
        );
        assert.equal(
            (
                await call("POST", "/", {
                    cookie: managerCookie,
                    body: newUser("x"),
                })
            ).status,
            403,
        );
        assert.equal(
            (await call("PATCH", "/x", { cookie: managerCookie, body: {} }))
                .status,
            403,
        );
        assert.equal(
            (
                await call("POST", "/x/password", {
                    cookie: managerCookie,
                    body: {},
                })
            ).status,
            403,
        );
    });

    it("creates a user who can sign in, without leaking secrets", async () => {
        const res = await call("POST", "/", {
            cookie: ownerCookie,
            body: newUser("ada"),
        });
        assert.equal(res.status, 201);
        assert.deepEqual(Object.keys(res.body).sort(), [
            "banned",
            "created_at",
            "email",
            "id",
            "name",
            "role",
            "username",
        ]);
        assert.equal(res.body.role, "cashier");
        assert.equal(res.body.banned, false);
        assert.ok(!res.text.includes(PASSWORD));
        assert.ok(await signIn(`ada-${suffix}@example.test`));
    });

    it("rejects invalid input", async () => {
        const bad: Record<string, unknown>[] = [
            newUser("b1", { role: "owner" }),
            newUser("b2", { role: "admin" }),
            newUser("b3", { password: "short" }),
            newUser("b4", { email: "not-an-email" }),
            newUser("b5", { username: "a b" }),
            newUser("b6", { name: "" }),
        ];
        for (const body of bad) {
            const res = await call("POST", "/", { cookie: ownerCookie, body });
            assert.equal(
                res.status,
                400,
                JSON.stringify(body.role) + body.name,
            );
            assert.equal(typeof res.body.message, "string");
            assert.ok(!res.text.includes(PASSWORD));
        }
    });

    it("answers 409 USER_EXISTS for a duplicate email or username", async () => {
        const dupEmail = await call("POST", "/", {
            cookie: ownerCookie,
            body: newUser("other", { email: `ADA-${suffix}@example.test` }),
        });
        assert.equal(dupEmail.status, 409);
        assert.equal(dupEmail.body.code, "USER_EXISTS");
        const dupName = await call("POST", "/", {
            cookie: ownerCookie,
            body: newUser("other2", { username: `ada${suffix}`.toUpperCase() }),
        });
        assert.equal(dupName.status, 409);
        assert.equal(dupName.body.code, "USER_EXISTS");
    });

    it("lists users in pages with a cursor", async () => {
        for (const n of ["p1", "p2", "p3"]) {
            await call("POST", "/", {
                cookie: ownerCookie,
                body: newUser(n, { role: "viewer" }),
            });
        }
        const seen: string[] = [];
        let cursor: string | null = null;
        let pages = 0;
        do {
            const q: string = `?limit=2${cursor ? `&cursor=${cursor}` : ""}`;
            const res = await call("GET", q, { cookie: ownerCookie });
            assert.equal(res.status, 200);
            assert.ok(res.body.users.length <= 2);
            seen.push(...res.body.users.map((u: { id: string }) => u.id));
            cursor = res.body.next_cursor;
            pages++;
            assert.ok(!res.text.includes("password"));
        } while (cursor);
        assert.ok(pages >= 3);
        assert.equal(new Set(seen).size, seen.length);
        assert.ok(seen.includes(ownerId));
        assert.equal(
            (await call("GET", "/?limit=0", { cookie: ownerCookie })).status,
            400,
        );
        assert.equal(
            (await call("GET", "/?cursor=zzz", { cookie: ownerCookie })).status,
            400,
        );
    });

    it("changes role, name and banned; a banned user is locked out", async () => {
        const created = (
            await call("POST", "/", {
                cookie: ownerCookie,
                body: newUser("bo"),
            })
        ).body;
        const email = `bo-${suffix}@example.test`;
        const cookie = await signIn(email);

        const role = await call("PATCH", `/${created.id}`, {
            cookie: ownerCookie,
            body: { role: "manager", name: "Bo B" },
        });
        assert.equal(role.status, 200);
        assert.equal(role.body.role, "manager");
        assert.equal(role.body.name, "Bo B");

        assert.equal((await call("GET", "/", { cookie })).status, 403);
        const ban = await call("PATCH", `/${created.id}`, {
            cookie: ownerCookie,
            body: { banned: true },
        });
        assert.equal(ban.status, 200);
        assert.equal(ban.body.banned, true);
        assert.equal((await call("GET", "/", { cookie })).status, 401);
        await assert.rejects(signIn(email));

        const unban = await call("PATCH", `/${created.id}`, {
            cookie: ownerCookie,
            body: { banned: false },
        });
        assert.equal(unban.body.banned, false);
        assert.ok(await signIn(email));
    });

    it("validates PATCH bodies and unknown ids", async () => {
        const id = ownerId;
        for (const body of [
            {},
            { role: "root" },
            { banned: "yes" },
            { name: " " },
        ]) {
            const res = await call("PATCH", `/${id}`, {
                cookie: ownerCookie,
                body,
            });
            assert.equal(res.status, 400, JSON.stringify(body));
        }
        const missing = await call("PATCH", "/nope", {
            cookie: ownerCookie,
            body: { name: "x" },
        });
        assert.equal(missing.status, 404);
        assert.equal(
            (
                await call("POST", "/nope/password", {
                    cookie: ownerCookie,
                    body: { password: NEW_PASSWORD },
                })
            ).status,
            404,
        );
    });

    it("refuses self role changes and self bans with SELF_CHANGE", async () => {
        for (const body of [{ role: "viewer" }, { banned: true }]) {
            const res = await call("PATCH", `/${ownerId}`, {
                cookie: ownerCookie,
                body,
            });
            assert.equal(res.status, 409);
            assert.equal(res.body.code, "SELF_CHANGE");
        }
        // renaming yourself, or "changing" to the role you hold, is fine
        assert.equal(
            (
                await call("PATCH", `/${ownerId}`, {
                    cookie: ownerCookie,
                    body: { name: "Boss", role: "owner" },
                })
            ).status,
            200,
        );
    });

    it("protects the last owner and lets an owner promote another", async () => {
        const second = (
            await call("POST", "/", {
                cookie: ownerCookie,
                body: newUser("o2", { role: "viewer" }),
            })
        ).body;
        // only the original owner is an owner: nobody but a non-user actor can touch them
        for (const body of [{ role: "manager" }, { banned: true }]) {
            const res = await call("PATCH", `/${ownerId}`, {
                service: true,
                body,
            });
            assert.equal(res.status, 409);
            assert.equal(res.body.code, "LAST_OWNER");
        }
        const promoted = await call("PATCH", `/${second.id}`, {
            cookie: ownerCookie,
            body: { role: "owner" },
        });
        assert.equal(promoted.status, 200);
        assert.equal(promoted.body.role, "owner");

        // two owners: demoting one is allowed, then the remaining one is protected
        const demoted = await call("PATCH", `/${ownerId}`, {
            service: true,
            body: { role: "manager" },
        });
        assert.equal(demoted.status, 200);
        const last = await call("PATCH", `/${second.id}`, {
            service: true,
            body: { banned: true },
        });
        assert.equal(last.status, 409);
        assert.equal(last.body.code, "LAST_OWNER");
        // put the original owner back for later tests
        await call("PATCH", `/${ownerId}`, {
            service: true,
            body: { role: "owner" },
        });
    });

    it("resets a password, revokes sessions and never echoes it", async () => {
        const created = (
            await call("POST", "/", {
                cookie: ownerCookie,
                body: newUser("pw"),
            })
        ).body;
        const email = `pw-${suffix}@example.test`;
        const oldCookie = await signIn(email);
        assert.equal(
            (await call("GET", "/", { cookie: oldCookie })).status,
            403,
        );

        const short = await call("POST", `/${created.id}/password`, {
            cookie: ownerCookie,
            body: { password: "x" },
        });
        assert.equal(short.status, 400);
        assert.ok(!short.text.includes('"x"'));

        const res = await call("POST", `/${created.id}/password`, {
            cookie: ownerCookie,
            body: { password: NEW_PASSWORD },
        });
        assert.equal(res.status, 204);
        assert.equal(res.text, "");
        assert.equal(
            (await call("GET", "/", { cookie: oldCookie })).status,
            401,
        );
        await assert.rejects(signIn(email, PASSWORD));
        assert.ok(await signIn(email, NEW_PASSWORD));
    });
});
