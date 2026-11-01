import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Principal } from "@tessellatepos/sdk";
import { pool } from "@/services/db/postgres";
import { createAuth } from "@/services/auth";
import { authv1Endpoint } from "@/endpoints/v1/auth";
import {
    DEVICE_SCOPES,
    hashDeviceToken,
    issueDeviceToken,
    resolveDeviceToken,
} from "@/auth/deviceToken";
import {
    createConfigDevice,
    deleteConfigDevice,
    getConfigDeviceByID,
    updateConfigDevice,
    withoutTokenHash,
} from "@/services/db/configDevice";
import { startTestApp, type TestApp } from "./helpers/app";
import { migrateTestDb } from "./helpers/db";

const suffix = randomUUID().slice(0, 8);
const PASSWORD = "correct-horse-battery";
const TOKEN_URL = "/api/v1/auth/device-token";

async function sessionCookie(role: "owner" | "viewer") {
    const auth = createAuth();
    const email = `${role}-${suffix}@example.test`;
    await auth.api.createUser({
        body: { email, password: PASSWORD, name: role, role },
    });
    const { headers } = await auth.api.signInEmail({
        body: { email, password: PASSWORD },
        returnHeaders: true,
    });
    return (headers.get("set-cookie") ?? "").split(";")[0];
}

describe("device tokens", () => {
    let server: TestApp;
    let owner: string;
    let viewer: string;
    const deviceIds: string[] = [];

    before(async () => {
        await migrateTestDb();
        owner = await sessionCookie("owner");
        viewer = await sessionCookie("viewer");
        server = await startTestApp((app) => {
            app.use("/api/v1/auth", authv1Endpoint.router);
            app.get("/me", (req, res) => {
                res.json(req.principal);
            });
            app.get("/gateway/me", (req, res) => {
                res.json(req.principal);
            });
        });
    });

    after(async () => {
        await server.close();
        for (const id of deviceIds) await deleteConfigDevice(id);
        await pool.query(
            `DELETE FROM "tessellate-auth-user" WHERE email LIKE $1`,
            [`%-${suffix}@example.test`],
        );
        await pool.end();
    });

    async function newDevice(paired = false, location: string | null = null) {
        const device = await createConfigDevice();
        deviceIds.push(device.id);
        if (paired) {
            await updateConfigDevice(device.id, {
                pairing_code: null,
                paired_at: new Date(),
                square_location: location,
            });
        }
        return device;
    }

    const post = (body: unknown, cookie?: string) =>
        fetch(server.url + TOKEN_URL, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                ...(cookie ? { cookie } : {}),
            },
            body: JSON.stringify(body),
        });
    const me = async (path: string, token: string) =>
        (await (
            await fetch(server.url + path, {
                headers: { authorization: `Bearer ${token}` },
            })
        ).json()) as Principal | null;

    it("rejects an exchange with no proof of pairing", async () => {
        const device = await newDevice();
        assert.equal((await post({ deviceId: device.id })).status, 401);
        assert.equal(
            (await post({ deviceId: device.id, pairingCode: "WRONGCOD" }))
                .status,
            401,
        );
        assert.equal(
            (await post({ deviceId: "NOSUCHDEVICE", pairingCode: "x" })).status,
            401,
        );
        assert.equal((await post({})).status, 400);
        assert.equal((await post({ deviceId: device.id }, viewer)).status, 401);
    });

    it("issues a tsd_ token for the live pairing code and stores only its hash", async () => {
        const device = await newDevice();
        const res = await post({
            deviceId: device.id,
            pairingCode: device.pairing_code,
        });
        assert.equal(res.status, 200);
        const { token } = (await res.json()) as { token: string };
        assert.match(token, /^tsd_[A-Za-z0-9_-]{43}$/);
        const row = await getConfigDeviceByID(device.id);
        assert.equal(row?.device_token_hash, hashDeviceToken(token));
        assert.ok(
            !JSON.stringify(row).includes(token),
            "plaintext token must not be stored",
        );
        assert.ok(!("device_token_hash" in withoutTokenHash(row!)));
    });

    it("resolves only once the device is paired, pinned to its location", async () => {
        const device = await newDevice();
        const token = (await issueDeviceToken(device.id))!;
        assert.equal(await me("/me", token), null);

        await updateConfigDevice(device.id, {
            pairing_code: null,
            paired_at: new Date(),
            square_location: "LOC123",
        });
        const p = await me("/me", token);
        assert.deepEqual(p, {
            kind: "device",
            id: device.id,
            roles: ["device"],
            scopes: [...DEVICE_SCOPES],
            location_ids: ["LOC123"],
        });
        assert.ok(!p!.scopes.includes("devices:admin"));
    });

    it("grants all locations to an unpinned device", async () => {
        const device = await newDevice(true);
        const token = (await issueDeviceToken(device.id))!;
        assert.equal((await me("/me", token))?.location_ids, "all");
    });

    it("never resolves on the gateway surface", async () => {
        const device = await newDevice(true);
        const token = (await issueDeviceToken(device.id))!;
        assert.equal(await me("/gateway/me", token), null);
    });

    it("closes the pairing-code path once paired; an admin can still rotate", async () => {
        const device = await newDevice(true);
        assert.equal(
            (await post({ deviceId: device.id, pairingCode: "" })).status,
            401,
        );
        const first = (await (
            await post({ deviceId: device.id }, owner)
        ).json()) as { token: string };
        const second = (await (
            await post({ deviceId: device.id }, owner)
        ).json()) as { token: string };
        assert.equal(await resolveDeviceToken(first.token), null);
        assert.equal((await resolveDeviceToken(second.token))?.id, device.id);
    });

    it("revokes with devices:admin only, and the token stops working", async () => {
        const device = await newDevice(true);
        const token = (await issueDeviceToken(device.id))!;
        const url = `${server.url}${TOKEN_URL}/${device.id}`;
        assert.equal((await fetch(url, { method: "DELETE" })).status, 401);
        assert.equal(
            (
                await fetch(url, {
                    method: "DELETE",
                    headers: { cookie: viewer },
                })
            ).status,
            403,
        );
        assert.equal((await me("/me", token))?.id, device.id);

        const ok = await fetch(url, {
            method: "DELETE",
            headers: { cookie: owner },
        });
        assert.equal(ok.status, 200);
        assert.equal(await me("/me", token), null);
        assert.equal(
            (await getConfigDeviceByID(device.id))?.device_token_hash,
            null,
        );

        const missing = await fetch(`${server.url}${TOKEN_URL}/NOSUCH`, {
            method: "DELETE",
            headers: { cookie: owner },
        });
        assert.equal(missing.status, 404);
    });

    it("rejects malformed tokens", async () => {
        assert.equal(await resolveDeviceToken("nope"), null);
        assert.equal(await resolveDeviceToken("tsd_"), null);
    });
});
