import {pgTable, timestamp, text, integer, boolean, varchar} from "drizzle-orm/pg-core";

export const configDevicesTable = pgTable("config/devices", {
    id: varchar('id', {length: 12}).primaryKey(),
    created_at: timestamp("entry_created_at", {withTimezone: true}).defaultNow(),
    paring_code: varchar('paring_code', {length: 8}),
    code_created_at: timestamp("code_created_at", {withTimezone: true}).defaultNow(),
    paired_at: timestamp("paired_at", {withTimezone: true}),
    square_location: varchar('square_location', {length: 14}),
    customer_facing: boolean(),
    device_hardware_id: text("device_hardware_id")
});

export const configSystem = pgTable("config/system", {
    id: integer("id").primaryKey(),
    createdAt: timestamp("created_at", {withTimezone: true}).defaultNow(),
    encryptedAccessToken: text("encrypted_access_token").notNull(),
    encryptedRefreshToken: text("encrypted_refresh_token").notNull(),
    updatedAt: timestamp("updated_at", {withTimezone: true}).defaultNow(),
});