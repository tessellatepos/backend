import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pool } from "@/services/db/postgres";
import { createAuth, getAuth } from "@/services/auth";
import { decrypt } from "@/services/crypto";
import { authProviders } from "@/auth/providers";
import { authProvidersv1Endpoint } from "@/endpoints/v1/authProviders";
import { startTestApp, type TestApp } from "./helpers/app";
import { migrateTestDb } from "./helpers/db";

const suffix = randomUUID().slice(0, 8);
const PASSWORD = "correct-horse-battery";
const SECRET = `s3cr3t-${suffix}`;
const CODE_SECRET = `code-s3cr3t-${suffix}`;
const ids = {
    social: `soc-${suffix}`,
    oauth: `oauth-${suffix}`,
    oidc: `oidc-${suffix}`,
    pin: `pin-${suffix}`,
};

async function signIn(email: string) {
    const { headers } = await createAuth().api.signInEmail({
        body: { email, password: PASSWORD },
        returnHeaders: true,
    });
    return (headers.get("set-cookie") ?? "").split(";")[0];
}

/** Collects everything written to stdout and stderr while `fn` runs. */
async function captureOutput<T>(fn: () => Promise<T>) {
    const chunks: string[] = [];
    const out = process.stdout.write.bind(process.stdout);
    const err = process.stderr.write.bind(process.stderr);
    const grab = (chunk: unknown) => {
        chunks.push(String(chunk));
        return true;
    };
    process.stdout.write = grab as typeof process.stdout.write;
    process.stderr.write = grab as typeof process.stderr.write;
    try {
        return { result: await fn(), output: chunks.join("") };
    } finally {
        process.stdout.write = out;
        process.stderr.write = err;
    }
}

describe("auth provider settings endpoints", () => {
    let server: TestApp;
    let owner: string;
    let viewer: string;
    const base = () => `${server.url}/api/v1/auth-providers`;
    const call = (
        path: string,
        init: { method?: string; cookie?: string; body?: unknown } = {},
    ) =>
        fetch(`${base()}${path}`, {
            method: init.method ?? "GET",
            headers: {
                "content-type": "application/json",
                ...(init.cookie ? { cookie: init.cookie } : {}),
            },
            body:
                init.method === "PUT"
                    ? JSON.stringify(init.body ?? {})
                    : undefined,
        });
    const dbRow = async (id: string) =>
        (
            await pool.query(
                `SELECT * FROM "tessellate-auth-providers" WHERE provider_id = $1`,
                [id],
            )
        ).rows[0];

    before(async () => {
        await migrateTestDb();
        authProviders.clear();
        authProviders.register({
            pluginName: "acme",
            authRoles: ["cashier"],
            provider: {
                id: ids.social,
                label: "GitHub",
                social: { provider: "github", clientId: "", clientSecret: "" },
            },
        });
        authProviders.register({
            pluginName: "acme",
            authRoles: ["cashier"],
            provider: {
                id: ids.oauth,
                label: "Legacy",
                oauth: {
                    authorizationUrl: "https://idp.example.test/auth",
                    tokenUrl: "https://idp.example.test/token",
                    userInfoUrl: "https://idp.example.test/me",
                    clientId: "code-id",
                    clientSecret: CODE_SECRET,
                },
            },
        });
        authProviders.register({
            pluginName: "acme",
            authRoles: [],
            provider: {
                id: ids.oidc,
                label: "Acme SSO",
                oidc: {
                    discoveryUrl: "",
                    clientId: "",
                    clientSecret: "",
                },
            },
        });
        authProviders.register({
            pluginName: "acme",
            authRoles: [],
            provider: {
                id: ids.pin,
                label: "PIN",
                betterAuthPlugin: { id: ids.pin },
            },
        });
        const auth = createAuth();
        for (const role of ["owner", "viewer"] as const) {
            await auth.api.createUser({
                body: {
                    email: `${role}-${suffix}@example.test`,
                    password: PASSWORD,
                    name: role,
                    role,
                },
            });
        }
        owner = await signIn(`owner-${suffix}@example.test`);
        viewer = await signIn(`viewer-${suffix}@example.test`);
        server = await startTestApp((app) => {
            app.use("/api/v1/auth-providers", authProvidersv1Endpoint.router);
        });
    });

    after(async () => {
        await server.close();
        authProviders.clear();
        await pool.query(
            `DELETE FROM "tessellate-auth-providers" WHERE provider_id = ANY($1)`,
            [Object.values(ids)],
        );
        await pool.query(
            `DELETE FROM "tessellate-auth-user" WHERE email LIKE $1`,
            [`%-${suffix}@example.test`],
        );
        await pool.end();
    });

    it("answers 401 without a session and 403 for a non-owner", async () => {
        for (const [method, path] of [
            ["GET", "/"],
            ["PUT", `/${ids.social}`],
        ]) {
            assert.equal((await call(path, { method })).status, 401);
            assert.equal(
                (await call(path, { method, cookie: viewer, body: {} })).status,
                403,
            );
        }
        assert.equal(await dbRow(ids.social), undefined);
    });

    it("lets the owner list providers, with no secrets", async () => {
        const res = await call("/", { cookie: owner });
        assert.equal(res.status, 200);
        const text = await res.text();
        assert.ok(!text.includes(CODE_SECRET));
        const list = JSON.parse(text) as Record<string, unknown>[];
        const byId = Object.fromEntries(list.map((p) => [p.id, p]));
        assert.deepEqual(byId[ids.oauth], {
            id: ids.oauth,
            label: "Legacy",
            kind: "oauth",
            plugin: "acme",
            enabled: false,
            configured: true,
            fields: { clientId: "code-id", hasSecret: true },
        });
        assert.deepEqual(byId[ids.social], {
            id: ids.social,
            label: "GitHub",
            kind: "social",
            plugin: "acme",
            enabled: false,
            configured: false,
            fields: { clientId: "", hasSecret: false },
        });
        assert.equal(
            (byId[ids.oidc] as { configured: boolean }).configured,
            false,
        );
        assert.deepEqual(byId[ids.pin].fields, { hasSecret: false });
    });

    it("keeps the public list empty until a provider is enabled and configured", async () => {
        const names = async () => {
            const res = await call("/public");
            assert.equal(res.status, 200);
            return ((await res.json()) as { id: string }[])
                .map((p) => p.id)
                .filter((id) => Object.values(ids).includes(id));
        };
        assert.deepEqual(await names(), []);

        // Enabled but missing credentials: still not offered.
        let res = await call(`/${ids.social}`, {
            method: "PUT",
            cookie: owner,
            body: { enabled: true },
        });
        assert.equal(res.status, 200);
        assert.deepEqual(await names(), []);

        res = await call(`/${ids.social}`, {
            method: "PUT",
            cookie: owner,
            body: { clientId: "gh-id", clientSecret: SECRET },
        });
        assert.equal(res.status, 200);
        const text = await res.text();
        assert.ok(!text.includes(SECRET));
        assert.deepEqual(JSON.parse(text), {
            id: ids.social,
            label: "GitHub",
            kind: "social",
            plugin: "acme",
            enabled: true,
            configured: true,
            fields: { clientId: "gh-id", hasSecret: true },
        });

        // The public list is reachable without a session and reveals no config.
        const pub = await call("/public");
        const body = await pub.text();
        assert.ok(!body.includes("gh-id") && !body.includes(SECRET));
        assert.deepEqual(
            (JSON.parse(body) as unknown[]).filter((p) =>
                JSON.stringify(p).includes(suffix),
            ),
            [{ id: ids.social, label: "GitHub", kind: "social" }],
        );

        res = await call(`/${ids.social}`, {
            method: "PUT",
            cookie: owner,
            body: { enabled: false },
        });
        assert.equal(res.status, 200);
        assert.deepEqual(await names(), []);
    });

    it("stores the secret encrypted, and an empty secret means unchanged", async () => {
        await call(`/${ids.social}`, {
            method: "PUT",
            cookie: owner,
            body: { clientId: "gh-id", clientSecret: SECRET },
        });
        const row = await dbRow(ids.social);
        assert.ok(!JSON.stringify(row).includes(SECRET));
        assert.deepEqual(JSON.parse(decrypt(row.config)), {
            clientId: "gh-id",
            clientSecret: SECRET,
        });

        const res = await call(`/${ids.social}`, {
            method: "PUT",
            cookie: owner,
            body: { clientId: "gh-id-2", clientSecret: "" },
        });
        assert.equal(res.status, 200);
        const after = JSON.parse(decrypt((await dbRow(ids.social)).config));
        assert.deepEqual(after, { clientId: "gh-id-2", clientSecret: SECRET });
        assert.equal(
            ((await res.json()) as { configured: boolean }).configured,
            true,
        );
    });

    it("never logs or returns a secret", async () => {
        const { result, output } = await captureOutput(async () => {
            const bodies: string[] = [];
            for (const [path, init] of [
                [
                    `/${ids.oidc}`,
                    {
                        body: {
                            clientSecret: SECRET,
                            discoveryUrl: "nonsense",
                        },
                    },
                ],
                [`/${ids.oidc}`, { body: { clientSecret: 5 } }],
                [`/${ids.pin}`, { body: { clientSecret: SECRET } }],
                ["/nope", { body: { clientSecret: SECRET } }],
                [
                    `/${ids.social}`,
                    { body: { clientSecret: SECRET, enabled: true } },
                ],
            ] as const) {
                const res = await call(path, {
                    method: "PUT",
                    cookie: owner,
                    ...init,
                });
                bodies.push(await res.text());
            }
            bodies.push(await (await call("/", { cookie: owner })).text());
            bodies.push(await (await call("/public")).text());
            return bodies;
        });
        for (const text of [...result, output]) {
            assert.ok(!text.includes(SECRET), "secret leaked");
            assert.ok(!text.includes(CODE_SECRET), "code secret leaked");
        }
    });

    it("validates the body and the provider", async () => {
        const put = (id: string, body: unknown) =>
            call(`/${id}`, { method: "PUT", cookie: owner, body });
        assert.equal((await put("missing", {})).status, 404);
        assert.equal((await put(ids.social, { enabled: "yes" })).status, 400);
        assert.equal(
            (await put(ids.oidc, { discoveryUrl: "nonsense" })).status,
            400,
        );
        assert.equal(
            (await put(ids.oidc, { discoveryUrl: "javascript:alert(1)" }))
                .status,
            400,
        );
        assert.equal(
            (await put(ids.social, { discoveryUrl: "https://a.test" })).status,
            400,
        );
        assert.equal((await put(ids.oauth, { scopes: [1] })).status, 400);
        assert.equal((await put(ids.social, { scopes: ["a"] })).status, 400);
        assert.equal((await put(ids.pin, { clientId: "x" })).status, 400);
        assert.equal((await put(ids.pin, { enabled: true })).status, 200);
        assert.equal(
            (
                await put(ids.oidc, {
                    discoveryUrl:
                        "https://idp.test/.well-known/openid-configuration",
                    clientId: "i",
                    clientSecret: "s",
                    scopes: ["email"],
                })
            ).status,
            200,
        );
    });

    it("rebuilds the auth instance on change and keeps sessions", async () => {
        const providerIds = async () =>
            (await getAuth().$context).socialProviders.map((p) => p.id);

        await call(`/${ids.social}`, {
            method: "PUT",
            cookie: owner,
            body: { enabled: false },
        });
        await call(`/${ids.oauth}`, {
            method: "PUT",
            cookie: owner,
            body: { enabled: false },
        });
        const before = getAuth();
        assert.ok(!(await providerIds()).includes("github"));
        assert.ok(!(await providerIds()).includes(ids.oauth));

        await call(`/${ids.oauth}`, {
            method: "PUT",
            cookie: owner,
            body: { enabled: true },
        });
        assert.notEqual(
            getAuth(),
            before,
            "a new instance replaced the old one",
        );
        assert.ok((await providerIds()).includes(ids.oauth));

        await call(`/${ids.social}`, {
            method: "PUT",
            cookie: owner,
            body: { enabled: true },
        });
        assert.ok((await providerIds()).includes("github"));

        // The earlier session still works on the new instance.
        const res = await call("/", { cookie: owner });
        assert.equal(res.status, 200);

        await call(`/${ids.oauth}`, {
            method: "PUT",
            cookie: owner,
            body: { enabled: false },
        });
        assert.ok(!(await providerIds()).includes(ids.oauth));
    });
});
