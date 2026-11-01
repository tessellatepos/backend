import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ROLE_SCOPES, scopesForRoles } from "@/auth/roles";

describe("scopesForRoles", () => {
    it("grants the wildcard to owner", () => {
        assert.deepEqual(scopesForRoles(["owner"]), ["*"]);
    });

    it("grants nothing for no roles or unknown roles", () => {
        assert.deepEqual(scopesForRoles([]), []);
        assert.deepEqual(scopesForRoles(["admin", "root", ""]), []);
    });

    it("never grants the wildcard to a non-owner role", () => {
        for (const role of ["manager", "cashier", "viewer", "*", "plugin:x"]) {
            assert.ok(!scopesForRoles([role]).includes("*"), role);
        }
    });

    it("does not resolve inherited object keys as roles", () => {
        assert.deepEqual(scopesForRoles(["toString", "__proto__"]), []);
    });

    it("unions and de-duplicates multiple roles", () => {
        const scopes = scopesForRoles(["cashier", "viewer", "cashier"]);
        assert.equal(new Set(scopes).size, scopes.length);
        assert.ok(scopes.includes("orders:write"));
        assert.ok(scopes.includes("dashboard:read"));
    });

    it("keeps the roles ordered by privilege", () => {
        const cashier = new Set(scopesForRoles(["cashier"]));
        const viewer = scopesForRoles(["viewer"]);
        const manager = new Set(scopesForRoles(["manager"]));
        assert.ok(
            viewer
                .filter((s) => s !== "dashboard:read")
                .every((s) => cashier.has(s)),
        );
        assert.ok([...cashier].every((s) => manager.has(s)));
    });

    it("keeps viewer read-only and users/credentials/settings writes owner-only", () => {
        assert.ok(ROLE_SCOPES.viewer.every((s) => s.endsWith(":read")));
        for (const role of ["manager", "cashier", "viewer"] as const) {
            for (const s of ROLE_SCOPES[role]) {
                assert.ok(
                    !/^(users|credentials|settings|plugins):(write|admin)$/.test(
                        s,
                    ),
                    s,
                );
                assert.ok(!s.endsWith(":admin"), s);
            }
        }
    });
});
