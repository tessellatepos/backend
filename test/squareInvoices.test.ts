import "@/test/localProvider";
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import type { Customer, Order } from "@tessellatepos/sdk";
import type { Square } from "square";
import { pool } from "@/services/db/postgres";
import { getRedisClient } from "@/services/redis";
import {
    createSquareProcessor,
    mapSquareEvent,
    mapSquareInvoiceStatus,
    type SquareInvoiceDeps,
    type SquareProcessorDeps,
} from "@/services/processors/square";
import {
    SQUARE_NOTIFICATION_URL,
    SQUARE_SIGNATURE_KEY,
    squareInvoiceEvent,
} from "./fixtures/squareWebhooks";

after(async () => {
    await pool.end();
    await (await getRedisClient())?.quit();
});

// The Square calls are replaced by a fake that records requests and answers
// in the documented response shapes. Nothing here has run against Square.
function fakeInvoiceDeps(
    overrides: Partial<SquareInvoiceDeps> = {},
    catalogIsSquare = false,
) {
    const calls: { name: string; request: unknown }[] = [];
    const record =
        <T>(name: string, answer: T) =>
        async (request: unknown): Promise<T> => {
            calls.push({ name, request });
            return answer;
        };
    const deps: SquareInvoiceDeps = {
        createOrder: record("createOrder", {
            order: { id: "SQORDERINV" },
        } as Square.CreateOrderResponse),
        createCustomer: record("createCustomer", {
            customer: { id: "SQCUST1" },
        } as Square.CreateCustomerResponse),
        createInvoice: record("createInvoice", {
            invoice: { id: "INV1", version: 0, status: "DRAFT" },
        } as Square.CreateInvoiceResponse),
        publishInvoice: record("publishInvoice", {
            invoice: {
                id: "INV1",
                version: 1,
                status: "UNPAID",
                publicUrl: "https://squareup.com/pay-invoice/INV1",
            },
        } as Square.PublishInvoiceResponse),
        getInvoice: record("getInvoice", {
            invoice: { id: "INV1", version: 4, status: "UNPAID" },
        } as Square.GetInvoiceResponse),
        cancelInvoice: record("cancelInvoice", {
            invoice: { id: "INV1", status: "CANCELED" },
        } as Square.CancelInvoiceResponse),
        deleteInvoice: record(
            "deleteInvoice",
            {} as Square.DeleteInvoiceResponse,
        ),
        catalogIsSquare: () => catalogIsSquare,
        ...overrides,
    };
    return { deps, calls };
}

const processorDeps = (): SquareProcessorDeps => ({
    createPaymentLink: async () => ({}),
    locationIdFor: async () => "LTEST",
    signatureKeys: async () => [SQUARE_SIGNATURE_KEY],
});

const order = {
    id: "SQORDER-LOCAL",
    locationId: "loc",
    referenceId: "ref-1",
    lineItems: [
        {
            name: "Cake",
            quantity: 2n,
            priceMoney: { amount: 750n, currency: "CAD" },
        },
    ],
    totalMoney: { amount: 1500n, currency: "CAD" },
} as unknown as Order;

const customer: Customer = {
    id: "cust-1",
    given_name: "Ada",
    family_name: "Lovelace",
    company_name: "",
    email: "ada@example.test",
    phone_number: "",
    note: "",
    tags: [],
    created_at: "",
    updated_at: "",
};

describe("square invoices", () => {
    it("creates and publishes an invoice, creating the Square order and customer when the catalog is not Square", async () => {
        const { deps, calls } = fakeInvoiceDeps();
        const processor = createSquareProcessor(processorDeps(), deps);
        const result = await processor.createInvoice!({
            order,
            customer,
            dueDate: "2030-01-24",
            delivery: "EMAIL",
            message: "Thanks!",
        });
        assert.deepEqual(result, {
            externalId: "INV1",
            url: "https://squareup.com/pay-invoice/INV1",
            status: "sent",
        });
        assert.deepEqual(
            calls.map((c) => c.name),
            [
                "createOrder",
                "createCustomer",
                "createInvoice",
                "publishInvoice",
            ],
        );
        const created = calls[2].request as Square.CreateInvoiceRequest;
        assert.equal(created.invoice.orderId, "SQORDERINV");
        assert.equal(created.invoice.primaryRecipient?.customerId, "SQCUST1");
        assert.equal(created.invoice.deliveryMethod, "EMAIL");
        assert.equal(created.invoice.description, "Thanks!");
        assert.equal(created.invoice.locationId, "LTEST");
        assert.deepEqual(created.invoice.paymentRequests, [
            { requestType: "BALANCE", dueDate: "2030-01-24" },
        ]);
        const published = calls[3].request as Square.PublishInvoiceRequest;
        assert.equal(published.invoiceId, "INV1");
        assert.equal(published.version, 0);
        const customerRequest = calls[1]
            .request as Square.CreateCustomerRequest;
        assert.equal(customerRequest.emailAddress, "ada@example.test");
        assert.equal(customerRequest.phoneNumber, undefined);
    });

    it("uses the order and customer as they are when Square is the catalog", async () => {
        const { deps, calls } = fakeInvoiceDeps({}, true);
        const processor = createSquareProcessor(processorDeps(), deps);
        await processor.createInvoice!({
            order,
            customer,
            dueDate: "2030-01-24",
            delivery: "SHARE_MANUALLY",
        });
        assert.deepEqual(
            calls.map((c) => c.name),
            ["createInvoice", "publishInvoice"],
        );
        const created = calls[0].request as Square.CreateInvoiceRequest;
        assert.equal(created.invoice.orderId, "SQORDER-LOCAL");
        assert.equal(created.invoice.primaryRecipient?.customerId, "cust-1");
    });

    it("deletes the draft when publishing fails", async () => {
        const { deps, calls } = fakeInvoiceDeps(
            {
                publishInvoice: async () => {
                    throw new Error("publish refused");
                },
            },
            true,
        );
        const processor = createSquareProcessor(processorDeps(), deps);
        await assert.rejects(
            processor.createInvoice!({
                order,
                customer,
                dueDate: "2030-01-24",
                delivery: "EMAIL",
            }),
            /publish refused/,
        );
        assert.deepEqual(calls.at(-1), {
            name: "deleteInvoice",
            request: { invoiceId: "INV1", version: 0 },
        });
    });

    it("cancels with the invoice's current version, and skips one already canceled", async () => {
        const { deps, calls } = fakeInvoiceDeps();
        const processor = createSquareProcessor(processorDeps(), deps);
        await processor.cancelInvoice!("INV1");
        assert.deepEqual(calls[1].request, { invoiceId: "INV1", version: 4 });

        const canceled = fakeInvoiceDeps({
            getInvoice: async () => ({
                invoice: { id: "INV1", version: 5, status: "CANCELED" },
            }),
        });
        await createSquareProcessor(processorDeps(), canceled.deps)
            .cancelInvoice!("INV1");
        assert.equal(canceled.calls.length, 0);
    });
});

describe("square invoice webhooks", () => {
    it("maps Square's invoice statuses to ours", () => {
        const expected: Record<string, string | null> = {
            DRAFT: "draft",
            UNPAID: "sent",
            SCHEDULED: "sent",
            PARTIALLY_PAID: "sent",
            PAYMENT_PENDING: "sent",
            PAID: "paid",
            REFUNDED: "refunded",
            CANCELED: "canceled",
            PARTIALLY_REFUNDED: null,
            FAILED: null,
        };
        for (const [from, to] of Object.entries(expected)) {
            assert.equal(mapSquareInvoiceStatus(from), to, from);
        }
        assert.equal(mapSquareInvoiceStatus(undefined), null);
    });

    it("turns an invoice notification into an invoice event keyed by the invoice id", () => {
        const body = JSON.parse(
            squareInvoiceEvent({
                eventId: "ev1",
                type: "invoice.payment_made",
                invoiceId: "INV1",
                status: "PAID",
                completed: { amount: 1500, currency: "CAD" },
            }),
        );
        assert.deepEqual(mapSquareEvent(body), {
            id: "ev1",
            type: "payment.updated",
            kind: "invoice",
            external_id: "INV1",
            status: "paid",
            amount: { amount: 1500n, currency: "CAD" },
        });
    });

    it("ignores failed charges, unmapped statuses and bodies without an invoice", () => {
        for (const body of [
            squareInvoiceEvent({
                eventId: "e2",
                type: "invoice.scheduled_charge_failed",
                invoiceId: "INV1",
                status: "UNPAID",
            }),
            squareInvoiceEvent({
                eventId: "e3",
                invoiceId: "INV1",
                status: "PARTIALLY_REFUNDED",
            }),
        ]) {
            assert.equal(mapSquareEvent(JSON.parse(body)).type, "ignored");
        }
        assert.equal(
            mapSquareEvent({ event_id: "e4", type: "invoice.created" }).type,
            "ignored",
        );
    });

    it("verifies the signature before mapping", async () => {
        const processor = createSquareProcessor(processorDeps());
        const body = squareInvoiceEvent({
            eventId: "ev9",
            type: "invoice.canceled",
            invoiceId: "INV9",
            status: "CANCELED",
        });
        const signature = createHmac("sha256", SQUARE_SIGNATURE_KEY)
            .update(SQUARE_NOTIFICATION_URL + body)
            .digest("base64");
        const request = (sig: string) => ({
            headers: { "x-square-hmacsha256-signature": sig },
            rawBody: Buffer.from(body),
            url: SQUARE_NOTIFICATION_URL,
        });
        const [event] = await processor.handleWebhook(request(signature));
        assert.equal(event.type, "payment.updated");
        await assert.rejects(processor.handleWebhook(request("AAAA")));
    });
});
