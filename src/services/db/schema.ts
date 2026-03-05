import {
    pgTable,
    timestamp,
    text,
    integer,
    boolean,
    varchar,
    jsonb,
} from "drizzle-orm/pg-core";

export const configDevicesTable = pgTable("config-devices", {
    id: varchar("id", { length: 12 }).primaryKey(),
    created_at: timestamp("entry_created_at", {
        withTimezone: true,
    }).defaultNow(),
    paring_code: varchar("paring_code", { length: 8 }),
    code_created_at: timestamp("code_created_at", {
        withTimezone: true,
    }).defaultNow(),
    paired_at: timestamp("paired_at", { withTimezone: true }),
    square_location: varchar("square_location", { length: 14 }),
    customer_facing: boolean(),
    device_hardware_id: text("device_hardware_id"),
});

export const configSystemTable = pgTable("config-system", {
    id: integer("id").primaryKey(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    encryptedAccessToken: text("encrypted_access_token").notNull(),
    encryptedRefreshToken: text("encrypted_refresh_token").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

export const squareOrdersTable = pgTable("square-orders", {
    id: text("id"),
    locationId: text("location_id").notNull(),
    referenceId: varchar("reference_id", { length: 255 }).primaryKey(),
    sourceName: varchar("source_name", { length: 255 }),
    customerId: varchar("customer_id", { length: 255 }),
    lineItems: jsonb("line_items"),
    taxes: jsonb("taxes"),
    discounts: jsonb("discounts").notNull(),
    netAmount: jsonb("net_amount"),
    roundingAdjustment: jsonb("rounding_adjustment"),
    tenders: jsonb("tenders"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
    state: varchar("state", { length: 20 }),
    version: integer("version"),
    totalMoney: jsonb("total_money"),
    totalTaxMoney: jsonb("total_tax_money"),
    totalDiscountMoney: jsonb("total_discount_money"),
    totalTipMoney: jsonb("total_tip_money"),
    totalServiceChargeMoney: jsonb("total_service_charge_money"),
});
