import type { Customer, Item, Location } from "@tessellatepos/sdk";
import { customerStore } from "@/services/db/customers";
import { catalogStore } from "@/services/db/catalog";
import { locationStore } from "@/services/db/locations";
import { truncate } from "@/test/db";
import { localProvider } from "../local";
import type { CatalogProvider, CustomerProvider } from "../types";

/**
 * One provider under contract test. The contract suites never reach into a
 * provider: they put its remote into a known state through these hooks, then
 * assert on what the provider interface returns.
 */
export interface ContractTarget {
    name: string;
    provider: CatalogProvider & CustomerProvider;
    /** Makes the remote hold exactly these locations (none clears it). */
    setLocations(locations: Location[]): Promise<void>;
    /** Makes the remote hold exactly these customers (none clears it). */
    setCustomers(customers: Customer[]): Promise<void>;
    /** Makes the remote hold exactly these items; locationIds says where. */
    setCatalog(items: Item[]): Promise<void>;
}

/**
 * `local` has no remote: its "remote" is the local store, against the real
 * test Postgres.
 */
const localTarget: ContractTarget = {
    name: "local (postgres)",
    provider: localProvider,
    async setLocations(locations) {
        await truncate("tessellate-locations");
        await locationStore.upsertMany(locations);
    },
    async setCustomers(customers) {
        await truncate("tessellate-customers");
        await customerStore.upsertMany(customers);
    },
    async setCatalog(items) {
        await truncate(
            "tessellate-catalog-items",
            "tessellate-catalog-categories",
            "tessellate-catalog-item-locations",
        );
        await catalogStore.upsertMany(items);
    },
};

/**
 * Providers the contract suites run against. Register a new provider (e.g.
 * Square against recorded fixtures) by adding a target here.
 */
export const contractTargets: ContractTarget[] = [localTarget];
