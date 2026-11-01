import { z } from "zod";
import {
    COUNTRIES,
    CURRENCIES,
    type Address,
    type CountryCode,
    type CurrencyCode,
    type Money,
} from "@tessellatepos/sdk";

/**
 * Wire form of a bigint: a base-10 string (JSON cannot carry a bigint). The
 * codec decodes to bigint, which is the SDK's in-memory type.
 */
export const wireBigint = z.codec(
    z.string().regex(/^-?\d+$/, "must be a whole number as a string"),
    z.bigint(),
    {
        decode: (value) => BigInt(value),
        encode: (value) => value.toString(),
    },
);

export const currencySchema = z.enum(
    Object.keys(CURRENCIES) as [CurrencyCode, ...CurrencyCode[]],
);

export const countrySchema = z.enum(
    Object.keys(COUNTRIES) as [CountryCode, ...CountryCode[]],
);

export const moneySchema = z.object({
    amount: wireBigint,
    currency: currencySchema,
}) satisfies z.ZodType<Money>;

export const addressSchema = z.object({
    country: countrySchema,
    name: z.string().optional(),
    organization: z.string().optional(),
    address_line_1: z.string(),
    address_line_2: z.string().optional(),
    dependent_locality: z.string().optional(),
    locality: z.string().optional(),
    subdivision: z.string().optional(),
    postal_code: z.string().optional(),
    sorting_code: z.string().optional(),
}) satisfies z.ZodType<Address>;

/** An ISO 8601 timestamp as the store writes it. */
export const timestampSchema = z.string().min(1);

/** Where a gateway list page starts; opaque to the caller. */
export const cursorSchema = z.string().min(1).max(512);

/** Page size for list operations. */
export const limitSchema = z.coerce.number().int().min(1).max(200);
