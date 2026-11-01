import { Logger } from "tslog";
import type {
    OnlinePaymentKind,
    OnlinePaymentStatus,
    ProcessorEvent,
} from "@tessellatepos/sdk";
import type { PaymentProcessor } from "./types";

const logger = new Logger();

/** Ids the host keeps for itself, including ones planned for core. */
export const RESERVED_PROCESSOR_IDS: readonly string[] = [
    "square",
    "stripe",
    "local",
];

const ID_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;

const CHECKOUT_STATUSES = ["created", "paid", "expired", "failed"];
const INVOICE_STATUSES = [
    "draft",
    "sent",
    "viewed",
    "paid",
    "overdue",
    "canceled",
    "refunded",
];

/** Thrown when a plugin's payment processor is refused. */
export class PaymentProcessorError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "PaymentProcessorError";
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Checks that a plugin may register a processor and that its shape is valid.
 * The id must be the plugin's name or start with "<plugin name>-", which keeps
 * plugins out of each other's namespace, and may never be one the host keeps.
 * @param pluginName the registering plugin
 * @param permitted whether the plugin holds the PAYMENT permission
 * @param processor the value the plugin passed to
 * `register("paymentProcessor", ...)`
 * @throws PaymentProcessorError when refused
 */
export function validatePaymentProcessor(
    pluginName: string,
    permitted: boolean,
    processor: unknown,
): asserts processor is PaymentProcessor {
    if (!permitted) {
        throw new PaymentProcessorError(
            `Plugin "${pluginName}" registered a payment processor without the PAYMENT permission; add "PAYMENT" to tessellate.permissions in its package.json`,
        );
    }
    if (!isRecord(processor)) {
        throw new PaymentProcessorError(
            `Plugin "${pluginName}": payment processor must be an object`,
        );
    }
    const { id, label, capabilities } = processor;
    if (typeof id !== "string" || !ID_PATTERN.test(id)) {
        throw new PaymentProcessorError(
            `Plugin "${pluginName}": payment processor id must be lower-case letters, digits, "-" or "_" (max 64 characters)`,
        );
    }
    if (RESERVED_PROCESSOR_IDS.includes(id)) {
        throw new PaymentProcessorError(
            `Plugin "${pluginName}": payment processor id "${id}" is reserved`,
        );
    }
    if (id !== pluginName && !id.startsWith(`${pluginName}-`)) {
        throw new PaymentProcessorError(
            `Plugin "${pluginName}": payment processor id "${id}" must be "${pluginName}" or start with "${pluginName}-"`,
        );
    }
    if (typeof label !== "string" || label.trim() === "") {
        throw new PaymentProcessorError(
            `Plugin "${pluginName}": payment processor "${id}" needs a label`,
        );
    }
    if (
        !isRecord(capabilities) ||
        typeof capabilities.checkout !== "boolean" ||
        typeof capabilities.invoice !== "boolean"
    ) {
        throw new PaymentProcessorError(
            `Plugin "${pluginName}": payment processor "${id}" needs capabilities { checkout, invoice }`,
        );
    }
    if (typeof processor.handleWebhook !== "function") {
        throw new PaymentProcessorError(
            `Plugin "${pluginName}": payment processor "${id}" needs handleWebhook`,
        );
    }
    if (
        capabilities.checkout &&
        typeof processor.createCheckout !== "function"
    ) {
        throw new PaymentProcessorError(
            `Plugin "${pluginName}": payment processor "${id}" declares checkout but has no createCheckout`,
        );
    }
    if (
        capabilities.invoice &&
        (typeof processor.createInvoice !== "function" ||
            typeof processor.cancelInvoice !== "function")
    ) {
        throw new PaymentProcessorError(
            `Plugin "${pluginName}": payment processor "${id}" declares invoice but lacks createInvoice or cancelInvoice`,
        );
    }
}

function validEvent(event: unknown): event is ProcessorEvent {
    if (!isRecord(event)) return false;
    if (typeof event.id !== "string" || event.id === "") return false;
    if (event.type === "ignored") return true;
    if (event.type !== "payment.updated") return false;
    if (typeof event.external_id !== "string" || event.external_id === "") {
        return false;
    }
    const kind = event.kind as OnlinePaymentKind;
    const allowed =
        kind === "checkout"
            ? CHECKOUT_STATUSES
            : kind === "invoice"
              ? INVOICE_STATUSES
              : null;
    if (!allowed || !allowed.includes(event.status as OnlinePaymentStatus)) {
        return false;
    }
    if (
        event.payment_id !== undefined &&
        typeof event.payment_id !== "string"
    ) {
        return false;
    }
    if (event.amount !== undefined) {
        if (
            !isRecord(event.amount) ||
            typeof event.amount.amount !== "bigint" ||
            typeof event.amount.currency !== "string"
        ) {
            return false;
        }
    }
    return true;
}

function isHttpUrl(value: unknown): value is string {
    if (typeof value !== "string") return false;
    try {
        const { protocol } = new URL(value);
        return protocol === "https:" || protocol === "http:";
    } catch {
        return false;
    }
}

/**
 * Wraps a validated plugin processor for the host. Plugin code is untrusted:
 * the wrapper exposes only what `capabilities` allows, checks what comes
 * back from the plugin before the host acts on it, and fixes the id and
 * label so the plugin cannot change them later.
 * @param pluginName the owning plugin, for log lines
 * @param processor the validated plugin processor
 * @returns the processor to put in the registry
 */
export function wrapPluginProcessor(
    pluginName: string,
    processor: PaymentProcessor,
): PaymentProcessor {
    const { id, label } = processor;
    const capabilities = {
        checkout: processor.capabilities.checkout,
        invoice: processor.capabilities.invoice,
    };
    const wrapped: PaymentProcessor = {
        id,
        label,
        capabilities,
        async handleWebhook(req) {
            const events: unknown = await processor.handleWebhook(req);
            if (!Array.isArray(events) || !events.every(validEvent)) {
                // The body is not logged: it is the processor's, and may hold
                // customer data.
                logger.warn(
                    `Plugin "${pluginName}" processor "${id}" returned malformed webhook events`,
                );
                throw new Error("Malformed processor events");
            }
            return events;
        },
    };
    if (capabilities.checkout) {
        wrapped.createCheckout = async (req) => {
            const result = await processor.createCheckout!(req);
            if (
                !result ||
                typeof result.externalId !== "string" ||
                result.externalId === "" ||
                !isHttpUrl(result.url)
            ) {
                throw new Error("Processor returned an invalid checkout");
            }
            return result;
        };
    }
    if (capabilities.invoice) {
        wrapped.createInvoice = async (req) => {
            const result = await processor.createInvoice!(req);
            if (
                !result ||
                typeof result.externalId !== "string" ||
                result.externalId === "" ||
                !INVOICE_STATUSES.includes(result.status) ||
                (result.url !== undefined && !isHttpUrl(result.url))
            ) {
                throw new Error("Processor returned an invalid invoice");
            }
            return result;
        };
        wrapped.cancelInvoice = (externalId) =>
            processor.cancelInvoice!(externalId);
    }
    return wrapped;
}
