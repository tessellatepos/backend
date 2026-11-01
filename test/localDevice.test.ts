import "@/test/localProvider";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { pool } from "@/services/db/postgres";
import { getRedisClient } from "@/services/redis";
import { createAuth } from "@/services/auth";
import { createApp, mountApiRoutes } from "@/app";
import { TessellatePluginRegistry } from "@/utils/registry/plugin/pluginRegistry";
import {
    createConfigDevice,
    deleteConfigDevice,
    getConfigDeviceByID,
    getLocalDeviceForLocation,
    getPairedDeviceByType,
} from "@/services/db/configDevice";
import { createLocalLocation, removeLocation } from "@/services/db/locations";
import { migrateTestDb } from "./helpers/db";

const PASSWORD = "correct-horse-battery";

describe("LOCAL devices (cash-only tills in a staff browser)", () => {
    const suffix = randomUUID().slice(0, 8);
    const cookies: Record<string, string> = {};
    const deviceIds: string[] = [];
    const locationIds: string[] = [];
    let server: Server;
    let url: string;

    before(async () => {
        await migrateTestDb();
        const auth = createAuth();
        for (const role of ["viewer", "cashier", "manager", "owner"]) {
            const email = `${role}-${suffix}@example.test`;
            await auth.api.createUser({
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
            cookies[role] = (headers.get("set-cookie") ?? "").split(";")[0];
        }
        const app = createApp();
        app.locals.pluginRegistry = new TessellatePluginRegistry();
        mountApiRoutes(app, app.locals.pluginRegistry.apiRegistry);
        server = await new Promise((resolve) => {
            const s = app.listen(0, "127.0.0.1", () => resolve(s));
        });
        url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        // The storefront tests need the local provider.
        await call("owner", "POST", "/api/v1/config/provider", {
            provider: "local",
        });
    });

    after(async () => {
        for (const id of deviceIds) await deleteConfigDevice(id);
        for (const id of locationIds) {
            await pool.query(
                `DELETE FROM "tessellate-locations" WHERE id = $1`,
                [id],
            );
        }
        await pool.query(
            `DELETE FROM "tessellate-auth-user" WHERE email LIKE $1`,
            [`%-${suffix}@example.test`],
        );
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await pool.end();
        await (await getRedisClient())?.quit();
    });

    async function call(
        role: "owner" | "manager" | "cashier" | "viewer" | "none",
        method: string,
        path: string,
        body?: unknown,
    ) {
        const res = await fetch(url + path, {
            method,
            headers: {
                "content-type": "application/json",
                ...(role === "none" ? {} : { cookie: cookies[role] }),
            },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        const text = await res.text();
        return {
            status: res.status,
            body: text ? JSON.parse(text) : undefined,
        };
    }

    async function newLocation(name: string) {
        const location = await createLocalLocation({
            name,
            currency: "CAD",
            country: "CA",
        });
        locationIds.push(location.id);
        return location;
    }

    describe("POST /api/v1/config/devices/local", () => {
        it("refuses callers without a session", async () => {
            const location = await newLocation(`Anon ${suffix}`);
            const res = await call(
                "none",
                "POST",
                "/api/v1/config/devices/local",
                {
                    locationId: location.id,
                },
            );
            assert.equal(res.status, 401);
        });

        it("refuses every role below owner", async () => {
            const location = await newLocation(`Gated ${suffix}`);
            for (const role of ["manager", "cashier", "viewer"] as const) {
                const res = await call(
                    role,
                    "POST",
                    "/api/v1/config/devices/local",
                    { locationId: location.id },
                );
                assert.equal(res.status, 403, role);
            }
        });

        it("creates a paired LOCAL device pinned to the location, then returns it", async () => {
            const location = await newLocation(`Till ${suffix}`);
            const created = await call(
                "owner",
                "POST",
                "/api/v1/config/devices/local",
                { locationId: location.id },
            );
            assert.equal(created.status, 201);
            assert.equal(created.body.device_type, "LOCAL");
            assert.equal(created.body.square_location, location.id);
            assert.equal(created.body.pairing_code, null);
            assert.equal(created.body.code_created_at, null);
            assert.ok(created.body.paired_at);
            assert.equal(created.body.device_hardware_id, null);
            assert.ok(!("device_token_hash" in created.body));
            deviceIds.push(created.body.id);

            const again = await call(
                "owner",
                "POST",
                "/api/v1/config/devices/local",
                { locationId: location.id },
            );
            assert.equal(again.status, 200);
            assert.equal(again.body.id, created.body.id);
            const stored = await getLocalDeviceForLocation(location.id);
            assert.equal(stored?.id, created.body.id);
        });

        it("two concurrent creates for one location leave one till", async () => {
            const location = await newLocation(`Race ${suffix}`);
            const [first, second] = await Promise.all([
                call("owner", "POST", "/api/v1/config/devices/local", {
                    locationId: location.id,
                }),
                call("owner", "POST", "/api/v1/config/devices/local", {
                    locationId: location.id,
                }),
            ]);
            assert.ok([200, 201].includes(first.status));
            assert.ok([200, 201].includes(second.status));
            assert.equal(first.body.id, second.body.id);
            deviceIds.push(first.body.id);

            const rows = await pool.query(
                `SELECT id FROM "tessellate-devices-config"
                 WHERE device_type = 'LOCAL' AND square_location = $1`,
                [location.id],
            );
            assert.equal(rows.rowCount, 1);
        });

        it("validates the location", async () => {
            const missing = await call(
                "owner",
                "POST",
                "/api/v1/config/devices/local",
                {},
            );
            assert.equal(missing.status, 400);

            const unknown = await call(
                "owner",
                "POST",
                "/api/v1/config/devices/local",
                { locationId: `nope-${suffix}` },
            );
            assert.equal(unknown.status, 404);

            const gone = await newLocation(`Removed ${suffix}`);
            assert.equal(await removeLocation(gone.id), true);
            const deleted = await call(
                "owner",
                "POST",
                "/api/v1/config/devices/local",
                { locationId: gone.id },
            );
            assert.equal(deleted.status, 404);
        });
    });

    describe("storefronts and their tills", () => {
        it("creating a storefront creates its LOCAL till and returns deviceId", async () => {
            const created = await call(
                "owner",
                "POST",
                "/api/v1/config/storefronts",
                { name: `Stall ${suffix}`, currency: "CAD", country: "CA" },
            );
            assert.equal(created.status, 201);
            locationIds.push(created.body.id);
            assert.ok(created.body.deviceId);
            deviceIds.push(created.body.deviceId);

            const device = await getConfigDeviceByID(created.body.deviceId);
            assert.equal(device?.device_type, "LOCAL");
            assert.equal(device?.square_location, created.body.id);

            const listed = await call(
                "owner",
                "GET",
                "/api/v1/config/storefronts",
            );
            const row = listed.body.storefronts.find(
                (s: { id: string }) => s.id === created.body.id,
            );
            assert.equal(row.deviceId, created.body.deviceId);
        });

        it("lists null deviceId for a storefront without a till", async () => {
            const location = await newLocation(`Bare ${suffix}`);
            const listed = await call(
                "owner",
                "GET",
                "/api/v1/config/storefronts",
            );
            const row = listed.body.storefronts.find(
                (s: { id: string }) => s.id === location.id,
            );
            assert.ok(row, "the location is listed");
            assert.equal(row.deviceId, null);
        });

        it("deleting a storefront deletes its till", async () => {
            const created = await call(
                "owner",
                "POST",
                "/api/v1/config/storefronts",
                { name: `Kiosk ${suffix}`, currency: "CAD", country: "CA" },
            );
            assert.equal(created.status, 201);
            const { id, deviceId } = created.body;
            locationIds.push(id);

            const removed = await call(
                "owner",
                "DELETE",
                `/api/v1/config/storefronts/${id}`,
            );
            assert.equal(removed.status, 200);
            assert.equal(await getConfigDeviceByID(deviceId), null);
            assert.equal(await getLocalDeviceForLocation(id), null);
        });
    });

    describe("LOCAL tills are not hardware and not device tokens", () => {
        it("cannot be exchanged for a device token, even by an owner", async () => {
            const location = await newLocation(`Exchange ${suffix}`);
            const till = await call(
                "owner",
                "POST",
                "/api/v1/config/devices/local",
                { locationId: location.id },
            );
            deviceIds.push(till.body.id);

            const byOwner = await call(
                "owner",
                "POST",
                "/api/v1/auth/device-token",
                {
                    deviceId: till.body.id,
                },
            );
            assert.equal(byOwner.status, 400);

            const anonymous = await call(
                "none",
                "POST",
                "/api/v1/auth/device-token",
                {
                    deviceId: till.body.id,
                    pairingCode: "",
                },
            );
            assert.equal(anonymous.status, 401);
        });

        it("cannot be paired with a code or hardware", async () => {
            const location = await newLocation(`Pair ${suffix}`);
            const till = await call(
                "owner",
                "POST",
                "/api/v1/config/devices/local",
                { locationId: location.id },
            );
            deviceIds.push(till.body.id);

            const paired = await call(
                "owner",
                "PUT",
                "/api/v1/config/devices/pair-device/ANYCODE1",
                { device_hardware_id: "hw-1", device_type: "LOCAL" },
            );
            assert.equal(paired.status, 400);
            assert.equal(
                (await getConfigDeviceByID(till.body.id))?.device_hardware_id,
                null,
            );
        });

        it("is listed with its type and never returned as paired hardware", async () => {
            const location = await newLocation(`Listed ${suffix}`);
            const till = await call(
                "owner",
                "POST",
                "/api/v1/config/devices/local",
                { locationId: location.id },
            );
            deviceIds.push(till.body.id);

            const listed = await call(
                "owner",
                "GET",
                "/api/v1/config/devices/",
            );
            const row = listed.body.find(
                (d: { id: string }) => d.id === till.body.id,
            );
            assert.equal(row.device_type, "LOCAL");
            assert.ok(!("device_token_hash" in row));

            const terminal = await getPairedDeviceByType("TERMINAL");
            const reader = await getPairedDeviceByType("MOBILE_READER");
            assert.notEqual(terminal?.id, till.body.id);
            assert.notEqual(reader?.id, till.body.id);
        });
    });

    describe("card tenders are refused for a LOCAL till", () => {
        it("refuses terminal checkout and mobile reader payment from it", async () => {
            const location = await newLocation(`Cash ${suffix}`);
            const till = await call(
                "owner",
                "POST",
                "/api/v1/config/devices/local",
                { locationId: location.id },
            );
            deviceIds.push(till.body.id);

            const checkout = await call(
                "owner",
                "POST",
                `/api/v1/orders/order-${suffix}/checkout`,
                { deviceId: till.body.id },
            );
            assert.equal(checkout.status, 400);
            assert.equal(checkout.body.message, "Local tills take cash only");

            const reader = await call(
                "owner",
                "POST",
                `/api/v1/orders/order-${suffix}/pay-mobile-reader`,
                { paymentId: "pay-1", deviceId: till.body.id },
            );
            assert.equal(reader.status, 400);
            assert.equal(reader.body.message, "Local tills take cash only");
        });
    });
    describe("reading a till's own record", () => {
        it("lets any staff role read a LOCAL till but not hardware devices", async () => {
            const location = await newLocation(`Read ${suffix}`);
            const till = await call(
                "owner",
                "POST",
                "/api/v1/config/devices/local",
                { locationId: location.id },
            );
            deviceIds.push(till.body.id);
            const hardware = await createConfigDevice();
            deviceIds.push(hardware.id);

            for (const role of ["cashier", "viewer"] as const) {
                const own = await call(
                    role,
                    "GET",
                    `/api/v1/config/devices/${till.body.id}`,
                );
                assert.equal(own.status, 200, role);
                assert.equal(own.body.device_type, "LOCAL");
                assert.equal(own.body.pairing_code, null);

                const other = await call(
                    role,
                    "GET",
                    `/api/v1/config/devices/${hardware.id}`,
                );
                assert.equal(other.status, 403, role);

                const list = await call(role, "GET", "/api/v1/config/devices");
                assert.equal(list.status, 403, role);
            }

            const manager = await call(
                "manager",
                "GET",
                `/api/v1/config/devices/${hardware.id}`,
            );
            assert.equal(manager.status, 200);
        });
    });

    describe("POST /api/v1/config/devices/:id", () => {
        it("answers 409, not 500, when it moves a till onto a location that has one", async () => {
            const a = await newLocation(`MoveA ${suffix}`);
            const b = await newLocation(`MoveB ${suffix}`);
            const tillA = await call(
                "owner",
                "POST",
                "/api/v1/config/devices/local",
                { locationId: a.id },
            );
            const tillB = await call(
                "owner",
                "POST",
                "/api/v1/config/devices/local",
                { locationId: b.id },
            );
            deviceIds.push(tillA.body.id, tillB.body.id);
            const res = await call(
                "owner",
                "POST",
                `/api/v1/config/devices/${tillB.body.id}`,
                { square_location: a.id },
            );
            assert.equal(res.status, 409, JSON.stringify(res.body));
            assert.match(res.body.message, /already has a local till/);
            const stored = await getLocalDeviceForLocation(a.id);
            assert.equal(stored?.id, tillA.body.id);
            assert.equal(
                (await getLocalDeviceForLocation(b.id))?.id,
                tillB.body.id,
            );
        });
    });
});
