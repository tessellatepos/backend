import { Logger } from "tslog";
import type { LocalStore } from "./types";

const logger = new Logger();

export interface SyncResourceOptions<T> {
    /** Shown in the log line, e.g. "locations". */
    name: string;
    /** Fetches the complete set of records from the remote system. */
    fetchRemote: () => Promise<T[]>;
    store: LocalStore<T>;
    /**
     * Whether an empty remote result may remove every local record. Off by
     * default, since an empty result is more often a failed fetch.
     */
    allowEmpty?: boolean;
}

export interface SyncResult {
    name: string;
    upserted: number;
    removed: number;
}

/**
 * Mirrors a remote resource into its local store: upserts everything the
 * remote returned and removes local records the remote no longer has. Safe to
 * run repeatedly.
 * @param options the resource name, its remote fetch and its local store
 * @returns how many records were upserted and removed
 */
export async function syncResource<T>(
    options: SyncResourceOptions<T>,
): Promise<SyncResult> {
    const { name, fetchRemote, store, allowEmpty = false } = options;
    const remote = await fetchRemote();
    await store.upsertMany(remote);

    let removed = 0;
    if (remote.length === 0 && !allowEmpty) {
        logger.warn(`${name}: remote returned nothing, keeping local records`);
    } else {
        const remoteIds = new Set(remote.map((item) => store.idOf(item)));
        const { items: local } = await store.list();
        for (const item of local) {
            const id = store.idOf(item);
            if (!remoteIds.has(id) && (await store.remove(id))) removed++;
        }
    }

    logger.debug(`${name}: synced ${remote.length}, removed ${removed}`);
    return { name, upserted: remote.length, removed };
}
