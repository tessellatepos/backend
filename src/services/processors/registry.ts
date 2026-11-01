import type { PaymentProcessorInfo } from "@tessellatepos/sdk";
import type { PaymentProcessor } from "./types";

/** Holds the payment processors a deployment offers, keyed by id. */
export class PaymentProcessorRegistry {
    private readonly processors = new Map<string, PaymentProcessor>();

    /**
     * @param processor the processor to add
     * @throws if a processor with the same id is already registered
     */
    register(processor: PaymentProcessor): void {
        if (!/^[a-z][a-z0-9_-]{0,63}$/.test(processor.id)) {
            throw new Error(`Invalid payment processor id "${processor.id}"`);
        }
        if (this.processors.has(processor.id)) {
            throw new Error(
                `Payment processor "${processor.id}" is already registered`,
            );
        }
        this.processors.set(processor.id, processor);
    }

    /**
     * @param id the id of the processor to remove
     * @returns true when a processor was removed
     */
    unregister(id: string): boolean {
        return this.processors.delete(id);
    }

    /**
     * @param id a processor id
     * @returns the processor, or undefined
     */
    get(id: string): PaymentProcessor | undefined {
        return this.processors.get(id);
    }

    /** @returns every processor, in registration order */
    list(): PaymentProcessorInfo[] {
        return [...this.processors.values()].map((p) => ({
            id: p.id,
            label: p.label,
            capabilities: { ...p.capabilities },
        }));
    }
}

/** The deployment's registry. `activeProvider` is separate and unchanged. */
export const processorRegistry = new PaymentProcessorRegistry();
