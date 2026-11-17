import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { MemberAuthProvider } from "@tessellatepos/plugin-sdk/server";
import {
    MemberAuthError,
    MemberProviderRegistry,
    effectiveMemberConfig,
    isMemberSourceActive,
    memberScope,
    validateMemberAuthProvider,
} from "@/auth/members/providers";
import { decideSignIn } from "@/auth/members/signIn";
import {
    buildAuthorizeUrl,
    createPkce,
    exchangeCode,
    fetchMemberProfile,
    isSafeReturnTo,
    MemberOAuthError,
    toMemberProfile,
} from "@/auth/members/oauth";
import {
    MEMBER_COOKIE,
    extractMemberToken,
    hashMemberToken,
    newMemberToken,
} from "@/auth/members/sessions";

const discord: MemberAuthProvider = {
    id: "discord",
    label: "Discord",
    oauth: {
        authorizationUrl: "https://discord.com/oauth2/authorize",
        tokenUrl: "https://discord.com/api/oauth2/token",
        userInfoUrl: "https://discord.com/api/users/@me",
        clientId: "",
        clientSecret: "",
        scopes: ["identify", "email"],
    },
};

describe("validateMemberAuthProvider", () => {
    it("accepts a valid provider", () => {
        assert.doesNotThrow(() =>
            validateMemberAuthProvider("tab-sys", true, discord),
        );
    });

    it("needs the MEMBER_AUTH permission", () => {
        assert.throws(
            () => validateMemberAuthProvider("tab-sys", false, discord),
            /MEMBER_AUTH/,
        );
    });

    it("rejects a bad id, missing oauth, bad urls and a bad signup", () => {
        const cases: unknown[] = [
            { ...discord, id: "Bad Id" },
            { ...discord, label: " " },
            { id: "x", label: "X" },
            { ...discord, oauth: { ...discord.oauth, tokenUrl: "ftp://x" } },
            { ...discord, oauth: { ...discord.oauth, clientId: 1 } },
            { ...discord, signup: "anyone" },
            { ...discord, resolveMember: "nope" },
            null,
        ];
        for (const bad of cases) {
            assert.throws(
                () => validateMemberAuthProvider("p", true, bad),
                MemberAuthError,
            );
        }
    });
});

describe("MemberProviderRegistry", () => {
    it("keeps ids unique per plugin and removes by plugin", () => {
        const registry = new MemberProviderRegistry();
        registry.register({ pluginName: "a", provider: discord });
        registry.register({ pluginName: "b", provider: discord });
        assert.throws(
            () => registry.register({ pluginName: "a", provider: discord }),
            MemberAuthError,
        );
        assert.equal(registry.list().length, 2);
        registry.removePlugin("a");
        assert.equal(registry.get("a", "discord"), undefined);
        assert.ok(registry.get("b", "discord"));
    });
});

describe("effective config", () => {
    it("defaults signup to approval and the owner's values win", () => {
        const base = effectiveMemberConfig(discord);
        assert.equal(base.signup, "approval");
        assert.equal(isMemberSourceActive(base), false);

        const settings = {
            enabled: true,
            signup: "open" as const,
            config: { clientId: "id", clientSecret: "secret" },
        };
        const merged = effectiveMemberConfig(discord, settings);
        assert.equal(merged.clientId, "id");
        assert.equal(merged.signup, "open");
        assert.equal(isMemberSourceActive(merged, settings), true);
        // Enabled but no credentials is still inactive.
        const noCreds = { ...settings, config: {} };
        assert.equal(
            isMemberSourceActive(
                effectiveMemberConfig(discord, noCreds),
                noCreds,
            ),
            false,
        );
    });

    it("lets the plugin choose open signup", () => {
        assert.equal(
            effectiveMemberConfig({ ...discord, signup: "open" }).signup,
            "open",
        );
    });
});

describe("member scope", () => {
    it("is only the plugin's own member scope", () => {
        assert.equal(memberScope("tab-sys"), "plugin:tab-sys:member");
    });
});

describe("decideSignIn", () => {
    const ok = {};
    it("creates active members under open signup", () => {
        assert.deepEqual(decideSignIn(null, ok, "open"), {
            kind: "active",
            create: true,
        });
    });
    it("creates pending members under approval signup", () => {
        assert.deepEqual(decideSignIn(null, ok, "approval"), {
            kind: "pending",
            create: true,
        });
    });
    it("honours the existing status whatever the policy", () => {
        assert.deepEqual(decideSignIn("active", ok, "approval"), {
            kind: "active",
            create: false,
        });
        assert.deepEqual(decideSignIn("pending", ok, "open"), {
            kind: "pending",
            create: false,
        });
        assert.deepEqual(decideSignIn("disabled", ok, "open"), {
            kind: "disabled",
        });
    });
    it("lets the plugin deny anyone, including existing members", () => {
        for (const status of [null, "active", "pending", "disabled"] as const) {
            assert.deepEqual(decideSignIn(status, { deny: "no" }, "open"), {
                kind: "denied",
                reason: "no",
            });
        }
    });
});

describe("oauth helpers", () => {
    const config = effectiveMemberConfig(discord, {
        enabled: true,
        signup: null,
        config: { clientId: "cid", clientSecret: "sec" },
    });

    it("builds an authorize URL with state and an S256 challenge", () => {
        const { challenge } = createPkce();
        const url = new URL(
            buildAuthorizeUrl(config, "https://s/cb", "st", challenge),
        );
        assert.equal(url.searchParams.get("client_id"), "cid");
        assert.equal(url.searchParams.get("state"), "st");
        assert.equal(url.searchParams.get("code_challenge"), challenge);
        assert.equal(url.searchParams.get("code_challenge_method"), "S256");
        assert.equal(url.searchParams.get("scope"), "identify email");
        assert.equal(url.searchParams.get("client_secret"), null);
    });

    it("exchanges a code and sends the verifier", async () => {
        let sent: URLSearchParams | undefined;
        const fake = (async (_url: unknown, init?: RequestInit) => {
            sent = init?.body as URLSearchParams;
            return Response.json({ access_token: "tok" });
        }) as typeof fetch;
        const token = await exchangeCode(
            config,
            "https://s/cb",
            "c",
            "v",
            fake,
        );
        assert.equal(token, "tok");
        assert.equal(sent?.get("code_verifier"), "v");
        assert.equal(sent?.get("grant_type"), "authorization_code");
    });

    it("fails clearly when the provider refuses, without leaking secrets", async () => {
        const fake = (async () =>
            new Response("{}", { status: 400 })) as typeof fetch;
        await assert.rejects(
            exchangeCode(config, "https://s/cb", "c", "v", fake),
            (err: Error) =>
                err instanceof MemberOAuthError && !err.message.includes("sec"),
        );
        const noToken = (async () => Response.json({})) as typeof fetch;
        await assert.rejects(
            exchangeCode(config, "https://s/cb", "c", "v", noToken),
            MemberOAuthError,
        );
    });

    it("normalises a Discord style profile", async () => {
        const fake = (async () =>
            Response.json({
                id: "123",
                username: "sam",
                global_name: "Sam",
                email: "sam@example.test",
                verified: true,
            })) as typeof fetch;
        const profile = await fetchMemberProfile("discord", config, "t", fake);
        assert.equal(profile.subject, "123");
        assert.equal(profile.name, "Sam");
        assert.equal(profile.email_verified, true);
        assert.throws(
            () => toMemberProfile("d", { name: "x" }),
            MemberOAuthError,
        );
    });

    it("only allows safe return URLs", () => {
        const trusted = ["https://club.example"];
        assert.ok(isSafeReturnTo("/tab", trusted));
        assert.ok(isSafeReturnTo("https://club.example/tab", trusted));
        for (const bad of [
            "//evil.test",
            "/\\evil.test",
            "https://evil.test/",
            "javascript:alert(1)",
            "tab",
        ]) {
            assert.equal(isSafeReturnTo(bad, trusted), false, bad);
        }
    });
});

describe("member sessions", () => {
    it("hashes tokens and never stores them", () => {
        const token = newMemberToken();
        assert.ok(token.startsWith("tsm_"));
        assert.notEqual(hashMemberToken(token), token);
        assert.equal(hashMemberToken(token), hashMemberToken(token));
    });

    it("reads the member cookie or a prefixed bearer, never a staff token", () => {
        const token = newMemberToken();
        assert.equal(
            extractMemberToken(`a=1; ${MEMBER_COOKIE}=${token}`, undefined),
            token,
        );
        assert.equal(extractMemberToken(undefined, `Bearer ${token}`), token);
        assert.equal(extractMemberToken(undefined, "Bearer tsd_device"), null);
        assert.equal(
            extractMemberToken(`${MEMBER_COOKIE}=abc`, undefined),
            null,
        );
        assert.equal(extractMemberToken(undefined, undefined), null);
    });
});
