import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { catalogStore } from "@/services/db/catalog";
import { syncResource } from "@/services/store";
import { makeItem } from "@/test/fixtures";
import type { ContractTarget } from "./harness";

/**
 * The catalog contract: fetchCatalog reflects the remote's current items and
 * where each is present, and syncing it into the local store mirrors them.
 * @param target the provider under test
 */
export function catalogContract(target: ContractTarget) {
    const { provider } = target;
    const sync = () =>
        syncResource({
            name: "catalog",
            fetchRemote: async () => {
                const { items, itemLocationIds } =
                    await provider.fetchCatalog();
                return items.map((item) => ({
                    ...item,
                    locationIds: itemLocationIds.get(item.id) ?? [],
                }));
            },
            store: catalogStore,
        });
    const ids = (items: { id: string }[]) => items.map((i) => i.id).sort();

    describe(`catalog contract: ${target.name}`, () => {
        beforeEach(() => target.setCatalog([]));

        it("returns nothing for an empty remote", async () => {
            const { items, itemLocationIds } = await provider.fetchCatalog();
            assert.deepEqual(items, []);
            assert.equal(itemLocationIds.size, 0);
        });

        it("returns items with variations and categories", async () => {
            const items = [
                makeItem("i1", "Coffee", ["L1"]),
                makeItem("i2", "Tea"),
            ];
            await target.setCatalog(items);
            const fetched = await provider.fetchCatalog();
            assert.deepEqual(
                [...fetched.items].sort((a, b) => a.id.localeCompare(b.id)),
                items,
            );
        });

        it("maps each item id to the locations it is present at", async () => {
            await target.setCatalog([
                makeItem("i1", "Coffee", ["L1", "L2"]),
                makeItem("i2", "Tea", ["L2"]),
            ]);
            const { itemLocationIds } = await provider.fetchCatalog();
            assert.deepEqual(itemLocationIds.get("i1")?.slice().sort(), [
                "L1",
                "L2",
            ]);
            assert.deepEqual(itemLocationIds.get("i2"), ["L2"]);
        });

        it("stops returning an item removed from the remote", async () => {
            await target.setCatalog([makeItem("i1", "A"), makeItem("i2", "B")]);
            await target.setCatalog([makeItem("i1", "A")]);
            assert.deepEqual(ids((await provider.fetchCatalog()).items), [
                "i1",
            ]);
        });

        it("syncs into the local store, idempotently, and mirrors removals", async () => {
            await target.setCatalog([
                makeItem("i1", "A", ["L1"]),
                makeItem("i2", "B", ["L1"]),
            ]);
            await sync();
            await sync();
            assert.deepEqual(ids((await catalogStore.list()).items), [
                "i1",
                "i2",
            ]);

            await target.setCatalog([makeItem("i1", "A", ["L1"])]);
            await sync();
            assert.deepEqual(ids((await catalogStore.list()).items), ["i1"]);
            assert.equal(await catalogStore.get("i2"), null);
        });
    });
}
