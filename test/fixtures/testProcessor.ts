import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type {
    InvoiceStatus,
    OnlinePaymentStatus,
    ProcessorEvent,
} from "@tessellatepos/sdk";
import type {
    PaymentProcessor,
    RawWebhookRequest,
} from "@/services/processors/types";

export const TEST_WEBHOOK_SECRET = "test-processor-webhook-secret";

/** Signs a webhook body the way the test processor expects. */
export function signTestWebhook(body: string): string {
    return createHmac("sha256", TEST_WEBHOOK_SECRET).update(body).digest("hex");
}

/** What the test processor was asked to do, for assertions. */
export interface TestProcessorCalls {
    invoices: { externalId: string; request: unknown }[];
    canceled: string[];
}

/**
 * A pure in-memory processor for contract tests: hosted checkout, HMAC
 * signed webhooks, events identified by id. Makes no network calls. With
 * `options.invoice` it also issues and cancels invoices, and its webhook body
 * may name `kind: "invoice"` with any invoice status.
 */
export function createTestProcessor(
    id = "test",
    options: { invoice?: boolean; calls?: TestProcessorCalls } = {},
): PaymentProcessor {
    const calls = options.calls;
    return {
        id,
        label: "Test processor",
        capabilities: { checkout: true, invoice: options.invoice ?? false },
        ...(options.invoice
            ? {
                  async createInvoice(request) {
                      const externalId = `inv_${randomUUID()}`;
                      calls?.invoices.push({ externalId, request });
                      return {
                          externalId,
                          url: `https://pay.example.test/${externalId}`,
                          status: "sent" as InvoiceStatus,
                      };
                  },
                  async cancelInvoice(externalId: string) {
                      calls?.canceled.push(externalId);
                  },
              }
            : {}),
        async createCheckout({ successUrl }) {
            const externalId = `chk_${randomUUID()}`;
            return {
                externalId,
                url: `https://pay.example.test/${externalId}?return=${encodeURIComponent(successUrl)}`,
            };
        },
        async handleWebhook(req: RawWebhookRequest): Promise<ProcessorEvent[]> {
            const header = req.headers["x-test-signature"];
            const given = typeof header === "string" ? header : "";
            const expected = signTestWebhook(req.rawBody.toString("utf8"));
            const a = Buffer.from(given);
            const b = Buffer.from(expected);
            if (a.length !== b.length || !timingSafeEqual(a, b)) {
                throw new Error("Invalid webhook signature");
            }
            const body = JSON.parse(req.rawBody.toString("utf8")) as {
                id: string;
                external_id?: string;
                status?: string;
                kind?: "checkout" | "invoice";
            };
            if (!body.external_id || !body.status) {
                return [{ id: body.id, type: "ignored" }];
            }
            return [
                {
                    id: body.id,
                    type: "payment.updated",
                    kind: body.kind ?? "checkout",
                    external_id: body.external_id,
                    status: body.status as OnlinePaymentStatus,
                },
            ];
        },
    };
}
