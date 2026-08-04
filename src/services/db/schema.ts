import {
    pgTable,
    pgEnum,
    timestamp,
    text,
    integer,
    boolean,
    varchar,
    jsonb,
    primaryKey,
} from "drizzle-orm/pg-core";

export const deviceTypeEnum = pgEnum("device_type", [
    "TERMINAL",
    "MOBILE_READER",
]);

export const pricingTypeEnum = pgEnum("pricing_type", ["FIXED", "VARIABLE"]);

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
    device_type: deviceTypeEnum("device_type"),
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

export const catalogItemsTable = pgTable("catalog-items", {
    id: varchar("id", { length: 255 }).primaryKey(),
    name: text("name"),
    displayName: text("display_name"),
    labelColor: varchar("label_color", { length: 20 }),
    isTaxable: boolean("is_taxable"),
    isArchived: boolean("is_archived").default(false),
    image: text("image"),
    providerMetadata: jsonb("provider_metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

export const catalogItemVariationsTable = pgTable("catalog-item-variations", {
    variationId: varchar("variation_id", { length: 255 }).primaryKey(),
    itemId: varchar("item_id", { length: 255 })
        .notNull()
        .references(() => catalogItemsTable.id),
    name: text("name"),
    sku: varchar("sku", { length: 255 }),
    upc: varchar("upc", { length: 255 }),
    ordinal: text("ordinal"),
    pricingType: pricingTypeEnum("pricing_type"),
    priceMoney: jsonb("price_money"),
    locationOverrides: jsonb("location_overrides"),
    trackInventory: boolean("track_inventory"),
    providerMetadata: jsonb("provider_metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

export const catalogCategoriesTable = pgTable("catalog-categories", {
    id: varchar("id", { length: 255 }).primaryKey(),
    name: text("name"),
    parentCategoryId: varchar("parent_category_id", {
        length: 255,
    }),
    imageId: varchar("image_id", { length: 255 }),
    imageURL: text("image_url"),
    providerMetadata: jsonb("provider_metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

export const catalogItemCategoriesTable = pgTable(
    "catalog-item-categories",
    {
        itemId: varchar("item_id", { length: 255 })
            .notNull()
            .references(() => catalogItemsTable.id),
        categoryId: varchar("category_id", { length: 255 })
            .notNull()
            .references(() => catalogCategoriesTable.id),
    },
    (table) => [primaryKey({ columns: [table.itemId, table.categoryId] })],
);

export const catalogItemLocationsTable = pgTable(
    "catalog-item-locations",
    {
        itemId: varchar("item_id", { length: 255 })
            .notNull()
            .references(() => catalogItemsTable.id),
        locationId: varchar("location_id", { length: 255 }).notNull(),
    },
    (table) => [primaryKey({ columns: [table.itemId, table.locationId] })],
);
