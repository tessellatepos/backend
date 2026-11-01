import { z } from "zod";
import type { Customer, CustomerInput, CustomerPage } from "@tessellatepos/sdk";
import { addressSchema, cursorSchema, limitSchema } from "./common.js";

export const customerSchema = z.object({
    id: z.string(),
    given_name: z.string(),
    family_name: z.string(),
    company_name: z.string(),
    email: z.string(),
    phone_number: z.string(),
    address: addressSchema.optional(),
    birthday: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional(),
    note: z.string(),
    tags: z.array(z.string()),
    created_at: z.string(),
    updated_at: z.string(),
}) satisfies z.ZodType<Customer>;

/** Writable fields only: no id, no timestamps. */
export const customerInputSchema = z.strictObject({
    given_name: z.string().max(255),
    family_name: z.string().max(255),
    company_name: z.string().max(255),
    email: z.string().max(255),
    phone_number: z.string().max(64),
    address: addressSchema.optional(),
    birthday: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional(),
    note: z.string().max(4000),
    tags: z.array(z.string().max(64)).max(50),
}) satisfies z.ZodType<CustomerInput>;

export const customerPatchSchema = customerInputSchema.partial();

export const customerListQuerySchema = z.strictObject({
    text: z.string().max(255).optional(),
    email: z.string().max(255).optional(),
    phone_number: z.string().max(64).optional(),
    tag: z.string().max(64).optional(),
    limit: limitSchema.optional(),
    cursor: cursorSchema.optional(),
});

export const customerPageSchema = z.object({
    customers: z.array(customerSchema),
    next_cursor: z.string().nullable(),
}) satisfies z.ZodType<CustomerPage>;
