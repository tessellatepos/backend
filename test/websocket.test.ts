import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import type { Principal } from "@tessellatepos/sdk";
import { pool } from "@/services/db/postgres";
import { createAuth } from "@/services/auth";
import { issueDeviceToken } from "@/auth/deviceToken";
import {
    createConfigDevice,
    deleteConfigDevice,
    updateConfigDevice,
} from "@/services/db/configDevice";
import {
    emitDatabaseEvent,
    emitPaymentStatusEvent,
} from "@/services/websocket/events";
import { canReceive, setupWebSocket } from "@/services/websocket/websocket";
import { migrateTestDb } from "./helpers/db";

const suffix = randomUUID().slice(0, 8);
const PASSWORD = "correct-horse-battery";

async function sessionCookie(role: string) {
    const auth = createAuth();
    const email = `${role}-${suffix}@example.test`;
    await auth.api.createUser({
        body: { email, password: PASSWORD, name: role, role: role as "owner" },
    });
    const { headers } = await auth.api.signInEmail({
        body: { email, password: PASSWORD },
        returnHeaders: true,
    });
    return (headers.get("set-cookie") ?? "").split(";")[0];
}

/** Opens a socket; resolves with the HTTP status when the upgrade is refused. */
function connect(
    url: string,
    headers: Record<string, string> = {},
): Promise<{ ws?: WebSocket; status?: number; first?: string }> {
    return new Promise((resolve) => {
        const ws = new WebSocket(url, { headers });
        ws.once("unexpected-response", (_req, res) => {
            resolve({ status: res.statusCode });
            res.resume();
        });
        ws.once("error", () => undefined);
        ws.once("message", (data) => resolve({ ws, first: data.toString() }));
    });
}

function collect(ws: WebSocket): string[] {
    const seen: string[] = [];
    ws.on("message", (data) => seen.push(data.toString()));
    return seen;
}

const pause = () => new Promise((resolve) => setTimeout(resolve, 100));

describe("websocket authentication", () => {
    let server: Server;
    let base: string;
    let owner: string;
    let viewer: string;
    const deviceIds: string[] = [];
    const sockets: WebSocket[] = [];

    before(async () => {
        await migrateTestDb();
        owner = await sessionCookie("owner");
        viewer = await sessionCookie("viewer");
        server = createServer();
        setupWebSocket(server);
        await new Promise<void>((resolve) =>
            server.listen(0, "127.0.0.1", resolve),
        );
        base = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/ws`;
    });

    after(async () => {
        for (const ws of sockets) ws.terminate();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        for (const id of deviceIds) await deleteConfigDevice(id);
        await pool.query(
            `DELETE FROM "tessellate-auth-user" WHERE email LIKE $1`,
            [`%-${suffix}@example.test`],
        );
        await pool.end();
    });

    async function deviceToken(location: string | null) {
        const device = await createConfigDevice();
        deviceIds.push(device.id);
        await updateConfigDevice(device.id, {
            pairing_code: null,
            paired_at: new Date(),
            square_location: location,
        });
        return (await issueDeviceToken(device.id))!;
    }

    it("rejects an upgrade with no credentials", async () => {
        assert.equal((await connect(base)).status, 401);
    });

    it("rejects a bad cookie and a bad or unknown token", async () => {
        assert.equal(
            (await connect(base, { cookie: "better-auth.session_token=nope" }))
                .status,
            401,
        );
        assert.equal((await connect(`${base}?access_token=nope`)).status, 401);
        assert.equal(
            (await connect(`${base}?access_token=tsd_${"A".repeat(43)}`))
                .status,
            401,
        );
    });

    it("accepts a session cookie", async () => {
        const { ws, first } = await connect(base, { cookie: owner });
        sockets.push(ws!);
        assert.deepEqual(JSON.parse(first!), {
            type: "connection",
            payload: null,
        });
    });

    it("refuses a cookie sent from a foreign origin", async () => {
        const res = await connect(base, {
            cookie: owner,
            origin: "https://evil.example",
        });
        assert.equal(res.status, 401);
    });

    it("accepts a device token as the access_token query parameter", async () => {
        const token = await deviceToken("L1");
        const { ws, first } = await connect(`${base}?access_token=${token}`);
        sockets.push(ws!);
        assert.ok(first);
    });

    it("sends events only to clients that may see the location", async () => {
        const [o, v, l1, l2] = await Promise.all([
            connect(base, { cookie: owner }),
            connect(base, { cookie: viewer }),
            connect(`${base}?access_token=${await deviceToken("L1")}`),
            connect(`${base}?access_token=${await deviceToken("L2")}`),
        ]);
        const seen = [o, v, l1, l2].map((c) => {
            sockets.push(c.ws!);
            return collect(c.ws!);
        });
        const payload = (locationId?: string) => ({
            orderId: "o1",
            locationId,
            status: "COMPLETED" as const,
            paymentMethod: "CASH" as const,
        });

        emitPaymentStatusEvent({
            type: "payment_status",
            payload: payload("L1"),
        });
        await pause();
        assert.deepEqual(
            seen.map((s) => s.length),
            [1, 1, 1, 0],
            "owner, viewer and the L1 device get it; the L2 device does not",
        );

        // no location on the event: everyone holding orders:read gets it
        emitDatabaseEvent({
            type: "order_created",
            payload: { orderId: "o2" },
        });
        await pause();
        assert.deepEqual(
            seen.map((s) => s.length),
            [2, 2, 2, 1],
        );
    });

    it("keeps device events for principals that can read devices", () => {
        const principal = (scopes: string[]): Principal => ({
            kind: "user",
            id: "u",
            roles: [],
            scopes: scopes as Principal["scopes"],
            location_ids: "all",
        });
        const event = {
            type: "device_paired",
            payload: { deviceId: "d" },
        } as const;
        assert.equal(canReceive(principal(["devices:read"]), event), true);
        assert.equal(canReceive(principal(["orders:read"]), event), false);
        assert.equal(
            canReceive(principal(["catalog:read"]), {
                type: "order_updated",
                payload: { orderId: "o" },
            }),
            false,
        );
    });
});
