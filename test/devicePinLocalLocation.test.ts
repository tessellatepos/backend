import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { pool } from "@/services/db/postgres";
import {
    createConfigDevice,
    deleteConfigDevice,
    getConfigDeviceByID,
    updateConfigDevice,
} from "@/services/db/configDevice";
import { migrateTestDb } from "./helpers/db";

// Locations created by the setup wizard get ids like "loc_" + 12 random
// characters (16 in total); a device pinned to one must not be rejected for
// length.
describe("pinning a device to a location created by the setup wizard", () => {
    let deviceId: string;
    before(migrateTestDb);
    after(async () => {
        if (deviceId) await deleteConfigDevice(deviceId);
        await pool.end();
    });

    it("stores a loc_ + 12 character location id", async () => {
        const locationId = `loc_${randomBytes(9).toString("base64url")}`;
        assert.equal(locationId.length, 16);
        const device = await createConfigDevice();
        deviceId = device.id;
        await updateConfigDevice(deviceId, { square_location: locationId });
        const stored = await getConfigDeviceByID(deviceId);
        assert.equal(stored?.square_location, locationId);
    });
});
