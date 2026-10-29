import assert from "node:assert/strict";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import express from "express";
import { loadUrlConfig } from "@/config/urls";
import { hostGuard } from "@/middleware/hostGuard";
import { surfaceCors } from "@/middleware/cors";
import { surfaceMiddleware } from "@/middleware/surface";

function makeServer(env: Record<string, string>) {
    const config = loadUrlConfig(env, () => {});
    const app = express();
    app.set("trust proxy", config.trustProxy);
    app.use(hostGuard(config));
    app.use(surfaceMiddleware);
    app.use(surfaceCors(config));
    app.use((req, res) => {
        res.json({
            ip: req.ip,
            protocol: req.protocol,
            hostname: req.hostname,
            surface: req.surface,
        });
    });
    return http.createServer(app);
}

function get(
    server: http.Server,
    path: string,
    headers: Record<string, string>,
) {
    const { port } = server.address() as AddressInfo;
    return new Promise<{
        status: number;
        headers: http.IncomingHttpHeaders;
        body: Record<string, string>;
    }>((resolve, reject) => {
        http.get({ port, host: "127.0.0.1", path, headers }, (res) => {
            let data = "";
            res.on("data", (c) => (data += c));
            res.on("end", () =>
                resolve({
                    status: res.statusCode ?? 0,
                    headers: res.headers,
                    body: data ? JSON.parse(data) : {},
                }),
            );
        }).on("error", reject);
    });
}

const listen = (s: http.Server) =>
    new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
const close = (s: http.Server) => new Promise((r) => s.close(r));

describe("host guard (PUBLIC_URL set)", () => {
    const server = makeServer({ PUBLIC_URL: "https://shop.example.test" });
    before(() => listen(server));
    after(() => close(server));

    it("404s admin paths on the public host", async () => {
        const res = await get(server, "/api/v1/locations", {
            Host: "shop.example.test",
        });
        assert.equal(res.status, 404);
    });

    it("serves gateway, webhooks and health on the public host", async () => {
        for (const [p, surface] of [
            ["/gateway/v1/x", "gateway"],
            ["/webhooks/square", "webhook"],
            ["/health", "internal"],
        ]) {
            const res = await get(server, p, { Host: "shop.example.test" });
            assert.equal(res.status, 200, p);
            assert.equal(res.body.surface, surface);
        }
    });

    it("does not affect other hosts", async () => {
        const res = await get(server, "/api/v1/locations", {
            Host: "localhost:3120",
        });
        assert.equal(res.status, 200);
        assert.equal(res.body.surface, "internal");
    });
});

describe("ALLOWED_HOSTS", () => {
    const server = makeServer({ ALLOWED_HOSTS: "pos.lan" });
    before(() => listen(server));
    after(() => close(server));

    it("421s unlisted hosts and serves listed ones", async () => {
        assert.equal(
            (await get(server, "/", { Host: "evil.test" })).status,
            421,
        );
        assert.equal((await get(server, "/", { Host: "pos.lan" })).status, 200);
    });
});

describe("trust proxy", () => {
    const fwd = {
        "X-Forwarded-For": "203.0.113.9",
        "X-Forwarded-Proto": "https",
        "X-Forwarded-Host": "pos.example.test",
        Host: "internal:3000",
    };

    it("ignores forwarded headers when TRUST_PROXY=0", async () => {
        const server = makeServer({ TRUST_PROXY: "0" });
        await listen(server);
        const res = await get(server, "/", fwd);
        await close(server);
        assert.equal(res.body.protocol, "http");
        assert.equal(res.body.hostname, "internal");
        assert.match(res.body.ip, /127\.0\.0\.1/);
    });

    it("honours forwarded headers when TRUST_PROXY=1", async () => {
        const server = makeServer({ TRUST_PROXY: "1" });
        await listen(server);
        const res = await get(server, "/", fwd);
        await close(server);
        assert.equal(res.body.protocol, "https");
        assert.equal(res.body.hostname, "pos.example.test");
        assert.equal(res.body.ip, "203.0.113.9");
    });

    it("cannot escape the guard via X-Forwarded-Host", async () => {
        const server = makeServer({
            PUBLIC_URL: "https://shop.example.test",
            TRUST_PROXY: "1",
        });
        await listen(server);
        const spoof = {
            Host: "shop.example.test",
            "X-Forwarded-Host": "localhost",
        };
        const admin = await get(server, "/api/v1/x", spoof);
        const root = await get(server, "/", spoof);
        const health = await get(server, "/health", spoof);
        const gw = await get(server, "/gateway/v1/x", spoof);
        const wh = await get(server, "/webhooks/square", spoof);
        await close(server);
        assert.equal(admin.status, 404);
        assert.equal(root.status, 404);
        assert.equal(health.status, 200);
        assert.equal(gw.status, 200);
        assert.equal(wh.status, 200);
    });

    it("ALLOWED_HOSTS also ignores X-Forwarded-Host", async () => {
        const server = makeServer({
            ALLOWED_HOSTS: "pos.lan",
            TRUST_PROXY: "1",
        });
        await listen(server);
        const res = await get(server, "/", {
            Host: "evil.test",
            "X-Forwarded-Host": "pos.lan",
        });
        await close(server);
        assert.equal(res.status, 421);
    });
});

describe("per-surface CORS", () => {
    const server = makeServer({
        PUBLIC_URL: "https://shop.example.test",
        NODE_ENV: "development",
    });
    before(() => listen(server));
    after(() => close(server));

    it("allows the dev origin and same-origin on internal routes", async () => {
        const dev = await get(server, "/api/v1/x", {
            Host: "localhost:3120",
            Origin: "http://localhost:5173",
        });
        assert.equal(
            dev.headers["access-control-allow-origin"],
            "http://localhost:5173",
        );
        const same = await get(server, "/api/v1/x", {
            Host: "localhost:3120",
            Origin: "http://localhost:3120",
        });
        assert.equal(
            same.headers["access-control-allow-origin"],
            "http://localhost:3120",
        );
    });

    it("sends no CORS headers to foreign origins or on gateway/webhooks", async () => {
        const foreign = await get(server, "/api/v1/x", {
            Host: "localhost:3120",
            Origin: "https://evil.test",
        });
        assert.equal(foreign.headers["access-control-allow-origin"], undefined);
        for (const p of ["/gateway/v1/x", "/webhooks/square"]) {
            const r = await get(server, p, {
                Host: "localhost:3120",
                Origin: "http://localhost:5173",
            });
            assert.equal(
                r.headers["access-control-allow-origin"],
                undefined,
                p,
            );
        }
    });
});
