import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import { pool } from "@/services/db/postgres";
import { createAuth } from "@/services/auth";
import { issueDeviceToken, revokeDeviceToken } from "@/auth/deviceToken";
import {
    createConfigDevice,
    deleteConfigDevice,
    updateConfigDevice,
} from "@/services/db/configDevice";
import {
    WS_REVALIDATE_INTERVAL_MS,
    revalidateSockets,
    setupWebSocket,
} from "@/services/websocket/websocket";
import { authv1Endpoint } from "@/endpoints/v1/auth";
import { usersv1Endpoint } from "@/endpoints/v1/users";
import { migrateTestDb } from "./helpers/db";
import { startTestApp, type TestApp } from "./helpers/app";

const suffix = randomUUID().slice(0, 8);
const PASSWORD = "correct-horse-battery";

interface Closed {
    code: number;
    reason: string;
}

/** Opens a socket and returns it with a promise of how it was closed. */
function open(url: string, headers: Record<string, string> = {}) {
    return new Promise<{ ws: WebSocket; closed: Promise<Closed> }>(
        (resolve, reject) => {
            const ws = new WebSocket(url, { headers });
            const closed = new Promise<Closed>((done) =>
                ws.once("close", (code, reason) =>
                    done({ code, reason: reason.toString() }),
                ),
            );
            ws.once("error", reject);
            ws.once("message", () => resolve({ ws, closed }));
        },
    );
}

const within = <T>(promise: Promise<T>, ms: number) =>
    Promise.race([
        promise,
        new Promise<"open">((resolve) => setTimeout(() => resolve("open"), ms)),
    ]);

// Both suites share the pool, so it is closed once, after the last of them.
after(async () => {
    await pool.end();
});

const ENDED = { code: 4401, reason: "session ended" };

describe("websocket revalidation", () => {
    it("checks open sockets every minute by default", () => {
        assert.equal(WS_REVALIDATE_INTERVAL_MS, 60_000);
    });
});

for (const [name, intervalMs] of [
    ["on the interval", 100],
    ["immediately on revoke or ban", 10 * 60_000],
] as const) {
    describe(`websocket sessions ended ${name}`, () => {
        const immediate = intervalMs > 1000;
        let server: Server;
        let base: string;
        let api: TestApp;
        let ownerCookie: string;
        const deviceIds: string[] = [];
        const sockets: WebSocket[] = [];

        async function user(role: string) {
            const auth = createAuth();
            const email = `${role}-${randomUUID().slice(0, 6)}-${suffix}@example.test`;
            const { user } = await auth.api.createUser({
                body: {
                    email,
                    password: PASSWORD,
                    name: role,
                    role: role as "owner",
                },
            });
            const { headers } = await auth.api.signInEmail({
                body: { email, password: PASSWORD },
                returnHeaders: true,
            });
            return {
                id: user.id,
                cookie: (headers.get("set-cookie") ?? "").split(";")[0],
            };
        }

        async function device() {
            const d = await createConfigDevice();
            deviceIds.push(d.id);
            await updateConfigDevice(d.id, {
                pairing_code: null,
                paired_at: new Date(),
            });
            return { id: d.id, token: (await issueDeviceToken(d.id))! };
        }

        const connect = async (headers: Record<string, string>, query = "") => {
            const c = await open(`${base}${query}`, headers);
            sockets.push(c.ws);
            return c;
        };

        before(async () => {
            await migrateTestDb();
            ownerCookie = (await user("owner")).cookie;
            server = createServer();
            setupWebSocket(server, intervalMs);
            await new Promise<void>((resolve) =>
                server.listen(0, "127.0.0.1", resolve),
            );
            base = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/ws`;
            api = await startTestApp((app) => {
                app.use("/api/v1/auth", authv1Endpoint.router);
                app.use("/api/v1/users", usersv1Endpoint.router);
            });
        });

        after(async () => {
            for (const ws of sockets) ws.terminate();
            await api.close();
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
            for (const id of deviceIds) await deleteConfigDevice(id);
            await pool.query(
                `DELETE FROM "tessellate-auth-user" WHERE email LIKE $1`,
                [`%-${suffix}@example.test`],
            );
        });

        const send = (method: string, path: string, body?: unknown) =>
            fetch(`${api.url}/api/v1${path}`, {
                method,
                headers: {
                    "content-type": "application/json",
                    cookie: ownerCookie,
                },
                body: body === undefined ? undefined : JSON.stringify(body),
            });

        it("keeps a healthy socket open", async () => {
            const viewer = await user("viewer");
            const { closed } = await connect({ cookie: viewer.cookie });
            assert.equal(await within(closed, 500), "open");
        });

        it("closes a socket when its device token is revoked", async () => {
            const d = await device();
            const { closed } = await connect({}, `?access_token=${d.token}`);
            if (immediate) {
                const res = await send("DELETE", `/auth/device-token/${d.id}`);
                assert.equal(res.status, 200);
            } else {
                await revokeDeviceToken(d.id);
            }
            assert.deepEqual(await within(closed, 1500), ENDED);
        });

        it("closes a banned user's socket", async () => {
            const target = await user("cashier");
            const { closed } = await connect({ cookie: target.cookie });
            if (immediate) {
                const res = await send("PATCH", `/users/${target.id}`, {
                    banned: true,
                });
                assert.equal(res.status, 200);
            } else {
                await pool.query(
                    `UPDATE "tessellate-auth-user" SET banned = true WHERE id = $1`,
                    [target.id],
                );
            }
            assert.deepEqual(await within(closed, 1500), ENDED);
        });

        it("closes a socket when its user's password is reset", async () => {
            const target = await user("manager");
            const { closed } = await connect({ cookie: target.cookie });
            const res = await send("POST", `/users/${target.id}/password`, {
                password: "another-long-password",
            });
            assert.equal(res.status, 204);
            assert.deepEqual(await within(closed, 1500), ENDED);
        });

        if (!immediate) {
            it("closes a socket whose user was deleted", async () => {
                const target = await user("viewer");
                const { closed } = await connect({ cookie: target.cookie });
                await pool.query(
                    `DELETE FROM "tessellate-auth-user" WHERE id = $1`,
                    [target.id],
                );
                assert.deepEqual(await within(closed, 1500), ENDED);
            });
        }

        it("leaves other principals' sockets open", async () => {
            const keep = await user("viewer");
            const gone = await user("viewer");
            const a = await connect({ cookie: keep.cookie });
            const b = await connect({ cookie: gone.cookie });
            const res = await send("PATCH", `/users/${gone.id}`, {
                banned: true,
            });
            assert.equal(res.status, 200);
            assert.deepEqual(await within(b.closed, 1500), ENDED);
            assert.equal(await within(a.closed, 400), "open");
        });
    });
}

describe("websocket revalidation with a failing lookup", () => {
    let server: Server;
    let base: string;
    const sockets: WebSocket[] = [];
    const deviceIds: string[] = [];

    before(async () => {
        await migrateTestDb();
        server = createServer();
        // Long interval: the test drives revalidateSockets directly.
        setupWebSocket(server, 10 * 60_000);
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
    });

    async function connectDevice() {
        const d = await createConfigDevice();
        deviceIds.push(d.id);
        await updateConfigDevice(d.id, {
            pairing_code: null,
            paired_at: new Date(),
        });
        const token = (await issueDeviceToken(d.id))!;
        const c = await open(`${base}?access_token=${token}`);
        sockets.push(c.ws);
        return { ...c, id: d.id, token };
    }

    it("keeps sockets open when the lookup throws", async () => {
        const d = await connectDevice();
        const closedCount = await revalidateSockets(async () => {
            throw new Error("connection terminated unexpectedly");
        });
        assert.equal(closedCount, 0);
        assert.equal(await within(d.closed, 400), "open");
        assert.equal(d.ws.readyState, WebSocket.OPEN);
    });

    it("closes only the sockets whose principal is positively gone", async () => {
        const gone = await connectDevice();
        const kept = await connectDevice();
        const closedCount = await revalidateSockets(async (headers) => {
            if (headers.authorization === `Bearer ${gone.token}`) return null;
            throw new Error("transient");
        });
        assert.equal(closedCount, 1);
        assert.deepEqual(await within(gone.closed, 1500), ENDED);
        assert.equal(await within(kept.closed, 400), "open");
    });

    it("keeps a socket after a transient failure and closes it once it is gone", async () => {
        const d = await connectDevice();
        await revalidateSockets(async () => {
            throw new Error("transient");
        });
        assert.equal(await within(d.closed, 300), "open");
        const closedCount = await revalidateSockets(async (headers) => {
            if (headers.authorization === `Bearer ${d.token}`) return null;
            throw new Error("transient");
        });
        assert.equal(closedCount, 1);
        assert.deepEqual(await within(d.closed, 1500), ENDED);
    });
});
