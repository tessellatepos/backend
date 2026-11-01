import { CURRENCIES, SALES_CHANNELS } from "@tessellatepos/sdk";
import type {
    CatalogFieldError,
    CurrencyCode,
    ItemCategoryInput,
    ItemQuery,
    Money,
    SalesChannel,
} from "@tessellatepos/sdk";

/*
 * Request validation for catalog writes. Errors carry a path and a fixed
 * message, never the value that failed, so a bad request cannot reflect
 * input (SKUs, prices, names) back through an error body or a log line.
 */

export const MAX_NAME = 255;
export const MAX_SKU = 64;
export const MAX_VARIATIONS = 100;
export const MAX_REFS = 200;
export const MAX_PAGE = 200;
export const DEFAULT_PAGE = 50;
/** The largest price accepted, in minor units. */
export const MAX_AMOUNT = 999_999_999_999n;

export type Validated<T> =
    { ok: true; value: T } | { ok: false; errors: CatalogFieldError[] };

export interface VariationDraft {
    id?: string;
    name: string;
    sku: string | null;
    upc: string | null;
    pricingType: "FIXED" | "VARIABLE";
    priceMoney: Money | null;
    trackInventory: boolean;
    /** Absent follows the item's channels. */
    channels?: SalesChannel[];
    locationOverrides: {
        locationId: string;
        priceMoney?: Money;
        pricingType?: "FIXED" | "VARIABLE";
        trackInventory?: boolean | null;
    }[];
}

export interface ItemDraft {
    name: string;
    displayName: string | null;
    labelColor: string | null;
    isTaxable: boolean;
    isArchived: boolean;
    image: string | null;
    channels: SalesChannel[];
    categoryIds: string[];
    locationIds: string[];
    variations: VariationDraft[];
}

/** A PATCH body: only the keys present change. Variations merge by id. */
export interface ItemPatch extends Partial<Omit<ItemDraft, "variations">> {
    variations?: (Partial<VariationDraft> & { id?: string })[];
}

type Raw = Record<string, unknown>;

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

class Collector {
    readonly errors: CatalogFieldError[] = [];
    add(path: string, message: string) {
        this.errors.push({ path, message });
    }
}

function isRecord(value: unknown): value is Raw {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Flags keys outside the allowed set. Names the path, never the key.
 * @param raw the object to check
 * @param allowed the keys it may carry
 * @param path where the object sits in the body
 * @param c the error collector
 */
function noUnknownKeys(
    raw: Raw,
    allowed: readonly string[],
    path: string,
    c: Collector,
) {
    if (Object.keys(raw).some((key) => !allowed.includes(key))) {
        c.add(path || "(body)", "contains an unknown field");
    }
}

interface StringRules {
    min?: number;
    max: number;
    pattern?: RegExp;
    patternMessage?: string;
}

/**
 * Reads a trimmed string. An empty result counts as absent when `min` is 0.
 * @param value the raw value
 * @param path where the value sits in the body
 * @param rules length and shape limits
 * @param c the error collector
 * @returns the string, or undefined after recording an error
 */
function readString(
    value: unknown,
    path: string,
    rules: StringRules,
    c: Collector,
): string | undefined {
    if (typeof value !== "string") {
        c.add(path, "must be a string");
        return undefined;
    }
    const text = value.trim();
    if (text.length < (rules.min ?? 0)) {
        c.add(
            path,
            rules.min === 1
                ? "is required"
                : `must be at least ${rules.min} characters`,
        );
        return undefined;
    }
    if (text.length > rules.max) {
        c.add(path, `must be at most ${rules.max} characters`);
        return undefined;
    }
    if (CONTROL.test(text)) {
        c.add(path, "must not contain control characters");
        return undefined;
    }
    if (rules.pattern && text && !rules.pattern.test(text)) {
        c.add(path, rules.patternMessage ?? "has an invalid format");
        return undefined;
    }
    return text;
}

/**
 * Reads an optional nullable string; empty text becomes null.
 * @param value the raw value
 * @param path where the value sits in the body
 * @param rules length and shape limits
 * @param c the error collector
 * @returns the string, null, or undefined after recording an error
 */
function readNullableString(
    value: unknown,
    path: string,
    rules: StringRules,
    c: Collector,
): string | null | undefined {
    if (value === null) return null;
    const text = readString(value, path, rules, c);
    return text === undefined ? undefined : text || null;
}

function readBoolean(
    value: unknown,
    path: string,
    c: Collector,
): boolean | undefined {
    if (typeof value === "boolean") return value;
    c.add(path, "must be true or false");
    return undefined;
}

/**
 * Reads an id-list field (category or location ids): unique, bounded.
 * @param value the raw value
 * @param path where the value sits in the body
 * @param c the error collector
 * @returns the ids, or undefined after recording an error
 */
function readIds(
    value: unknown,
    path: string,
    c: Collector,
): string[] | undefined {
    if (!Array.isArray(value)) {
        c.add(path, "must be an array");
        return undefined;
    }
    if (value.length > MAX_REFS) {
        c.add(path, `must have at most ${MAX_REFS} entries`);
        return undefined;
    }
    const ids: string[] = [];
    let ok = true;
    value.forEach((entry, index) => {
        const id = readString(
            entry,
            `${path}[${index}]`,
            { min: 1, max: 255 },
            c,
        );
        if (id === undefined) ok = false;
        else ids.push(id);
    });
    if (new Set(ids).size !== ids.length) {
        c.add(path, "must not repeat an entry");
        return undefined;
    }
    return ok ? ids : undefined;
}

/**
 * Reads Money: minor units as a non-negative integer (number or digit
 * string) and a known currency.
 * @param value the raw value
 * @param path where the value sits in the body
 * @param c the error collector
 * @returns the money, or undefined after recording an error
 */
function readMoney(
    value: unknown,
    path: string,
    c: Collector,
): Money | undefined {
    if (!isRecord(value)) {
        c.add(path, "must be an object with amount and currency");
        return undefined;
    }
    noUnknownKeys(value, ["amount", "currency"], path, c);
    let amount: bigint | undefined;
    const raw = value.amount;
    if (typeof raw === "number") {
        if (Number.isSafeInteger(raw) && raw >= 0) amount = BigInt(raw);
    } else if (typeof raw === "string" && /^\d{1,15}$/.test(raw)) {
        amount = BigInt(raw);
    }
    if (amount === undefined || amount > MAX_AMOUNT) {
        c.add(
            `${path}.amount`,
            "must be a non-negative whole number of minor units",
        );
    }
    const currency = value.currency;
    if (typeof currency !== "string" || !Object.hasOwn(CURRENCIES, currency)) {
        c.add(`${path}.currency`, "must be a known currency code");
    }
    return amount === undefined || amount > MAX_AMOUNT
        ? undefined
        : typeof currency === "string" && Object.hasOwn(CURRENCIES, currency)
          ? { amount, currency: currency as CurrencyCode }
          : undefined;
}

const NAME: StringRules = { min: 1, max: MAX_NAME };
const SKU: StringRules = { max: MAX_SKU };
const UPC: StringRules = {
    max: 14,
    pattern: /^\d{8,14}$/,
    patternMessage: "must be 8 to 14 digits",
};
const COLOR: StringRules = {
    max: 7,
    pattern: /^#[0-9a-fA-F]{6}$/,
    patternMessage: "must be a hex colour like #1a2b3c",
};
const VARIATION_KEYS = [
    "id",
    "name",
    "sku",
    "upc",
    "pricingType",
    "priceMoney",
    "trackInventory",
    "locationOverrides",
    "channels",
] as const;
const ITEM_KEYS = [
    "name",
    "displayName",
    "labelColor",
    "isTaxable",
    "isArchived",
    "image",
    "channels",
    "categoryIds",
    "locationIds",
    "variations",
] as const;

function readImageUrl(
    value: unknown,
    path: string,
    c: Collector,
): string | null | undefined {
    const text = readNullableString(value, path, { max: 2048 }, c);
    if (!text) return text;
    try {
        const url = new URL(text);
        if (url.protocol === "http:" || url.protocol === "https:") return text;
    } catch {
        // falls through to the error below
    }
    c.add(path, "must be an http or https URL");
    return undefined;
}

/**
 * Reads a channel set: known channels, no repeats, at least one.
 * @param value the raw value
 * @param path where the value sits in the body
 * @param c the error collector
 * @returns the channels, or undefined after recording an error
 */
function readChannels(
    value: unknown,
    path: string,
    c: Collector,
): SalesChannel[] | undefined {
    if (
        !Array.isArray(value) ||
        value.length === 0 ||
        value.length > SALES_CHANNELS.length
    ) {
        c.add(path, "must list at least one channel");
        return undefined;
    }
    if (!value.every((v) => SALES_CHANNELS.includes(v as SalesChannel))) {
        c.add(path, `must only contain ${SALES_CHANNELS.join(" or ")}`);
        return undefined;
    }
    if (new Set(value).size !== value.length) {
        c.add(path, "must not repeat a channel");
        return undefined;
    }
    return value as SalesChannel[];
}

function readPricingType(
    value: unknown,
    path: string,
    c: Collector,
): "FIXED" | "VARIABLE" | undefined {
    if (value === "FIXED" || value === "VARIABLE") return value;
    c.add(path, "must be FIXED or VARIABLE");
    return undefined;
}

function readOverrides(
    value: unknown,
    path: string,
    c: Collector,
): VariationDraft["locationOverrides"] | undefined {
    if (!Array.isArray(value) || value.length > MAX_REFS) {
        c.add(path, "must be an array of overrides");
        return undefined;
    }
    const out: VariationDraft["locationOverrides"] = [];
    value.forEach((entry, index) => {
        const at = `${path}[${index}]`;
        if (!isRecord(entry)) {
            c.add(at, "must be an object");
            return;
        }
        noUnknownKeys(
            entry,
            ["locationId", "priceMoney", "pricingType", "trackInventory"],
            at,
            c,
        );
        const locationId = readString(
            entry.locationId,
            `${at}.locationId`,
            { min: 1, max: 255 },
            c,
        );
        const override: VariationDraft["locationOverrides"][number] = {
            locationId: locationId ?? "",
        };
        if (entry.priceMoney != null) {
            override.priceMoney = readMoney(
                entry.priceMoney,
                `${at}.priceMoney`,
                c,
            );
        }
        if (entry.pricingType !== undefined) {
            override.pricingType = readPricingType(
                entry.pricingType,
                `${at}.pricingType`,
                c,
            );
        }
        if (entry.trackInventory !== undefined) {
            override.trackInventory =
                entry.trackInventory === null
                    ? null
                    : readBoolean(
                          entry.trackInventory,
                          `${at}.trackInventory`,
                          c,
                      );
        }
        if (
            override.priceMoney === undefined &&
            override.pricingType === undefined &&
            override.trackInventory === undefined
        ) {
            c.add(at, "must override a price, pricing type or tracking");
        }
        if (override.pricingType === "FIXED" && !override.priceMoney) {
            c.add(`${at}.priceMoney`, "is required for a FIXED override");
        }
        out.push(override);
    });
    const ids = out.map((o) => o.locationId);
    if (new Set(ids).size !== ids.length) {
        c.add(path, "must not repeat a location");
    }
    return out;
}

/**
 * Validates one variation.
 * @param raw the raw variation
 * @param path where it sits in the body
 * @param partial true for PATCH: only an id is required
 * @param c the error collector
 * @returns the variation (a partial one when `partial`)
 */
function readVariation(
    raw: unknown,
    path: string,
    partial: boolean,
    c: Collector,
): Partial<VariationDraft> {
    if (!isRecord(raw)) {
        c.add(path, "must be an object");
        return {};
    }
    noUnknownKeys(raw, VARIATION_KEYS, path, c);
    const out: Partial<VariationDraft> = {};
    if (raw.id !== undefined) {
        out.id = readString(raw.id, `${path}.id`, NAME, c);
    } else if (partial) {
        c.add(`${path}.id`, "is required to change a variation");
    }
    if (raw.name !== undefined || !partial) {
        out.name = readString(raw.name, `${path}.name`, NAME, c);
    }
    if (raw.sku !== undefined) {
        out.sku = readNullableString(raw.sku, `${path}.sku`, SKU, c);
    }
    if (raw.upc !== undefined) {
        out.upc = readNullableString(raw.upc, `${path}.upc`, UPC, c);
    }
    if (raw.pricingType !== undefined) {
        out.pricingType = readPricingType(
            raw.pricingType,
            `${path}.pricingType`,
            c,
        );
    }
    if (raw.priceMoney !== undefined) {
        out.priceMoney =
            raw.priceMoney === null
                ? null
                : readMoney(raw.priceMoney, `${path}.priceMoney`, c);
    }
    if (raw.trackInventory !== undefined) {
        out.trackInventory =
            raw.trackInventory === null
                ? false
                : readBoolean(raw.trackInventory, `${path}.trackInventory`, c);
    }
    if (raw.channels !== undefined) {
        out.channels = readChannels(raw.channels, `${path}.channels`, c);
    }
    if (raw.locationOverrides !== undefined) {
        out.locationOverrides = readOverrides(
            raw.locationOverrides,
            `${path}.locationOverrides`,
            c,
        );
    }
    return out;
}

/**
 * Completes a variation with defaults and checks the pricing rule.
 * @param v the validated variation fields
 * @param path where it sits in the body
 * @param c the error collector
 * @returns the complete variation
 */
export function finishVariation(
    v: Partial<VariationDraft>,
    path: string,
    c: Collector | null,
): VariationDraft {
    const draft: VariationDraft = {
        id: v.id,
        name: v.name ?? "",
        sku: v.sku ?? null,
        upc: v.upc ?? null,
        pricingType: v.pricingType ?? "FIXED",
        priceMoney: v.priceMoney ?? null,
        trackInventory: v.trackInventory ?? false,
        ...(v.channels ? { channels: v.channels } : {}),
        locationOverrides: v.locationOverrides ?? [],
    };
    if (draft.pricingType === "FIXED" && !draft.priceMoney) {
        c?.add(`${path}.priceMoney`, "is required for a FIXED price");
    }
    return draft;
}

function dedupeCheck(variations: VariationDraft[], path: string, c: Collector) {
    const skus = variations.map((v) => v.sku).filter((s): s is string => !!s);
    if (new Set(skus).size !== skus.length) {
        c.add(`${path}`, "must not repeat a SKU");
    }
    const ids = variations.map((v) => v.id).filter((s): s is string => !!s);
    if (new Set(ids).size !== ids.length) {
        c.add(`${path}`, "must not repeat a variation id");
    }
}

/**
 * Applies a PATCH's variation list to the stored variations: an entry with an
 * id merges onto that variation, one without is a new variation, and any
 * stored variation not listed is removed.
 * @param existing the item's stored variations (each with its id)
 * @param patches the validated entries from the PATCH body
 * @returns the resulting variations, or the errors
 */
export function mergeVariations(
    existing: VariationDraft[],
    patches: NonNullable<ItemPatch["variations"]>,
): Validated<VariationDraft[]> {
    const c = new Collector();
    const out = patches.map((patch, index) => {
        const path = `variations[${index}]`;
        let base: Partial<VariationDraft> = {};
        if (patch.id !== undefined) {
            const found = existing.find((v) => v.id === patch.id);
            if (found) base = found;
            else c.add(`${path}.id`, "does not match a variation of this item");
        } else if (!patch.name) {
            c.add(`${path}.name`, "is required");
        }
        return finishVariation({ ...base, ...patch }, path, c);
    });
    dedupeCheck(out, "variations", c);
    return c.errors.length > 0
        ? { ok: false, errors: c.errors }
        : { ok: true, value: out };
}

/**
 * Validates a full item body (POST and PUT).
 * @param body the parsed JSON body
 * @returns the validated draft, or the errors
 */
export function parseItemInput(body: unknown): Validated<ItemDraft> {
    const c = new Collector();
    if (!isRecord(body)) {
        return {
            ok: false,
            errors: [{ path: "(body)", message: "must be an object" }],
        };
    }
    noUnknownKeys(body, ITEM_KEYS, "", c);

    const name = readString(body.name, "name", NAME, c);
    const displayName =
        body.displayName === undefined
            ? null
            : readNullableString(body.displayName, "displayName", NAME, c);
    const labelColor =
        body.labelColor === undefined
            ? null
            : readNullableString(body.labelColor, "labelColor", COLOR, c);
    const isTaxable =
        body.isTaxable === undefined
            ? true
            : readBoolean(body.isTaxable, "isTaxable", c);
    const isArchived =
        body.isArchived === undefined
            ? false
            : readBoolean(body.isArchived, "isArchived", c);
    const image =
        body.image === undefined ? null : readImageUrl(body.image, "image", c);
    const channels =
        body.channels === undefined
            ? (["pos"] as SalesChannel[])
            : readChannels(body.channels, "channels", c);
    const categoryIds =
        body.categoryIds === undefined
            ? []
            : readIds(body.categoryIds, "categoryIds", c);
    const locationIds =
        body.locationIds === undefined
            ? []
            : readIds(body.locationIds, "locationIds", c);

    const variations: VariationDraft[] = [];
    if (!Array.isArray(body.variations) || body.variations.length === 0) {
        c.add("variations", "must have at least one variation");
    } else if (body.variations.length > MAX_VARIATIONS) {
        c.add("variations", `must have at most ${MAX_VARIATIONS} entries`);
    } else {
        body.variations.forEach((raw, index) => {
            const path = `variations[${index}]`;
            variations.push(
                finishVariation(readVariation(raw, path, false, c), path, c),
            );
        });
        dedupeCheck(variations, "variations", c);
    }

    if (c.errors.length > 0) return { ok: false, errors: c.errors };
    return {
        ok: true,
        value: {
            name: name!,
            displayName: displayName ?? null,
            labelColor: labelColor ?? null,
            isTaxable: isTaxable!,
            isArchived: isArchived!,
            image: image ?? null,
            channels: channels!,
            categoryIds: categoryIds!,
            locationIds: locationIds!,
            variations,
        },
    };
}

/**
 * Validates a PATCH body. Absent keys stay as they are; `variations`, when
 * present, lists the complete set to keep, each merged onto the stored one.
 * @param body the parsed JSON body
 * @returns the validated patch, or the errors
 */
export function parseItemPatch(body: unknown): Validated<ItemPatch> {
    const c = new Collector();
    if (!isRecord(body)) {
        return {
            ok: false,
            errors: [{ path: "(body)", message: "must be an object" }],
        };
    }
    noUnknownKeys(body, ITEM_KEYS, "", c);
    const patch: ItemPatch = {};
    if (body.name !== undefined)
        patch.name = readString(body.name, "name", NAME, c);
    if (body.displayName !== undefined) {
        patch.displayName = readNullableString(
            body.displayName,
            "displayName",
            NAME,
            c,
        );
    }
    if (body.labelColor !== undefined) {
        patch.labelColor = readNullableString(
            body.labelColor,
            "labelColor",
            COLOR,
            c,
        );
    }
    if (body.isTaxable !== undefined) {
        patch.isTaxable = readBoolean(body.isTaxable, "isTaxable", c);
    }
    if (body.isArchived !== undefined) {
        patch.isArchived = readBoolean(body.isArchived, "isArchived", c);
    }
    if (body.image !== undefined) {
        patch.image = readImageUrl(body.image, "image", c);
    }
    if (body.channels !== undefined) {
        patch.channels = readChannels(body.channels, "channels", c);
    }
    if (body.categoryIds !== undefined) {
        patch.categoryIds = readIds(body.categoryIds, "categoryIds", c);
    }
    if (body.locationIds !== undefined) {
        patch.locationIds = readIds(body.locationIds, "locationIds", c);
    }
    if (body.variations !== undefined) {
        if (
            !Array.isArray(body.variations) ||
            body.variations.length === 0 ||
            body.variations.length > MAX_VARIATIONS
        ) {
            c.add("variations", `must have 1 to ${MAX_VARIATIONS} entries`);
        } else {
            patch.variations = body.variations.map((raw, index) =>
                readVariation(
                    raw,
                    `variations[${index}]`,
                    isRecord(raw) && raw.id !== undefined,
                    c,
                ),
            );
        }
    }
    if (c.errors.length > 0) return { ok: false, errors: c.errors };
    return { ok: true, value: patch };
}

/** A body that sets channels on an item and, optionally, its variations. */
export interface ChannelsChange {
    channels: SalesChannel[];
    /** By variation id; null makes the variation follow the item again. */
    variations?: Record<string, SalesChannel[] | null>;
}

/**
 * Validates the body of a channels-only change.
 * @param body the parsed JSON body
 * @returns the validated change, or the errors
 */
export function parseChannelsChange(body: unknown): Validated<ChannelsChange> {
    const c = new Collector();
    if (!isRecord(body)) {
        return {
            ok: false,
            errors: [{ path: "(body)", message: "must be an object" }],
        };
    }
    noUnknownKeys(body, ["channels", "variations"], "", c);
    const channels = readChannels(body.channels, "channels", c);
    let variations: ChannelsChange["variations"];
    if (body.variations !== undefined) {
        if (!isRecord(body.variations)) {
            c.add("variations", "must be an object keyed by variation id");
        } else {
            variations = {};
            for (const [id, value] of Object.entries(body.variations)) {
                if (id.length > 255) {
                    c.add("variations", "has an id that is too long");
                } else if (value === null) {
                    variations[id] = null;
                } else {
                    const read = readChannels(value, "variations", c);
                    if (read) variations[id] = read;
                }
            }
        }
    }
    if (c.errors.length > 0) return { ok: false, errors: c.errors };
    return { ok: true, value: { channels: channels!, variations } };
}

/**
 * Validates a category body.
 * @param body the parsed JSON body
 * @param partial true for PATCH-style updates: every key optional
 * @returns the validated fields, or the errors
 */
export function parseCategoryInput(
    body: unknown,
    partial = false,
): Validated<Partial<ItemCategoryInput>> {
    const c = new Collector();
    if (!isRecord(body)) {
        return {
            ok: false,
            errors: [{ path: "(body)", message: "must be an object" }],
        };
    }
    noUnknownKeys(body, ["name", "parentCategoryId", "imageURL"], "", c);
    const out: Partial<ItemCategoryInput> = {};
    if (body.name !== undefined || !partial) {
        out.name = readString(
            body.name,
            "name",
            {
                ...NAME,
                pattern: /^[^>;]+$/,
                patternMessage: "must not contain > or ;",
            },
            c,
        );
    }
    if (body.parentCategoryId !== undefined) {
        out.parentCategoryId =
            body.parentCategoryId === null
                ? null
                : readString(
                      body.parentCategoryId,
                      "parentCategoryId",
                      { min: 1, max: 255 },
                      c,
                  );
    }
    if (body.imageURL !== undefined) {
        out.imageURL = readImageUrl(body.imageURL, "imageURL", c);
    }
    if (c.errors.length > 0) return { ok: false, errors: c.errors };
    return { ok: true, value: out };
}

/**
 * Validates the list query string.
 * @param query Express's parsed query
 * @returns the validated query with limit and offset filled in
 */
export function parseItemQuery(
    query: Raw,
): Validated<
    Required<Pick<ItemQuery, "limit" | "offset" | "archived">> &
        Pick<ItemQuery, "q" | "categoryId" | "locationId">
> {
    const c = new Collector();
    const one = (key: string): string | undefined => {
        const value = query[key];
        if (value === undefined) return undefined;
        if (typeof value !== "string") {
            c.add(key, "must be a single value");
            return undefined;
        }
        return value;
    };
    const q = one("q")?.trim();
    if (q && q.length > MAX_NAME)
        c.add("q", `must be at most ${MAX_NAME} characters`);
    const archivedRaw = one("archived") ?? "false";
    if (!["true", "false", "all"].includes(archivedRaw)) {
        c.add("archived", "must be true, false or all");
    }
    const intParam = (
        key: string,
        fallback: number,
        min: number,
        max: number,
    ) => {
        const raw = one(key);
        if (raw === undefined) return fallback;
        const n = Number(raw);
        if (!/^\d{1,9}$/.test(raw) || n < min || n > max) {
            c.add(key, `must be a whole number from ${min} to ${max}`);
            return fallback;
        }
        return n;
    };
    const limit = intParam("limit", DEFAULT_PAGE, 1, MAX_PAGE);
    const offset = intParam("offset", 0, 0, 1_000_000);
    const categoryId = one("category") ?? one("categoryId");
    const locationId = one("location") ?? one("locationId");
    if (c.errors.length > 0) return { ok: false, errors: c.errors };
    return {
        ok: true,
        value: {
            q: q || undefined,
            categoryId,
            locationId,
            archived: archivedRaw as "true" | "false" | "all",
            limit,
            offset,
        },
    };
}
