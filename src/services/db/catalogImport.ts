import { randomUUID } from "node:crypto";
import { isNull } from "drizzle-orm";
import {
    CATALOG_CSV_COLUMNS,
    CURRENCIES,
    convertCentsToDollars,
    convertDollarsToCents,
} from "@tessellatepos/sdk";
import type {
    CatalogCsvColumn,
    CatalogFieldError,
    CatalogImportReport,
    CatalogImportRowResult,
    CurrencyCode,
    Item,
} from "@tessellatepos/sdk";
import { drizzleDB } from "@/services/db/postgres";
import {
    CsvError,
    MAX_CSV_BYTES,
    parseCsv,
    serializeCsv,
    unguardCell,
} from "@/services/catalogCsv";
import {
    MAX_AMOUNT,
    MAX_NAME,
    MAX_SKU,
    type ItemDraft,
    type VariationDraft,
} from "@/services/catalogValidation";
import {
    catalogCategoriesTable as categoriesTable,
    catalogItemsTable,
    locationsTable,
} from "./schema";
import { hydrateItems } from "./catalog";
import {
    CatalogError,
    canSeeItem,
    toDraft,
    withCatalogTx,
    writeItem,
    type Tx,
    type WriteContext,
} from "./catalogManage";

/** The importer keeps everything but the writes outside the transaction. */
interface ParsedRow {
    line: number;
    itemName: string;
    variationName: string;
    sku: string | null;
    upc: string | null;
    price: bigint | null;
    currency: CurrencyCode | null;
    categories: string[][] | undefined;
    locationIds: string[] | undefined;
    taxable: boolean | undefined;
    archived: boolean | undefined;
}

interface CategoryRow {
    id: string;
    name: string | null;
    parentCategoryId: string | null;
}

interface PlannedGroup {
    existing: Item | null;
    id: string;
    draft: ItemDraft;
    rows: number[];
}

interface Plan {
    results: CatalogImportRowResult[];
    groups: PlannedGroup[];
    newCategories: {
        id: string;
        name: string;
        parentCategoryId: string | null;
    }[];
    summary: CatalogImportReport["summary"];
}

const NO_BYTES = "The file is empty";

function blankToNull(value: string): string | null {
    return value === "" ? null : value;
}

function readBool(value: string): boolean | undefined | "invalid" {
    const v = value.trim().toLowerCase();
    if (v === "") return undefined;
    if (["true", "yes", "y", "1"].includes(v)) return true;
    if (["false", "no", "n", "0"].includes(v)) return false;
    return "invalid";
}

const CONTROL = /[\u0000-\u001f\u007f]/; // eslint-disable-line no-control-regex

function textError(
    value: string,
    max: number,
): "too long" | "has control characters" | null {
    if (value.length > max) return "too long";
    if (CONTROL.test(value)) return "has control characters";
    return null;
}

/** Splits a header row into column indexes, or the errors it has. */
function readHeader(cells: string[]): {
    index: Map<CatalogCsvColumn, number>;
    errors: CatalogFieldError[];
} {
    const errors: CatalogFieldError[] = [];
    const index = new Map<CatalogCsvColumn, number>();
    cells.forEach((cell, position) => {
        const name = cell.trim().toLowerCase() as CatalogCsvColumn;
        if (!CATALOG_CSV_COLUMNS.includes(name)) {
            errors.push({ path: "header", message: "has an unknown column" });
        } else if (index.has(name)) {
            errors.push({ path: "header", message: "repeats a column" });
        } else {
            index.set(name, position);
        }
    });
    if (!index.has("item name")) {
        errors.push({ path: "header", message: 'needs an "item name" column' });
    }
    return { index, errors: dedupe(errors) };
}

function dedupe(errors: CatalogFieldError[]): CatalogFieldError[] {
    const seen = new Set<string>();
    return errors.filter((e) => {
        const key = `${e.path}|${e.message}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

/** Everything a plan reads from the database. */
interface Snapshot {
    items: Item[];
    categories: CategoryRow[];
    locations: { id: string; name: string }[];
}

async function takeSnapshot(db: Tx | typeof drizzleDB): Promise<Snapshot> {
    const [itemRows, categories, locations] = await Promise.all([
        db.select().from(catalogItemsTable),
        db
            .select({
                id: categoriesTable.id,
                name: categoriesTable.name,
                parentCategoryId: categoriesTable.parentCategoryId,
            })
            .from(categoriesTable),
        db
            .select({ id: locationsTable.id, name: locationsTable.name })
            .from(locationsTable)
            .where(isNull(locationsTable.deletedAt)),
    ]);
    return {
        items: await hydrateItems(itemRows, {}, db as typeof drizzleDB),
        categories,
        locations,
    };
}

/**
 * Validates and plans an import against the current catalog without writing.
 * Errors name a line and a column, never the value found there.
 * @param csv the CSV text
 * @param snapshot the catalog and storefronts as they are now
 * @param ctx the importer's location limit
 * @returns the plan: per-row results, items to write, categories to add
 */
function planImport(csv: string, snapshot: Snapshot, ctx: WriteContext): Plan {
    const empty: CatalogImportReport["summary"] = {
        rows: 0,
        errors: 0,
        itemsCreated: 0,
        itemsUpdated: 0,
        variationsCreated: 0,
        variationsUpdated: 0,
        categoriesCreated: 0,
    };
    const fail = (line: number, errors: CatalogFieldError[]): Plan => ({
        results: [{ line, status: "error", errors }],
        groups: [],
        newCategories: [],
        summary: { ...empty, errors: 1 },
    });

    let table: ReturnType<typeof parseCsv>;
    try {
        table = parseCsv(csv);
    } catch (err) {
        if (err instanceof CsvError) {
            if (err.code === "too_many_rows") {
                throw new CatalogError(413, "import_too_large", err.message);
            }
            return fail(1, [{ path: "file", message: err.message }]);
        }
        throw err;
    }
    if (table.length === 0) {
        return fail(1, [{ path: "file", message: NO_BYTES }]);
    }
    const header = readHeader(table[0].cells);
    if (header.errors.length > 0) return fail(1, header.errors);

    const locationById = new Map(snapshot.locations.map((l) => [l.id, l.id]));
    const locationsByName = new Map<string, string[]>();
    for (const l of snapshot.locations) {
        const key = l.name.trim().toLowerCase();
        locationsByName.set(key, [...(locationsByName.get(key) ?? []), l.id]);
    }

    // Pass 1: read and validate each row on its own.
    const results: CatalogImportRowResult[] = [];
    const parsed = new Map<number, ParsedRow>();
    const seenSkus = new Map<string, number>();
    for (const { line, cells } of table.slice(1)) {
        const errors: CatalogFieldError[] = [];
        const cell = (column: CatalogCsvColumn): string => {
            const position = header.index.get(column);
            return unguardCell(
                position === undefined ? "" : (cells[position] ?? "").trim(),
            );
        };
        if (cells.length > table[0].cells.length) {
            errors.push({
                path: "row",
                message: "has more cells than the header",
            });
        }
        const check = (column: CatalogCsvColumn, max: number) => {
            const problem = textError(cell(column), max);
            if (problem) errors.push({ path: column, message: problem });
        };

        const itemName = cell("item name");
        if (!itemName)
            errors.push({ path: "item name", message: "is required" });
        check("item name", MAX_NAME);
        check("variation name", MAX_NAME);
        check("sku", MAX_SKU);
        const sku = blankToNull(cell("sku"));
        if (sku) {
            const first = seenSkus.get(sku);
            if (first !== undefined) {
                errors.push({
                    path: "sku",
                    message: "appears on more than one row",
                });
            }
            seenSkus.set(sku, line);
        }
        const upc = blankToNull(cell("upc"));
        if (upc && !/^\d{8,14}$/.test(upc)) {
            errors.push({ path: "upc", message: "must be 8 to 14 digits" });
        }

        let price: bigint | null = null;
        const priceText = cell("price");
        if (priceText) {
            price = convertDollarsToCents(priceText);
            if (price === null || price > MAX_AMOUNT) {
                errors.push({
                    path: "price",
                    message:
                        "must be a non-negative amount with up to 2 decimals",
                });
                price = null;
            }
        }
        const currencyText = cell("currency").toUpperCase();
        let currency: CurrencyCode | null = null;
        if (currencyText) {
            if (Object.hasOwn(CURRENCIES, currencyText)) {
                currency = currencyText as CurrencyCode;
            } else {
                errors.push({
                    path: "currency",
                    message: "is not a known currency",
                });
            }
        } else if (priceText) {
            errors.push({
                path: "currency",
                message: "is required with a price",
            });
        }

        let categories: string[][] | undefined;
        const categoryText = cell("category");
        if (categoryText) {
            categories = categoryText
                .split(";")
                .map((path) => path.split(">").map((part) => part.trim()))
                .filter((parts) => parts.some(Boolean));
            const badName = categories.some((parts) =>
                parts.some((part) => !part || textError(part, MAX_NAME)),
            );
            if (badName) {
                errors.push({
                    path: "category",
                    message: "has an invalid category name",
                });
            }
        }

        let locationIds: string[] | undefined;
        const locationText = cell("locations");
        if (locationText) {
            const ids: string[] = [];
            let unknown = false;
            for (const part of locationText.split(";").map((p) => p.trim())) {
                if (!part) continue;
                const byName = locationsByName.get(part.toLowerCase());
                const id =
                    locationById.get(part) ??
                    (byName?.length === 1 ? byName[0] : undefined);
                if (id === undefined) unknown = true;
                else ids.push(id);
            }
            if (unknown) {
                errors.push({
                    path: "locations",
                    message: "names an unknown or ambiguous storefront",
                });
            }
            locationIds = [...new Set(ids)];
        }

        const taxable = readBool(cell("taxable"));
        const archived = readBool(cell("archived"));
        if (taxable === "invalid")
            errors.push({ path: "taxable", message: "must be true or false" });
        if (archived === "invalid")
            errors.push({ path: "archived", message: "must be true or false" });

        results.push({
            line,
            status: errors.length ? "error" : "update",
            errors,
        });
        if (!errors.length) {
            parsed.set(line, {
                line,
                itemName,
                variationName: cell("variation name"),
                sku,
                upc,
                price,
                currency,
                categories,
                locationIds,
                taxable: taxable === "invalid" ? undefined : taxable,
                archived: archived === "invalid" ? undefined : archived,
            });
        }
    }
    if (results.length === 0) {
        return fail(table[0].line, [
            { path: "file", message: "has no data rows" },
        ]);
    }
    const resultOf = new Map(results.map((r) => [r.line, r]));
    const flag = (line: number, path: string, message: string) => {
        const result = resultOf.get(line)!;
        result.status = "error";
        result.errors.push({ path, message });
    };

    // Pass 2: match rows to existing items and group rows by item.
    const bySku = new Map<string, { item: Item; variationId: string }>();
    const byName = new Map<string, Item[]>();
    for (const item of snapshot.items) {
        if (!canSeeItem(ctx, item)) continue;
        const key = (item.name ?? "").trim().toLowerCase();
        byName.set(key, [...(byName.get(key) ?? []), item]);
        for (const v of item.variations ?? []) {
            if (v.sku && v.itemId && !bySku.has(v.sku)) {
                bySku.set(v.sku, { item, variationId: v.itemId });
            }
        }
    }

    const groupsByKey = new Map<
        string,
        { existing: Item | null; rows: ParsedRow[] }
    >();
    for (const row of parsed.values()) {
        let existing: Item | null = null;
        const bySkuMatch = row.sku ? bySku.get(row.sku) : undefined;
        if (bySkuMatch) {
            existing = bySkuMatch.item;
        } else {
            const candidates = byName.get(row.itemName.toLowerCase()) ?? [];
            if (candidates.length > 1) {
                flag(
                    row.line,
                    "item name",
                    "matches more than one existing item; use a SKU",
                );
                continue;
            }
            existing = candidates[0] ?? null;
        }
        const key = existing
            ? existing.id
            : `new:${row.itemName.toLowerCase()}`;
        const group = groupsByKey.get(key) ?? { existing, rows: [] };
        group.rows.push(row);
        groupsByKey.set(key, group);
    }

    // Category paths resolve to existing categories or new ones to create.
    const categoryIds = new Map<string, string>();
    for (const c of snapshot.categories) {
        if (c.name) {
            categoryIds.set(
                `${c.parentCategoryId ?? ""}\u0000${c.name.toLowerCase()}`,
                c.id,
            );
        }
    }
    const newCategories: Plan["newCategories"] = [];
    const resolvePath = (parts: string[]): string => {
        let parent: string | null = null;
        let id = "";
        for (const part of parts) {
            const key = `${parent ?? ""}\u0000${part.toLowerCase()}`;
            let found = categoryIds.get(key);
            if (!found) {
                found = randomUUID();
                categoryIds.set(key, found);
                newCategories.push({
                    id: found,
                    name: part,
                    parentCategoryId: parent,
                });
            }
            parent = found;
            id = found;
        }
        return id;
    };

    // Pass 3: build each item's resulting draft.
    const summary = { ...empty, rows: results.length };
    const groups: PlannedGroup[] = [];
    const rowVariation = new Map<number, "create" | "update">();
    for (const group of groupsByKey.values()) {
        const rows = group.rows;
        const existing = group.existing;

        const names = new Set(rows.map((r) => r.itemName.toLowerCase()));
        if (names.size > 1) {
            rows.slice(1).forEach((r) =>
                flag(
                    r.line,
                    "item name",
                    "differs between rows of the same item",
                ),
            );
        }
        const pick = <T>(
            column: CatalogCsvColumn,
            get: (r: ParsedRow) => T | undefined,
        ): T | undefined => {
            const first = rows.find((r) => get(r) !== undefined);
            if (!first) return undefined;
            const value = JSON.stringify(get(first));
            for (const r of rows) {
                if (get(r) !== undefined && JSON.stringify(get(r)) !== value) {
                    flag(
                        r.line,
                        column,
                        "conflicts with another row of the same item",
                    );
                }
            }
            return get(first);
        };
        const categories = pick("category", (r) => r.categories);
        const locationIds = pick("locations", (r) => r.locationIds);
        const taxable = pick("taxable", (r) => r.taxable);
        const archived = pick("archived", (r) => r.archived);

        const draft: ItemDraft = existing
            ? toDraft(existing)
            : {
                  name: rows[0].itemName,
                  displayName: null,
                  labelColor: null,
                  isTaxable: true,
                  isArchived: false,
                  image: null,
                  categoryIds: [],
                  locationIds: [],
                  variations: [],
              };
        draft.name = rows[0].itemName;
        if (categories) {
            draft.categoryIds = [...new Set(categories.map(resolvePath))];
        }
        if (locationIds) {
            draft.locationIds = locationIds;
            draft.variations = draft.variations.map((v) => ({
                ...v,
                locationOverrides: v.locationOverrides.filter((o) =>
                    locationIds.includes(o.locationId),
                ),
            }));
        }
        if (taxable !== undefined) draft.isTaxable = taxable;
        if (archived !== undefined) draft.isArchived = archived;

        const touched = new Set<string>();
        for (const row of rows) {
            const bySkuMatch = row.sku ? bySku.get(row.sku) : undefined;
            let target: VariationDraft | undefined = draft.variations.find(
                (v) =>
                    v.id !== undefined &&
                    bySkuMatch?.item.id === existing?.id &&
                    v.id === bySkuMatch?.variationId,
            );
            if (!target && !row.sku) {
                const wanted = (row.variationName || "Regular").toLowerCase();
                target = draft.variations.find(
                    (v) =>
                        v.id &&
                        !touched.has(v.id) &&
                        v.name.toLowerCase() === wanted,
                );
            }
            if (target?.id && touched.has(target.id)) {
                flag(
                    row.line,
                    "variation name",
                    "repeats a variation of the same item",
                );
                continue;
            }
            const isNew = !target;
            if (!target) {
                target = {
                    id: randomUUID(),
                    name: "Regular",
                    sku: null,
                    upc: null,
                    pricingType: "VARIABLE",
                    priceMoney: null,
                    trackInventory: false,
                    locationOverrides: [],
                };
                draft.variations.push(target);
            }
            touched.add(target.id!);
            if (row.variationName) target.name = row.variationName;
            if (row.sku) target.sku = row.sku;
            if (row.upc) target.upc = row.upc;
            if (row.price !== null && row.currency) {
                target.pricingType = "FIXED";
                target.priceMoney = {
                    amount: row.price,
                    currency: row.currency,
                };
            }
            rowVariation.set(row.line, isNew ? "create" : "update");
            const result = resultOf.get(row.line)!;
            if (result.status !== "error")
                result.status = isNew ? "create" : "update";
        }

        groups.push({
            existing,
            id: existing?.id ?? randomUUID(),
            draft,
            rows: rows.map((r) => r.line),
        });
    }

    // Pass 4: cross-checks on the resulting items.
    const finalSkuOwner = new Map<string, string>();
    const planned = new Set(groups.map((g) => g.existing?.id ?? g.id));
    for (const item of snapshot.items) {
        if (planned.has(item.id)) continue;
        for (const v of item.variations ?? []) {
            if (v.sku && v.itemId) finalSkuOwner.set(v.sku, v.itemId);
        }
    }
    for (const group of groups) {
        const lines = group.rows;
        const { draft } = group;
        if (draft.variations.length > 100) {
            lines.forEach((l) =>
                flag(l, "item name", "would have too many variations"),
            );
        }
        for (const v of draft.variations) {
            if (!v.sku) continue;
            const owner = finalSkuOwner.get(v.sku);
            if (owner && owner !== v.id) {
                const rowsWithSku = lines.filter(
                    (l) => parsed.get(l)?.sku === v.sku,
                );
                (rowsWithSku.length ? rowsWithSku : lines).forEach((l) =>
                    flag(l, "sku", "is used by another item"),
                );
            } else {
                finalSkuOwner.set(v.sku, v.id!);
            }
        }
        const pinned = ctx.allowedLocations !== "all";
        if (pinned)
            lines.forEach((l) =>
                flag(l, "row", "needs an unrestricted account"),
            );
    }

    // Tally.
    for (const group of groups) {
        const bad = group.rows.some((l) => resultOf.get(l)!.status === "error");
        if (bad) continue;
        if (group.existing) summary.itemsUpdated++;
        else summary.itemsCreated++;
        for (const l of group.rows) {
            if (rowVariation.get(l) === "create") summary.variationsCreated++;
            else summary.variationsUpdated++;
        }
    }
    summary.errors = results.filter((r) => r.status === "error").length;
    summary.categoriesCreated = newCategories.length;
    return { results, groups, newCategories, summary };
}

/** A real import that found errors and wrote nothing. */
class ImportRejected extends Error {
    readonly report: CatalogImportReport;

    constructor(report: CatalogImportReport) {
        super("Import rejected");
        this.report = report;
    }
}

function toReport(
    plan: Plan,
    dryRun: boolean,
    applied: boolean,
): CatalogImportReport {
    return { dryRun, applied, rows: plan.results, summary: plan.summary };
}

/**
 * Imports a catalog CSV. A dry run only reports. A real run writes
 * everything in one transaction, or nothing when any row is invalid.
 * @param csv the CSV text
 * @param options dryRun to report without writing
 * @param ctx the importer's location limit
 * @returns what happened per row and in total
 */
export async function importCatalogCsv(
    csv: string,
    options: { dryRun: boolean },
    ctx: WriteContext,
): Promise<CatalogImportReport> {
    if (Buffer.byteLength(csv) > MAX_CSV_BYTES) {
        throw new CatalogError(
            413,
            "import_too_large",
            "The file is too large",
        );
    }
    if (options.dryRun) {
        const plan = planImport(csv, await takeSnapshot(drizzleDB), ctx);
        return toReport(plan, true, false);
    }
    try {
        return await withCatalogTx(async (tx) => {
            const plan = planImport(csv, await takeSnapshot(tx), ctx);
            if (plan.summary.errors > 0) {
                throw new ImportRejected(toReport(plan, false, false));
            }
            for (const category of plan.newCategories) {
                await tx
                    .insert(categoriesTable)
                    .values({ ...category, origin: "local" });
            }
            for (const group of plan.groups) {
                await writeItem(
                    tx,
                    group.id,
                    group.draft,
                    group.existing === null,
                );
            }
            return toReport(plan, false, true);
        });
    } catch (err) {
        if (err instanceof ImportRejected) return err.report;
        throw err;
    }
}

/**
 * Writes the visible catalog as CSV in the import format.
 * @param items the items to write, in order
 * @returns the CSV text
 */
export function exportCatalogCsv(items: Item[]): string {
    const rows: string[][] = [[...CATALOG_CSV_COLUMNS]];
    for (const item of items) {
        const categories = (item.categories ?? [])
            .map((category) => {
                const path: string[] = [];
                for (
                    let c: typeof category | null | undefined = category;
                    c && path.length < 20;
                    c = c.parentCategory
                ) {
                    path.unshift(c.name ?? "");
                }
                return path.join(" > ");
            })
            .join("; ");
        for (const v of item.variations ?? []) {
            const price = v.pricingType === "FIXED" ? v.priceMoney : undefined;
            rows.push([
                item.name ?? "",
                v.name ?? "",
                v.sku ?? "",
                v.upc ?? "",
                price ? convertCentsToDollars(price.amount) : "",
                price?.currency ?? "",
                categories,
                (item.locationIds ?? []).join("; "),
                String(item.isTaxable ?? true),
                String(item.isArchived ?? false),
            ]);
        }
    }
    return serializeCsv(rows);
}
