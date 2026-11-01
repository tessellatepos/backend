import "@/test/localProvider";
import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { ordersv1Endpoint } from "@/endpoints/v1/orders";
import { getOrderById } from "@/services/db/orders";
import { closeTestDb, setupTestDb, truncate } from "@/test/db";
import { TessellatePluginRegistry } from "@/utils/registry/plugin/pluginRegistry";

const LOC = "LOC-CASH";

// Shape of an order as a local till sends it to POST /orders/create.
const order = {
    locationId: LOC,
    discounts: [],
    lineItems: [
        {
            name: "Tea",
            quantity: 2,
            priceMoney: { amount: "350", currency: "CAD" },
        },
    ],
};

describe("cash payment on a LOCAL till", () => {
    let server: Server;
    let base: string;

    before(async () => {
        await setupTestDb();
        const app = express();
        app.use(express.json());
        app.use((req, _res, next) => {
            req.principal = {
                kind: "user",
                id: "test-cashier",
                display_name: "Test Cashier",
                roles: ["cashier"],
                scopes: ["orders:write"],
                location_ids: "all",
            } as typeof req.principal;
            next();
        });
        app.locals.pluginRegistry = new TessellatePluginRegistry();
        app.use("/orders", ordersv1Endpoint.router);
        server = await new Promise((resolve) => {
            const s = app.listen(0, "127.0.0.1", () => resolve(s));
        });
        base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    after(async () => {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncate("tessellate-orders");
    });

    async function call(method: string, path: string, body?: unknown) {
        const res = await fetch(base + path, {
            method,
            headers: { "content-type": "application/json" },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        const text = await res.text();
        return {
            status: res.status,
            body: text ? JSON.parse(text) : undefined,
        };
    }

    async function createOrder(): Promise<string> {
        const res = await call("POST", "/orders/create", order);
        assert.equal(res.status, 200);
        return res.body.id as string;
    }

    const payCash = (id: string) =>
        call("POST", `/orders/${id}/pay-cash`, { amountTendered: "1000" });

    it("pays an order created through the create path: 200, COMPLETED, with a CASH tender", async () => {
        const id = await createOrder();

        const res = await payCash(id);

        assert.equal(res.status, 200, JSON.stringify(res.body));
        assert.equal(res.body.order.state, "COMPLETED");
        assert.equal(res.body.order.tenders.length, 1);
        assert.equal(res.body.order.tenders[0].type, "CASH");
        assert.equal(res.body.changeDue.amount, "300");

        const row = await getOrderById(id);
        assert.equal(row?.state, "COMPLETED");
        assert.equal(row?.version, 1);
    });

    it("refuses a second payment of the same order with 409, not 500", async () => {
        const id = await createOrder();
        assert.equal((await payCash(id)).status, 200);

        const again = await payCash(id);

        assert.equal(again.status, 409, JSON.stringify(again.body));
        const row = await getOrderById(id);
        assert.equal(
            row?.tenders?.length,
            1,
            "second payment must not add a tender",
        );
    });

    it("lets exactly one of two concurrent payments succeed; the other is a 409", async () => {
        const id = await createOrder();

        const results = await Promise.all([payCash(id), payCash(id)]);
        const statuses = results.map((r) => r.status).sort();

        assert.deepEqual(statuses, [200, 409]);
        const row = await getOrderById(id);
        assert.equal(row?.state, "COMPLETED");
        assert.equal(row?.tenders?.length, 1);
    });
});
