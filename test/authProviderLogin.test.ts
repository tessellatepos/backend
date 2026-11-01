import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { pool } from "@/services/db/postgres";
import { AUTH_BASE_PATH, createAuth, getAuth } from "@/services/auth";
import { authProviders } from "@/auth/providers";
import { rebuildAuth, saveSettings } from "@/services/authProviders";
import { migrateTestDb } from "./helpers/db";

/**
 * A login through a plugin's OIDC provider, end to end except for the
 * browser: better-auth runs its real sign-in, discovery, redirect, code
 * exchange (with PKCE), userinfo and callback against a mock identity
 * provider on an ephemeral port. The test plays the browser by following
 * the redirects and carrying cookies by hand.
 */

const suffix = randomUUID().slice(0, 8);
const ORIGIN = "http://localhost";
const PROVIDER_ID = `mock-${suffix}`;
const CLIENT_ID = `client-${suffix}`;
const CLIENT_SECRET = `secret-${suffix}`;
const email = (name: string) => `${name}-${suffix}@example.test`;

interface MockIdp {
    server: Server;
    url: string;
    /** What the token endpoint saw on the last exchange. */
    lastToken: { params: URLSearchParams; authorization?: string } | null;
    close(): Promise<void>;
}

/** An OAuth2/OIDC provider: discovery, authorize, token and userinfo. */
async function startMockIdp(
    profiles: Map<string, Record<string, unknown>>,
): Promise<MockIdp> {
    const codes = new Map<string, string>();
    const idp = { lastToken: null } as unknown as MockIdp;
    const server = createServer((req, res) => {
        const url = new URL(req.url ?? "/", idp.url);
        const json = (body: unknown, status = 200) => {
            res.writeHead(status, { "content-type": "application/json" });
            res.end(JSON.stringify(body));
        };
        if (url.pathname === "/.well-known/openid-configuration") {
            json({
                issuer: idp.url,
                authorization_endpoint: `${idp.url}/authorize`,
                token_endpoint: `${idp.url}/token`,
                userinfo_endpoint: `${idp.url}/userinfo`,
                // Marks the provider as OIDC, so `sub` is the account subject.
                id_token_signing_alg_values_supported: ["RS256"],
            });
        } else if (url.pathname === "/authorize") {
            // The "user" is whoever the test says is signing in, passed in
            // login_hint (better-auth forwards it from the sign-in call).
            const who = url.searchParams.get("login_hint") ?? "";
            const code = randomUUID();
            codes.set(code, who);
            const back = new URL(url.searchParams.get("redirect_uri") ?? "");
            back.searchParams.set("code", code);
            back.searchParams.set("state", url.searchParams.get("state") ?? "");
            res.writeHead(302, { location: back.toString() });
            res.end();
        } else if (url.pathname === "/token" && req.method === "POST") {
            let raw = "";
            req.on("data", (c) => (raw += c));
            req.on("end", () => {
                const params = new URLSearchParams(raw);
                idp.lastToken = {
                    params,
                    authorization: req.headers.authorization,
                };
                const who = codes.get(params.get("code") ?? "");
                if (!who) return json({ error: "invalid_grant" }, 400);
                json({
                    access_token: `at-${who}`,
                    token_type: "Bearer",
                    expires_in: 3600,
                });
            });
        } else if (url.pathname === "/userinfo") {
            const who = (req.headers.authorization ?? "").replace(
                "Bearer at-",
                "",
            );
            const profile = profiles.get(who);
            if (!profile) return json({ error: "invalid_token" }, 401);
            json(profile);
        } else {
            json({ error: "not_found" }, 404);
        }
    });
    await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
    );
    idp.server = server;
    idp.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    idp.close = () =>
        new Promise<void>((resolve) => {
            server.closeAllConnections();
            server.close(() => resolve());
        });
    return idp;
}

function cookiesFrom(res: Response, jar: Map<string, string>) {
    for (const line of res.headers.getSetCookie()) {
        const [pair] = line.split(";");
        const eq = pair.indexOf("=");
        jar.set(pair.slice(0, eq), pair.slice(eq + 1));
    }
}

const header = (jar: Map<string, string>) =>
    [...jar].map(([k, v]) => `${k}=${v}`).join("; ");

interface LoginResult {
    /** Where the final callback sent the browser. */
    location: string;
    sessionCookie: boolean;
}

describe("login through a plugin OIDC provider", () => {
    const profiles = new Map<string, Record<string, unknown>>();
    const denied = new Set<string>();
    let idp: MockIdp;

    /** Plays the browser through the whole redirect flow. */
    async function login(who: string): Promise<LoginResult> {
        const jar = new Map<string, string>();
        const auth = getAuth();
        const start = await auth.handler(
            new Request(`${ORIGIN}${AUTH_BASE_PATH}/sign-in/social`, {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    origin: ORIGIN,
                },
                body: JSON.stringify({
                    provider: PROVIDER_ID,
                    callbackURL: "/",
                    loginHint: who,
                }),
            }),
        );
        assert.equal(start.status, 200, await start.clone().text());
        cookiesFrom(start, jar);
        const { url } = (await start.json()) as { url: string };
        assert.ok(url.startsWith(`${idp.url}/authorize?`), url);

        const authorize = await fetch(url, { redirect: "manual" });
        assert.equal(authorize.status, 302);
        const callback = authorize.headers.get("location") ?? "";
        assert.ok(callback.includes(`/callback/${PROVIDER_ID}`), callback);

        const done = await auth.handler(
            new Request(callback, { headers: { cookie: header(jar) } }),
        );
        const sessionJar = new Map<string, string>();
        cookiesFrom(done, sessionJar);
        return {
            location: done.headers.get("location") ?? "",
            sessionCookie: [...sessionJar.keys()].some((k) =>
                k.includes("session_token"),
            ),
        };
    }

    const userRow = async (address: string) =>
        (
            await pool.query(
                `SELECT id, role, email_verified FROM "tessellate-auth-user" WHERE email = $1`,
                [address],
            )
        ).rows[0] as { id: string; role: string } | undefined;

    before(async () => {
        await migrateTestDb();
        for (const name of [
            "mgr",
            "both",
            "ownerclaim",
            "none",
            "deny",
            "throws",
            "stranger",
            "target",
            "later",
        ]) {
            profiles.set(name, {
                sub: `sub-${name}`,
                email: email(name),
                email_verified: true,
                name,
            });
        }
        idp = await startMockIdp(profiles);

        authProviders.clear();
        authProviders.register({
            pluginName: "mock-plugin",
            // owner here is a plugin author's mistake; it must still not work.
            authRoles: ["manager", "cashier", "owner"],
            provider: {
                id: PROVIDER_ID,
                label: "Mock SSO",
                oidc: {
                    discoveryUrl: `${idp.url}/.well-known/openid-configuration`,
                    clientId: "",
                    clientSecret: "",
                },
                resolveAccess: (profile) => {
                    const name = profile.email?.split("-")[0];
                    if (name === "deny" || denied.has(name ?? "")) {
                        return { deny: "not on the list" };
                    }
                    if (name === "throws") throw new Error("lookup failed");
                    if (name === "mgr") {
                        return { roles: ["owner", "manager", "superuser"] };
                    }
                    if (name === "both")
                        return { roles: ["cashier", "manager"] };
                    if (name === "none") return { roles: ["owner"] };
                    if (name === "ownerclaim") return { roles: ["owner"] };
                    return Promise.resolve({ roles: ["cashier"] });
                },
            },
        });
        // The owner enables and configures it, as through the settings API.
        await saveSettings(authProviders.get(PROVIDER_ID)!, {
            enabled: true,
            clientId: CLIENT_ID,
            clientSecret: CLIENT_SECRET,
        });
        await rebuildAuth();
        // Make sure discovery has run before the first login.
        await getAuth().$context;
    });

    after(async () => {
        await idp.close();
        authProviders.clear();
        await pool.query(
            `DELETE FROM "tessellate-auth-providers" WHERE provider_id = $1`,
            [PROVIDER_ID],
        );
        await pool.query(
            `DELETE FROM "tessellate-auth-user" WHERE email LIKE $1`,
            [`%-${suffix}@example.test`],
        );
        await pool.end();
    });

    it("creates a new user with the capped roles and a session", async () => {
        const result = await login("mgr");
        assert.equal(result.sessionCookie, true, result.location);
        assert.ok(!result.location.includes("error="), result.location);
        // Asked for owner, manager and an unknown role: only manager remains.
        const row = await userRow(email("mgr"));
        assert.equal(row?.role, "manager");

        // The real code exchange: PKCE and the owner-configured credentials.
        const seen = idp.lastToken;
        assert.ok(seen?.params.get("code_verifier"), "PKCE verifier sent");
        const basic = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString(
            "base64",
        );
        const posted =
            seen?.params.get("client_id") === CLIENT_ID &&
            seen?.params.get("client_secret") === CLIENT_SECRET;
        assert.ok(posted || seen?.authorization === `Basic ${basic}`);
    });

    it("grants several allowed roles together", async () => {
        const result = await login("both");
        assert.equal(result.sessionCookie, true);
        assert.equal((await userRow(email("both")))?.role, "cashier,manager");
    });

    it("never grants owner, even when the plugin asks for only owner", async () => {
        for (const name of ["none", "ownerclaim"]) {
            const result = await login(name);
            assert.equal(result.sessionCookie, true, name);
            assert.equal((await userRow(email(name)))?.role, "viewer", name);
        }
        const { rows } = await pool.query(
            `SELECT 1 FROM "tessellate-auth-user" WHERE email LIKE $1 AND role LIKE '%owner%'`,
            [`%-${suffix}@example.test`],
        );
        assert.equal(rows.length, 0);
    });

    it("blocks a deny: no session and no user", async () => {
        const result = await login("deny");
        assert.equal(result.sessionCookie, false);
        assert.match(result.location, /error=access_denied/);
        assert.equal(await userRow(email("deny")), undefined);
    });

    it("treats a throw as a deny", async () => {
        const result = await login("throws");
        assert.equal(result.sessionCookie, false);
        assert.match(result.location, /error=access_denied/);
        assert.equal(await userRow(email("throws")), undefined);
    });

    it("keeps a returning user's stored roles but still applies a deny", async () => {
        assert.equal((await login("later")).sessionCookie, true);
        await pool.query(
            `UPDATE "tessellate-auth-user" SET role = 'manager' WHERE email = $1`,
            [email("later")],
        );
        // resolveAccess says cashier; the owner's choice of manager stands.
        assert.equal((await login("later")).sessionCookie, true);
        assert.equal((await userRow(email("later")))?.role, "manager");

        denied.add("later");
        const blocked = await login("later");
        denied.delete("later");
        assert.equal(blocked.sessionCookie, false);
        assert.match(blocked.location, /error=access_denied/);
    });

    it("cannot take over an existing account by asserting its email", async () => {
        const { user } = await createAuth().api.createUser({
            body: {
                email: email("target"),
                password: "correct-horse-battery",
                name: "Target",
                role: "owner",
            },
        });
        await rebuildAuth();
        await getAuth().$context;
        const result = await login("target");
        assert.equal(result.sessionCookie, false);
        assert.match(result.location, /error=/);
        const { rows } = await pool.query(
            `SELECT 1 FROM "tessellate-auth-account" WHERE user_id = $1 AND provider_id = $2`,
            [user.id, PROVIDER_ID],
        );
        assert.equal(rows.length, 0, "no account was linked to the owner");
    });

    it("does not offer a disabled provider", async () => {
        await saveSettings(authProviders.get(PROVIDER_ID)!, { enabled: false });
        await rebuildAuth();
        const res = await getAuth().handler(
            new Request(`${ORIGIN}${AUTH_BASE_PATH}/sign-in/social`, {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    origin: ORIGIN,
                },
                body: JSON.stringify({
                    provider: PROVIDER_ID,
                    callbackURL: "/",
                }),
            }),
        );
        assert.ok(res.status >= 400, `status ${res.status}`);
    });
});
