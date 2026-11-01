import { processorRegistry } from "./registry";
import { createSquareProcessor } from "./square";

/** Adds the processors that ship with the backend. Safe to call twice. */
export function registerBuiltinProcessors(): void {
    if (!processorRegistry.get("square")) {
        processorRegistry.register(createSquareProcessor());
    }
}
