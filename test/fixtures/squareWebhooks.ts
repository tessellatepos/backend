/**
 * Square notification bodies in the shape Square documents for
 * `payment.updated` and `order.updated`, trimmed to the fields we read.
 * Recorded by hand from the docs, not captured from a live sandbox.
 */
export const SQUARE_SIGNATURE_KEY = "square-test-signature-key-0123456789";
export const SQUARE_NOTIFICATION_URL =
    "https://shop.example.test/webhooks/square";

export function squarePaymentUpdated(opts: {
    eventId: string;
    orderId: string;
    status: string;
    amount?: number;
    currency?: string;
}): string {
    return JSON.stringify({
        merchant_id: "MLTEST",
        type: "payment.updated",
        event_id: opts.eventId,
        created_at: "2025-01-01T12:00:00.000Z",
        data: {
            type: "payment",
            id: "PAYTEST1",
            object: {
                payment: {
                    id: "PAYTEST1",
                    order_id: opts.orderId,
                    location_id: "LTEST",
                    status: opts.status,
                    amount_money: {
                        amount: opts.amount ?? 1500,
                        currency: opts.currency ?? "CAD",
                    },
                    total_money: {
                        amount: opts.amount ?? 1500,
                        currency: opts.currency ?? "CAD",
                    },
                },
            },
        },
    });
}

export function squareOrderUpdated(opts: {
    eventId: string;
    orderId: string;
    state: string;
}): string {
    return JSON.stringify({
        merchant_id: "MLTEST",
        type: "order.updated",
        event_id: opts.eventId,
        created_at: "2025-01-01T12:00:00.000Z",
        data: {
            type: "order_updated",
            id: opts.orderId,
            object: {
                order_updated: {
                    order_id: opts.orderId,
                    location_id: "LTEST",
                    state: opts.state,
                    version: 3,
                },
            },
        },
    });
}

/**
 * An `invoice.*` notification in the shape Square documents, trimmed to the
 * fields we read. Written by hand from the docs, not captured from a sandbox.
 */
export function squareInvoiceEvent(opts: {
    eventId: string;
    type?: string;
    invoiceId: string;
    status: string;
    completed?: { amount: number; currency: string };
}): string {
    return JSON.stringify({
        merchant_id: "MLTEST",
        type: opts.type ?? "invoice.updated",
        event_id: opts.eventId,
        created_at: "2025-01-01T12:00:00.000Z",
        data: {
            type: "invoice",
            id: opts.invoiceId,
            object: {
                invoice: {
                    id: opts.invoiceId,
                    version: 2,
                    location_id: "LTEST",
                    order_id: "SQORDERINV",
                    status: opts.status,
                    payment_requests: [
                        {
                            uid: "pr1",
                            request_type: "BALANCE",
                            due_date: "2030-01-24",
                            total_completed_amount_money: opts.completed,
                        },
                    ],
                },
            },
        },
    });
}
