import { z } from "zod";
import type { Location, LocationHours, TimePeriod } from "@tessellatepos/sdk";
import { addressSchema, currencySchema } from "./common.js";

const timeSchema = z.object({
    time: z.string(),
    timezone: z.string(),
});

const periodSchema = z.object({
    open: timeSchema,
    close: timeSchema,
}) satisfies z.ZodType<TimePeriod>;

const dayHours = z.array(periodSchema);

export const locationHoursSchema = z.object({
    sunday: dayHours,
    monday: dayHours,
    tuesday: dayHours,
    wednesday: dayHours,
    thursday: dayHours,
    friday: dayHours,
    saturday: dayHours,
}) satisfies z.ZodType<LocationHours>;

export const locationSchema = z.object({
    id: z.string(),
    name: z.string(),
    address: addressSchema,
    currency: currencySchema,
    phone_number: z.string(),
    website_url: z.string(),
    email: z.string(),
    hours: locationHoursSchema,
    logo_url: z.string(),
}) satisfies z.ZodType<Location>;

export const locationListSchema = z.array(locationSchema);
