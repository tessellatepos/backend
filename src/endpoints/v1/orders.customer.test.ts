import { startTestApp, type TestApp } from "@/test/http";
import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { pool } from "@/services/db/postgres";
import { closeTestDb, setupTestDb, truncate } from "@/test/db";
import { TessellatePluginRegistry } from "@/utils/registry/plugin/pluginRegistry";

const order = (customerId?: unknown) => ({
    locationId: "L1",
    discounts: [],
    lineItems: [
        {
            name: "Tea",
            quantity: 2,
            priceMoney: { amount: "350", currency: "CAD" },
        },
    ],
    ...(customerId === undefined ? {} : { customerId }),
});

describe("orders linked to customers", () => {
    let app: TestApp;

    before(async () => {
        await setupTestDb();
        app = await startTestApp(new TessellatePluginRegistry());
    });
    after(async () => {
        await app.close();
        await closeTestDb();
    });
    beforeEach(async () => {
        await truncate("tessellate-customers", "tessellate-orders");
    });

    const newCustomer = async () =>
        (await app.request("POST", "/customers", { given_name: "Ada" })).body
            .id as string;

    it("rejects an order for an unknown customer", async () => {
        for (const bad of ["missing", 42, {}]) {
            const res = await app.request("POST", "/orders/create", order(bad));
            assert.equal(res.status, 400);
            assert.deepEqual(res.body, { message: "Unknown customer" });
        }
    });

    it("accepts an order with no customer", async () => {
        const res = await app.request("POST", "/orders/create", order());
        assert.equal(res.status, 200);
        assert.equal(res.body.customerId, undefined);
        const res2 = await app.request("POST", "/orders/create", order(null));
        assert.equal(res2.status, 200);
    });

    it("persists customerId and lists the order under the customer", async () => {
        const id = await newCustomer();
        const other = await newCustomer();
        const created = await app.request("POST", "/orders/create", order(id));
        assert.equal(created.status, 200);
        assert.equal(created.body.customerId, id);
        await app.request("POST", "/orders/create", order(other));

        const listed = await app.request("GET", `/customers/${id}/orders`);
        assert.equal(listed.status, 200);
        assert.equal(listed.body.orders.length, 1);
        const [row] = listed.body.orders;
        assert.equal(row.referenceId, created.body.referenceId);
        assert.equal(row.customerId, id);
        assert.equal(row.locationId, "L1");
        assert.equal(row.totalMoney.amount, "700");
        assert.ok(row.createdAt);
        assert.equal(listed.body.next_cursor, null);
    });

    it("lists orders newest first and pages with a cursor", async () => {
        const id = await newCustomer();
        const made: string[] = [];
        for (let i = 0; i < 3; i++) {
            const res = await app.request("POST", "/orders/create", order(id));
            made.push(res.body.referenceId);
        }
        const first = await app.request(
            "GET",
            `/customers/${id}/orders?limit=2`,
        );
        assert.deepEqual(
            first.body.orders.map(
                (o: { referenceId: string }) => o.referenceId,
            ),
            [made[2], made[1]],
        );
        const second = await app.request(
            "GET",
            `/customers/${id}/orders?limit=2&cursor=${encodeURIComponent(first.body.next_cursor)}`,
        );
        assert.deepEqual(
            second.body.orders.map(
                (o: { referenceId: string }) => o.referenceId,
            ),
            [made[0]],
        );
        assert.equal(second.body.next_cursor, null);
        const bad = await app.request(
            "GET",
            `/customers/${id}/orders?cursor=junk`,
        );
        assert.equal(bad.status, 400);
    });

    it("includes the orders in the export", async () => {
        const id = await newCustomer();
        await app.request("POST", "/orders/create", order(id));
        const res = await app.request("GET", `/customers/${id}/export`);
        assert.equal(res.body.customer.id, id);
        assert.equal(res.body.orders.length, 1);
        assert.equal(res.body.orders[0].customerId, id);
    });

    it("keeps the order's customer_id after the customer is deleted", async () => {
        const id = await newCustomer();
        const created = await app.request("POST", "/orders/create", order(id));
        assert.equal(
            (await app.request("DELETE", `/customers/${id}`)).status,
            200,
        );
        assert.equal(
            (await app.request("GET", `/customers/${id}`)).status,
            404,
        );

        const rows = await pool.query(
            'SELECT customer_id FROM "tessellate-orders" WHERE reference_id = $1',
            [created.body.referenceId],
        );
        assert.equal(rows.rows[0].customer_id, id);
        // and the customer no longer exists, so a new order for it is refused
        const again = await app.request("POST", "/orders/create", order(id));
        assert.equal(again.status, 400);
    });
});
