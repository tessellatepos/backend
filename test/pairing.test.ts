import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { pool } from "@/services/db/postgres";
import { createAuth } from "@/services/auth";
import { authv1Endpoint, resetDeviceTokenLimits } from "@/endpoints/v1/auth";
import {
    PAIR_APPROVE_MAX,
    PAIR_REQUEST_MAX,
    configDevicev1Endpoint,
    resetPairingLimits,
} from "@/endpoints/v1/config/devices";
import { DEVICE_TOKEN_MAX_FAILURES } from "@/endpoints/v1/auth";
import {
    createConfigDevice,
    deleteConfigDevice,
    getConfigDeviceByID,
} from "@/services/db/configDevice";
import { startTestApp, type TestApp } from "./helpers/app";
import { migrateTestDb } from "./helpers/db";

const suffix = randomUUID().slice(0, 8);
const PASSWORD = "correct-horse-battery";
const DEVICES = "/api/v1/config/devices";

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

describe("device pairing policy", () => {
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
            app.use(DEVICES, configDevicev1Endpoint.router);
        });
    });

    beforeEach(() => {
        resetPairingLimits();
        resetDeviceTokenLimits();
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

    const call = (
        method: string,
        path: string,
        opts: { cookie?: string; body?: unknown } = {},
    ) =>
        fetch(server.url + path, {
            method,
            headers: {
                "content-type": "application/json",
                ...(opts.cookie ? { cookie: opts.cookie } : {}),
            },
            body:
                opts.body === undefined ? undefined : JSON.stringify(opts.body),
        });

    async function newDevice() {
        const device = await createConfigDevice();
        deviceIds.push(device.id);
        return device;
    }

    it("lets anyone request a code, up to the limit, then answers 429", async () => {
        for (let i = 0; i < PAIR_REQUEST_MAX; i++) {
            const res = await call("GET", `${DEVICES}/pair-device/`);
            assert.equal(res.status, 200);
            deviceIds.push(((await res.json()) as { id: string }).id);
        }
        const limited = await call("GET", `${DEVICES}/pair-device/`);
        assert.equal(limited.status, 429);
        assert.ok(Number(limited.headers.get("retry-after")) >= 1);
    });

    it("needs devices:admin to approve a pairing", async () => {
        const device = await newDevice();
        const url = `${DEVICES}/pair-device/${device.pairing_code}`;
        const body = {
            device_hardware_id: "hw-1",
            device_type: "MOBILE_READER",
        };
        assert.equal((await call("PUT", url, { body })).status, 401);
        assert.equal(
            (await call("PUT", url, { cookie: viewer, body })).status,
            403,
        );
        const ok = await call("PUT", url, { cookie: owner, body });
        assert.equal(ok.status, 200);
        assert.ok((await getConfigDeviceByID(device.id))?.paired_at);
    });

    it("limits approvals per client, counting only authorised calls", async () => {
        const device = await newDevice();
        const url = `${DEVICES}/pair-device/${device.pairing_code}`;
        for (let i = 0; i < 40; i++) {
            assert.equal((await call("PUT", url, { body: {} })).status, 401);
        }
        for (let i = 0; i < PAIR_APPROVE_MAX; i++) {
            assert.equal(
                (await call("PUT", url, { cookie: owner, body: {} })).status,
                400,
            );
        }
        assert.equal(
            (await call("PUT", url, { cookie: owner, body: {} })).status,
            429,
        );
    });

    it("rejects a bad body with 400 naming the rule, not the value", async () => {
        const device = await newDevice();
        const url = `${DEVICES}/pair-device/${device.pairing_code}`;
        const cases: [unknown, RegExp][] = [
            [
                { device_hardware_id: "hw", device_type: "pos" },
                /device_type must be one of TERMINAL, MOBILE_READER/,
            ],
            [
                { device_hardware_id: "hw", device_type: 5 },
                /device_type must be one of/,
            ],
            [
                { device_type: "TERMINAL" },
                /device_hardware_id must be a non-empty string/,
            ],
            [
                { device_hardware_id: "  " },
                /device_hardware_id must be a non-empty string/,
            ],
            [
                { device_hardware_id: 12 },
                /device_hardware_id must be a non-empty string/,
            ],
        ];
        for (const [body, rule] of cases) {
            const res = await call("PUT", url, { cookie: owner, body });
            assert.equal(res.status, 400, JSON.stringify(body));
            const json = (await res.json()) as { message: string };
            assert.match(json.message, rule);
            assert.ok(!json.message.includes("pos"));
        }
        // still unpaired, and a body that is not an object is a 400 too
        assert.equal((await getConfigDeviceByID(device.id))?.paired_at, null);
        const res = await fetch(server.url + url, {
            method: "PUT",
            headers: { "content-type": "application/json", cookie: owner },
            body: "null",
        });
        assert.equal(res.status, 400);
    });

    it("rate limits failed device-token exchanges only", async () => {
        const device = await newDevice();
        const post = (body: unknown, cookie?: string) =>
            call("POST", "/api/v1/auth/device-token", { body, cookie });
        for (let i = 0; i < DEVICE_TOKEN_MAX_FAILURES; i++) {
            assert.equal(
                (await post({ deviceId: device.id, pairingCode: "WRONGCOD" }))
                    .status,
                401,
            );
        }
        assert.equal(
            (await post({ deviceId: device.id, pairingCode: "WRONGCOD" }))
                .status,
            429,
        );
        // the right code from the same client is held back too...
        assert.equal(
            (
                await post({
                    deviceId: device.id,
                    pairingCode: device.pairing_code,
                })
            ).status,
            429,
        );
        // ...but an admin is not, and a malformed request does not count
        assert.equal((await post({ deviceId: device.id }, owner)).status, 200);
        resetDeviceTokenLimits();
        for (let i = 0; i < DEVICE_TOKEN_MAX_FAILURES + 2; i++) {
            assert.equal((await post({})).status, 400);
        }
        for (let i = 0; i < DEVICE_TOKEN_MAX_FAILURES; i++) {
            assert.equal(
                (
                    await post({
                        deviceId: device.id,
                        pairingCode: device.pairing_code,
                    })
                ).status,
                200,
            );
        }
    });

    it("never logs the pairing code or a request body", async () => {
        const device = await newDevice();
        const secret = "HARDWARE-SECRET-ID";
        const chunks: string[] = [];
        const realWrite = process.stdout.write.bind(process.stdout);
        const realLog = console.log;
        process.stdout.write = ((chunk: string | Uint8Array) => {
            chunks.push(String(chunk));
            return true;
        }) as typeof process.stdout.write;
        console.log = (...args: unknown[]) => void chunks.push(args.join(" "));
        try {
            await call("GET", `${DEVICES}/pair-device/${device.pairing_code}`);
            const fresh = await getConfigDeviceByID(device.id);
            await call("PUT", `${DEVICES}/pair-device/${fresh!.pairing_code}`, {
                cookie: owner,
                body: { device_hardware_id: secret },
            });
            await call("POST", `${DEVICES}/${device.id}`, {
                cookie: owner,
                body: { pairing_code: "BODYCOD1", device_hardware_id: secret },
            });
        } finally {
            process.stdout.write = realWrite;
            console.log = realLog;
        }
        const logged = chunks.join("\n");
        assert.ok(logged.includes(device.id), "logs name the device id");
        for (const forbidden of [device.pairing_code!, secret, "BODYCOD1"]) {
            assert.ok(!logged.includes(forbidden), `leaked ${forbidden}`);
        }
    });

    it("has no log statement that interpolates a pairing code or body", () => {
        const source = readFileSync(
            "src/endpoints/v1/config/devices.ts",
            "utf8",
        );
        const logCalls = source.match(/logger\.\w+\(([^;]|\n)*?\);/g) ?? [];
        assert.ok(logCalls.length > 3);
        for (const call of logCalls) {
            assert.ok(!/pairingCode|pairing_code|req\.body/.test(call), call);
        }
    });
});
