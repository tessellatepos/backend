import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type {
    AuthProvider,
    ExternalProfile,
} from "@tessellatepos/plugin-sdk/server";
import { DEFAULT_ROLE, capRoles, resolveProviderAccess } from "@/auth/access";
import { createAccessGate, toExternalProfile } from "@/auth/accessGate";
import { AuthProviderRegistry } from "@/auth/providers";

const profile: ExternalProfile = {
    provider: "acme",
    subject: "u1",
    email: "a@example.test",
    raw: {},
};

describe("capRoles", () => {
    it("keeps roles the host knows and the manifest lists", () => {
        assert.deepEqual(
            capRoles(["manager", "cashier"], ["manager", "cashier"]),
            ["manager", "cashier"],
        );
    });

    it("strips owner even when the manifest lists it", () => {
        assert.deepEqual(capRoles(["owner", "manager"], ["owner", "manager"]), [
            "manager",
        ]);
        assert.deepEqual(capRoles(["owner"], ["owner"]), [DEFAULT_ROLE]);
    });

    it("drops roles the host does not know", () => {
        assert.deepEqual(
            capRoles(["superuser", "manager"], ["superuser", "manager"]),
            ["manager"],
        );
        assert.deepEqual(capRoles(["toString", "__proto__"], ["toString"]), [
            DEFAULT_ROLE,
        ]);
    });

    it("drops roles outside the manifest's authRoles", () => {
        assert.deepEqual(capRoles(["manager", "cashier"], ["cashier"]), [
            "cashier",
        ]);
    });

    it("does not split or trim a role string into something valid", () => {
        assert.deepEqual(capRoles(["manager,owner", " owner", "OWNER"], []), [
            DEFAULT_ROLE,
        ]);
        assert.deepEqual(capRoles(["manager,owner"], ["manager,owner"]), [
            DEFAULT_ROLE,
        ]);
    });

    it("falls back to the default role when nothing remains", () => {
        assert.deepEqual(capRoles([], ["manager"]), [DEFAULT_ROLE]);
        assert.deepEqual(capRoles(["manager"], []), [DEFAULT_ROLE]);
        assert.deepEqual(capRoles(["manager"], undefined), [DEFAULT_ROLE]);
    });

    it("grants nothing extra for malformed input", () => {
        for (const bad of [null, undefined, "manager", { 0: "manager" }, 7]) {
            assert.deepEqual(capRoles(bad, ["manager"]), [DEFAULT_ROLE]);
        }
        assert.deepEqual(capRoles([1, null, {}, "manager"], ["manager"]), [
            "manager",
        ]);
    });

    it("de-duplicates", () => {
        assert.deepEqual(
            capRoles(["cashier", "cashier", "viewer"], ["cashier", "viewer"]),
            ["cashier", "viewer"],
        );
    });
});

describe("resolveProviderAccess", () => {
    const run = (p: Pick<AuthProvider, "resolveAccess">, roles = ["manager"]) =>
        resolveProviderAccess(p, roles, profile, 50);

    it("gives the default role when there is no resolveAccess", async () => {
        assert.deepEqual(await run({}), {
            allowed: true,
            roles: [DEFAULT_ROLE],
        });
    });

    it("caps what a sync resolveAccess returns", async () => {
        const out = await run({ resolveAccess: () => ({ roles: ["owner"] }) });
        assert.deepEqual(out, { allowed: true, roles: [DEFAULT_ROLE] });
        const ok = await run({
            resolveAccess: () => ({ roles: ["manager", "owner"] }),
        });
        assert.deepEqual(ok, { allowed: true, roles: ["manager"] });
    });

    it("caps what an async resolveAccess returns", async () => {
        const out = await run({
            resolveAccess: async () => ({ roles: ["manager", "cashier"] }),
        });
        assert.deepEqual(out, { allowed: true, roles: ["manager"] });
    });

    it("refuses on deny, sync or async", async () => {
        const a = await run({ resolveAccess: () => ({ deny: "nope" }) });
        assert.deepEqual(a, { allowed: false, reason: "nope" });
        const b = await run({
            resolveAccess: async () => ({ deny: "later" }),
        });
        assert.deepEqual(b, { allowed: false, reason: "later" });
    });

    it("refuses when it throws or rejects", async () => {
        const a = await run({
            resolveAccess: () => {
                throw new Error("boom");
            },
        });
        assert.equal(a.allowed, false);
        const b = await run({
            resolveAccess: () => Promise.reject(new Error("later")),
        });
        assert.equal(b.allowed, false);
    });

    it("refuses an answer that is neither roles nor deny", async () => {
        for (const bad of [undefined, null, "yes", 1, {}, { ok: true }]) {
            const out = await run({
                resolveAccess: (() => bad) as never,
            });
            assert.equal(out.allowed, false, String(bad));
        }
    });

    it("lets deny win over roles", async () => {
        const out = await run({
            resolveAccess: (() => ({ roles: ["manager"], deny: "x" })) as never,
        });
        assert.equal(out.allowed, false);
    });

    it("refuses when it takes too long", async () => {
        const out = await run({
            resolveAccess: () => new Promise(() => undefined),
        });
        assert.equal(out.allowed, false);
    });
});

describe("toExternalProfile", () => {
    it("normalises common claims and keeps the raw profile", () => {
        const raw = {
            sub: "abc",
            email: "x@example.test",
            email_verified: true,
            name: "X",
            preferred_username: "xx",
        };
        const p = toExternalProfile("acme", raw, {});
        assert.deepEqual(p, {
            provider: "acme",
            subject: "abc",
            email: "x@example.test",
            email_verified: true,
            name: "X",
            username: "xx",
            raw,
        });
    });

    it("uses id when there is no sub, and refuses when neither exists", () => {
        assert.equal(toExternalProfile("a", { id: 42 }, {})?.subject, "42");
        assert.equal(toExternalProfile("a", { email: "x" }, {}), null);
        assert.equal(toExternalProfile("a", undefined, {}), null);
    });
});

describe("access gate", () => {
    const registry = new AuthProviderRegistry();
    registry.register({
        pluginName: "acme-plugin",
        authRoles: ["manager", "owner"],
        provider: {
            id: "acme",
            label: "Acme",
            oidc: { discoveryUrl: "", clientId: "", clientSecret: "" },
            resolveAccess: (p) =>
                p.email === "deny@example.test"
                    ? { deny: "no" }
                    : { roles: ["owner", "manager", "cashier"] },
        },
    });
    const gate = createAccessGate(registry);
    const ctx = {} as never;
    const oauth = (action: string, email: string) => ({
        user: { email } as Record<string, unknown>,
        source: {
            method: "oauth",
            action,
            oauth: { providerId: "acme", profile: { sub: "s1", email } },
        } as never,
    });

    it("writes the capped roles on create-user", async () => {
        const input = oauth("create-user", "a@example.test");
        assert.equal(await gate(input, ctx), undefined);
        assert.equal(input.user.role, "manager");
    });

    it("blocks a deny on create and on sign-in", async () => {
        for (const action of ["create-user", "sign-in"]) {
            const out = await gate(oauth(action, "deny@example.test"), ctx);
            assert.equal(out?.error, "access_denied");
        }
    });

    it("does not touch the roles of a returning user", async () => {
        const input = oauth("sign-in", "a@example.test");
        assert.equal(await gate(input, ctx), undefined);
        assert.equal(input.user.role, undefined);
    });

    it("refuses to link a plugin provider to an existing account", async () => {
        const out = await gate(oauth("link-account", "a@example.test"), ctx);
        assert.equal(out?.error, "access_denied");
    });

    it("refuses a profile without a subject", async () => {
        const input = oauth("sign-in", "a@example.test");
        (input.source as { oauth: { profile: unknown } }).oauth.profile = {};
        assert.equal((await gate(input, ctx))?.error, "access_denied");
    });

    it("creates users from unknown OAuth providers as viewers", async () => {
        const user: Record<string, unknown> = { role: "owner" };
        await gate(
            {
                user,
                source: {
                    method: "oauth",
                    action: "create-user",
                    oauth: { providerId: "other" },
                } as never,
            },
            ctx,
        );
        assert.equal(user.role, DEFAULT_ROLE);
    });

    it("lets only the admin path create an owner", async () => {
        const create = (method: string) =>
            gate(
                {
                    user: { role: "manager,owner" },
                    source: { method, action: "create-user" } as never,
                },
                ctx,
            );
        assert.equal(await create("admin"), undefined);
        assert.equal(
            (await create("email-password"))?.error,
            "owner_not_grantable",
        );
        assert.equal(
            (await create("magic-link"))?.error,
            "owner_not_grantable",
        );
    });
});
