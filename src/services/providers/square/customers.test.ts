import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Customer as SquareCustomer } from "square";
import type { Customer, CustomerInput } from "@tessellatepos/sdk";
import {
    mapSquareCustomer,
    pageCustomers,
    referenceIdToTags,
    tagsToReferenceId,
    canWriteTags,
    toSquareCreateBody,
    toSquareUpdateBody,
} from "./customers";

// Shaped like Square's Retrieve/Create Customer response (camelCased by the SDK).
const fullSquareCustomer = {
    id: "SQ1",
    createdAt: "2026-01-02T03:04:05.678Z",
    updatedAt: "2026-02-03T04:05:06.789Z",
    givenName: "Grace",
    familyName: "Hopper",
    nickname: "Amazing Grace",
    companyName: "Navy",
    emailAddress: "grace@example.test",
    phoneNumber: "+15550100",
    address: {
        addressLine1: "1 Main St",
        addressLine2: "Suite 2",
        addressLine3: "Floor 3",
        locality: "Regina",
        sublocality: "Cathedral",
        administrativeDistrictLevel1: "SK",
        postalCode: "S4P 1A1",
        country: "CA",
    },
    birthday: "1906-12-09",
    referenceId: 'tessellate:tags:["vip","tea"]',
    note: "likes tea",
    creationSource: "THIRD_PARTY",
    groupIds: ["G1"],
    segmentIds: ["S1"],
    version: 3n,
} as SquareCustomer & { id: string };

const input: CustomerInput = {
    given_name: "Grace",
    family_name: "Hopper",
    company_name: "Navy",
    email: "grace@example.test",
    phone_number: "+15550100",
    address: {
        country: "CA",
        address_line_1: "1 Main St",
        locality: "Regina",
    },
    birthday: "1906-12-09",
    note: "likes tea",
    tags: ["vip", "tea"],
};

const empty: CustomerInput = {
    given_name: "",
    family_name: "",
    company_name: "",
    email: "",
    phone_number: "",
    note: "",
    tags: [],
};

describe("square customer mapping", () => {
    it("maps a full Square customer", () => {
        assert.deepEqual(mapSquareCustomer(fullSquareCustomer), {
            id: "SQ1",
            given_name: "Grace",
            family_name: "Hopper",
            company_name: "Navy",
            email: "grace@example.test",
            phone_number: "+15550100",
            address: {
                country: "CA",
                address_line_1: "1 Main St",
                address_line_2: "Suite 2, Floor 3",
                dependent_locality: "Cathedral",
                locality: "Regina",
                subdivision: "SK",
                postal_code: "S4P 1A1",
            },
            birthday: "1906-12-09",
            note: "likes tea",
            tags: ["vip", "tea"],
            created_at: "2026-01-02T03:04:05.678Z",
            updated_at: "2026-02-03T04:05:06.789Z",
        });
    });

    it("maps missing and null fields to empty strings", () => {
        const mapped = mapSquareCustomer({
            id: "SQ2",
            givenName: null,
            emailAddress: null,
            note: null,
            birthday: null,
            address: {},
        } as SquareCustomer & { id: string });
        assert.equal(mapped.given_name, "");
        assert.equal(mapped.family_name, "");
        assert.equal(mapped.company_name, "");
        assert.equal(mapped.email, "");
        assert.equal(mapped.phone_number, "");
        assert.equal(mapped.note, "");
        assert.equal(mapped.birthday, undefined);
        assert.equal(mapped.address, undefined);
        assert.deepEqual(mapped.tags, []);
    });

    it("builds a create body, omitting empty fields", () => {
        assert.deepEqual(toSquareCreateBody(input, "key-1"), {
            idempotencyKey: "key-1",
            givenName: "Grace",
            familyName: "Hopper",
            companyName: "Navy",
            emailAddress: "grace@example.test",
            phoneNumber: "+15550100",
            address: {
                addressLine1: "1 Main St",
                addressLine2: undefined,
                sublocality: undefined,
                locality: "Regina",
                administrativeDistrictLevel1: undefined,
                postalCode: undefined,
                country: "CA",
            },
            birthday: "1906-12-09",
            note: "likes tea",
            referenceId: 'tessellate:tags:["vip","tea"]',
        });
        const body = toSquareCreateBody(empty, "key-2");
        assert.deepEqual(JSON.parse(JSON.stringify(body)), {
            idempotencyKey: "key-2",
        });
    });

    it("builds an update body that clears empty fields with null", () => {
        const body = toSquareUpdateBody("SQ1", empty);
        assert.equal(body.customerId, "SQ1");
        assert.equal(body.givenName, null);
        assert.equal(body.emailAddress, null);
        assert.equal(body.phoneNumber, null);
        assert.equal(body.note, null);
        assert.equal(body.birthday, null);
        assert.equal(body.referenceId, null);
        assert.equal(body.address, undefined);
        assert.equal(toSquareUpdateBody("SQ1", input).givenName, "Grace");
    });

    it("round-trips an input through create body and back", () => {
        const body = toSquareCreateBody(input, "k");
        const back = mapSquareCustomer({
            ...body,
            id: "SQ1",
        } as SquareCustomer & { id: string });
        const rest: Partial<Customer> = { ...back };
        delete rest.id;
        delete rest.created_at;
        delete rest.updated_at;
        assert.deepEqual(rest, input);
    });
});

describe("square customer tags", () => {
    it("ignores a reference id that is not ours or is malformed", () => {
        assert.deepEqual(referenceIdToTags("ORDER-123"), []);
        assert.deepEqual(referenceIdToTags("tessellate:tags:{oops"), []);
        assert.deepEqual(referenceIdToTags("tessellate:tags:[1,2]"), []);
        assert.deepEqual(referenceIdToTags(null), []);
    });

    it("stores nothing for no tags and drops tags that do not fit", () => {
        assert.equal(tagsToReferenceId([]), undefined);
        const many = Array.from({ length: 30 }, (_, i) => `tag-number-${i}`);
        const stored = tagsToReferenceId(many);
        assert.ok(stored && stored.length <= 100);
        assert.deepEqual(
            referenceIdToTags(stored),
            many.slice(0, referenceIdToTags(stored).length),
        );
        assert.equal(tagsToReferenceId(["x".repeat(200)]), undefined);
    });
});

describe("pageCustomers", () => {
    const make = (id: string, over: Partial<Customer> = {}): Customer => ({
        ...empty,
        id,
        created_at: "",
        updated_at: "",
        ...over,
    });
    const all = [
        make("c", { given_name: "Cy", tags: ["vip"] }),
        make("a", { given_name: "Ada", email: "Ada@X.test" }),
        make("b", { given_name: "Bob", phone_number: "555" }),
    ];

    it("filters and orders by id", () => {
        assert.deepEqual(
            pageCustomers(all, {}).customers.map((c) => c.id),
            ["a", "b", "c"],
        );
        assert.deepEqual(
            pageCustomers(all, { text: "ADA" }).customers.map((c) => c.id),
            ["a"],
        );
        assert.deepEqual(
            pageCustomers(all, { email: "ada@x.test" }).customers.map(
                (c) => c.id,
            ),
            ["a"],
        );
        assert.deepEqual(
            pageCustomers(all, { tag: "vip" }).customers.map((c) => c.id),
            ["c"],
        );
    });

    it("pages by cursor", () => {
        const first = pageCustomers(all, { limit: 2 });
        assert.deepEqual(
            first.customers.map((c) => c.id),
            ["a", "b"],
        );
        assert.equal(first.next_cursor, "b");
        const second = pageCustomers(all, { limit: 2, cursor: "b" });
        assert.deepEqual(
            second.customers.map((c) => c.id),
            ["c"],
        );
        assert.equal(second.next_cursor, null);
    });
});

describe("square update referenceId handling", () => {
    const withTags: CustomerInput = { ...empty, tags: ["vip"] };

    it("writes our tags over an empty referenceId", () => {
        for (const current of [undefined, null, ""]) {
            assert.equal(
                toSquareUpdateBody("SQ1", withTags, current).referenceId,
                'tessellate:tags:["vip"]',
            );
        }
    });

    it("replaces a referenceId that already holds our tags", () => {
        assert.equal(
            toSquareUpdateBody("SQ1", withTags, 'tessellate:tags:["old"]')
                .referenceId,
            'tessellate:tags:["vip"]',
        );
        assert.equal(
            toSquareUpdateBody("SQ1", empty, 'tessellate:tags:["old"]')
                .referenceId,
            null,
        );
    });

    it("preserves a foreign referenceId by not sending one", () => {
        const body = toSquareUpdateBody("SQ1", withTags, "ORDER-123");
        assert.equal("referenceId" in body, false);
        assert.equal(canWriteTags("ORDER-123"), false);
    });
});
