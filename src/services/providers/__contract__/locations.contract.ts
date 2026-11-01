import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { locationStore } from "@/services/db/locations";
import { syncResource } from "@/services/store";
import { makeLocation } from "@/test/fixtures";
import type { ContractTarget } from "./harness";

/**
 * The locations contract: fetchLocations reflects the remote's current set,
 * and syncing it into the local store mirrors that set.
 * @param target the provider under test
 */
export function locationsContract(target: ContractTarget) {
    const { provider } = target;
    const byId = <T extends { id: string }>(list: T[]) =>
        [...list].sort((a, b) => a.id.localeCompare(b.id));
    const sync = () =>
        syncResource({
            name: "locations",
            fetchRemote: () => provider.fetchLocations(),
            store: locationStore,
        });

    describe(`locations contract: ${target.name}`, () => {
        beforeEach(() => target.setLocations([]));

        it("returns nothing for an empty remote", async () => {
            assert.deepEqual(await provider.fetchLocations(), []);
        });

        it("returns every location with unset fields as empty strings", async () => {
            const locations = [
                makeLocation("L2", "Two"),
                makeLocation("L1", "One"),
            ];
            await target.setLocations(locations);
            assert.deepEqual(
                byId(await provider.fetchLocations()),
                byId(locations),
            );
        });

        it("preserves populated fields", async () => {
            const full = {
                ...makeLocation("L1", "One"),
                phone_number: "555-0100",
                website_url: "https://example.test",
                email: "one@example.test",
                logo_url: "https://example.test/logo.png",
            };
            full.hours.monday = [{ start: "09:00", end: "17:00" }] as never;
            await target.setLocations([full]);
            assert.deepEqual(await provider.fetchLocations(), [full]);
        });

        it("stops returning a location removed from the remote", async () => {
            await target.setLocations([
                makeLocation("L1", "One"),
                makeLocation("L2", "Two"),
            ]);
            await target.setLocations([makeLocation("L1", "One")]);
            assert.deepEqual(
                (await provider.fetchLocations()).map((l) => l.id),
                ["L1"],
            );
        });

        it("syncs into the local store, idempotently, and mirrors removals", async () => {
            await target.setLocations([
                makeLocation("L1", "One"),
                makeLocation("L2", "Two"),
            ]);
            await sync();
            await sync();
            assert.deepEqual(
                (await locationStore.list()).items.map((l) => l.id),
                ["L1", "L2"],
            );

            await target.setLocations([makeLocation("L1", "One")]);
            await sync();
            assert.deepEqual(
                (await locationStore.list()).items.map((l) => l.id),
                ["L1"],
            );
            assert.equal(await locationStore.get("L2"), null);
        });
    });
}
