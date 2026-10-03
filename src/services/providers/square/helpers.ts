import type { ItemVariation } from "@tessellatepos/sdk";

/**
 * Internal helper for compatibility with the Square catalog API response shape.
 * Use ItemVariation for application code.
 */
export interface squareHelperItemVariation {
    itemVariationData: ItemVariation;
    id: string;
    presentAtAllLocations?: boolean | null;
    presentAtLocationIds?: string[];
}

/**
 * Internal helper for compatibility with the Square catalog API response shape.
 * Use ItemCategory for application code.
 */
export interface squareHelperCategory {
    id: string;
    ordinal?: bigint | null;
}
