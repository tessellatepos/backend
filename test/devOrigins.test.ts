import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pool } from "@/services/db/postgres";
import { AUTH_BASE_PATH, createAuth } from "@/services/auth";
import { urlConfig } from "@/config/urls";
import { migrateTestDb } from "./helpers/db";

const suffix = randomUUID().slice(0, 8);
const PASSWORD = "correct-horse-battery";

describe("sign-out from a dev proxy origin", () => {
    let cookie: string;
    const original = urlConfig.allowDevOrigins;

    async function signOut(origin: string) {
        return createAuth().handler(
            new Request(`http://localhost:3190${AUTH_BASE_PATH}/sign-out`, {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    origin,
                    cookie,
                },
                body: "{}",
            }),
        );
    }

    before(async () => {
        await migrateTestDb();
        const auth = createAuth();
        const email = `signout-${suffix}@example.test`;
        await auth.api.createUser({
            body: { email, password: PASSWORD, name: "Out", role: "viewer" },
        });
        const { headers } = await auth.api.signInEmail({
            body: { email, password: PASSWORD },
            returnHeaders: true,
        });
        cookie = (headers.get("set-cookie") ?? "").split(";")[0];
    });

    after(async () => {
        urlConfig.allowDevOrigins = original;
        await pool.query(
            `DELETE FROM "tessellate-auth-user" WHERE email LIKE $1`,
            [`%-${suffix}@example.test`],
        );
        await pool.end();
    });

    it("succeeds outside production", async () => {
        urlConfig.allowDevOrigins = true;
        const res = await signOut("http://localhost:5999");
        assert.equal(res.status, 200);
    });

    it("is rejected with INVALID_ORIGIN in production mode", async () => {
        urlConfig.allowDevOrigins = false;
        const res = await signOut("http://localhost:5999");
        assert.equal(res.status, 403);
        const body = (await res.json()) as { code?: string };
        assert.equal(body.code, "INVALID_ORIGIN");
    });

    it("rejects a foreign origin even outside production", async () => {
        urlConfig.allowDevOrigins = true;
        const res = await signOut("https://evil.example");
        assert.equal(res.status, 403);
    });
});
