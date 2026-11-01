import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { eq } from "drizzle-orm";
import { pool } from "@/services/db/postgres";
import { drizzleDB } from "@/services/db/postgres";
import { apiCredentialsTable } from "@/services/db/schema";
import { createAuth } from "@/services/auth";
import { createLocalLocation, removeLocation } from "@/services/db/locations";
import {
    authenticateCredential,
    CredentialNotFoundError,
    CredentialValidationError,
    createCredential,
    getCredential,
    getWebhookSecret,
    listCredentials,
    revokeCredential,
    rotateSecret,
    rotateWebhookSecret,
    updateCredential,
} from "@/services/credentials";
import { getRedisClient } from "@/services/redis";
import { createApp, mountApiRoutes } from "@/app";
import { TessellatePluginRegistry } from "@/utils/registry/plugin/pluginRegistry";
import { resolvePrincipal } from "@/auth/principal";
import { resolveCredentialPrincipal } from "@/gateway/principal";
import { migrateTestDb } from "./helpers/db";

// One pool for the file: each suite shares it, so it closes once, at the end.
after(async () => {
    await pool.end();
    await (await getRedisClient())?.quit();
});

const suffix = randomUUID().slice(0, 8);
const base = (locationId: string) => ({
    name: "Online store",
    scopes: ["catalog:read", "orders:write"] as const,
    location_ids: [locationId],
});

describe("gateway credentials service", () => {
    let locationId: string;
    const created: string[] = [];

    before(async () => {
        await migrateTestDb();
        locationId = (
            await createLocalLocation({
                name: `Credentials ${suffix}`,
                currency: "CAD",
                country: "CA",
            })
        ).id;
    });

    after(async () => {
        for (const id of created) {
            await pool.query(
                `DELETE FROM "tessellate-api-credentials" WHERE id = $1`,
                [id],
            );
        }
        await removeLocation(locationId);
    });

    async function make(overrides: Record<string, unknown> = {}) {
        const result = await createCredential(
            { ...base(locationId), ...overrides } as never,
            "owner-user",
        );
        created.push(result.client_id);
        return result;
    }

    it("creates a credential with id, secret and webhook secret", async () => {
        const result = await make();
        assert.match(result.client_id, /^tcid_/);
        assert.match(result.client_secret, /^tcs_/);
        assert.match(result.webhook_secret, /^whsec_/);
        assert.equal(result.credential.id, result.client_id);
        assert.equal(result.credential.rate_limit_per_minute, 120);
        assert.equal(result.credential.expires_at, null);
        assert.deepEqual(result.credential.origins, []);
    });

    it("stores the secret as a hash and the webhook secret encrypted", async () => {
        const result = await make();
        const [row] = await drizzleDB
            .select()
            .from(apiCredentialsTable)
            .where(eq(apiCredentialsTable.id, result.client_id));
        const stored = JSON.stringify(row);
        assert.ok(!stored.includes(result.client_secret));
        assert.ok(!stored.includes(result.webhook_secret));
        assert.equal(row.secret_hash.length, 64);
        assert.equal(
            await getWebhookSecret(result.client_id),
            result.webhook_secret,
        );
    });

    it("never returns a secret or hash from list or get", async () => {
        const result = await make();
        const texts = [
            JSON.stringify(await getCredential(result.client_id)),
            JSON.stringify(await listCredentials()),
        ];
        for (const text of texts) {
            assert.ok(!text.includes(result.client_secret));
            assert.ok(!text.includes(result.webhook_secret));
            assert.ok(!text.includes("secret_hash"));
            assert.ok(!text.includes("webhook_secret"));
        }
    });

    it("authenticates the right secret and refuses a wrong one or an unknown id", async () => {
        const result = await make();
        assert.ok(
            await authenticateCredential(
                result.client_id,
                result.client_secret,
            ),
        );
        assert.equal(
            await authenticateCredential(result.client_id, "tcs_nope"),
            null,
        );
        assert.equal(
            await authenticateCredential("tcid_unknown", result.client_secret),
            null,
        );
    });

    it("treats a client id with no secret as publishable", async () => {
        const result = await make();
        const auth = await authenticateCredential(result.client_id, "");
        assert.equal(auth?.publishable, true);
        const secret = await authenticateCredential(
            result.client_id,
            result.client_secret,
        );
        assert.equal(secret?.publishable, false);
    });

    it("refuses a revoked credential", async () => {
        const result = await make();
        await revokeCredential(result.client_id);
        assert.equal(
            await authenticateCredential(
                result.client_id,
                result.client_secret,
            ),
            null,
        );
        await assert.rejects(
            rotateSecret(result.client_id),
            CredentialValidationError,
        );
    });

    it("refuses an expired credential", async () => {
        const result = await make({
            expires_at: new Date(Date.now() + 60_000).toISOString(),
        });
        const later = new Date(Date.now() + 120_000);
        assert.equal(
            await authenticateCredential(
                result.client_id,
                result.client_secret,
                later,
            ),
            null,
        );
        assert.ok(
            await authenticateCredential(
                result.client_id,
                result.client_secret,
            ),
        );
    });

    it("rotates the secret: the old one stops at once with no overlap", async () => {
        const result = await make();
        const rotated = await rotateSecret(result.client_id);
        assert.equal(rotated.credential.id, result.client_id);
        assert.notEqual(rotated.client_secret, result.client_secret);
        assert.equal(
            await authenticateCredential(
                result.client_id,
                result.client_secret,
            ),
            null,
        );
        assert.ok(
            await authenticateCredential(
                result.client_id,
                rotated.client_secret,
            ),
        );
    });

    it("keeps the old secret for the chosen overlap, then ends it", async () => {
        const result = await make();
        const rotated = await rotateSecret(result.client_id, 3600);
        assert.ok(
            await authenticateCredential(
                result.client_id,
                result.client_secret,
            ),
        );
        assert.ok(
            await authenticateCredential(
                result.client_id,
                rotated.client_secret,
            ),
        );
        const afterOverlap = new Date(Date.now() + 3601 * 1000);
        assert.equal(
            await authenticateCredential(
                result.client_id,
                result.client_secret,
                afterOverlap,
            ),
            null,
        );
    });

    it("rotates the webhook secret and shows the new one once", async () => {
        const result = await make();
        const rotated = await rotateWebhookSecret(result.client_id);
        assert.notEqual(rotated.webhook_secret, result.webhook_secret);
        assert.equal(
            await getWebhookSecret(result.client_id),
            rotated.webhook_secret,
        );
    });

    it("updates the editable settings but not the secret", async () => {
        const result = await make();
        const updated = await updateCredential(result.client_id, {
            name: "Renamed",
            origins: ["https://shop.example.test"],
            rate_limit_per_minute: 30,
        });
        assert.equal(updated.name, "Renamed");
        assert.deepEqual(updated.origins, ["https://shop.example.test"]);
        assert.ok(
            await authenticateCredential(
                result.client_id,
                result.client_secret,
            ),
        );
    });

    it("refuses scopes that may not be granted", async () => {
        for (const scope of [
            "*",
            "credentials:admin",
            "settings:admin",
            "nope",
        ]) {
            await assert.rejects(
                make({ scopes: [scope] }),
                CredentialValidationError,
                scope,
            );
        }
        const plugin = await make({ scopes: ["plugin:loyalty-sidebar:read"] });
        assert.deepEqual(plugin.credential.scopes, [
            "plugin:loyalty-sidebar:read",
        ]);
    });

    it("refuses an unknown location, and an empty location list", async () => {
        await assert.rejects(
            make({ location_ids: ["no-such-location"] }),
            CredentialValidationError,
        );
        await assert.rejects(
            make({ location_ids: [] }),
            CredentialValidationError,
        );
    });

    it("refuses bad origins and webhook URLs", async () => {
        const bad: Record<string, unknown>[] = [
            { origins: ["https://shop.example.test/path"] },
            { origins: ["http://shop.example.test"] },
            { origins: ["*"] },
            { webhook_url: "http://example.test/hook" },
            { webhook_url: "https://user:pass@example.test/hook" },
            { webhook_url: "not a url" },
        ];
        for (const overrides of bad) {
            await assert.rejects(
                make(overrides),
                CredentialValidationError,
                JSON.stringify(overrides),
            );
        }
        const local = await make({
            origins: ["http://localhost:5173"],
            webhook_url: "http://127.0.0.1:9000/hook",
        });
        assert.deepEqual(local.credential.origins, ["http://localhost:5173"]);
    });

    it("refuses an expiry in the past and a rate limit out of range", async () => {
        await assert.rejects(
            make({ expires_at: new Date(Date.now() - 1000).toISOString() }),
            CredentialValidationError,
        );
        await assert.rejects(
            make({ rate_limit_per_minute: 0 }),
            CredentialValidationError,
        );
        await assert.rejects(
            make({ rate_limit_per_minute: 10_001 }),
            CredentialValidationError,
        );
    });

    it("reports a missing credential as not found", async () => {
        await assert.rejects(
            rotateSecret("tcid_missing"),
            CredentialNotFoundError,
        );
        await assert.rejects(
            revokeCredential("tcid_missing"),
            CredentialNotFoundError,
        );
    });
});

describe("credential principal resolution", () => {
    let locationId: string;
    before(async () => {
        await migrateTestDb();
        locationId = (
            await createLocalLocation({
                name: `Principal ${suffix}`,
                currency: "CAD",
                country: "CA",
            })
        ).id;
    });
    after(async () => {
        await removeLocation(locationId);
    });

    const basic = (id: string, secret: string) =>
        `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`;

    it("turns a valid Basic credential into a credential principal", async () => {
        const result = await createCredential(
            { name: "P", scopes: ["catalog:read"], location_ids: [locationId] },
            "owner-user",
        );
        const req = {
            headers: {
                authorization: basic(result.client_id, result.client_secret),
            },
        } as never;
        const principal = await resolveCredentialPrincipal(req);
        assert.equal(principal?.kind, "credential");
        assert.deepEqual(principal?.scopes, ["catalog:read"]);
        assert.deepEqual(principal?.location_ids, [locationId]);
        assert.equal(principal?.id, result.client_id);
    });

    it("refuses a wrong secret and a malformed header", async () => {
        const result = await createCredential(
            { name: "Q", scopes: ["catalog:read"], location_ids: [locationId] },
            "owner-user",
        );
        const wrong = {
            headers: { authorization: basic(result.client_id, "tcs_wrong") },
        } as never;
        assert.equal(await resolveCredentialPrincipal(wrong), null);
        const malformed = { headers: { authorization: "Basic !!!" } } as never;
        assert.equal(await resolveCredentialPrincipal(malformed), null);
    });

    it("never accepts a credential on an internal route", async () => {
        const result = await createCredential(
            { name: "R", scopes: ["catalog:read"], location_ids: [locationId] },
            "owner-user",
        );
        const req = {
            surface: "internal",
            headers: {
                authorization: basic(result.client_id, result.client_secret),
            },
        } as never;
        assert.equal(await resolvePrincipal(req), null);
    });
});

describe("credential admin endpoints", () => {
    let server: Server;
    let url: string;
    let locationId: string;
    const suffixRole = randomUUID().slice(0, 8);
    const cookies: Record<string, string> = {};
    const created: string[] = [];

    before(async () => {
        await migrateTestDb();
        locationId = (
            await createLocalLocation({
                name: `Admin ${suffix}`,
                currency: "CAD",
                country: "CA",
            })
        ).id;
        const auth = createAuth();
        for (const role of ["manager", "owner"]) {
            const email = `${role}-cred-${suffixRole}@example.test`;
            await auth.api.createUser({
                body: {
                    email,
                    password: "correct-horse-battery",
                    name: role,
                    role: role as "owner",
                },
            });
            const { headers } = await auth.api.signInEmail({
                body: { email, password: "correct-horse-battery" },
                returnHeaders: true,
            });
            cookies[role] = (headers.get("set-cookie") ?? "").split(";")[0];
        }
        const app = createApp();
        app.locals.pluginRegistry = new TessellatePluginRegistry();
        mountApiRoutes(app, app.locals.pluginRegistry.apiRegistry);
        server = await new Promise((resolve) => {
            const s = app.listen(0, "127.0.0.1", () => resolve(s));
        });
        url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    after(async () => {
        for (const id of created) {
            await pool.query(
                `DELETE FROM "tessellate-api-credentials" WHERE id = $1`,
                [id],
            );
        }
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await removeLocation(locationId);
        await pool.query(
            `DELETE FROM "tessellate-auth-user" WHERE email LIKE $1`,
            [`%-cred-${suffixRole}@example.test`],
        );
    });

    const call = (
        method: string,
        path: string,
        opts: { cookie?: string; body?: unknown; basic?: string } = {},
    ) =>
        fetch(url + path, {
            method,
            headers: {
                "content-type": "application/json",
                ...(opts.cookie ? { cookie: opts.cookie } : {}),
                ...(opts.basic ? { authorization: opts.basic } : {}),
            },
            body:
                opts.body === undefined ? undefined : JSON.stringify(opts.body),
        });

    it("answers 401 without a session and 403 for a manager", async () => {
        assert.equal((await call("GET", "/api/v1/credentials")).status, 401);
        assert.equal(
            (
                await call("GET", "/api/v1/credentials", {
                    cookie: cookies.manager,
                })
            ).status,
            403,
        );
        assert.equal(
            (
                await call("POST", "/api/v1/credentials", {
                    cookie: cookies.manager,
                    body: {},
                })
            ).status,
            403,
        );
    });

    it("lets the owner create, read, update, rotate, revoke", async () => {
        const create = await call("POST", "/api/v1/credentials", {
            cookie: cookies.owner,
            body: {
                name: "Store",
                scopes: ["catalog:read"],
                location_ids: [locationId],
            },
        });
        assert.equal(create.status, 201);
        const secret = (await create.json()) as {
            client_id: string;
            client_secret: string;
            webhook_secret: string;
        };
        created.push(secret.client_id);
        assert.match(secret.client_secret, /^tcs_/);

        const get = await call(
            "GET",
            `/api/v1/credentials/${secret.client_id}`,
            { cookie: cookies.owner },
        );
        const getText = await get.text();
        assert.equal(get.status, 200);
        assert.ok(!getText.includes(secret.client_secret));

        const patch = await call(
            "PATCH",
            `/api/v1/credentials/${secret.client_id}`,
            {
                cookie: cookies.owner,
                body: { name: "Renamed" },
            },
        );
        assert.equal(patch.status, 200);

        const rotate = await call(
            "POST",
            `/api/v1/credentials/${secret.client_id}/rotate`,
            {
                cookie: cookies.owner,
                body: {},
            },
        );
        assert.equal(rotate.status, 200);
        const rotated = (await rotate.json()) as { client_secret: string };
        assert.notEqual(rotated.client_secret, secret.client_secret);

        const revoke = await call(
            "POST",
            `/api/v1/credentials/${secret.client_id}/revoke`,
            {
                cookie: cookies.owner,
            },
        );
        assert.equal(revoke.status, 200);
        assert.equal(
            await authenticateCredential(
                secret.client_id,
                rotated.client_secret,
            ),
            null,
        );
    });

    it("refuses a PATCH that tries to change a secret", async () => {
        const created1 = await createCredential(
            { name: "S", scopes: ["catalog:read"], location_ids: [locationId] },
            "owner-user",
        );
        created.push(created1.client_id);
        const res = await call(
            "PATCH",
            `/api/v1/credentials/${created1.client_id}`,
            {
                cookie: cookies.owner,
                body: { secret_hash: "x" },
            },
        );
        assert.equal(res.status, 400);
    });

    it("answers 404 for an unknown credential", async () => {
        const res = await call("GET", "/api/v1/credentials/tcid_missing", {
            cookie: cookies.owner,
        });
        assert.equal(res.status, 404);
    });

    it("ignores a credential presented to an internal route", async () => {
        const result = await createCredential(
            { name: "T", scopes: ["catalog:read"], location_ids: [locationId] },
            "owner-user",
        );
        created.push(result.client_id);
        const basic = `Basic ${Buffer.from(`${result.client_id}:${result.client_secret}`).toString("base64")}`;
        const res = await call("GET", "/api/v1/items/by-location/", { basic });
        assert.equal(res.status, 401);
    });
});
