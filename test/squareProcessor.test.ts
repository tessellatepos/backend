import "@/test/localProvider";
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import type { Order } from "@tessellatepos/sdk";
import { pool } from "@/services/db/postgres";
import { getRedisClient } from "@/services/redis";
import {
    createSquareProcessor,
    mapSquareEvent,
    verifySquareSignature,
    type SquareProcessorDeps,
} from "@/services/processors/square";
import {
    SQUARE_NOTIFICATION_URL,
    SQUARE_SIGNATURE_KEY,
    squareOrderUpdated,
    squarePaymentUpdated,
} from "./fixtures/squareWebhooks";

after(async () => {
    await pool.end();
    await (await getRedisClient())?.quit();
});

const sign = (body: string, key = SQUARE_SIGNATURE_KEY) =>
    createHmac("sha256", key)
        .update(SQUARE_NOTIFICATION_URL + body)
        .digest("base64");

function fakeDeps(
    overrides: Partial<SquareProcessorDeps> = {},
): SquareProcessorDeps & { requests: unknown[] } {
    const requests: unknown[] = [];
    return {
        requests,
        async createPaymentLink(request) {
            requests.push(request);
            return {
                paymentLink: {
                    id: "LINK1",
                    version: 1,
                    orderId: "SQORDER1",
                    url: "https://square.link/u/abc",
                },
            };
        },
        locationIdFor: async () => "LTEST",
        signatureKeys: async () => [SQUARE_SIGNATURE_KEY],
        ...overrides,
    };
}

const webhook = (body: string, signature: string | undefined) => ({
    headers:
        signature === undefined
            ? {}
            : { "x-square-hmacsha256-signature": signature },
    rawBody: Buffer.from(body),
    url: SQUARE_NOTIFICATION_URL,
});

describe("verifySquareSignature", () => {
    // Computed with Python's hmac/hashlib, independently of the code under test.
    const url = "https://example.test/webhooks/square";
    const body = '{"event_id":"e1","type":"payment.updated"}';
    const known = "TLLkMSMIEVsG45elbFiFWIaSd7ksoL8TtCqaC+qi6nk=";

    it("accepts the known vector", () => {
        assert.equal(
            verifySquareSignature("vector-key", url, Buffer.from(body), known),
            true,
        );
    });

    it("rejects a tampered body, a wrong key, a wrong url and junk", () => {
        const raw = Buffer.from(body);
        assert.equal(
            verifySquareSignature(
                "vector-key",
                url,
                Buffer.from(body + " "),
                known,
            ),
            false,
        );
        assert.equal(
            verifySquareSignature("other-key", url, raw, known),
            false,
        );
        assert.equal(
            verifySquareSignature(
                "vector-key",
                "https://evil.test/webhooks/square",
                raw,
                known,
            ),
            false,
        );
        assert.equal(verifySquareSignature("vector-key", url, raw, ""), false);
        assert.equal(
            verifySquareSignature("vector-key", url, raw, "not base64 !!"),
            false,
        );
    });
});

describe("square processor webhooks", () => {
    const processor = createSquareProcessor(fakeDeps());

    it("declares checkout and invoices", () => {
        assert.deepEqual(processor.capabilities, {
            checkout: true,
            invoice: true,
        });
    });

    it("maps a completed payment to paid, with the payment id and amount", async () => {
        const body = squarePaymentUpdated({
            eventId: "e1",
            orderId: "SQORDER1",
            status: "COMPLETED",
        });
        const [event] = await processor.handleWebhook(
            webhook(body, sign(body)),
        );
        assert.deepEqual(event, {
            id: "e1",
            type: "payment.updated",
            kind: "checkout",
            external_id: "SQORDER1",
            status: "paid",
            payment_id: "PAYTEST1",
            amount: { amount: 1500n, currency: "CAD" },
        });
    });

    it("maps failed and canceled payments to failed", () => {
        for (const status of ["FAILED", "CANCELED"]) {
            const event = mapSquareEvent(
                JSON.parse(
                    squarePaymentUpdated({
                        eventId: "e2",
                        orderId: "O",
                        status,
                    }),
                ),
            );
            assert.equal(
                event.type === "ignored" ? null : event.status,
                "failed",
            );
        }
    });

    it("ignores payments that are not final", () => {
        for (const status of ["PENDING", "APPROVED"]) {
            const event = mapSquareEvent(
                JSON.parse(
                    squarePaymentUpdated({
                        eventId: "e3",
                        orderId: "O",
                        status,
                    }),
                ),
            );
            assert.equal(event.type, "ignored");
        }
    });

    it("maps order.updated COMPLETED to paid and CANCELED to expired", () => {
        const paid = mapSquareEvent(
            JSON.parse(
                squareOrderUpdated({
                    eventId: "e4",
                    orderId: "SQORDER1",
                    state: "COMPLETED",
                }),
            ),
        );
        const expired = mapSquareEvent(
            JSON.parse(
                squareOrderUpdated({
                    eventId: "e5",
                    orderId: "SQORDER1",
                    state: "CANCELED",
                }),
            ),
        );
        assert.equal(paid.type === "ignored" ? null : paid.status, "paid");
        assert.equal(
            expired.type === "ignored" ? null : expired.status,
            "expired",
        );
        assert.equal(
            mapSquareEvent(
                JSON.parse(
                    squareOrderUpdated({
                        eventId: "e6",
                        orderId: "SQORDER1",
                        state: "OPEN",
                    }),
                ),
            ).type,
            "ignored",
        );
    });

    it("ignores unrelated event types and events without an id", async () => {
        const other = JSON.stringify({
            event_id: "e7",
            type: "catalog.version.updated",
            data: {},
        });
        assert.deepEqual(
            await processor.handleWebhook(webhook(other, sign(other))),
            [{ id: "e7", type: "ignored" }],
        );
        assert.equal(
            mapSquareEvent({ type: "payment.updated" }).type,
            "ignored",
        );
    });

    it("rejects unsigned, tampered, wrongly keyed and keyless webhooks", async () => {
        const body = squarePaymentUpdated({
            eventId: "e8",
            orderId: "SQORDER1",
            status: "COMPLETED",
        });
        await assert.rejects(processor.handleWebhook(webhook(body, undefined)));
        await assert.rejects(
            processor.handleWebhook(webhook(body + " ", sign(body))),
        );
        await assert.rejects(
            processor.handleWebhook(
                webhook(body, sign(body, "some-other-key")),
            ),
        );
        const noKeys = createSquareProcessor(
            fakeDeps({ signatureKeys: async () => [] }),
        );
        await assert.rejects(noKeys.handleWebhook(webhook(body, sign(body))));
    });

    it("accepts a signature from any configured key", async () => {
        const body = squarePaymentUpdated({
            eventId: "e9",
            orderId: "SQORDER1",
            status: "COMPLETED",
        });
        const two = createSquareProcessor(
            fakeDeps({
                signatureKeys: async () => ["first-key", SQUARE_SIGNATURE_KEY],
            }),
        );
        assert.equal(
            (await two.handleWebhook(webhook(body, sign(body)))).length,
            1,
        );
    });
});

describe("square processor checkout", () => {
    const order: Order = {
        locationId: "LTEST",
        referenceId: "ref-1",
        totalMoney: { amount: 1500n, currency: "CAD" },
        // as read back from jsonb: bigints are strings
        lineItems: [
            {
                name: "Latte",
                quantity: "2",
                priceMoney: { amount: "500", currency: "CAD" },
            },
            {
                name: "Muffin",
                quantity: "1",
                priceMoney: { amount: "500", currency: "CAD" },
            },
        ] as unknown as Order["lineItems"],
    };

    it("creates a payment link and uses the Square order id as the external id", async () => {
        const deps = fakeDeps();
        const result = await createSquareProcessor(deps).createCheckout!({
            order,
            successUrl: "https://shop.example.test/thanks",
            cancelUrl: "https://shop.example.test/cart",
        });
        assert.deepEqual(result, {
            externalId: "SQORDER1",
            url: "https://square.link/u/abc",
        });
        const sent = deps.requests[0] as {
            order: {
                locationId: string;
                referenceId: string;
                lineItems: { name: string; quantity: string }[];
            };
            checkoutOptions: { redirectUrl: string };
            idempotencyKey: string;
        };
        assert.equal(sent.order.locationId, "LTEST");
        assert.equal(sent.order.referenceId, "ref-1");
        assert.equal(
            sent.checkoutOptions.redirectUrl,
            "https://shop.example.test/thanks",
        );
        assert.deepEqual(
            sent.order.lineItems.map((l) => [l.name, l.quantity]),
            [
                ["Latte", "2"],
                ["Muffin", "1"],
            ],
        );
        assert.ok(sent.idempotencyKey);
    });

    it("charges the order total as one line when the lines do not add up", async () => {
        const deps = fakeDeps();
        await createSquareProcessor(deps).createCheckout!({
            order: { ...order, totalMoney: { amount: 1700n, currency: "CAD" } },
            successUrl: "https://shop.example.test/thanks",
            cancelUrl: "https://shop.example.test/cart",
        });
        const sent = deps.requests[0] as {
            order: {
                lineItems: {
                    quantity: string;
                    basePriceMoney: { amount: bigint };
                }[];
            };
        };
        assert.equal(sent.order.lineItems.length, 1);
        assert.equal(sent.order.lineItems[0].basePriceMoney.amount, 1700n);
    });

    it("fails when Square returns no link or the order has no total", async () => {
        const noLink = createSquareProcessor(
            fakeDeps({ createPaymentLink: async () => ({}) }),
        );
        await assert.rejects(
            noLink.createCheckout!({
                order,
                successUrl: "https://s.test/a",
                cancelUrl: "https://s.test/b",
            }),
        );
        await assert.rejects(
            createSquareProcessor(fakeDeps()).createCheckout!({
                order: { ...order, totalMoney: undefined },
                successUrl: "https://s.test/a",
                cancelUrl: "https://s.test/b",
            }),
        );
    });
});
