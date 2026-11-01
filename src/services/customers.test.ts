import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CustomerValidationError, validateCustomerInput } from "./customers";

const issuesOf = (raw: unknown): string[] => {
    try {
        validateCustomerInput(raw);
    } catch (error) {
        if (error instanceof CustomerValidationError) return error.issues;
        throw error;
    }
    return [];
};

describe("validateCustomerInput", () => {
    it("trims, defaults unset fields and de-duplicates tags", () => {
        assert.deepEqual(
            validateCustomerInput({
                given_name: "  Ada ",
                email: "ada@x.test",
                tags: ["vip", " vip", "tea", ""],
                extra: "dropped",
            }),
            {
                given_name: "Ada",
                family_name: "",
                company_name: "",
                email: "ada@x.test",
                phone_number: "",
                address: undefined,
                birthday: undefined,
                note: "",
                tags: ["vip", "tea"],
            },
        );
    });

    it("rejects non-objects and customers with no identifying field", () => {
        assert.equal(issuesOf(null).length, 1);
        assert.equal(issuesOf([]).length, 1);
        assert.equal(issuesOf({ note: "just a note" }).length, 1);
    });

    it("rejects bad email, phone, birthday and tags without echoing values", () => {
        const issues = issuesOf({
            given_name: "Ada",
            email: "secret-not-an-email",
            phone_number: "abc",
            birthday: "2026-02-30",
            tags: [1],
        });
        assert.equal(issues.length, 4);
        assert.ok(issues.every((issue) => !issue.includes("secret")));
    });

    it("enforces length caps", () => {
        assert.deepEqual(issuesOf({ given_name: "x".repeat(101) }), [
            "given_name must be at most 100 characters",
        ]);
        assert.equal(
            issuesOf({
                given_name: "Ada",
                tags: Array.from({ length: 21 }, (_, i) => `t${i}`),
            }).length,
            1,
        );
    });

    it("needs a country and first line on an address", () => {
        assert.equal(
            issuesOf({ given_name: "Ada", address: { country: "CA" } }).length,
            1,
        );
    });
});
