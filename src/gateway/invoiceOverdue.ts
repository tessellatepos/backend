import { Logger } from "tslog";
import { markOverdueInvoices, type OverdueOptions } from "@/services/invoices";

const logger = new Logger({ name: "invoice-overdue" });

/** How often the worker looks for invoices past due. */
export const OVERDUE_INTERVAL_MS = 5 * 60_000;

/**
 * Runs {@link markOverdueInvoices} on an interval, one pass at a time.
 * @param registry the plugin registry that receives the overdue events
 * @param intervalMs how often to run
 * @returns a function that stops it
 */
export function startInvoiceOverdueWorker(
    registry: OverdueOptions["registry"],
    intervalMs = OVERDUE_INTERVAL_MS,
): () => void {
    let running = false;
    const timer = setInterval(() => {
        if (running) return;
        running = true;
        markOverdueInvoices({ registry })
            .catch((err) => logger.error("Invoice overdue pass failed", err))
            .finally(() => {
                running = false;
            });
    }, intervalMs);
    timer.unref();
    return () => clearInterval(timer);
}
