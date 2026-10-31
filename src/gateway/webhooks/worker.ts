/**
 * Runs the delivery worker on an interval. One pass at a time per process;
 * the database lease keeps two processes from sending the same row.
 */
import { Logger } from "tslog";
import { deliverDue } from "@/gateway/webhooks/dispatch";

const logger = new Logger({ name: "webhooks" });

/** How often the worker looks for due deliveries. */
export const WORKER_INTERVAL_MS = 5_000;

/**
 * Starts the worker.
 * @param intervalMs how often to run a pass
 * @returns a function that stops it
 */
export function startWebhookWorker(
    intervalMs = WORKER_INTERVAL_MS,
): () => void {
    let running = false;
    const timer = setInterval(() => {
        if (running) return;
        running = true;
        deliverDue()
            .catch((err) => logger.error("Webhook worker pass failed", err))
            .finally(() => {
                running = false;
            });
    }, intervalMs);
    timer.unref();
    return () => clearInterval(timer);
}
