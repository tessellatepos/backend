import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pool } from "@/services/db/postgres";
import { AUTH_BASE_PATH, createAuth } from "@/services/auth";
import { parseRoles, scopesForRoles } from "@/auth/roles";
import { migrateTestDb } from "./helpers/db";

const suffix = randomUUID().slice(0, 8);
const email = (name: string) => `${name}-${suffix}@example.test`;

describe("auth accounts", () => {
    before(async () => {
        await migrateTestDb();
        createAuth();
    });

    after(async () => {
        await pool.query(
            `DELETE FROM "tessellate-auth-user" WHERE email LIKE $1`,
            [`%-${suffix}@example.test`],
        );
        await pool.end();
    });

    it("rejects open email sign-up", async () => {
        const auth = createAuth();
        const res = await auth.handler(
            new Request(`http://localhost${AUTH_BASE_PATH}/sign-up/email`, {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    origin: "http://localhost",
                },
                body: JSON.stringify({
                    email: email("signup"),
                    password: "correct-horse-battery",
                    name: "Sign Up",
                }),
            }),
        );
        assert.ok(res.status >= 400, `status ${res.status}`);
        const { rows } = await pool.query(
            `SELECT 1 FROM "tessellate-auth-user" WHERE email = $1`,
            [email("signup")],
        );
        assert.equal(rows.length, 0);
    });

    it("lets the server API create users, defaulting to viewer", async () => {
        const auth = createAuth();
        const { user } = await auth.api.createUser({
            body: {
                email: email("default"),
                password: "correct-horse-battery",
                name: "Default",
            },
        });
        assert.equal(user.role, "viewer");
    });

    it("accepts our role names and rejects unknown ones", async () => {
        const auth = createAuth();
        const { user } = await auth.api.createUser({
            body: {
                email: email("owner"),
                password: "correct-horse-battery",
                name: "Owner",
                role: "owner",
            },
        });
        assert.equal(user.role, "owner");
        await assert.rejects(
            auth.api.createUser({
                body: {
                    email: email("bogus"),
                    password: "correct-horse-battery",
                    name: "Bogus",
                    // @ts-expect-error not one of our roles
                    role: "superuser",
                },
            }),
        );
    });
});

describe("multi-role strings", () => {
    it("parseRoles splits, trims and de-duplicates", () => {
        assert.deepEqual(parseRoles(" manager, cashier ,manager,,"), [
            "manager",
            "cashier",
        ]);
        assert.deepEqual(parseRoles(null), []);
        assert.deepEqual(parseRoles(""), []);
    });

    it("scopesForRoles accepts a comma separated string", () => {
        const scopes = scopesForRoles("cashier, viewer");
        assert.ok(scopes.includes("orders:write"));
        assert.ok(scopes.includes("dashboard:read"));
        assert.equal(new Set(scopes).size, scopes.length);
    });

    it("only owner yields the wildcard, even in a multi-role string", () => {
        assert.deepEqual(scopesForRoles("owner,viewer").includes("*"), true);
        assert.ok(!scopesForRoles("manager,*").includes("*"));
        assert.ok(!scopesForRoles(" * ").includes("*"));
    });
});
