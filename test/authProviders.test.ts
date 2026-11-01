import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { PluginManifest } from "@tessellatepos/plugin-sdk";
import type { AuthProvider } from "@tessellatepos/plugin-sdk/server";
import { Plugin } from "@/plugin/plugin";
import { grantedPermissions } from "@/plugin/lifecycle/manifest";
import { TessellatePluginRegistry } from "@/utils/registry/plugin/pluginRegistry";
import {
    AuthProviderRegistry,
    authProviders,
    buildContributions,
    effectiveConfig,
    isConfigured,
    oauthProviderId,
    providerKind,
    toBetterAuthPlugin,
    toGenericOAuthConfig,
    toSocialProviderEntry,
} from "@/auth/providers";

function manifest(name: string, permissions: string[]): PluginManifest {
    return {
        name,
        version: "1.0.0",
        main: "index.js",
        engines: { tessellate: "*" },
        tessellate: { permissions, authRoles: ["manager"] },
    } as unknown as PluginManifest;
}

function plugin(name: string, permissions: string[] = ["AUTH"]) {
    const m = manifest(name, permissions);
    return new Plugin(m, grantedPermissions(m));
}

const oidc: AuthProvider = {
    id: "acme",
    label: "Acme SSO",
    oidc: {
        discoveryUrl:
            "https://idp.example.test/.well-known/openid-configuration",
        clientId: "code-id",
        clientSecret: "code-secret",
        scopes: ["email"],
    },
};

const oauth: AuthProvider = {
    id: "legacy",
    label: "Legacy",
    oauth: {
        authorizationUrl: "https://idp.example.test/auth",
        tokenUrl: "https://idp.example.test/token",
        userInfoUrl: "https://idp.example.test/me",
        clientId: "id",
        clientSecret: "secret",
    },
};

const social: AuthProvider = {
    id: "gh",
    label: "GitHub",
    social: { provider: "github", clientId: "", clientSecret: "" },
};

describe('register("auth")', () => {
    it("needs the AUTH permission", () => {
        assert.throws(
            () => plugin("p", []).register("auth", oidc),
            /without the AUTH permission/,
        );
    });

    it("stores a valid provider", () => {
        const p = plugin("p");
        p.register("auth", oidc);
        assert.deepEqual(p.get("auth"), [oidc]);
    });

    it("rejects bad shapes", () => {
        const cases: [string, unknown, RegExp][] = [
            ["not an object", "x", /must be an object/],
            ["no id", { label: "x", oidc: oidc.oidc }, /id must be/],
            ["upper-case id", { ...oidc, id: "Acme" }, /id must be/],
            ["slash in id", { ...oidc, id: "a/b" }, /id must be/],
            ["reserved id", { ...oidc, id: "credential" }, /reserved/],
            ["reserved social id", { ...oidc, id: "github" }, /reserved/],
            ["no label", { ...oidc, label: " " }, /needs a label/],
            ["none declared", { id: "x", label: "X" }, /exactly one/],
            [
                "two declared",
                { ...oidc, social: social.social },
                /exactly one of .*found oidc, social/,
            ],
            [
                "oidc missing secret",
                {
                    ...oidc,
                    oidc: { discoveryUrl: "https://a.test", clientId: "" },
                },
                /clientSecret must be a string/,
            ],
            [
                "oidc bad url",
                {
                    ...oidc,
                    oidc: { ...oidc.oidc, discoveryUrl: "javascript:1" },
                },
                /http\(s\) URL/,
            ],
            [
                "oauth missing url",
                { ...oauth, oauth: { ...oauth.oauth, tokenUrl: "" } },
                /tokenUrl must be an http/,
            ],
            [
                "bad social",
                {
                    ...social,
                    social: {
                        provider: "myspace",
                        clientId: "",
                        clientSecret: "",
                    },
                },
                /social.provider must be one of/,
            ],
            [
                "bad plugin",
                { id: "x", label: "X", betterAuthPlugin: {} },
                /invalid betterAuthPlugin/,
            ],
            [
                "bad resolveAccess",
                { ...oidc, resolveAccess: "yes" },
                /resolveAccess must be a function/,
            ],
            [
                "bad scopes",
                { ...oidc, oidc: { ...oidc.oidc, scopes: [1] } },
                /invalid scopes/,
            ],
        ];
        for (const [name, bad, message] of cases) {
            assert.throws(
                () => plugin("p").register("auth", bad as AuthProvider),
                message,
                name,
            );
        }
    });

    it("accepts empty credentials, for the owner to fill in", () => {
        plugin("p").register("auth", social);
    });

    it("accepts a betterAuthPlugin provider", () => {
        plugin("p").register("auth", {
            id: "pin",
            label: "PIN",
            betterAuthPlugin: { id: "pin" },
        });
    });
});

describe("AuthProviderRegistry", () => {
    const entry = (pluginName: string, provider: AuthProvider) => ({
        pluginName,
        authRoles: [],
        provider,
    });

    it("rejects a duplicate id across plugins", () => {
        const r = new AuthProviderRegistry();
        r.register(entry("a", oidc));
        assert.throws(
            () => r.register(entry("b", oidc)),
            /already registered by plugin "a"/,
        );
    });

    it("rejects two providers that use the same social login", () => {
        const r = new AuthProviderRegistry();
        r.register(entry("a", social));
        assert.throws(
            () => r.register(entry("b", { ...social, id: "gh2" })),
            /already uses/,
        );
    });

    it("finds providers by callback id and removes by plugin", () => {
        const r = new AuthProviderRegistry();
        r.register(entry("a", oidc));
        r.register(entry("a", social));
        assert.equal(r.findByOAuthId("acme")?.provider.id, "acme");
        assert.equal(r.findByOAuthId("github")?.provider.id, "gh");
        assert.equal(r.findByOAuthId("gh"), undefined);
        assert.equal(r.findByOAuthId(null), undefined);
        r.removePlugin("a");
        assert.equal(r.list().length, 0);
    });

    it("the plugin registry refuses a cross-plugin duplicate and leaves nothing behind", async () => {
        authProviders.clear();
        const registry = new TessellatePluginRegistry();
        const a = plugin("a");
        a.register("auth", oidc);
        await registry.loadPlugin("a", a);
        const b = plugin("b");
        b.register("auth", oidc);
        await assert.rejects(registry.loadPlugin("b", b), /already registered/);
        assert.equal(registry.getPlugins().has("b"), false);
        assert.deepEqual(
            authProviders.list().map((e) => e.pluginName),
            ["a"],
        );
        authProviders.clear();
    });
});

describe("translations", () => {
    it("classifies providers", () => {
        assert.equal(providerKind(oidc), "oidc");
        assert.equal(providerKind(oauth), "oauth");
        assert.equal(providerKind(social), "social");
        assert.equal(
            providerKind({
                id: "p",
                label: "P",
                betterAuthPlugin: { id: "p" },
            }),
            "custom",
        );
        assert.equal(oauthProviderId(social), "github");
        assert.equal(oauthProviderId(oidc), "acme");
    });

    it("maps oidc to a discovery based genericOAuth config", () => {
        assert.deepEqual(toGenericOAuthConfig(oidc), {
            providerId: "acme",
            name: "Acme SSO",
            clientId: "code-id",
            clientSecret: "code-secret",
            scopes: ["email"],
            pkce: true,
            discoveryUrl: oidc.oidc?.discoveryUrl,
        });
    });

    it("maps oauth to explicit endpoints", () => {
        assert.deepEqual(toGenericOAuthConfig(oauth), {
            providerId: "legacy",
            name: "Legacy",
            clientId: "id",
            clientSecret: "secret",
            scopes: [],
            pkce: true,
            authorizationUrl: "https://idp.example.test/auth",
            tokenUrl: "https://idp.example.test/token",
            userInfoUrl: "https://idp.example.test/me",
        });
    });

    it("lets the owner's values override the code defaults", () => {
        const cfg = toGenericOAuthConfig(oidc, {
            clientId: "owner-id",
            clientSecret: "owner-secret",
            discoveryUrl: "https://other.test/.well-known/openid-configuration",
            scopes: ["profile"],
        });
        assert.equal(cfg?.clientId, "owner-id");
        assert.equal(cfg?.clientSecret, "owner-secret");
        assert.equal(
            cfg?.discoveryUrl,
            "https://other.test/.well-known/openid-configuration",
        );
        assert.deepEqual(cfg?.scopes, ["profile"]);
        // Empty strings fall back to the code defaults.
        assert.equal(
            effectiveConfig(oidc, { clientId: "" }).clientId,
            "code-id",
        );
    });

    it("maps social to a socialProviders entry", () => {
        assert.equal(toSocialProviderEntry(social), null);
        assert.deepEqual(
            toSocialProviderEntry(social, { clientId: "i", clientSecret: "s" }),
            ["github", { clientId: "i", clientSecret: "s" }],
        );
        assert.equal(toGenericOAuthConfig(social), null);
    });

    it("passes a betterAuthPlugin through unchanged", () => {
        const betterAuthPlugin = { id: "pin" };
        const p: AuthProvider = { id: "pin", label: "PIN", betterAuthPlugin };
        assert.equal(toBetterAuthPlugin(p), betterAuthPlugin);
        assert.equal(toBetterAuthPlugin(oidc), null);
        assert.equal(toGenericOAuthConfig(p), null);
    });

    it("is only configured with credentials (and a discovery URL for oidc)", () => {
        assert.equal(isConfigured(oidc), true);
        assert.equal(isConfigured(social), false);
        assert.equal(isConfigured(social, { clientId: "i" }), false);
        assert.equal(
            isConfigured(social, { clientId: "i", clientSecret: "s" }),
            true,
        );
        const blank: AuthProvider = {
            ...oidc,
            oidc: { discoveryUrl: "", clientId: "", clientSecret: "" },
        };
        assert.equal(isConfigured(blank), false);
        assert.equal(
            isConfigured(blank, {
                clientId: "i",
                clientSecret: "s",
                discoveryUrl:
                    "https://idp.test/.well-known/openid-configuration",
            }),
            true,
        );
        assert.equal(
            isConfigured(blank, {
                clientId: "i",
                clientSecret: "s",
                discoveryUrl: "nonsense",
            }),
            false,
        );
    });
});

describe("buildContributions", () => {
    const pin: AuthProvider = {
        id: "pin",
        label: "PIN",
        betterAuthPlugin: { id: "pin" },
    };
    const reg = (provider: AuthProvider) => ({
        entry: { pluginName: "p", authRoles: [], provider },
    });

    it("contributes only enabled and configured providers", () => {
        const seen: string[] = [];
        const out = buildContributions(
            [
                { ...reg(oidc), settings: { enabled: true, config: {} } },
                { ...reg(oauth), settings: { enabled: false, config: {} } },
                { ...reg(social), settings: { enabled: true, config: {} } },
                { ...reg(pin), settings: { enabled: true, config: {} } },
                reg({ ...pin, id: "pin2", betterAuthPlugin: { id: "pin2" } }),
            ],
            (e) => seen.push(e.provider.id),
        );
        assert.deepEqual(
            out.genericOAuth.map((c) => c.providerId),
            ["acme"],
        );
        assert.deepEqual(out.socialProviders, {});
        assert.deepEqual(
            out.plugins.map((p) => p.id),
            ["pin"],
        );
        assert.deepEqual(seen, ["pin"]);
    });

    it("adds a social provider once it is configured", () => {
        const out = buildContributions([
            {
                ...reg(social),
                settings: {
                    enabled: true,
                    config: { clientId: "i", clientSecret: "s" },
                },
            },
        ]);
        assert.deepEqual(out.socialProviders, {
            github: { clientId: "i", clientSecret: "s" },
        });
    });
});
