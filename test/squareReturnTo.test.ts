process.env.SQUARE_APPLICATION_ID ??= "sq0idp-test";
process.env.SQUARE_APPLICATION_SECRET ??= "sq0csp-test-secret";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pool } from "@/services/db/postgres";
import { createAuth } from "@/services/auth";
import { frontendUrl } from "@/config/urls";
import { squarev1Endpoint } from "@/endpoints/v1/square";
import {
    DEFAULT_RETURN_TO,
    normalizeReturnTo,
    peekReturnTo,
} from "@/services/squareOauth";
import { startTestApp, type TestApp } from "./helpers/app";
import { migrateTestDb } from "./helpers/db";

const suffix = randomUUID().slice(0, 8);
const PASSWORD = "correct-horse-battery";
const base = frontendUrl ?? "";

describe("Square OAuth return path", () => {
    let server: TestApp;
    let owner: string;

    before(async () => {
        await migrateTestDb();
        const auth = createAuth();
        const email = `owner-${suffix}@example.test`;
        await auth.api.createUser({
            body: { email, password: PASSWORD, name: "o", role: "owner" },
        });
        const { headers } = await auth.api.signInEmail({
            body: { email, password: PASSWORD },
            returnHeaders: true,
        });
        owner = (headers.get("set-cookie") ?? "").split(";")[0];
        server = await startTestApp((app) => {
            app.use("/api/v1/square", squarev1Endpoint.router);
        });
    });

    after(async () => {
        await server.close();
        await pool.query(
            `DELETE FROM "tessellate-auth-user" WHERE email LIKE $1`,
            [`%-${suffix}@example.test`],
        );
        await pool.end();
    });

    /** Starts the flow and returns the state Square would echo back. */
    async function authorize(returnTo?: string | string[]) {
        const query = new URLSearchParams();
        for (const v of [returnTo ?? []].flat()) query.append("returnTo", v);
        const res = await fetch(
            `${server.url}/api/v1/square/oauth/authorize?${query}`,
            { headers: { cookie: owner } },
        );
        assert.equal(res.status, 200);
        const { url } = (await res.json()) as { url: string };
        return { url, state: new URL(url).searchParams.get("state")! };
    }

    const callback = (query: string, cookie: string | undefined = owner) =>
        fetch(`${server.url}/api/v1/square/oauth/callback?${query}`, {
            redirect: "manual",
            headers: cookie ? { cookie } : {},
        });

    it("normalises against the allow-list", () => {
        assert.equal(normalizeReturnTo("/setup"), "/setup");
        assert.equal(normalizeReturnTo("/settings"), "/settings");
        for (const bad of [
            undefined,
            "",
            "/",
            "/other",
            "//evil.example",
            "https://evil.example/setup",
            "/setup/../x",
            "/setup?x=1",
            ["/setup"],
            42,
        ]) {
            assert.equal(
                normalizeReturnTo(bad),
                DEFAULT_RETURN_TO,
                String(bad),
            );
        }
    });

    it("returns to /setup when authorize asked for it, and keeps it off Square's URL", async () => {
        const { url, state } = await authorize("/setup");
        assert.ok(!url.includes("returnTo"));
        assert.ok(!url.includes("setup"));
        assert.equal(peekReturnTo(state), "/setup");
        const res = await callback(`error=access_denied&state=${state}`);
        assert.equal(res.status, 302);
        assert.equal(
            res.headers.get("location"),
            `${base}/setup?square_auth=error`,
        );
    });

    it("returns to /settings by default and for anything not allow-listed", async () => {
        for (const value of [
            undefined,
            "/settings",
            "/evil",
            "//evil.example",
            "https://evil.example",
            ["/setup", "/settings"],
        ]) {
            const { state } = await authorize(value);
            const res = await callback(`error=access_denied&state=${state}`);
            assert.equal(
                res.headers.get("location"),
                `${base}/settings?square_auth=error`,
                String(value),
            );
        }
    });

    it("falls back to /settings for an unknown state or a missing code", async () => {
        for (const query of [
            "code=abc&state=unknown",
            "state=unknown",
            "code=abc",
            "error=denied",
        ]) {
            const res = await callback(query);
            assert.equal(
                res.headers.get("location"),
                `${base}/settings?square_auth=error`,
                query,
            );
        }
    });

    it("keeps the callback behind settings:admin", async () => {
        assert.equal((await callback("error=x", "")).status, 401);
    });
});
