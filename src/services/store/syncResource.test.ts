import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Location } from "@tessellatepos/sdk";
import { makeLocation } from "@/test/fixtures";
import { locationStore } from "@/services/db/locations";
import { pool } from "@/services/db/postgres";
import { closeTestDb, setupTestDb, truncate } from "@/test/db";
import { syncResource } from "./syncResource";

describe("syncResource", () => {
    before(setupTestDb);
    after(closeTestDb);
    beforeEach(() => truncate("tessellate-locations"));

    it("is idempotent when run twice", async () => {
        const remote = [makeLocation("L1", "One"), makeLocation("L2", "Two")];
        const run = () =>
            syncResource({
                name: "locations",
                fetchRemote: async () => remote,
                store: locationStore,
            });
        const first = await run();
        const snapshot = (await locationStore.list()).items;
        const second = await run();

        assert.deepEqual(first, { name: "locations", upserted: 2, removed: 0 });
        assert.deepEqual(second, {
            name: "locations",
            upserted: 2,
            removed: 0,
        });
        assert.deepEqual((await locationStore.list()).items, snapshot);
        const rows = await pool.query(`SELECT * FROM "tessellate-locations"`);
        assert.equal(rows.rowCount, 2);
    });

    it("soft deletes a record removed remotely and it leaves list and get", async () => {
        const sync = (remote: Location[]) =>
            syncResource({
                name: "locations",
                fetchRemote: async () => remote,
                store: locationStore,
            });
        await sync([makeLocation("L1", "One"), makeLocation("L2", "Two")]);
        const result = await sync([makeLocation("L1", "One")]);

        assert.equal(result.removed, 1);
        assert.deepEqual(
            (await locationStore.list()).items.map((l) => l.id),
            ["L1"],
        );
        assert.equal(await locationStore.get("L2"), null);
        const row = await pool.query(
            `SELECT deleted_at FROM "tessellate-locations" WHERE id='L2'`,
        );
        assert.ok(row.rows[0].deleted_at);

        // and it comes back if the remote returns it again
        await sync([makeLocation("L1", "One"), makeLocation("L2", "Two")]);
        assert.equal((await locationStore.get("L2"))?.name, "Two");
    });

    it("applies remote changes to existing records", async () => {
        const sync = (remote: Location[]) =>
            syncResource({
                name: "locations",
                fetchRemote: async () => remote,
                store: locationStore,
            });
        await sync([makeLocation("L1", "One")]);
        await sync([makeLocation("L1", "Renamed")]);
        assert.equal((await locationStore.get("L1"))?.name, "Renamed");
    });

    it("keeps local records when the remote returns nothing, unless allowed", async () => {
        const sync = (allowEmpty?: boolean) =>
            syncResource({
                name: "locations",
                fetchRemote: async () => [],
                store: locationStore,
                allowEmpty,
            });
        await locationStore.upsert(makeLocation("L1", "One"));

        assert.equal((await sync()).removed, 0);
        assert.equal((await locationStore.list()).items.length, 1);
        assert.equal((await sync(true)).removed, 1);
        assert.equal((await locationStore.list()).items.length, 0);
    });

    it("leaves local records untouched when the fetch fails", async () => {
        await locationStore.upsert(makeLocation("L1", "One"));
        await assert.rejects(
            syncResource({
                name: "locations",
                fetchRemote: async () => {
                    throw new Error("remote down");
                },
                store: locationStore,
            }),
            /remote down/,
        );
        assert.equal((await locationStore.list()).items.length, 1);
    });
});
