import {
    and,
    eq,
    getTableColumns,
    gt,
    ilike,
    isNull,
    or,
    type SQL,
} from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import { drizzleDB } from "@/services/db/postgres";
import type { ListOptions, LocalStore, Page } from "./types";

export interface LocalStoreConfig<TTable extends PgTable, T> {
    /** Must have `id` and `updatedAt` columns; `deletedAt` enables soft deletes. */
    table: TTable;
    /** Maps a record to a full row, including its id. */
    toRow: (item: T) => TTable["$inferInsert"];
    fromRow: (row: TTable["$inferSelect"]) => T;
    /** Columns matched by ILIKE when listing with `text`. */
    searchColumns?: PgColumn[];
    /** Sort column (a string column), then id. Defaults to id. */
    orderBy?: PgColumn;
}

/**
 * Escapes LIKE wildcards so user text is matched literally.
 * @param text the raw search text
 * @returns the escaped text
 */
function escapeLike(text: string): string {
    return text.replace(/[\\%_]/g, "\\$&");
}

/**
 * Creates the local store for one table.
 * @param config the table and its row mapping
 * @returns the store
 */
export function createLocalStore<TTable extends PgTable, T>(
    config: LocalStoreConfig<TTable, T>,
): LocalStore<T> {
    const { table, toRow, fromRow, searchColumns = [] } = config;
    const columns = getTableColumns(table) as Record<string, PgColumn>;
    const { id: idColumn, updatedAt: updatedAtColumn } = columns;
    const deletedAtColumn: PgColumn | undefined = columns.deletedAt;
    if (!idColumn || !updatedAtColumn) {
        throw new Error("A local store table needs id and updatedAt columns");
    }
    const orderColumn = config.orderBy ?? idColumn;
    if (orderColumn.dataType !== "string") {
        throw new Error("A local store can only be ordered by a string column");
    }
    const foundKey = Object.keys(columns).find(
        (key) => columns[key] === orderColumn,
    );
    if (!foundKey) {
        throw new Error("orderBy must be a column of the store's table");
    }
    const orderKey: string = foundKey;

    const live = (): SQL | undefined =>
        deletedAtColumn ? isNull(deletedAtColumn) : undefined;

    /** Keyset condition for rows after the cursor's (sort value, id). */
    function afterCursor(cursor: string): SQL | undefined {
        const [value, id] = JSON.parse(
            Buffer.from(cursor, "base64url").toString(),
        ) as [string, string];
        if (orderColumn === idColumn) return gt(idColumn, id);
        return or(
            gt(orderColumn, value),
            and(eq(orderColumn, value), gt(idColumn, id)),
        );
    }

    function encodeCursor(row: Record<string, unknown>): string {
        return Buffer.from(JSON.stringify([row[orderKey], row.id])).toString(
            "base64url",
        );
    }

    async function list(options: ListOptions = {}): Promise<Page<T>> {
        const { text, limit, cursor, where } = options;
        const conditions = [
            live(),
            text && searchColumns.length > 0
                ? or(
                      ...searchColumns.map((column) =>
                          ilike(column, `%${escapeLike(text)}%`),
                      ),
                  )
                : undefined,
            cursor ? afterCursor(cursor) : undefined,
            where,
        ];
        const query = drizzleDB
            .select()
            .from(table as PgTable)
            .where(and(...conditions))
            .orderBy(orderColumn, idColumn)
            .$dynamic();
        const rows = (await (limit === undefined
            ? query
            : query.limit(limit + 1))) as Record<string, unknown>[];

        const hasMore = limit !== undefined && rows.length > limit;
        const pageRows = hasMore ? rows.slice(0, limit) : rows;
        return {
            items: pageRows.map((row) =>
                fromRow(row as TTable["$inferSelect"]),
            ),
            nextCursor: hasMore
                ? encodeCursor(pageRows[pageRows.length - 1])
                : null,
        };
    }

    async function get(id: string): Promise<T | null> {
        const [row] = await drizzleDB
            .select()
            .from(table as PgTable)
            .where(and(eq(idColumn, id), live()))
            .limit(1);
        return row ? fromRow(row as TTable["$inferSelect"]) : null;
    }

    async function upsertMany(items: T[]): Promise<void> {
        if (items.length === 0) return;
        await drizzleDB.transaction(async (tx) => {
            for (const item of items) {
                const values = toRow(item) as Record<string, unknown>;
                const { id: _id, ...rest } = values;
                void _id;
                await tx
                    .insert(table)
                    .values(values as TTable["$inferInsert"])
                    .onConflictDoUpdate({
                        target: idColumn,
                        set: {
                            ...rest,
                            updatedAt: new Date(),
                            ...(deletedAtColumn ? { deletedAt: null } : {}),
                        } as never,
                    });
            }
        });
    }

    async function remove(id: string): Promise<boolean> {
        if (deletedAtColumn) {
            const removed = await drizzleDB
                .update(table)
                .set({ deletedAt: new Date(), updatedAt: new Date() } as never)
                .where(and(eq(idColumn, id), isNull(deletedAtColumn)))
                .returning({ id: idColumn });
            return removed.length > 0;
        }
        const removed = await drizzleDB
            .delete(table)
            .where(eq(idColumn, id))
            .returning({ id: idColumn });
        return removed.length > 0;
    }

    return {
        idOf: (item) => String((toRow(item) as { id: unknown }).id),
        list,
        get,
        upsertMany,
        upsert: (item) => upsertMany([item]),
        remove,
    };
}
