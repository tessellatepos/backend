import { parseMoney } from "@tessellatepos/sdk";
import type { Money } from "@tessellatepos/sdk";

/** The pricing a variation has at one location. */
export interface ResolvedPricing {
    pricingType: "FIXED" | "VARIABLE" | undefined;
    priceMoney: Money | undefined;
}

/** A location override as stored (money amounts may still be strings). */
interface RawOverride {
    locationId?: string | null;
    priceMoney?: unknown;
    pricingType?: "FIXED" | "VARIABLE";
}

/**
 * Resolves a variation's pricing at a location: a location override replaces
 * the base price and/or pricing type it sets, the rest is inherited. The
 * gateway catalog exposes the same overrides, so this is the one reading of
 * them that both a displayed price and a charged price should follow.
 * @param base the variation's own pricing
 * @param base.pricingType the base pricing type
 * @param base.priceMoney the base price, raw or parsed
 * @param overrides the variation's location overrides
 * @param locationId the location being sold at
 * @returns the pricing in effect at that location
 */
export function resolveVariationPricing(
    base: { pricingType?: string | null; priceMoney?: unknown },
    overrides: RawOverride[] | null | undefined,
    locationId: string | null | undefined,
): ResolvedPricing {
    const override = locationId
        ? overrides?.find((o) => o.locationId === locationId)
        : undefined;
    const baseType =
        base.pricingType === "VARIABLE"
            ? "VARIABLE"
            : base.pricingType === "FIXED"
              ? "FIXED"
              : undefined;
    return {
        pricingType: override?.pricingType ?? baseType,
        priceMoney: parseMoney(override?.priceMoney ?? base.priceMoney),
    };
}
