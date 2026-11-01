import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Item, Location } from "@tessellatepos/sdk";
import { pool } from "@/services/db/postgres";
import { createAuth } from "@/services/auth";
import { issueDeviceToken } from "@/auth/deviceToken";
import {
    createConfigDevice,
    deleteConfigDevice,
    updateConfigDevice,
} from "@/services/db/configDevice";
import { EMPTY_HOURS, locationStore } from "@/services/db/locations";
import { getRedisClient, setItemsByLocationID } from "@/services/redis";
import { itemsv1Endpoint } from "@/endpoints/v1/items";
import { locationsv1Endpoint } from "@/endpoints/v1/locations";
import { migrateTestDb } from "./helpers/db";
import { startTestApp, type TestApp } from "./helpers/app";

const suffix = randomUUID().slice(0, 8);
const L1 = `locA-${suffix}`;
const L2 = `locB-${suffix}`;
const item = (id: string, locationIds: string[]): Item => ({
    id: `${id}-${suffix}`,
    name: id,
    variations: [],
    locationIds,
});
const location = (id: string): Location => ({
    id,
    name: id,
    address: {
        country: "CA",
        address_line_1: "1 Main St",
    },
    currency: "CAD",
    phone_number: "",
    website_url: "",
    email: "",
    hours: EMPTY_HOURS,
    logo_url: "",
});

describe("location filtering for pinned principals", () => {
    let server: TestApp;
    let ownerCookie: string;
    let pinnedToken: string;
    let pinnedId: string;
    let otherId: string;
    let unpinnedToken: string;
    const deviceIds: string[] = [];

    async function device(square_location: string | null) {
        const d = await createConfigDevice();
        deviceIds.push(d.id);
        await updateConfigDevice(d.id, {
            pairing_code: null,
            paired_at: new Date(),
            square_location,
        });
        return { id: d.id, token: (await issueDeviceToken(d.id))! };
    }

    const get = async (
        path: string,
        auth: { cookie?: string; token?: string },
    ) => {
        const res = await fetch(`${server.url}${path}`, {
            headers: {
                ...(auth.cookie ? { cookie: auth.cookie } : {}),
                ...(auth.token
                    ? { authorization: `Bearer ${auth.token}` }
                    : {}),
            },
        });
        const text = await res.text();
        return { status: res.status, body: text ? JSON.parse(text) : null };
    };
    const ids = (rows: { id: string }[]) =>
        rows
            .map((r) => r.id)
            .filter((id) => id.endsWith(suffix) || id.includes(suffix));

    before(async () => {
        await migrateTestDb();
        const auth = createAuth();
        const email = `owner-${suffix}@example.test`;
        await auth.api.createUser({
            body: {
                email,
                password: "correct-horse-battery",
                name: "owner",
                role: "owner",
            },
        });
        const { headers } = await auth.api.signInEmail({
            body: { email, password: "correct-horse-battery" },
            returnHeaders: true,
        });
        ownerCookie = (headers.get("set-cookie") ?? "").split(";")[0];

        await locationStore.upsertMany([location(L1), location(L2)]);
        await setItemsByLocationID([
            item("only1", [L1]),
            item("only2", [L2]),
            item("both", [L1, L2]),
        ]);
        const pinned = await device(L1);
        pinnedToken = pinned.token;
        pinnedId = pinned.id;
        const other = await device(L2);
        otherId = other.id;
        unpinnedToken = (await device(null)).token;

        server = await startTestApp((app) => {
            app.use("/api/v1/items", itemsv1Endpoint.router);
            app.use("/api/v1/locations", locationsv1Endpoint.router);
        });
    });

    after(async () => {
        await server.close();
        for (const id of deviceIds) await deleteConfigDevice(id);
        await pool.query(
            `DELETE FROM "tessellate-locations" WHERE id = ANY($1)`,
            [[L1, L2]],
        );
        const redis = await getRedisClient();
        await redis?.del([
            ...["only1", "only2", "both"].map(
                (n) => `square:item:${n}-${suffix}`,
            ),
            `square:items:${L1}`,
            `square:items:${L2}`,
        ]);
        await redis?.sRem(
            "square:items:all",
            ["only1", "only2", "both"].map((n) => `${n}-${suffix}`),
        );
        await pool.query(
            `DELETE FROM "tessellate-auth-user" WHERE email LIKE $1`,
            [`%-${suffix}@example.test`],
        );
        await pool.end();
        await redis?.quit();
    });

    it("lists only the pinned location's items", async () => {
        const r = await get("/api/v1/items/by-location/", {
            token: pinnedToken,
        });
        assert.equal(r.status, 200);
        assert.deepEqual(ids(r.body).sort(), [
            `both-${suffix}`,
            `only1-${suffix}`,
        ]);
    });

    it("lists every location's items for an owner or an unpinned device", async () => {
        const all = [`both-${suffix}`, `only1-${suffix}`, `only2-${suffix}`];
        for (const auth of [
            { cookie: ownerCookie },
            { token: unpinnedToken },
        ]) {
            const r = await get("/api/v1/items/by-location/", auth);
            assert.deepEqual(ids(r.body).sort(), all);
        }
    });

    it("serves by-device-id for its own device but not another location's", async () => {
        const own = await get(`/api/v1/items/by-device-id/${pinnedId}`, {
            token: pinnedToken,
        });
        assert.equal(own.status, 200);
        assert.deepEqual(ids(own.body).sort(), [
            `both-${suffix}`,
            `only1-${suffix}`,
        ]);
        const foreign = await get(`/api/v1/items/by-device-id/${otherId}`, {
            token: pinnedToken,
        });
        assert.equal(foreign.status, 403);
        const owner = await get(`/api/v1/items/by-device-id/${otherId}`, {
            cookie: ownerCookie,
        });
        assert.equal(owner.status, 200);
        assert.deepEqual(ids(owner.body).sort(), [
            `both-${suffix}`,
            `only2-${suffix}`,
        ]);
    });

    it("lists only the pinned principal's locations", async () => {
        const pinned = await get("/api/v1/locations/", { token: pinnedToken });
        assert.equal(pinned.status, 200);
        assert.deepEqual(ids(pinned.body), [L1]);
        const owner = await get("/api/v1/locations/", { cookie: ownerCookie });
        assert.deepEqual(ids(owner.body).sort(), [L1, L2]);
    });
});
