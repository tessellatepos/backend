import "@/test/localProvider";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { localProvider } from "@/services/providers/local";
import { InvalidOrderError } from "@/services/providers/types";
import { drizzleDB } from "@/services/db/postgres";
import {
    catalogItemVariationsTable,
    catalogItemsTable,
} from "@/services/db/schema";
import { closeTestDb, setupTestDb } from "@/test/db";

const ITEM = "PRICING-ITEM";
const FIXED = "PRICING-FIXED";
const VARIABLE = "PRICING-VARIABLE";
const OVERRIDDEN = "PRICING-OVERRIDDEN";
const OVERRIDE_TO_VARIABLE = "PRICING-OVERRIDE-VARIABLE";

const line = (itemId: string, amount?: string, currency = "CAD") => ({
    itemId,
    quantity: 2n,
    ...(amount ? { priceMoney: { amount, currency } } : {}),
});

const total = async (
    lineItems: ReturnType<typeof line>[],
    catalogPricing = true,
    locationId?: string,
) =>
    (
        await localProvider.createOrder({ lineItems, locationId } as never, {
            catalogPricing,
        })
    )?.totalMoney?.amount;

describe("local provider order pricing", () => {
    before(async () => {
        await setupTestDb();
        await drizzleDB
            .insert(catalogItemsTable)
            .values({ id: ITEM, name: "Pricing", origin: "local" });
        await drizzleDB.insert(catalogItemVariationsTable).values([
            {
                variationId: FIXED,
                itemId: ITEM,
                pricingType: "FIXED",
                priceMoney: { amount: "500", currency: "CAD" },
            },
            {
                variationId: VARIABLE,
                itemId: ITEM,
                pricingType: "VARIABLE",
                priceMoney: { amount: "0", currency: "CAD" },
            },
            {
                variationId: OVERRIDDEN,
                itemId: ITEM,
                pricingType: "FIXED",
                priceMoney: { amount: "500", currency: "CAD" },
                locationOverrides: [
                    {
                        locationId: "LOC-B",
                        priceMoney: { amount: "800", currency: "CAD" },
                    },
                ],
            },
            {
                variationId: OVERRIDE_TO_VARIABLE,
                itemId: ITEM,
                pricingType: "FIXED",
                priceMoney: { amount: "500", currency: "CAD" },
                locationOverrides: [
                    { locationId: "LOC-B", pricingType: "VARIABLE" },
                ],
            },
        ]);
    });

    after(async () => {
        await drizzleDB
            .delete(catalogItemVariationsTable)
            .where(eq(catalogItemVariationsTable.itemId, ITEM));
        await drizzleDB
            .delete(catalogItemsTable)
            .where(eq(catalogItemsTable.id, ITEM));
        await closeTestDb();
    });

    it("ignores a client price for a fixed-price variation", async () => {
        assert.equal(await total([line(FIXED, "1")]), 1000n);
        assert.equal(await total([line(FIXED)]), 1000n);
    });

    it("rejects an unknown variation", async () => {
        await assert.rejects(
            total([line("NO-SUCH-VARIATION", "100")]),
            InvalidOrderError,
        );
    });

    it("keeps the staff till's client price over the catalog", async () => {
        assert.equal(await total([line(FIXED, "1")], false), 2n);
        assert.equal(await total([line(FIXED)], false), 1000n);
    });

    it("uses the client price for a variable-price variation", async () => {
        assert.equal(await total([line(VARIABLE, "250")]), 500n);
    });

    it("rejects a missing, non-positive or wrong-currency variable price", async () => {
        for (const bad of [
            line(VARIABLE),
            line(VARIABLE, "0"),
            line(VARIABLE, "-5"),
            line(VARIABLE, "250", "USD"),
        ]) {
            await assert.rejects(total([bad]), InvalidOrderError);
        }
    });

    it("still takes the client price for an ad-hoc line with no catalog row", async () => {
        assert.equal(
            await total(
                [
                    {
                        name: "Tea",
                        quantity: 2n,
                        priceMoney: { amount: "350", currency: "CAD" },
                    } as never,
                ],
                false,
            ),
            700n,
        );
    });

    it("charges the location override price, the base price elsewhere", async () => {
        assert.equal(await total([line(OVERRIDDEN)], true, "LOC-B"), 1600n);
        assert.equal(await total([line(OVERRIDDEN)], true, "LOC-A"), 1000n);
        assert.equal(await total([line(OVERRIDDEN)]), 1000n);
    });

    it("honours a location override that makes a variation variable", async () => {
        assert.equal(
            await total([line(OVERRIDE_TO_VARIABLE, "300")], true, "LOC-B"),
            600n,
        );
        await assert.rejects(
            total([line(OVERRIDE_TO_VARIABLE)], true, "LOC-B"),
            InvalidOrderError,
        );
        // Elsewhere it is still fixed: the client price is ignored.
        assert.equal(
            await total([line(OVERRIDE_TO_VARIABLE, "300")], true, "LOC-A"),
            1000n,
        );
    });

    it("leaves the staff till on the client price at an overridden location", async () => {
        assert.equal(await total([line(OVERRIDDEN, "1")], false, "LOC-B"), 2n);
    });
});
