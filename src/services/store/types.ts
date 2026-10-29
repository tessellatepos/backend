import type { SQL } from "drizzle-orm";

export interface ListOptions {
    /** Case-insensitive substring matched against the store's search columns. */
    text?: string;
    /** Maximum number of records to return. Omit to return everything. */
    limit?: number;
    /** The nextCursor of the previous page. */
    cursor?: string;
    /** Extra filter, ANDed with the rest. */
    where?: SQL;
}

export interface Page<T> {
    items: T[];
    /** Pass as `cursor` to get the next page, or null on the last page. */
    nextCursor: string | null;
}

/**
 * The local (Postgres) copy of one resource. Readers and endpoints talk to
 * this; providers fill it. Implemented by createLocalStore, or by hand where
 * a resource doesn't fit one table (see the catalog store).
 */
export interface LocalStore<T> {
    /**
     * Reads the id of a record.
     * @param item the record
     * @returns its id
     */
    idOf(item: T): string;

    /**
     * Lists live records, sorted, optionally searched and paged.
     * @param options text search, paging and filters
     * @returns a page of records
     */
    list(options?: ListOptions): Promise<Page<T>>;

    /**
     * Fetches one live record.
     * @param id the record id
     * @returns the record, or null if it doesn't exist or was removed
     */
    get(id: string): Promise<T | null>;

    /**
     * Inserts or updates records by id. Re-adds a record that was removed.
     * @param items the records to write
     */
    upsertMany(items: T[]): Promise<void>;

    /**
     * Inserts or updates one record by id.
     * @param item the record to write
     */
    upsert(item: T): Promise<void>;

    /**
     * Removes a record: soft where the store supports it, otherwise hard.
     * @param id the record id
     * @returns true if a live record was removed
     */
    remove(id: string): Promise<boolean>;
}
