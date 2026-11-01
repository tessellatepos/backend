import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Customer } from "@tessellatepos/sdk";
import { pool } from "@/services/db/postgres";
import { customerStore } from "@/services/db/customers";
import { syncResource } from "@/services/store";
import { makeCustomer, makeCustomerInput } from "@/test/fixtures";
import type { ContractTarget } from "./harness";

/**
 * The customers contract: CRUD, search and paging through the provider
 * interface, delete semantics, and syncing fetchCustomers into the store.
 * @param target the provider under test
 */
export function customersContract(target: ContractTarget) {
    const { provider } = target;
    const sync = () =>
        syncResource({
            name: "customers",
            fetchRemote: () => provider.fetchCustomers(),
            store: customerStore,
        });
    const rowCount = async (id: string) =>
        (
            await pool.query(
                'SELECT 1 FROM "tessellate-customers" WHERE id = $1',
                [id],
            )
        ).rowCount;
    const ids = (list: { id: string }[]) => list.map((c) => c.id).sort();

    describe(`customers contract: ${target.name}`, () => {
        beforeEach(() => target.setCustomers([]));

        it("creates a customer with an id, timestamps and empty unset fields", async () => {
            const created = await provider.createCustomer(
                makeCustomerInput("Ada", "Lovelace", { email: "ada@x.test" }),
            );
            assert.ok(created.id);
            assert.equal(created.given_name, "Ada");
            assert.equal(created.email, "ada@x.test");
            assert.equal(created.phone_number, "");
            assert.equal(created.company_name, "");
            assert.equal(created.note, "");
            assert.deepEqual(created.tags, []);
            assert.ok(!Number.isNaN(Date.parse(created.created_at)));
            assert.ok(!Number.isNaN(Date.parse(created.updated_at)));
            assert.deepEqual(await provider.getCustomer(created.id), created);
        });

        it("round-trips every field", async () => {
            const input = makeCustomerInput("Grace", "Hopper", {
                company_name: "Navy",
                email: "grace@x.test",
                phone_number: "+1 555-0100",
                birthday: "1906-12-09",
                note: "likes tea",
                tags: ["vip", "tea"],
                address: {
                    country: "CA",
                    address_line_1: "1 Main St",
                    locality: "Regina",
                    postal_code: "S4P 1A1",
                },
            });
            const created = await provider.createCustomer(input);
            const rest: Partial<Customer> = { ...created };
            delete rest.id;
            delete rest.created_at;
            delete rest.updated_at;
            assert.deepEqual(rest, input);
        });

        it("returns null for an unknown id", async () => {
            assert.equal(await provider.getCustomer("nope"), null);
            assert.equal(
                await provider.updateCustomer("nope", makeCustomerInput("X")),
                null,
            );
            assert.equal(await provider.deleteCustomer("nope"), false);
        });

        it("updates by replacing the details and keeps the id", async () => {
            const created = await provider.createCustomer(
                makeCustomerInput("Ada", "Lovelace", {
                    email: "ada@x.test",
                    tags: ["a"],
                }),
            );
            const updated = await provider.updateCustomer(
                created.id,
                makeCustomerInput("Ada", "Byron", { note: "renamed" }),
            );
            assert.equal(updated?.id, created.id);
            assert.equal(updated?.family_name, "Byron");
            assert.equal(updated?.email, "");
            assert.equal(updated?.note, "renamed");
            assert.deepEqual(updated?.tags, []);
            assert.equal(updated?.created_at, created.created_at);
            assert.deepEqual(await provider.getCustomer(created.id), updated);
        });

        it("deletes once, then reports it gone", async () => {
            const created = await provider.createCustomer(
                makeCustomerInput("Ada"),
            );
            assert.equal(await provider.deleteCustomer(created.id), true);
            assert.equal(await provider.getCustomer(created.id), null);
            assert.equal(await rowCount(created.id), 0, "row is hard deleted");
            assert.equal(await provider.deleteCustomer(created.id), false);
            assert.deepEqual((await provider.listCustomers({})).customers, []);
        });

        it("searches text across names, company, email and phone, ignoring case", async () => {
            await provider.createCustomer(makeCustomerInput("Ada", "Lovelace"));
            await provider.createCustomer(
                makeCustomerInput("Bob", "Smith", { company_name: "Acme" }),
            );
            await provider.createCustomer(
                makeCustomerInput("Cy", "Jones", { email: "cy@mail.test" }),
            );
            await provider.createCustomer(
                makeCustomerInput("Di", "Brown", { phone_number: "555-0199" }),
            );
            const find = async (text: string) =>
                (await provider.listCustomers({ text })).customers
                    .map((c) => c.given_name)
                    .sort();
            assert.deepEqual(await find("LOVE"), ["Ada"]);
            assert.deepEqual(await find("acme"), ["Bob"]);
            assert.deepEqual(await find("mail.test"), ["Cy"]);
            assert.deepEqual(await find("0199"), ["Di"]);
            assert.deepEqual(await find("zzz"), []);
        });

        it("matches % and _ in search text literally", async () => {
            await provider.createCustomer(makeCustomerInput("Ada"));
            await provider.createCustomer(makeCustomerInput("5%_off"));
            const found = await provider.listCustomers({ text: "%_" });
            assert.deepEqual(
                found.customers.map((c) => c.given_name),
                ["5%_off"],
            );
        });

        it("filters by email, phone number and tag", async () => {
            await provider.createCustomer(
                makeCustomerInput("Ada", "A", {
                    email: "Ada@X.test",
                    phone_number: "555-0001",
                    tags: ["vip"],
                }),
            );
            await provider.createCustomer(
                makeCustomerInput("Bob", "B", {
                    email: "bob@x.test",
                    phone_number: "555-0002",
                    tags: ["vip", "tea"],
                }),
            );
            const names = async (query: object) =>
                (await provider.listCustomers(query)).customers
                    .map((c) => c.given_name)
                    .sort();
            assert.deepEqual(await names({ email: "ada@x.test" }), ["Ada"]);
            assert.deepEqual(await names({ phone_number: "555-0002" }), [
                "Bob",
            ]);
            assert.deepEqual(await names({ tag: "vip" }), ["Ada", "Bob"]);
            assert.deepEqual(await names({ tag: "tea" }), ["Bob"]);
            assert.deepEqual(await names({ tag: "vi" }), []);
            assert.deepEqual(await names({ tag: "tea", text: "ada" }), []);
        });

        it("pages with a cursor until the end, without repeats", async () => {
            for (let i = 0; i < 5; i++) {
                await provider.createCustomer(makeCustomerInput(`C${i}`));
            }
            const seen: string[] = [];
            let cursor: string | undefined;
            let pages = 0;
            do {
                const page = await provider.listCustomers({ limit: 2, cursor });
                assert.ok(page.customers.length <= 2);
                seen.push(...page.customers.map((c) => c.id));
                cursor = page.next_cursor ?? undefined;
                pages++;
            } while (cursor);
            assert.equal(pages, 3);
            assert.equal(new Set(seen).size, 5);
        });

        it("syncs fetchCustomers into the store, idempotently", async () => {
            await target.setCustomers([
                makeCustomer("c1", "Ada"),
                makeCustomer("c2", "Bob"),
            ]);
            const first = ids(await provider.fetchCustomers());
            assert.deepEqual(first, ["c1", "c2"]);
            await sync();
            await sync();
            assert.deepEqual(ids((await customerStore.list()).items), first);
        });

        it("hard deletes a customer removed from the remote when syncing", async () => {
            await target.setCustomers([
                makeCustomer("c1", "Ada"),
                makeCustomer("c2", "Bob"),
            ]);
            await sync();
            await target.setCustomers([makeCustomer("c1", "Ada")]);
            await sync();
            assert.deepEqual(ids((await customerStore.list()).items), ["c1"]);
            assert.equal(await customerStore.get("c2"), null);
            assert.equal(await rowCount("c2"), 0, "row is hard deleted");
        });
    });
}
