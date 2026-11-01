import "@/test/localProvider";
import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { ordersv1Endpoint } from "@/endpoints/v1/orders";
import { closeTestDb, setupTestDb, truncate } from "@/test/db";
import { TessellatePluginRegistry } from "@/utils/registry/plugin/pluginRegistry";

// Principal chosen per request: "unpinned" (all locations), or a location id
// the principal is pinned to.
const LOC_A = "LOC-A";
const LOC_B = "LOC-B";
const NOT_FOUND = { message: "Order not found" };

const order = (locationId: string) => ({
    locationId,
    discounts: [],
    lineItems: [
        {
            name: "Tea",
            quantity: 2,
            priceMoney: { amount: "350", currency: "CAD" },
        },
    ],
});

describe("order routes respect the principal's locations", () => {
    let server: Server;
    let base: string;

    before(async () => {
        await setupTestDb();
        const app = express();
        app.use(express.json());
        app.use((req, _res, next) => {
            const pin = req.header("x-test-pin");
            req.principal = {
                kind: "user",
                id: "test-cashier",
                display_name: "Test Cashier",
                roles: ["cashier"],
                scopes: ["orders:write"],
                location_ids: pin ? [pin] : "all",
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

    async function call(
        pin: string | undefined,
        method: string,
        path: string,
        body?: unknown,
    ) {
        const res = await fetch(base + path, {
            method,
            headers: {
                "content-type": "application/json",
                ...(pin ? { "x-test-pin": pin } : {}),
            },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        const text = await res.text();
        return {
            status: res.status,
            body: text ? JSON.parse(text) : undefined,
        };
    }

    async function createOrder(locationId: string): Promise<string> {
        const res = await call(
            undefined,
            "POST",
            "/orders/create",
            order(locationId),
        );
        assert.equal(res.status, 200);
        return res.body.id as string;
    }

    const payCash = (pin: string | undefined, id: string) =>
        call(pin, "POST", `/orders/${id}/pay-cash`, { amountTendered: "1000" });

    it("refuses a principal pinned to A on checkout, status, cash and mobile reader for an order at B", async () => {
        const id = await createOrder(LOC_B);

        const checkout = await call(
            "LOC-A",
            "POST",
            `/orders/${id}/checkout`,
            {},
        );
        assert.equal(checkout.status, 404);
        assert.deepEqual(checkout.body, NOT_FOUND);

        const status = await call(
            "LOC-A",
            "GET",
            `/orders/${id}/checkout/chk-1`,
        );
        assert.equal(status.status, 404);
        assert.deepEqual(status.body, NOT_FOUND);

        const cash = await payCash("LOC-A", id);
        assert.equal(cash.status, 404);
        assert.deepEqual(cash.body, NOT_FOUND);

        const reader = await call(
            "LOC-A",
            "POST",
            `/orders/${id}/pay-mobile-reader`,
            {
                paymentId: "pay-1",
            },
        );
        assert.equal(reader.status, 404);
        assert.deepEqual(reader.body, NOT_FOUND);
    });

    it("answers an unknown order exactly like a wrong-location order", async () => {
        const unknown = await payCash("LOC-A", "missing-order");
        assert.equal(unknown.status, 404);
        assert.deepEqual(unknown.body, NOT_FOUND);

        const id = await createOrder(LOC_B);
        const elsewhere = await payCash("LOC-A", id);
        assert.deepEqual(elsewhere, unknown);
    });

    // The allowed path reaches the normal handler. A 500 from the local
    // provider's version check is not a refusal, so these assert "not refused".
    it("lets a principal pinned to A past the location check for an order at A", async () => {
        const id = await createOrder(LOC_A);
        const cash = await payCash("LOC-A", id);
        assert.notEqual(cash.status, 404);
        assert.notDeepEqual(cash.body, NOT_FOUND);
    });

    it("lets an unpinned principal past the location check for an order at B", async () => {
        const id = await createOrder(LOC_B);
        const cash = await payCash(undefined, id);
        assert.notEqual(cash.status, 404);
        assert.notDeepEqual(cash.body, NOT_FOUND);
    });

    it("lets an unpinned principal past the location check on checkout and status", async () => {
        const id = await createOrder(LOC_B);
        const checkout = await call(
            undefined,
            "POST",
            `/orders/${id}/checkout`,
            {},
        );
        assert.notDeepEqual(checkout.body, NOT_FOUND);
        const status = await call(
            undefined,
            "GET",
            `/orders/${id}/checkout/chk-1`,
        );
        assert.notDeepEqual(status.body, NOT_FOUND);
    });
});
