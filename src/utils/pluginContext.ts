import type { Request } from "express";
import type { Order } from "@tessellatepos/sdk";
import type { HookContext } from "@tessellatepos/plugin-sdk/server";

/**
 * The context plugin hooks and events receive: who is calling and where the
 * order came from. A stored order's own source wins over the caller, so staff
 * paying an online order at pickup still reads as an online order.
 * @param req the request, or undefined when nothing authenticated caused the
 * action (an inbound processor webhook)
 * @param order the order the action is about, when it exists yet
 * @returns the context
 */
export function pluginContext(
    req: Pick<Request, "principal"> | undefined,
    order?: Pick<Order, "source"> | null,
): HookContext {
    const principal = req?.principal ?? null;
    const caller =
        principal?.kind === "credential" ? principal.display_name : null;
    return { principal, source: order?.source?.name ?? caller ?? null };
}
