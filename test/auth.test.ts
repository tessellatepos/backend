import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { pool } from "@/services/db/postgres";
import { AUTH_BASE_PATH, createAuth, getAuth } from "@/services/auth";

describe("auth factory", () => {
    after(async () => {
        await pool.end();
    });

    it("getAuth throws before createAuth is called", () => {
        assert.throws(() => getAuth(), /createAuth/);
    });

    it("createAuth builds an instance that getAuth returns", () => {
        const auth = createAuth();
        assert.equal(getAuth(), auth);
        assert.equal(auth.options.basePath, AUTH_BASE_PATH);
    });

    it("createAuth replaces the current instance", () => {
        const first = createAuth();
        const second = createAuth();
        assert.notEqual(first, second);
        assert.equal(getAuth(), second);
    });
});
