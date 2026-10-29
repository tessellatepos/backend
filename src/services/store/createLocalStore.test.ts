import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { pgTable, text } from "drizzle-orm/pg-core";
import { catalogCategoriesTable, locationsTable } from "@/services/db/schema";
import { closeTestDb, setupTestDb, truncate } from "@/test/db";
import { pool } from "@/services/db/postgres";
import { createLocalStore } from "./createLocalStore";

interface Place {
    id: string;
    name: string;
}

// locations has deleted_at (soft delete); categories does not (hard delete).
const softStore = createLocalStore({
    table: locationsTable,
    toRow: (p: Place) => ({
        id: p.id,
        name: p.name,
        address: {},
        currency: "CAD",
    }),
    fromRow: (row): Place => ({ id: row.id, name: row.name }),
    searchColumns: [locationsTable.name],
    orderBy: locationsTable.name,
});

const hardStore = createLocalStore({
    table: catalogCategoriesTable,
    toRow: (p: Place) => ({ id: p.id, name: p.name }),
    fromRow: (row): Place => ({ id: row.id, name: row.name ?? "" }),
    searchColumns: [catalogCategoriesTable.name],
});

const places: Place[] = [
    { id: "a", name: "Charlie" },
    { id: "b", name: "alpha" },
    { id: "c", name: "Bravo_50%" },
    { id: "d", name: "Alpha" },
];

describe("createLocalStore", () => {
    before(setupTestDb);
    after(closeTestDb);
    beforeEach(() =>
        truncate("tessellate-locations", "tessellate-catalog-categories"),
    );

    it("rejects tables without id and updatedAt", () => {
        assert.throws(() =>
            createLocalStore({
                table: pgTable("no_updated_at", { id: text("id") }),
                toRow: (p: Place) => ({ id: p.id }),
                fromRow: (): Place => ({ id: "", name: "" }),
            }),
        );
    });

    it("upserts, gets and lists sorted by the order column then id", async () => {
        await softStore.upsertMany(places);
        const { items, nextCursor } = await softStore.list();
        assert.equal(nextCursor, null);
        assert.deepEqual(
            items.map((p) => p.id),
            // collation-dependent case ordering is avoided by comparing
            // against the database's own ordering of the names
            (
                await pool.query(
                    `SELECT id FROM "tessellate-locations" ORDER BY name, id`,
                )
            ).rows.map((r) => r.id),
        );
        assert.deepEqual(await softStore.get("a"), places[0]);
        assert.equal(await softStore.get("missing"), null);
    });

    it("pages with cursors without gaps or repeats", async () => {
        await softStore.upsertMany(places);
        const all = (await softStore.list()).items.map((p) => p.id);
        const seen: string[] = [];
        let cursor: string | undefined;
        let pages = 0;
        do {
            const page = await softStore.list({ limit: 3, cursor });
            seen.push(...page.items.map((p) => p.id));
            cursor = page.nextCursor ?? undefined;
            pages++;
        } while (cursor);
        assert.deepEqual(seen, all);
        assert.equal(pages, 2);
    });

    it("pages by id when no order column is given", async () => {
        await hardStore.upsertMany(places);
        const first = await hardStore.list({ limit: 2 });
        assert.deepEqual(
            first.items.map((p) => p.id),
            ["a", "b"],
        );
        const second = await hardStore.list({
            limit: 2,
            cursor: first.nextCursor ?? undefined,
        });
        assert.deepEqual(
            second.items.map((p) => p.id),
            ["c", "d"],
        );
        assert.equal(second.nextCursor, null);
    });

    it("searches case-insensitively and treats wildcards literally", async () => {
        await softStore.upsertMany(places);
        const alpha = await softStore.list({ text: "ALPHA" });
        assert.deepEqual(alpha.items.map((p) => p.id).sort(), ["b", "d"]);
        const pct = await softStore.list({ text: "50%" });
        assert.deepEqual(
            pct.items.map((p) => p.id),
            ["c"],
        );
        const underscore = await softStore.list({ text: "o_5" });
        assert.equal(underscore.items.length, 1);
        assert.equal((await softStore.list({ text: "_" })).items.length, 1);
        assert.equal((await softStore.list({ text: "%" })).items.length, 1);
    });

    it("upsert updates in place and bumps updated_at", async () => {
        await softStore.upsert({ id: "a", name: "One" });
        const before = (
            await pool.query(
                `SELECT updated_at, created_at FROM "tessellate-locations" WHERE id='a'`,
            )
        ).rows[0];
        await new Promise((resolve) => setTimeout(resolve, 10));
        await softStore.upsert({ id: "a", name: "Two" });
        const after = (
            await pool.query(
                `SELECT updated_at, created_at FROM "tessellate-locations" WHERE id='a'`,
            )
        ).rows[0];
        assert.equal((await softStore.list()).items.length, 1);
        assert.equal((await softStore.get("a"))?.name, "Two");
        assert.ok(after.updated_at > before.updated_at);
        assert.deepEqual(after.created_at, before.created_at);
    });

    it("soft deletes when the table has deleted_at, and upsert revives", async () => {
        await softStore.upsertMany(places);
        assert.equal(await softStore.remove("a"), true);
        assert.equal(await softStore.remove("a"), false);
        assert.equal(await softStore.get("a"), null);
        assert.equal(
            (await softStore.list()).items.some((p) => p.id === "a"),
            false,
        );
        const row = await pool.query(
            `SELECT deleted_at FROM "tessellate-locations" WHERE id='a'`,
        );
        assert.ok(row.rows[0].deleted_at, "row kept with deleted_at set");

        await softStore.upsert({ id: "a", name: "Back" });
        assert.equal((await softStore.get("a"))?.name, "Back");
    });

    it("hard deletes when the table has no deleted_at", async () => {
        await hardStore.upsertMany(places);
        assert.equal(await hardStore.remove("a"), true);
        assert.equal(await hardStore.remove("a"), false);
        const rows = await pool.query(
            `SELECT 1 FROM "tessellate-catalog-categories" WHERE id='a'`,
        );
        assert.equal(rows.rowCount, 0);
    });

    it("upserting nothing is a no-op", async () => {
        await softStore.upsertMany([]);
        assert.equal((await softStore.list()).items.length, 0);
    });
});
