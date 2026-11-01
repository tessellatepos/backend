import { startTestApp, type TestApp } from "@/test/http";
import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { PluginManifest } from "@tessellatepos/plugin-sdk";
import { events, hooks } from "@tessellatepos/plugin-sdk/server";
import { Plugin } from "@/plugin/plugin";
import { closeTestDb, setupTestDb, truncate } from "@/test/db";
import { TessellatePluginRegistry } from "@/utils/registry/plugin/pluginRegistry";

const manifest = { name: "t" } as unknown as PluginManifest;
const permissions = (customer: boolean) => ({
    cart: false,
    catalog: false,
    checkout: false,
    device: false,
    order: false,
    customer,
    auth: false,
    payment: false,
});

const ada = {
    given_name: "Ada",
    family_name: "Lovelace",
    email: "ada@example.test",
    phone_number: "+1 555 0100",
    tags: ["vip"],
};

describe("customers endpoints", () => {
    let app: TestApp;
    const registry = new TessellatePluginRegistry();
    // what each plugin saw, by "<plugin>:<what>"
    const seen: Record<string, unknown[]> = {};
    let blockReason: string | null = null;

    before(async () => {
        await setupTestDb();
        for (const [name, allowed] of [
            ["allowed", true],
            ["denied", false],
        ] as const) {
            const plugin = new Plugin(manifest, permissions(allowed));
            const log = (what: string, ...args: unknown[]) => {
                (seen[`${name}:${what}`] ??= []).push(args);
            };
            plugin.hook(hooks.beforeCustomerSave, (input) => {
                log("hook", input);
                if (blockReason) return { ok: false, reason: blockReason };
                return {
                    ok: true,
                    value: {
                        ...input.customer,
                        tags: [...(input.customer.tags ?? []), name],
                    },
                };
            });
            plugin.on(events.customerCreated, (c) => log("created", c));
            plugin.on(events.customerUpdated, (c, p) => log("updated", c, p));
            plugin.on(events.customerDeleted, (id) => log("deleted", id));
            await registry.loadPlugin(name, plugin);
        }
        app = await startTestApp(registry);
    });
    after(async () => {
        await app.close();
        await closeTestDb();
    });
    beforeEach(async () => {
        await truncate("tessellate-customers", "tessellate-orders");
        for (const key of Object.keys(seen)) delete seen[key];
        blockReason = null;
    });
    // events are dispatched on a microtask after the response is built
    const settle = () => new Promise((resolve) => setImmediate(resolve));

    it("round trips create, get, update and delete", async () => {
        const created = await app.request("POST", "/customers", ada);
        assert.equal(created.status, 201);
        assert.equal(created.body.given_name, "Ada");
        const id = created.body.id as string;
        assert.ok(id);

        const got = await app.request("GET", `/customers/${id}`);
        assert.equal(got.status, 200);
        assert.equal(got.body.email, "ada@example.test");

        const updated = await app.request("PUT", `/customers/${id}`, {
            ...ada,
            given_name: "Augusta",
        });
        assert.equal(updated.status, 200);
        assert.equal(updated.body.given_name, "Augusta");
        assert.equal(
            (await app.request("GET", `/customers/${id}`)).body.given_name,
            "Augusta",
        );

        const deleted = await app.request("DELETE", `/customers/${id}`);
        assert.equal(deleted.status, 200);
        assert.equal(typeof deleted.body.message, "string");
        assert.equal(
            (await app.request("GET", `/customers/${id}`)).status,
            404,
        );
    });

    it("PATCH merges while PUT replaces", async () => {
        const id = (await app.request("POST", "/customers", ada)).body
            .id as string;

        const patched = await app.request("PATCH", `/customers/${id}`, {
            given_name: "Augusta",
        });
        assert.equal(patched.status, 200);
        assert.equal(patched.body.given_name, "Augusta");
        assert.equal(patched.body.family_name, "Lovelace");
        assert.equal(patched.body.email, "ada@example.test");
        assert.equal(patched.body.phone_number, "+1 555 0100");
        const got = await app.request("GET", `/customers/${id}`);
        assert.equal(got.body.email, "ada@example.test");
        assert.ok(got.body.tags.includes("vip"));

        const cleared = await app.request("PATCH", `/customers/${id}`, {
            email: null,
        });
        assert.equal(cleared.body.email, "");
        assert.equal(cleared.body.family_name, "Lovelace");

        const replaced = await app.request("PUT", `/customers/${id}`, {
            given_name: "Only",
        });
        assert.equal(replaced.status, 200);
        assert.equal(replaced.body.given_name, "Only");
        assert.equal(replaced.body.family_name, "");
        assert.equal(replaced.body.email, "");
    });

    it("PATCH answers 404 and 400 without echoing values", async () => {
        assert.equal(
            (await app.request("PATCH", "/customers/nope", { note: "x" }))
                .status,
            404,
        );
        const id = (await app.request("POST", "/customers", ada)).body
            .id as string;
        const bad = await app.request("PATCH", `/customers/${id}`, {
            email: "secret-not-an-email",
        });
        assert.equal(bad.status, 400);
        assert.match(bad.body.message, /email is not valid/);
        assert.ok(!JSON.stringify(bad.body).includes("secret-not-an-email"));
        const notObject = await app.request("PATCH", `/customers/${id}`, [1]);
        assert.equal(notObject.status, 400);
        assert.equal(
            (await app.request("GET", `/customers/${id}`)).body.email,
            "ada@example.test",
        );
    });

    it("PATCH runs the hook and emits the update event once", async () => {
        const id = (await app.request("POST", "/customers", ada)).body
            .id as string;
        await settle();
        for (const key of Object.keys(seen)) delete seen[key];

        const res = await app.request("PATCH", `/customers/${id}`, {
            given_name: "Augusta",
        });
        assert.equal(res.status, 200);
        await settle();
        assert.equal(seen["allowed:hook"].length, 1);
        const [hookInput] = seen["allowed:hook"][0] as [
            {
                customer: { given_name: string; email: string };
                existingId: string;
            },
        ];
        assert.equal(hookInput.existingId, id);
        assert.equal(hookInput.customer.given_name, "Augusta");
        assert.equal(hookInput.customer.email, "ada@example.test");
        assert.equal(seen["allowed:updated"].length, 1);
        assert.equal(seen["denied:updated"], undefined);
        assert.equal(seen["denied:hook"], undefined);

        blockReason = "nope";
        const blocked = await app.request("PATCH", `/customers/${id}`, {
            note: "x",
        });
        assert.equal(blocked.status, 400);
        assert.equal(blocked.body.message, "nope");
    });

    it("searches by text and filters, and pages", async () => {
        for (const given_name of ["Ann", "Bob", "Cy", "Di", "Ed"]) {
            await app.request("POST", "/customers", {
                given_name,
                email: `${given_name.toLowerCase()}@example.test`,
                tags: given_name === "Cy" ? ["gold"] : [],
            });
        }
        const byText = await app.request("GET", "/customers?text=bob");
        assert.deepEqual(
            byText.body.customers.map(
                (c: { given_name: string }) => c.given_name,
            ),
            ["Bob"],
        );
        const byEmail = await app.request(
            "GET",
            "/customers?email=ED@example.test",
        );
        assert.equal(byEmail.body.customers.length, 1);
        const byTag = await app.request("GET", "/customers?tag=gold");
        assert.equal(byTag.body.customers[0].given_name, "Cy");

        const first = await app.request("GET", "/customers?limit=2");
        assert.equal(first.body.customers.length, 2);
        assert.ok(first.body.next_cursor);
        const second = await app.request(
            "GET",
            `/customers?limit=2&cursor=${encodeURIComponent(first.body.next_cursor)}`,
        );
        assert.equal(second.body.customers.length, 2);
        const third = await app.request(
            "GET",
            `/customers?limit=2&cursor=${encodeURIComponent(second.body.next_cursor)}`,
        );
        assert.equal(third.body.customers.length, 1);
        assert.equal(third.body.next_cursor, null);
        const ids = [first, second, third].flatMap((p) =>
            p.body.customers.map((c: { id: string }) => c.id),
        );
        assert.equal(new Set(ids).size, 5);
    });

    it("rejects invalid input with 400 and never echoes values", async () => {
        const bad = await app.request("POST", "/customers", {
            given_name: "Ada",
            email: "secret-not-an-email",
        });
        assert.equal(bad.status, 400);
        assert.ok(!JSON.stringify(bad.body).includes("secret"));
        assert.equal((await app.request("POST", "/customers", {})).status, 400);
        assert.equal(
            (await app.request("GET", "/customers?limit=abc")).status,
            400,
        );
        assert.equal(
            (await app.request("GET", "/customers?limit=0")).status,
            400,
        );

        const { body } = await app.request("POST", "/customers", ada);
        const putBad = await app.request("PUT", `/customers/${body.id}`, {
            given_name: "x".repeat(101),
        });
        assert.equal(putBad.status, 400);
        // nothing was saved by the failed update
        assert.equal(
            (await app.request("GET", `/customers/${body.id}`)).body.given_name,
            "Ada",
        );
    });

    it("answers 404 for unknown ids", async () => {
        for (const [method, path] of [
            ["GET", "/customers/nope"],
            ["PUT", "/customers/nope"],
            ["DELETE", "/customers/nope"],
            ["GET", "/customers/nope/orders"],
            ["GET", "/customers/nope/export"],
        ]) {
            const res = await app.request(
                method,
                path,
                method === "PUT" ? ada : undefined,
            );
            assert.equal(res.status, 404, `${method} ${path}`);
            assert.ok(!JSON.stringify(res.body).includes("nope"));
        }
    });

    it("exports the customer and their orders as an attachment", async () => {
        const { body } = await app.request("POST", "/customers", ada);
        const res = await app.request("GET", `/customers/${body.id}/export`);
        assert.equal(res.status, 200);
        assert.equal(
            res.headers.get("content-disposition"),
            `attachment; filename="customer-${body.id}.json"`,
        );
        assert.equal(res.body.customer.id, body.id);
        assert.deepEqual(res.body.orders, []);
        const orders = await app.request("GET", `/customers/${body.id}/orders`);
        assert.deepEqual(orders.body, { orders: [], next_cursor: null });
    });

    describe("plugin dispatch", () => {
        it("lets a hook modify the input, for permitted plugins only", async () => {
            const res = await app.request("POST", "/customers", ada);
            assert.equal(res.status, 201);
            assert.deepEqual(res.body.tags, ["vip", "allowed"]);
            assert.equal(seen["allowed:hook"]?.length, 1);
            assert.equal(seen["denied:hook"], undefined);
            assert.equal(
                (seen["allowed:hook"][0] as [{ existingId?: string }])[0]
                    .existingId,
                undefined,
            );
        });

        it("passes each permitted plugin the previous plugin's output", async () => {
            const second = new Plugin(manifest, permissions(true));
            second.hook(hooks.beforeCustomerSave, (input) => ({
                ok: true,
                value: {
                    ...input.customer,
                    tags: [...(input.customer.tags ?? []), "second"],
                },
            }));
            const local = new TessellatePluginRegistry();
            for (const [name, plugin] of [
                ["first", registry.getPlugins().get("allowed")!],
                ["second", second],
            ] as const) {
                await local.loadPlugin(name, plugin);
            }
            const other = await startTestApp(local);
            try {
                const res = await other.request("POST", "/customers", ada);
                assert.equal(res.status, 201);
                assert.deepEqual(res.body.tags, ["vip", "allowed", "second"]);
            } finally {
                await other.close();
            }
        });

        it("lets a hook block with its reason on create and update", async () => {
            const { body } = await app.request("POST", "/customers", ada);
            blockReason = "No bad customers";
            const create = await app.request("POST", "/customers", ada);
            assert.equal(create.status, 400);
            assert.deepEqual(create.body, { message: "No bad customers" });
            const update = await app.request(
                "PUT",
                `/customers/${body.id}`,
                ada,
            );
            assert.equal(update.status, 400);
            assert.equal(update.body.message, "No bad customers");
            assert.equal(
                (await app.request("GET", "/customers")).body.customers.length,
                1,
            );
            await settle();
            assert.equal(seen["allowed:updated"], undefined);
        });

        it("passes existingId to the hook on update", async () => {
            const { body } = await app.request("POST", "/customers", ada);
            await app.request("PUT", `/customers/${body.id}`, ada);
            const calls = seen["allowed:hook"] as [{ existingId?: string }][];
            assert.equal(calls[1][0].existingId, body.id);
        });

        it("fires each event once with the right payloads", async () => {
            const created = (await app.request("POST", "/customers", ada)).body;
            await app.request("PUT", `/customers/${created.id}`, {
                ...ada,
                given_name: "Augusta",
            });
            await app.request("DELETE", `/customers/${created.id}`);
            await settle();

            assert.equal(seen["allowed:created"].length, 1);
            assert.equal(
                (seen["allowed:created"][0] as [{ id: string }])[0].id,
                created.id,
            );
            assert.equal(seen["allowed:updated"].length, 1);
            const [now, before] = seen["allowed:updated"][0] as [
                { given_name: string },
                { given_name: string },
            ];
            assert.equal(now.given_name, "Augusta");
            assert.equal(before.given_name, "Ada");
            assert.deepEqual(seen["allowed:deleted"], [[created.id]]);
        });

        it("never calls a plugin lacking the CUSTOMER permission", async () => {
            const created = (await app.request("POST", "/customers", ada)).body;
            await app.request("PUT", `/customers/${created.id}`, ada);
            await app.request("DELETE", `/customers/${created.id}`);
            await settle();
            assert.deepEqual(
                Object.keys(seen).filter((key) => key.startsWith("denied:")),
                [],
            );
        });

        it("does not fail the request when an event listener throws", async () => {
            const throwing = new Plugin(manifest, permissions(true));
            throwing.on(events.customerCreated, () => {
                throw new Error("listener blew up");
            });
            const local = new TessellatePluginRegistry();
            await local.loadPlugin("throwing", throwing);
            const other = await startTestApp(local);
            try {
                const res = await other.request("POST", "/customers", ada);
                assert.equal(res.status, 201);
            } finally {
                await other.close();
            }
        });

        it("answers a generic 500 when a hook handler throws", async () => {
            const throwing = new Plugin(manifest, permissions(true));
            throwing.hook(hooks.beforeCustomerSave, () => {
                throw new Error("hook blew up Ada");
            });
            const local = new TessellatePluginRegistry();
            await local.loadPlugin("throwing", throwing);
            const other = await startTestApp(local);
            try {
                const res = await other.request("POST", "/customers", ada);
                assert.equal(res.status, 500);
                assert.ok(!JSON.stringify(res.body).includes("Ada"));
            } finally {
                await other.close();
            }
        });
    });
});
