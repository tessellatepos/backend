import { Logger } from "tslog";
import type { Request, Response } from "express";
import { parseMoney } from "@tessellatepos/sdk";
import type {
    InvoiceStatus,
    OnlinePaymentStatus,
    ProcessorEvent,
} from "@tessellatepos/sdk";
import { getRedisClient } from "@/services/redis";
import {
    findOnlinePayment,
    setOnlinePaymentStatus,
} from "@/services/db/onlinePayments";
import { onlinePaymentsAvailable, webhookUrl } from "@/config/urls";
import type { TessellatePluginRegistry } from "@/utils/registry/plugin/pluginRegistry";
import { applyInvoiceEvent } from "@/services/invoices";
import { completeOrderFromPayment } from "./completeOrder";
import { processorRegistry, type PaymentProcessorRegistry } from "./registry";

const logger = new Logger();

/** Long enough to outlive any processor's retry schedule. */
const SEEN_TTL_SECONDS = 30 * 24 * 60 * 60;

const seenKey = (processorId: string, eventId: string) =>
    `processor-event:${processorId}:${eventId}`;

async function wasSeen(processorId: string, eventId: string) {
    const redis = await getRedisClient();
    return (await redis.exists(seenKey(processorId, eventId))) === 1;
}

async function markSeen(processorId: string, eventId: string) {
    const redis = await getRedisClient();
    await redis.set(seenKey(processorId, eventId), "1", {
        EX: SEEN_TTL_SECONDS,
    });
}

/**
 * Acts on the events of one verified webhook. An event id is recorded only
 * after it was handled, so a failure part-way is retried by the processor;
 * handling itself is idempotent, so a duplicate that slips past the seen-set
 * (or a retry) changes nothing and emits nothing a second time.
 * Events for an attempt we do not know are dropped without a trace in the
 * response, and are not recorded, so one that raced ahead of the attempt row
 * is handled if the processor sends it again.
 * @param processorId the processor the webhook came from
 * @param eventList the events its handleWebhook returned
 * @param registry the plugin registry to emit on
 */
export async function applyProcessorEvents(
    processorId: string,
    eventList: ProcessorEvent[],
    registry: TessellatePluginRegistry,
): Promise<void> {
    for (const event of eventList) {
        if (event.type === "ignored") continue;
        if (await wasSeen(processorId, event.id)) continue;

        const attempt = await findOnlinePayment(processorId, event.external_id);
        if (!attempt) {
            logger.debug(
                `Webhook event ${event.id} for an unknown ${processorId} attempt`,
            );
            continue;
        }

        if (event.kind === "invoice") {
            const outcome = await applyInvoiceEvent(
                attempt,
                {
                    status: event.status as InvoiceStatus,
                    paymentId: event.payment_id,
                    amount: event.amount,
                },
                registry,
            );
            if (outcome === "mismatch") {
                logger.warn(
                    `Paid event ${event.id} does not match order ${attempt.order_reference}; left open`,
                );
            }
            await markSeen(processorId, event.id);
            continue;
        }

        if (event.status === "paid") {
            // Before the status update, so a retry after a crash in between
            // still completes the order.
            const result = await completeOrderFromPayment(
                attempt.order_reference,
                {
                    paymentId: event.payment_id,
                    amount: event.amount ?? parseMoney(attempt.amount),
                },
                registry,
            );
            if (result.outcome === "amount_mismatch") {
                logger.warn(
                    `Paid event ${event.id} does not match order ${attempt.order_reference}; left open`,
                );
                await markSeen(processorId, event.id);
                continue;
            }
            if (result.outcome === "canceled") {
                logger.warn(
                    `Order ${attempt.order_reference} was paid after it was canceled; needs a refund`,
                );
            }
        }

        const next: OnlinePaymentStatus = event.status;
        // A paid attempt only moves on to refunded, so a late "expired" or
        // "failed" from an out-of-order event cannot undo it.
        const keep =
            attempt.status === next ||
            (attempt.status === "paid" && next !== "refunded");
        if (!keep) await setOnlinePaymentStatus(attempt.id, next);
        await markSeen(processorId, event.id);
    }
}

/**
 * Express handler for `POST /webhooks/:processorId`. Mounted before
 * `express.json()` with `express.raw()` so the signature can cover the exact
 * bytes. Anything that fails verification gets the same bare 401; nothing
 * about a body or signature is logged or echoed.
 * @param registry the processors to dispatch to
 * @returns the handler
 */
export function processorWebhookHandler(
    registry: PaymentProcessorRegistry = processorRegistry,
) {
    return async (req: Request, res: Response) => {
        const processor = registry.get(String(req.params.processorId));
        if (!processor) {
            res.status(404).json({ message: "Not Found" });
            return;
        }

        let eventList: ProcessorEvent[];
        try {
            eventList = await processor.handleWebhook({
                headers: req.headers,
                rawBody: Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0),
                url:
                    // Behind a proxy the request's own URL is not what the
                    // processor signed; PUBLIC_URL is.
                    (onlinePaymentsAvailable()
                        ? webhookUrl(processor.id)
                        : null) ??
                    `${req.protocol}://${req.get("host")}${req.originalUrl}`,
            });
        } catch {
            res.status(401).json({ message: "Unauthorized" });
            return;
        }

        try {
            const registryOfPlugins = (
                req.app.locals as { pluginRegistry: TessellatePluginRegistry }
            ).pluginRegistry;
            await applyProcessorEvents(
                processor.id,
                eventList,
                registryOfPlugins,
            );
            res.status(200).json({ received: true });
        } catch (err) {
            logger.error(`Webhook handling failed for ${processor.id}`, err);
            // The processor retries on a non-2xx answer.
            res.status(500).json({ message: "Internal Server Error" });
        }
    };
}
