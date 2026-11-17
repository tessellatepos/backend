import { pool } from "@/services/db/postgres";
import {
    PluginColumnType,
    PluginDatabaseColumn,
    PluginDatabaseMount,
    PluginDatabaseRepository,
    PluginDatabaseTable,
    PluginMigrationOp,
    PluginTableClient,
    PluginTableHookError,
} from "@tessellatepos/plugin-sdk";
import type {
    HookResult,
    PluginTableHooks,
} from "@tessellatepos/plugin-sdk/server";
import { Logger } from "tslog";

const logger = new Logger();

const quote = (identifier: string) => `"${identifier.replace(/"/g, '""')}"`;

const VERSIONS_TABLE = "plugin_schema_versions";

/** Unwraps a before-hook result, turning a block into a thrown error. */
function unwrap<T>(result: HookResult<T>): T {
    if (!result.ok) throw new PluginTableHookError(result.reason, result.code);
    return result.value;
}

interface RegisteredTable {
    physicalName: string;
    primaryKey: string;
    columnNames: Set<string>;
}

export class TessellatePluginDatabaseRegistry {
    private plugins: Map<string, Map<string, RegisteredTable>> = new Map();
    private tableHooks: Map<string, Map<string, PluginTableHooks[]>> =
        new Map();

    public async register(
        pluginName: string,
        mount: PluginDatabaseMount | PluginDatabaseMount[],
    ) {
        const mounts = Array.isArray(mount) ? mount : [mount];
        const tables =
            this.plugins.get(pluginName) ?? new Map<string, RegisteredTable>();

        for (const database of mounts) {
            for (const table of database.tables) {
                const registeredTable = this.buildRegisteredTable(
                    pluginName,
                    table,
                );
                await this.provisionTable(registeredTable, table);
                tables.set(table.name, registeredTable);
            }
        }

        this.plugins.set(pluginName, tables);
    }

    public unregister(pluginName: string) {
        this.plugins.delete(pluginName);
        this.tableHooks.delete(pluginName);
    }

    /** Hooks must target tables the plugin declared. */
    public setTableHooks(
        pluginName: string,
        hooks: Map<string, PluginTableHooks[]>,
    ) {
        const tables = this.plugins.get(pluginName);
        for (const tableName of hooks.keys()) {
            if (!tables?.has(tableName)) {
                throw new Error(
                    `Plugin "${pluginName}" registered hooks for unknown table "${tableName}"`,
                );
            }
        }
        this.tableHooks.set(pluginName, hooks);
    }

    public getRepository(pluginName: string): PluginDatabaseRepository {
        return {
            table: (name: string): PluginTableClient => {
                const table = this.plugins.get(pluginName)?.get(name);
                if (!table) {
                    throw new Error(
                        `Plugin "${pluginName}" has no registered table named "${name}"`,
                    );
                }
                return this.buildTableClient(
                    table,
                    this.tableHooks.get(pluginName)?.get(name) ?? [],
                );
            },
        };
    }

    private buildRegisteredTable(
        pluginName: string,
        table: PluginDatabaseTable,
    ): RegisteredTable {
        const primaryKeyColumns = table.columns.filter(
            (column) => column.primaryKey,
        );
        if (primaryKeyColumns.length !== 1) {
            throw new Error(
                `Table "${table.name}" for plugin "${pluginName}" must declare exactly one primary key column (found ${primaryKeyColumns.length})`,
            );
        }

        return {
            physicalName: `${pluginName}-${table.name}`,
            primaryKey: primaryKeyColumns[0].name,
            columnNames: new Set(table.columns.map((column) => column.name)),
        };
    }

    /**
     * Creates the table, or migrates it to the declared version. Runs in one
     * transaction. The applied version is kept in `plugin_schema_versions`;
     * a table that exists without a record predates versioning (version 1).
     */
    private async provisionTable(
        registeredTable: RegisteredTable,
        table: PluginDatabaseTable,
    ) {
        const latest = this.validateMigrations(registeredTable, table);
        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            await client.query(
                `CREATE TABLE IF NOT EXISTS ${quote(VERSIONS_TABLE)} (physical_name TEXT PRIMARY KEY, version INTEGER NOT NULL)`,
            );
            const recorded = await client.query(
                `SELECT version FROM ${quote(VERSIONS_TABLE)} WHERE physical_name = $1 FOR UPDATE`,
                [registeredTable.physicalName],
            );
            let current: number | undefined = recorded.rows[0]?.version;

            if (current === undefined) {
                const existing = await client.query(
                    "SELECT to_regclass($1) AS found",
                    [quote(registeredTable.physicalName)],
                );
                if (existing.rows[0].found === null) {
                    await client.query(
                        this.buildCreateTableStatement(registeredTable, table),
                    );
                    current = latest;
                } else {
                    current = 1;
                }
            }

            if (current > latest) {
                throw new Error(
                    `Table "${registeredTable.physicalName}" is at schema version ${current}, newer than the plugin's ${latest}`,
                );
            }

            const pending = (table.migrations ?? [])
                .filter((m) => m.version > current && m.version <= latest)
                .sort((a, b) => a.version - b.version);
            for (const migration of pending) {
                logger.info(
                    `Migrating "${registeredTable.physicalName}" to version ${migration.version}`,
                );
                for (const op of migration.up) {
                    await client.query(
                        this.buildMigrationStatement(registeredTable, op),
                    );
                }
            }

            await client.query(
                `INSERT INTO ${quote(VERSIONS_TABLE)} (physical_name, version) VALUES ($1, $2)
                 ON CONFLICT (physical_name) DO UPDATE SET version = EXCLUDED.version`,
                [registeredTable.physicalName, latest],
            );
            await client.query("COMMIT");
        } catch (err) {
            await client.query("ROLLBACK");
            throw err;
        } finally {
            client.release();
        }
    }

    /** Returns the table's declared schema version. */
    private validateMigrations(
        registeredTable: RegisteredTable,
        table: PluginDatabaseTable,
    ): number {
        const migrations = table.migrations ?? [];
        const seen = new Set<number>();
        for (const migration of migrations) {
            if (!Number.isInteger(migration.version) || migration.version < 2) {
                throw new Error(
                    `Table "${table.name}": migration version must be an integer >= 2 (got ${migration.version})`,
                );
            }
            if (seen.has(migration.version)) {
                throw new Error(
                    `Table "${table.name}": duplicate migration version ${migration.version}`,
                );
            }
            seen.add(migration.version);
            for (const op of migration.up) {
                if (op.op === "addColumn") {
                    const { column } = op;
                    if (column.primaryKey) {
                        throw new Error(
                            `Table "${table.name}": migration ${migration.version} cannot add a primary key column`,
                        );
                    }
                    if (
                        !column.nullable &&
                        (column.default === undefined ||
                            column.default === null)
                    ) {
                        throw new Error(
                            `Table "${table.name}": column "${column.name}" added in migration ${migration.version} must be nullable or have a default`,
                        );
                    }
                } else if (
                    op.op === "dropColumn" &&
                    op.name === registeredTable.primaryKey
                ) {
                    throw new Error(
                        `Table "${table.name}": migration ${migration.version} cannot drop the primary key column`,
                    );
                }
            }
        }

        const highest = Math.max(1, ...seen);
        const latest = table.version ?? highest;
        if (!Number.isInteger(latest) || latest < highest) {
            throw new Error(
                `Table "${table.name}": version ${latest} is lower than its highest migration (${highest})`,
            );
        }
        return latest;
    }

    private buildMigrationStatement(
        registeredTable: RegisteredTable,
        op: PluginMigrationOp,
    ): string {
        const alter = `ALTER TABLE ${quote(registeredTable.physicalName)}`;
        switch (op.op) {
            case "addColumn":
                return `${alter} ADD COLUMN ${this.buildColumnDefinition(op.column)}`;
            case "dropColumn":
                return `${alter} DROP COLUMN ${quote(op.name)}`;
            case "renameColumn":
                return `${alter} RENAME COLUMN ${quote(op.from)} TO ${quote(op.to)}`;
            default:
                throw new Error(
                    `Unknown migration op: ${String((op as { op: unknown }).op)}`,
                );
        }
    }

    private buildCreateTableStatement(
        registeredTable: RegisteredTable,
        table: PluginDatabaseTable,
    ): string {
        const columnDefinitions = table.columns
            .map((column) => this.buildColumnDefinition(column))
            .join(",\n    ");

        return `CREATE TABLE IF NOT EXISTS "${registeredTable.physicalName.replace(/"/g, '""')}" (\n    ${columnDefinitions}\n);`;
    }

    private buildColumnDefinition(column: PluginDatabaseColumn): string {
        let type: string;
        switch (column.type) {
            case PluginColumnType.TEXT:
                type = "TEXT";
                break;
            case PluginColumnType.VARCHAR:
                type = `VARCHAR(${column.length ?? 255})`;
                break;
            case PluginColumnType.INTEGER:
                type = column.autoIncrement ? "SERIAL" : "INTEGER";
                break;
            case PluginColumnType.BOOLEAN:
                type = "BOOLEAN";
                break;
            case PluginColumnType.TIMESTAMP:
                type = "TIMESTAMP";
                break;
            case PluginColumnType.JSONB:
                type = "JSONB";
                break;
            default:
                throw new Error(`Unknown column type: ${String(column.type)}`);
        }

        let definition = `"${column.name.replace(/"/g, '""')}" ${type}`;

        if (column.primaryKey) {
            definition += " PRIMARY KEY";
        } else {
            if (!column.nullable) {
                definition += " NOT NULL";
            }
            if (column.unique) {
                definition += " UNIQUE";
            }
        }

        if (column.default !== undefined && column.default !== null) {
            const defaultValue =
                typeof column.default === "string"
                    ? `'${column.default.replace(/'/g, "''")}'`
                    : column.default;
            definition += ` DEFAULT ${defaultValue}`;
        }

        return definition;
    }

    private buildTableClient(
        table: RegisteredTable,
        hooks: PluginTableHooks[],
    ): PluginTableClient {
        // After-hooks never affect the write: errors are logged, not thrown.
        const fireAfter = (
            name: string,
            call: (h: PluginTableHooks) => void | Promise<void> | undefined,
        ) => {
            for (const hook of hooks) {
                Promise.resolve(call(hook)).catch((err) =>
                    logger.error(
                        `Table hook "${name}" error on "${table.physicalName}":`,
                        err,
                    ),
                );
            }
        };

        const knownColumns = (row: Record<string, unknown>): string[] =>
            Object.keys(row).filter((key) => table.columnNames.has(key));

        return {
            find: async (query = {}) => {
                const keys = Object.keys(query).filter((key) =>
                    table.columnNames.has(key),
                );
                const values = keys.map((key) => query[key]);
                const where = keys.length
                    ? ` WHERE ${keys.map((key, i) => `"${key.replace(/"/g, '""')}" = $${i + 1}`).join(" AND ")}`
                    : "";

                const result = await pool.query(
                    `SELECT * FROM "${table.physicalName.replace(/"/g, '""')}"${where}`,
                    values,
                );
                return result.rows;
            },

            findOne: async (id) => {
                const result = await pool.query(
                    `SELECT * FROM "${table.physicalName.replace(/"/g, '""')}" WHERE "${table.primaryKey.replace(/"/g, '""')}" = $1 LIMIT 1`,
                    [id],
                );
                return result.rows[0] ?? null;
            },

            insert: async (input) => {
                let row = input;
                for (const hook of hooks) {
                    if (hook.beforeInsert) {
                        row = unwrap(await hook.beforeInsert(row));
                    }
                }
                const keys = knownColumns(row);
                const values = keys.map((key) => row[key]);
                const columns = keys
                    .map((key) => `"${key.replace(/"/g, '""')}"`)
                    .join(", ");
                const placeholders = keys.map((_, i) => `$${i + 1}`).join(", ");
                // An empty row is valid (e.g. a table of only an
                // auto-increment key): every column takes its default.
                const insertBody = keys.length
                    ? `(${columns}) VALUES (${placeholders})`
                    : "DEFAULT VALUES";

                const result = await pool.query(
                    `INSERT INTO "${table.physicalName.replace(/"/g, '""')}" ${insertBody} RETURNING *`,
                    values,
                );
                const inserted = result.rows[0];
                fireAfter("afterInsert", (h) => h.afterInsert?.(inserted));
                return inserted;
            },

            update: async (id, input) => {
                let patch = input;
                for (const hook of hooks) {
                    if (hook.beforeUpdate) {
                        patch = unwrap(await hook.beforeUpdate({ id, patch }));
                    }
                }
                const keys = knownColumns(patch);
                if (keys.length === 0) {
                    throw new Error(
                        `No recognized columns provided to update in table "${table.physicalName}"`,
                    );
                }
                const values = keys.map((key) => patch[key]);
                const assignments = keys
                    .map((key, i) => `"${key.replace(/"/g, '""')}" = $${i + 1}`)
                    .join(", ");

                const result = await pool.query(
                    `UPDATE "${table.physicalName.replace(/"/g, '""')}" SET ${assignments} WHERE "${table.primaryKey.replace(/"/g, '""')}" = $${keys.length + 1} RETURNING *`,
                    [...values, id],
                );
                const updated = result.rows[0];
                if (updated) {
                    fireAfter("afterUpdate", (h) => h.afterUpdate?.(updated));
                }
                return updated;
            },

            delete: async (id) => {
                for (const hook of hooks) {
                    if (hook.beforeDelete) {
                        unwrap(await hook.beforeDelete({ id }));
                    }
                }
                await pool.query(
                    `DELETE FROM "${table.physicalName.replace(/"/g, '""')}" WHERE "${table.primaryKey.replace(/"/g, '""')}" = $1`,
                    [id],
                );
                fireAfter("afterDelete", (h) => h.afterDelete?.({ id }));
            },
        };
    }
}
