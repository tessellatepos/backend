import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { parseMoney } from "@tessellatepos/sdk";
import type {
    InvoiceStatus,
    Money,
    Order,
    ProcessorEvent,
} from "@tessellatepos/sdk";
import type { Square } from "square";
import { getActiveProviderId } from "@/services/providers";
import { squareClient } from "@/services/providers/square";
import { getStoredLocationId } from "@/services/squareOauth";
import {
    getEnabledProcessorConfig,
    listEnabledProcessorConfigs,
} from "./settings";
import type { PaymentProcessor, RawWebhookRequest } from "./types";

const SIGNATURE_HEADER = "x-square-hmacsha256-signature";

/** Everything the processor needs from outside, so tests can replace it. */
export interface SquareProcessorDeps {
    createPaymentLink(
        request: Square.checkout.CreatePaymentLinkRequest,
    ): Promise<Square.CreatePaymentLinkResponse>;
    /** The Square location to charge at for an order. */
    locationIdFor(order: Order): Promise<string>;
    /** Webhook signature keys that may have signed a notification. */
    signatureKeys(): Promise<string[]>;
}

/** The Square calls invoicing needs, separate so a test can replace them. */
export interface SquareInvoiceDeps {
    createOrder(
        request: Square.CreateOrderRequest,
    ): Promise<Square.CreateOrderResponse>;
    createCustomer(
        request: Square.CreateCustomerRequest,
    ): Promise<Square.CreateCustomerResponse>;
    createInvoice(
        request: Square.CreateInvoiceRequest,
    ): Promise<Square.CreateInvoiceResponse>;
    publishInvoice(
        request: Square.PublishInvoiceRequest,
    ): Promise<Square.PublishInvoiceResponse>;
    getInvoice(
        request: Square.GetInvoicesRequest,
    ): Promise<Square.GetInvoiceResponse>;
    cancelInvoice(
        request: Square.CancelInvoiceRequest,
    ): Promise<Square.CancelInvoiceResponse>;
    deleteInvoice(
        request: Square.DeleteInvoicesRequest,
    ): Promise<Square.DeleteInvoiceResponse>;
    /** True when our orders and customers already are Square's. */
    catalogIsSquare(): boolean;
}

/**
 * Square's webhook signature: base64 HMAC-SHA256, keyed with the
 * subscription's signature key, over the notification URL followed by the raw
 * body.
 * @param key the subscription's signature key
 * @param url the notification URL registered with Square
 * @param rawBody the body exactly as received
 * @param given the header value
 * @returns true when the signature matches
 */
export function verifySquareSignature(
    key: string,
    url: string,
    rawBody: Buffer,
    given: string,
): boolean {
    const expected = createHmac("sha256", key)
        .update(url)
        .update(rawBody)
        .digest();
    const actual = Buffer.from(given, "base64");
    return (
        actual.length === expected.length && timingSafeEqual(actual, expected)
    );
}

interface SquareWebhookBody {
    event_id?: string;
    type?: string;
    data?: {
        object?: {
            payment?: {
                id?: string;
                order_id?: string;
                status?: string;
                amount_money?: { amount?: number | string; currency?: string };
            };
            order_updated?: { order_id?: string; state?: string };
            invoice?: {
                id?: string;
                status?: string;
                payment_requests?: {
                    total_completed_amount_money?: {
                        amount?: number | string;
                        currency?: string;
                    };
                }[];
            };
        };
    };
}

function toMoney(raw: { amount?: number | string; currency?: string }) {
    return raw.amount === undefined || !raw.currency
        ? undefined
        : parseMoney({ amount: raw.amount, currency: raw.currency });
}

/**
 * Square's invoice status in our vocabulary. Square has more states than we
 * track: a partly paid invoice is still open, and states we have no word for
 * (a partial refund, a failed automatic charge) change nothing.
 * @param status Square's `Invoice.status`
 * @returns our status, or null when it should be ignored
 */
export function mapSquareInvoiceStatus(
    status: string | undefined,
): InvoiceStatus | null {
    switch (status) {
        case "DRAFT":
            return "draft";
        case "UNPAID":
        case "SCHEDULED":
        case "PARTIALLY_PAID":
        case "PAYMENT_PENDING":
            return "sent";
        case "PAID":
            return "paid";
        case "REFUNDED":
            return "refunded";
        case "CANCELED":
            return "canceled";
        default:
            return null;
    }
}

/**
 * Turns a verified Square notification into a host event. Both
 * `payment.updated` and `order.updated` can say "paid"; the host treats the
 * second as a no-op. The attempt is identified by the Square order id.
 * @param body the parsed notification
 * @returns the event; `ignored` for anything the host does not act on
 */
export function mapSquareEvent(body: SquareWebhookBody): ProcessorEvent {
    const id = body.event_id ?? "";
    const object = body.data?.object;
    if (!id) return { id, type: "ignored" };

    // The invoice's own status decides, not the event name, so a redelivered
    // or reordered notification still describes the invoice as it was then.
    if (body.type?.startsWith("invoice.") && object?.invoice?.id) {
        const invoice = object.invoice;
        const status =
            body.type === "invoice.scheduled_charge_failed"
                ? null
                : mapSquareInvoiceStatus(invoice.status);
        if (status) {
            const completed =
                invoice.payment_requests?.[0]?.total_completed_amount_money;
            return {
                id,
                type: "payment.updated",
                kind: "invoice",
                external_id: invoice.id!,
                status,
                amount:
                    status === "paid" && completed
                        ? toMoney(completed)
                        : undefined,
            };
        }
        return { id, type: "ignored" };
    }

    if (body.type === "payment.updated" && object?.payment?.order_id) {
        const payment = object.payment;
        const status =
            payment.status === "COMPLETED"
                ? "paid"
                : payment.status === "FAILED" || payment.status === "CANCELED"
                  ? "failed"
                  : null;
        if (status) {
            return {
                id,
                type: "payment.updated",
                kind: "checkout",
                external_id: payment.order_id!,
                status,
                payment_id: payment.id,
                amount:
                    status === "paid" && payment.amount_money
                        ? toMoney(payment.amount_money)
                        : undefined,
            };
        }
    }

    if (body.type === "order.updated" && object?.order_updated?.order_id) {
        const { order_id, state } = object.order_updated;
        const status =
            state === "COMPLETED"
                ? "paid"
                : state === "CANCELED"
                  ? "expired"
                  : null;
        if (status) {
            return {
                id,
                type: "payment.updated",
                kind: "checkout",
                external_id: order_id!,
                status,
            };
        }
    }

    return { id, type: "ignored" };
}

/** Sum of the lines, or null when any line cannot be priced. */
function sumLines(lines: Square.OrderLineItem[]): bigint | null {
    let sum = 0n;
    for (const line of lines) {
        if (line.basePriceMoney?.amount == null) return null;
        sum += BigInt(line.basePriceMoney.amount) * BigInt(line.quantity);
    }
    return sum;
}

/**
 * Square line items for an order. Falls back to one line for the whole total
 * when the stored lines do not add up to it (taxes, discounts), so the amount
 * the shopper is asked to pay is always the order's total.
 * @param order our order
 * @param total the order total
 * @returns the lines to send to Square
 */
function toSquareLines(order: Order, total: Money): Square.OrderLineItem[] {
    // Stored lines come back from jsonb, where bigints are strings.
    const stored = (order.lineItems ?? []).flatMap((line) => {
        const price = parseMoney(line.priceMoney);
        if (!line.name || !price) return [];
        return [
            {
                name: line.name,
                quantity: String(line.quantity ?? 1),
                basePriceMoney: {
                    amount: price.amount,
                    currency: price.currency as Square.Currency,
                },
            },
        ];
    });
    if (stored.length > 0 && sumLines(stored) === total.amount) return stored;
    return [
        {
            name: `Order ${order.referenceId ?? ""}`.trim(),
            quantity: "1",
            basePriceMoney: {
                amount: total.amount,
                currency: total.currency as Square.Currency,
            },
        },
    ];
}

function defaultInvoiceDeps(): SquareInvoiceDeps {
    return {
        createOrder: (request) => squareClient.orders.create(request),
        createCustomer: (request) => squareClient.customers.create(request),
        createInvoice: (request) => squareClient.invoices.create(request),
        publishInvoice: (request) => squareClient.invoices.publish(request),
        getInvoice: (request) => squareClient.invoices.get(request),
        cancelInvoice: (request) => squareClient.invoices.cancel(request),
        deleteInvoice: (request) => squareClient.invoices.delete(request),
        catalogIsSquare: () => getActiveProviderId() === "square",
    };
}

function defaultDeps(): SquareProcessorDeps {
    return {
        createPaymentLink: (request) =>
            squareClient.checkout.paymentLinks.create(request),
        async locationIdFor(order) {
            const configured = (
                await getEnabledProcessorConfig("square", order.locationId)
            )?.squareLocationId;
            if (configured) return configured;
            // With Square as the catalog, our locations are Square's.
            if (getActiveProviderId() === "square") return order.locationId;
            const stored = await getStoredLocationId();
            if (!stored) throw new Error("No Square location is configured");
            return stored;
        },
        async signatureKeys() {
            const configs = await listEnabledProcessorConfigs("square");
            return [
                ...configs.map((c) => c.webhookSignatureKey),
                process.env.SQUARE_WEBHOOK_SIGNATURE_KEY,
            ].filter((k): k is string => !!k);
        },
    };
}

/**
 * The Square payment processor: hosted checkout through Payment Links. The
 * shopper pays on Square's page, so no card data reaches this backend; the
 * result comes back as a signed webhook. Invoices go through Square's
 * Invoices API: the invoice is created and published in one step, and Square
 * emails or texts it (or hands back a link to share).
 * Square's hosts are fixed by the SDK, never user supplied.
 * @param deps replaces the Square client and key lookup, for tests
 * @param invoiceDeps replaces the Square invoice, order and customer calls
 * @returns the processor
 */
export function createSquareProcessor(
    deps?: SquareProcessorDeps,
    invoiceDeps?: SquareInvoiceDeps,
): PaymentProcessor {
    let resolved = deps;
    const resolve = () => (resolved ??= defaultDeps());
    let resolvedInvoices = invoiceDeps;
    const invoices = () => (resolvedInvoices ??= defaultInvoiceDeps());
    return {
        id: "square",
        label: "Square",
        capabilities: { checkout: true, invoice: true },

        async createCheckout({ order, successUrl, customer }) {
            const total = parseMoney(order.totalMoney);
            if (!order.referenceId || !total) {
                throw new Error("Order has no total to charge");
            }
            const d = resolve();
            const response = await d.createPaymentLink({
                idempotencyKey: randomUUID(),
                order: {
                    locationId: await d.locationIdFor(order),
                    referenceId: order.referenceId,
                    lineItems: toSquareLines(order, total),
                },
                checkoutOptions: { redirectUrl: successUrl },
                prePopulatedData: customer?.email
                    ? { buyerEmail: customer.email }
                    : undefined,
            });
            const link = response.paymentLink;
            // The webhooks name the Square order, not the link.
            if (!link?.orderId || !link.url) {
                throw new Error("Square did not return a checkout link");
            }
            return { externalId: link.orderId, url: link.url };
        },

        async createInvoice({ order, customer, dueDate, delivery, message }) {
            const total = parseMoney(order.totalMoney);
            if (!order.referenceId || !total) {
                throw new Error("Order has no total to invoice");
            }
            const d = resolve();
            const api = invoices();
            const locationId = await d.locationIdFor(order);

            let squareOrderId = order.id;
            let squareCustomerId = customer.id;
            if (!api.catalogIsSquare() || !squareOrderId) {
                // Our orders and customers are not Square's, but an invoice
                // needs both to exist there.
                const created = await api.createOrder({
                    idempotencyKey: randomUUID(),
                    order: {
                        locationId,
                        referenceId: order.referenceId,
                        lineItems: toSquareLines(order, total),
                    },
                });
                squareOrderId = created.order?.id;
                const person = await api.createCustomer({
                    idempotencyKey: randomUUID(),
                    referenceId: customer.id,
                    givenName: customer.given_name || undefined,
                    familyName: customer.family_name || undefined,
                    companyName: customer.company_name || undefined,
                    emailAddress: customer.email || undefined,
                    phoneNumber: customer.phone_number || undefined,
                });
                squareCustomerId = person.customer?.id ?? "";
            }
            if (!squareOrderId || !squareCustomerId) {
                throw new Error("Square did not return an order and customer");
            }

            const draft = (
                await api.createInvoice({
                    idempotencyKey: randomUUID(),
                    invoice: {
                        locationId,
                        orderId: squareOrderId,
                        primaryRecipient: { customerId: squareCustomerId },
                        paymentRequests: [{ requestType: "BALANCE", dueDate }],
                        deliveryMethod: delivery,
                        description: message,
                        acceptedPaymentMethods: { card: true },
                    },
                })
            ).invoice;
            if (!draft?.id) throw new Error("Square did not return an invoice");

            let published: Square.Invoice | undefined;
            try {
                published = (
                    await api.publishInvoice({
                        invoiceId: draft.id,
                        version: draft.version ?? 0,
                        idempotencyKey: randomUUID(),
                    })
                ).invoice;
            } catch (err) {
                // Do not leave a draft nobody knows about.
                await api
                    .deleteInvoice({
                        invoiceId: draft.id,
                        version: draft.version ?? 0,
                    })
                    .catch(() => undefined);
                throw err;
            }
            return {
                externalId: draft.id,
                url: published?.publicUrl,
                status: mapSquareInvoiceStatus(published?.status) ?? "sent",
            };
        },

        async cancelInvoice(externalId) {
            const api = invoices();
            const current = (await api.getInvoice({ invoiceId: externalId }))
                .invoice;
            if (current?.status === "CANCELED") return;
            await api.cancelInvoice({
                invoiceId: externalId,
                version: current?.version ?? 0,
            });
        },

        async handleWebhook(req: RawWebhookRequest): Promise<ProcessorEvent[]> {
            const header = req.headers[SIGNATURE_HEADER];
            const given = typeof header === "string" ? header : "";
            const keys = given ? await resolve().signatureKeys() : [];
            const valid = keys.some((key) =>
                verifySquareSignature(key, req.url, req.rawBody, given),
            );
            if (!valid) throw new Error("Invalid webhook signature");

            let body: SquareWebhookBody;
            try {
                body = JSON.parse(req.rawBody.toString("utf8"));
            } catch {
                return [];
            }
            return [mapSquareEvent(body)];
        },
    };
}
