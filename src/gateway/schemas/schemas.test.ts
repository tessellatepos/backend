import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { wireBigint, moneySchema } from "./common";
import { itemSchema } from "./catalog";
import { customerInputSchema, customerPatchSchema } from "./customers";
import { orderCreateSchema, orderSchema, toInternalOrder } from "./orders";
import { locationSchema } from "./locations";

const money = { amount: "500", currency: "CAD" };

describe("wire bigint", () => {
    it("decodes a digit string to bigint and encodes it back", () => {
        assert.equal(wireBigint.parse("12345"), 12345n);
        assert.equal(wireBigint.parse("-7"), -7n);
        assert.equal(wireBigint.encode(42n), "42");
    });

    it("refuses numbers, decimals and words", () => {
        for (const bad of [12, "1.5", "abc", "", " 3"]) {
            assert.throws(() => wireBigint.parse(bad));
        }
    });
});

describe("money and items", () => {
    it("reads a wire amount as bigint", () => {
        const parsed = moneySchema.parse(money);
        assert.equal(parsed.amount, 500n);
    });

    it("accepts a catalog item with variations and drops unknown fields", () => {
        const parsed = itemSchema.parse({
            id: "ITEM1",
            name: "Latte",
            variations: [
                {
                    id: "VAR1",
                    itemId: "ITEM1",
                    name: "Regular",
                    priceMoney: money,
                    pricingType: "FIXED",
                },
            ],
            internalOnlyField: "not for the gateway",
        });
        assert.equal(parsed.variations?.[0].priceMoney?.amount, 500n);
        assert.ok(!("internalOnlyField" in parsed));
    });

    it("rejects an item whose price is not a whole-number string", () => {
        assert.throws(() =>
            itemSchema.parse({
                id: "ITEM1",
                variations: [
                    {
                        id: "VAR1",
                        priceMoney: { amount: 5.5, currency: "CAD" },
                    },
                ],
            }),
        );
    });

    it("rejects an unknown currency", () => {
        assert.throws(() =>
            moneySchema.parse({ amount: "1", currency: "QQQ" }),
        );
    });
});

describe("orders", () => {
    const valid = {
        location_id: "L1",
        line_items: [{ variation_id: "VAR1", quantity: "2" }],
        pickup: { name: "Ada", phone_number: "5550100" },
    };

    it("accepts variation ids, quantities and the pickup contact", () => {
        const parsed = orderCreateSchema.parse(valid);
        assert.equal(parsed.line_items[0].quantity, 2n);
    });

    it("rejects a client-supplied discount or total, and the old price key", () => {
        const withPrice = {
            ...valid,
            line_items: [
                {
                    variation_id: "VAR1",
                    quantity: "1",
                    priceMoney: money,
                },
            ],
        };
        assert.throws(() => orderCreateSchema.parse(withPrice));
        assert.throws(() =>
            orderCreateSchema.parse({ ...valid, totalMoney: money }),
        );
        assert.throws(() =>
            orderCreateSchema.parse({ ...valid, discounts: [{ id: "d" }] }),
        );
    });

    it("carries a line price through for the provider to judge", () => {
        const internal = toInternalOrder(
            orderCreateSchema.parse({
                ...valid,
                line_items: [
                    { variation_id: "V", quantity: "1", price_money: money },
                ],
            }),
        );
        assert.deepEqual(internal.lineItems[0].priceMoney, {
            amount: 500n,
            currency: "CAD",
        });
    });

    it("rejects a quantity outside 1 to 999 and an empty basket", () => {
        for (const quantity of ["0", "1000", "-1"]) {
            assert.throws(() =>
                orderCreateSchema.parse({
                    ...valid,
                    line_items: [{ variation_id: "V", quantity }],
                }),
            );
        }
        assert.throws(() =>
            orderCreateSchema.parse({ ...valid, line_items: [] }),
        );
    });

    it("maps to an internal order that carries ids and quantities only", () => {
        const internal = toInternalOrder(orderCreateSchema.parse(valid));
        assert.deepEqual(internal, {
            locationId: "L1",
            lineItems: [{ itemId: "VAR1", quantity: 2n }],
        });
    });

    it("accepts a stored order's response shape", () => {
        const parsed = orderSchema.parse({
            id: "o1",
            locationId: "L1",
            discounts: [],
            state: "OPEN",
            totalMoney: money,
            lineItems: [{ itemId: "VAR1", quantity: "1", priceMoney: money }],
        });
        assert.equal(parsed.totalMoney?.amount, 500n);
    });
});

describe("customers and locations", () => {
    const input = {
        given_name: "Ada",
        family_name: "Lovelace",
        company_name: "",
        email: "ada@example.test",
        phone_number: "",
        note: "",
        tags: ["vip"],
    };

    it("accepts the writable fields", () => {
        assert.deepEqual(customerInputSchema.parse(input).tags, ["vip"]);
    });

    it("rejects server-owned fields on create and on patch", () => {
        assert.throws(() => customerInputSchema.parse({ ...input, id: "c1" }));
        assert.throws(() =>
            customerPatchSchema.parse({ created_at: "2026-01-01" }),
        );
    });

    it("accepts a partial patch", () => {
        assert.deepEqual(customerPatchSchema.parse({ note: "x" }), {
            note: "x",
        });
    });

    it("validates a location with hours", () => {
        const day = [
            {
                open: { time: "09:00", timezone: "America/Toronto" },
                close: { time: "17:00", timezone: "America/Toronto" },
            },
        ];
        const parsed = locationSchema.parse({
            id: "L1",
            name: "Main",
            address: { country: "CA", address_line_1: "1 Main St" },
            currency: "CAD",
            phone_number: "",
            website_url: "",
            email: "",
            logo_url: "",
            hours: {
                sunday: [],
                monday: day,
                tuesday: day,
                wednesday: day,
                thursday: day,
                friday: day,
                saturday: [],
            },
        });
        assert.equal(parsed.hours.monday.length, 1);
    });
});
