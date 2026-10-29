import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
    evaluateHost,
    gatewayBase,
    loadUrlConfig,
    normalizeHost,
    trustedOrigins,
    webhookUrl,
} from "@/config/urls";

const load = (env: Record<string, string>) => {
    const warnings: string[] = [];
    const config = loadUrlConfig(env, (m) => warnings.push(m));
    return { config, warnings };
};

describe("urls config", () => {
    it("defaults to LAN mode when PUBLIC_URL is unset", () => {
        const { config, warnings } = load({ NODE_ENV: "development" });
        assert.equal(config.publicUrl, null);
        assert.equal(config.allowedHosts, null);
        assert.equal(config.trustProxy, 0);
        assert.equal(config.frontendUrl, undefined);
        assert.equal(config.squareRedirectUrl, undefined);
        assert.equal(webhookUrl("square", config), null);
        assert.equal(
            gatewayBase("http://192.168.1.5:3000", config),
            "http://192.168.1.5:3000/gateway/v1",
        );
        assert.equal(evaluateHost("anything.lan", "/api/v1/x", config), "ok");
        assert.deepEqual(warnings, []);
        assert.deepEqual(config.corsOrigins, ["http://localhost:5173"]);
    });

    it("derives urls from PUBLIC_URL", () => {
        const { config } = load({
            PUBLIC_URL: "https://shop.example.test/",
            NODE_ENV: "production",
        });
        assert.equal(config.publicUrl, "https://shop.example.test");
        assert.equal(config.publicHost, "shop.example.test");
        assert.equal(config.trustProxy, 1);
        assert.equal(
            gatewayBase(undefined, config),
            "https://shop.example.test/gateway/v1",
        );
        assert.equal(
            webhookUrl("square", config),
            "https://shop.example.test/webhooks/square",
        );
        assert.equal(config.frontendUrl, undefined);
        assert.deepEqual(config.corsOrigins, ["https://shop.example.test"]);
        assert.deepEqual(trustedOrigins(undefined, config), [
            "https://shop.example.test",
        ]);
    });

    it("exposes the app url when admin is exposed (mode C)", () => {
        const { config } = load({
            PUBLIC_URL: "https://pos.example.test",
            EXPOSE_ADMIN_ON_PUBLIC_URL: "true",
        });
        assert.equal(config.frontendUrl, "https://pos.example.test");
        assert.equal(
            config.squareRedirectUrl,
            "https://pos.example.test/api/v1/square/oauth/callback",
        );
        assert.equal(
            evaluateHost("pos.example.test", "/api/v1/x", config),
            "ok",
        );
    });

    it("rejects an invalid PUBLIC_URL", () => {
        assert.throws(() => load({ PUBLIC_URL: "nope" }));
        assert.throws(() => load({ PUBLIC_URL: "ftp://x.test" }));
    });

    it("keeps legacy vars as overrides and warns once", () => {
        const env = {
            PUBLIC_URL: "https://pos.example.test",
            EXPOSE_ADMIN_ON_PUBLIC_URL: "true",
            FRONTEND_URL: "https://app.legacy.test",
            BETTER_AUTH_URL: "https://auth.legacy.test",
            SQUARE_REDIRECT_URL: "https://cb.legacy.test/cb",
        };
        const first = load(env);
        assert.equal(first.config.frontendUrl, "https://app.legacy.test");
        assert.equal(first.config.authBaseUrl, "https://auth.legacy.test");
        assert.equal(
            first.config.squareRedirectUrl,
            "https://cb.legacy.test/cb",
        );
        assert.ok(first.config.corsOrigins.includes("https://app.legacy.test"));
        assert.equal(first.warnings.length, 3);
        assert.match(first.warnings[0], /deprecated/);
        // one-time: a second load does not warn again
        assert.equal(load(env).warnings.length, 0);
    });

    it("parses TRUST_PROXY forms", () => {
        assert.equal(load({ TRUST_PROXY: "2" }).config.trustProxy, 2);
        assert.equal(load({ TRUST_PROXY: "true" }).config.trustProxy, true);
        assert.deepEqual(
            load({ TRUST_PROXY: "loopback, 10.0.0.0/8" }).config.trustProxy,
            ["loopback", "10.0.0.0/8"],
        );
        assert.equal(
            load({ PUBLIC_URL: "https://a.test", TRUST_PROXY: "0" }).config
                .trustProxy,
            0,
        );
    });

    it("normalizes hosts", () => {
        assert.equal(
            normalizeHost("Shop.Example.TEST:8443"),
            "shop.example.test",
        );
        assert.equal(normalizeHost("[::1]:3000"), "[::1]");
        assert.equal(normalizeHost(undefined), null);
    });
});

describe("evaluateHost", () => {
    const { config } = load({ PUBLIC_URL: "https://shop.example.test" });

    it("lets the public host reach only public prefixes", () => {
        for (const p of ["/gateway/v1/x", "/webhooks/square", "/health"]) {
            assert.equal(evaluateHost("shop.example.test", p, config), "ok", p);
        }
        for (const p of [
            "/",
            "/api/v1/locations",
            "/plugins/a",
            "/Api/v1",
            "/gatewayx",
            "//gateway",
        ]) {
            assert.equal(
                evaluateHost("shop.example.test", p, config),
                "not-found",
                p,
            );
        }
    });

    it("leaves other hosts unaffected", () => {
        assert.equal(
            evaluateHost("localhost", "/api/v1/locations", config),
            "ok",
        );
        assert.equal(evaluateHost("192.168.1.5", "/", config), "ok");
    });

    it("returns 421 for unlisted hosts when ALLOWED_HOSTS is set", () => {
        const { config: c } = load({
            ALLOWED_HOSTS: "pos.lan, 192.168.1.5:3000",
        });
        assert.deepEqual(c.allowedHosts, ["pos.lan", "192.168.1.5"]);
        assert.equal(evaluateHost("pos.lan", "/", c), "ok");
        assert.equal(evaluateHost("evil.test", "/", c), "misdirected");
        assert.equal(evaluateHost(null, "/", c), "misdirected");
    });
});
