import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { closeTestDb, setupTestDb, truncate } from "@/test/db";
import { makeItem } from "@/test/fixtures";
import { syncResource } from "@/services/store";
import { catalogStore } from "./catalog";

describe("catalogStore", () => {
    before(setupTestDb);
    after(closeTestDb);
    beforeEach(() =>
        truncate(
            "tessellate-catalog-items",
            "tessellate-catalog-categories",
            "tessellate-catalog-item-locations",
        ),
    );

    it("round-trips an item with variations, categories and locations", async () => {
        const item = makeItem("i1", "Coffee", ["L1", "L2"]);
        await catalogStore.upsert(item);
        const stored = await catalogStore.get("i1");
        assert.equal(stored?.name, "Coffee");
        assert.deepEqual(stored?.locationIds?.slice().sort(), ["L1", "L2"]);
        assert.equal(stored?.variations?.[0].priceMoney?.amount, 350n);
        assert.equal(stored?.categories?.[0].id, "cat");
    });

    it("upsert does not archive other items", async () => {
        await catalogStore.upsertMany([
            makeItem("i1", "A"),
            makeItem("i2", "B"),
        ]);
        await catalogStore.upsert(makeItem("i1", "A2"));
        assert.deepEqual(
            (await catalogStore.list()).items.map((i) => i.id),
            ["i1", "i2"],
        );
    });

    it("lists by id with cursor paging and searches name and sku", async () => {
        await catalogStore.upsertMany([
            makeItem("i1", "Coffee"),
            makeItem("i2", "Tea"),
            makeItem("i3", "Cocoa"),
        ]);
        const first = await catalogStore.list({ limit: 2 });
        assert.deepEqual(
            first.items.map((i) => i.id),
            ["i1", "i2"],
        );
        const second = await catalogStore.list({
            limit: 2,
            cursor: first.nextCursor ?? undefined,
        });
        assert.deepEqual(
            second.items.map((i) => i.id),
            ["i3"],
        );
        assert.equal(second.nextCursor, null);
        assert.deepEqual(
            (await catalogStore.list({ text: "CO" })).items.map((i) => i.id),
            ["i1", "i3"],
        );
        assert.deepEqual(
            (await catalogStore.list({ text: "i2-sku" })).items.map(
                (i) => i.id,
            ),
            ["i2"],
        );
    });

    it("remove archives, and the item leaves list and get", async () => {
        await catalogStore.upsert(makeItem("i1", "A"));
        assert.equal(await catalogStore.remove("i1"), true);
        assert.equal(await catalogStore.remove("i1"), false);
        assert.equal(await catalogStore.get("i1"), null);
        assert.equal((await catalogStore.list()).items.length, 0);
        // an upsert of the (un-archived) item brings it back
        await catalogStore.upsert(makeItem("i1", "A"));
        assert.equal((await catalogStore.get("i1"))?.name, "A");
    });

    it("syncResource is idempotent and archives items removed remotely", async () => {
        const sync = (items: ReturnType<typeof makeItem>[]) =>
            syncResource({
                name: "catalog",
                fetchRemote: async () => items,
                store: catalogStore,
            });
        const both = [makeItem("i1", "A", ["L1"]), makeItem("i2", "B", ["L1"])];
        await sync(both);
        const snapshot = (await catalogStore.list()).items;
        await sync(both);
        assert.deepEqual((await catalogStore.list()).items, snapshot);

        const result = await sync([makeItem("i1", "A", ["L1"])]);
        assert.equal(result.removed, 1);
        assert.deepEqual(
            (await catalogStore.list()).items.map((i) => i.id),
            ["i1"],
        );
        assert.equal(await catalogStore.get("i2"), null);
    });
});
