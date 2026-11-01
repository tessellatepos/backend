import { z } from "zod";
import type { CartItem, Discount, Order } from "@tessellatepos/sdk";
import { moneySchema, wireBigint } from "./common.js";

const discountSchema = z.object({
    id: z.string(),
    name: z.string().nullish(),
    discountType: z
        .enum([
            "FIXED_AMOUNT",
            "FIXED_PERCENTAGE",
            "VARIABLE_AMOUNT",
            "VARIABLE_PERCENTAGE",
        ])
        .optional(),
    amountMoney: moneySchema.optional(),
    percentage: z.string().nullish(),
    pinRequired: z.boolean().nullish(),
    labelColor: z.string().nullish(),
    modifyTaxBasis: z
        .enum(["MODIFY_TAX_BASIS", "DO_NOT_MODIFY_TAX_BASIS"])
        .optional(),
    maximumAmountMoney: moneySchema.optional(),
}) satisfies z.ZodType<Discount>;

const lineItemSchema = z.object({
    uid: z.string().optional(),
    itemId: z.string().nullish(),
    name: z.string().nullish(),
    quantity: wireBigint.optional(),
    priceMoney: moneySchema.optional(),
    pricingType: z.enum(["FIXED", "VARIABLE"]).optional(),
    variationName: z.string().nullish(),
});

/** An order as the gateway returns it. Tender details are not exposed. */
export const orderSchema = z.object({
    id: z.string().optional(),
    locationId: z.string(),
    referenceId: z.string().nullish(),
    source: z.object({ name: z.string().nullish() }).optional(),
    customerId: z.string().nullish(),
    lineItems: z.array(lineItemSchema).nullish(),
    // The local provider omits discounts on a new order; the gateway always
    // states them, so an absent list is an empty one.
    discounts: z.array(discountSchema).default([]),
    state: z.enum(["OPEN", "COMPLETED", "CANCELED", "DRAFT"]).optional(),
    version: z.number().int().optional(),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
    closedAt: z.string().optional(),
    totalMoney: moneySchema.optional(),
    totalTaxMoney: moneySchema.optional(),
    totalDiscountMoney: moneySchema.optional(),
    totalTipMoney: moneySchema.optional(),
    totalServiceChargeMoney: moneySchema.optional(),
}) satisfies z.ZodType<Order>;

/**
 * What a gateway caller may send to create an order. Strict: any price,
 * discount, total or tender field is rejected. Totals are computed on the
 * server from the catalog.
 */
export const orderCreateSchema = z.strictObject({
    // Optional so a credential with one location may omit it (filled in).
    location_id: z.string().min(1).max(255).optional(),
    customer_id: z.string().min(1).max(255).optional(),
    line_items: z
        .array(
            z.strictObject({
                variation_id: z.string().min(1).max(255),
                quantity: wireBigint.refine((q) => q > 0n && q <= 999n, {
                    message: "quantity must be 1 to 999",
                }),
            }),
        )
        .min(1)
        .max(100),
    pickup: z
        .strictObject({
            name: z.string().min(1).max(255),
            phone_number: z.string().min(3).max(64),
            email: z.string().max(255).optional(),
            note: z.string().max(1000).optional(),
        })
        .optional(),
});

export type OrderCreateInput = z.infer<typeof orderCreateSchema>;

/**
 * Maps a validated gateway order to the internal order body. Only variation
 * ids and quantities cross over: the provider prices each line from the
 * catalog, never from the caller. The pickup contact is validated but not
 * stored yet (`Order` has no pickup fields).
 * @param input the output of {@link orderCreateSchema}
 * @returns the body the internal `POST /orders/create` route expects
 */
export function toInternalOrder(input: OrderCreateInput): {
    locationId: string;
    customerId?: string;
    lineItems: CartItem[];
} {
    if (!input.location_id) {
        throw new Error("location_id must be set before mapping an order");
    }
    const lineItems: CartItem[] = input.line_items.map((line) => ({
        itemId: line.variation_id,
        quantity: line.quantity,
    }));
    return {
        locationId: input.location_id,
        ...(input.customer_id ? { customerId: input.customer_id } : {}),
        lineItems,
    };
}
