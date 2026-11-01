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

export const configDevicesTable = pgTable("tessellate-devices-config", {
    id: varchar("id", { length: 12 }).primaryKey(),
    created_at: timestamp("entry_created_at", {
        withTimezone: true,
    }).defaultNow(),
    pairing_code: varchar("paring_code", { length: 8 }),
    code_created_at: timestamp("code_created_at", {
        withTimezone: true,
    }).defaultNow(),
    paired_at: timestamp("paired_at", { withTimezone: true }),
    square_location: varchar("square_location", { length: 14 }),
    customer_facing: boolean(),
    device_hardware_id: text("device_hardware_id"),
    device_type: deviceTypeEnum("device_type"),
    square_device_id: text("square_device_id"),
    square_device_code_id: text("square_device_code_id"),
    square_pair_by: timestamp("square_pair_by", { withTimezone: true }),
    // sha-256 (hex) of the device's API token; the token itself is never stored.
    device_token_hash: text("device_token_hash").unique(),
});

export const configSystemTable = pgTable("tessellate-system-config", {
    id: integer("id").primaryKey(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    encryptedAccessToken: text("encrypted_access_token").notNull(),
    encryptedRefreshToken: text("encrypted_refresh_token").notNull(),
    applicationId: text("application_id"),
    locationId: text("location_id"),
    merchantId: text("merchant_id"),
    tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", {
        withTimezone: true,
    }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

/**
 * Owner-managed settings for plugin sign-in methods. `config` is a JSON
 * document (client id and secret, discovery URL, scopes) encrypted with
 * services/crypto.ts; it is never stored or returned in plaintext.
 */
export const authProviderSettingsTable = pgTable("tessellate-auth-providers", {
    providerId: text("provider_id").primaryKey(),
    pluginName: text("plugin_name").notNull(),
    enabled: boolean("enabled").notNull().default(false),
    config: text("config").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
        .notNull()
        .defaultNow(),
});

/**
 * First-run setup state: a single row (id 1) once setup has been marked
 * complete. Kept apart from the system config, whose Square token columns
 * are required.
 */
export const setupStateTable = pgTable("tessellate-setup-state", {
    id: integer("id").primaryKey(),
    completedAt: timestamp("completed_at", { withTimezone: true }).notNull(),
});

export const ordersTable = pgTable("tessellate-orders", {
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

export const catalogItemsTable = pgTable("tessellate-catalog-items", {
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

export const catalogItemVariationsTable = pgTable(
    "tessellate-catalog-item-variations",
    {
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
    },
);

export const catalogCategoriesTable = pgTable("tessellate-catalog-categories", {
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
    "tessellate-catalog-item-categories",
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
    "tessellate-catalog-item-locations",
    {
        itemId: varchar("item_id", { length: 255 })
            .notNull()
            .references(() => catalogItemsTable.id),
        locationId: varchar("location_id", { length: 255 }).notNull(),
    },
    (table) => [primaryKey({ columns: [table.itemId, table.locationId] })],
);

export const locationsTable = pgTable("tessellate-locations", {
    id: varchar("id", { length: 255 }).primaryKey(),
    name: text("name").notNull(),
    address: jsonb("address").notNull(),
    currency: varchar("currency", { length: 3 }).notNull(),
    phoneNumber: text("phone_number"),
    websiteUrl: text("website_url"),
    email: text("email"),
    hours: jsonb("hours"),
    logoUrl: text("logo_url"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
});

export const customersTable = pgTable("tessellate-customers", {
    id: varchar("id", { length: 255 }).primaryKey(),
    givenName: text("given_name"),
    familyName: text("family_name"),
    companyName: text("company_name"),
    email: text("email"),
    phoneNumber: text("phone_number"),
    address: jsonb("address"),
    birthday: varchar("birthday", { length: 10 }),
    note: text("note"),
    tags: jsonb("tags").notNull().default([]),
    provider: varchar("provider", { length: 50 }).notNull(),
    providerId: varchar("provider_id", { length: 255 }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

export const pluginRegistryTable = pgTable("tessellate-plugin-registry", {
    id: varchar("id", { length: 255 }).primaryKey().notNull(),
    version: varchar("version", { length: 255 }),
    source: jsonb("source_ref"),
    sha256: varchar("sha256", { length: 255 }),
    tables: jsonb("tables"),
    installedAt: timestamp("installed_at"),
});

// ---------------------------------------------------------------------------
// better-auth tables
//
// Hand-written from better-auth's core schema plus the `admin` and `username`
// plugin schemas (the better-auth CLI is not usable here, see the A1 notes).
// Property names must match better-auth's field names; the SQL table and
// column names are ours. services/auth.ts hands these to the Drizzle adapter
// through its `schema` option, keyed by better-auth's model names.
// ---------------------------------------------------------------------------

export const authUserTable = pgTable("tessellate-auth-user", {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    email: text("email").notNull().unique(),
    emailVerified: boolean("email_verified").notNull().default(false),
    image: text("image"),
    createdAt: timestamp("created_at", { withTimezone: true })
        .notNull()
        .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
        .notNull()
        .defaultNow(),
    // username plugin
    username: text("username").unique(),
    displayUsername: text("display_username"),
    // admin plugin
    role: text("role"),
    banned: boolean("banned").default(false),
    banReason: text("ban_reason"),
    banExpires: timestamp("ban_expires", { withTimezone: true }),
});

export const authSessionTable = pgTable("tessellate-auth-session", {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    token: text("token").notNull().unique(),
    createdAt: timestamp("created_at", { withTimezone: true })
        .notNull()
        .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
        .notNull()
        .references(() => authUserTable.id, { onDelete: "cascade" }),
    // admin plugin
    impersonatedBy: text("impersonated_by"),
});

export const authAccountTable = pgTable("tessellate-auth-account", {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
        .notNull()
        .references(() => authUserTable.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", {
        withTimezone: true,
    }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", {
        withTimezone: true,
    }),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at", { withTimezone: true })
        .notNull()
        .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
});

export const authVerificationTable = pgTable("tessellate-auth-verification", {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
        .notNull()
        .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
        .notNull()
        .defaultNow(),
});

/** The better-auth tables keyed by better-auth model name, for the adapter. */
export const authSchema = {
    user: authUserTable,
    session: authSessionTable,
    account: authAccountTable,
    verification: authVerificationTable,
};
