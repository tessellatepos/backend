import { pool } from "@/services/db/postgres";
import {
    PluginColumnType,
    PluginDatabaseColumn,
    PluginDatabaseMount,
    PluginDatabaseRepository,
    PluginDatabaseTable,
    PluginTableClient,
} from "@tessellatepos/plugin-sdk";

interface RegisteredTable {
    physicalName: string;
    primaryKey: string;
    columnNames: Set<string>;
}

export class TessellatePluginDatabaseRegistry {
    private plugins: Map<string, Map<string, RegisteredTable>> = new Map();

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
                await pool.query(
                    this.buildCreateTableStatement(registeredTable, table),
                );
                tables.set(table.name, registeredTable);
            }
        }

        this.plugins.set(pluginName, tables);
    }

    public unregister(pluginName: string) {
        this.plugins.delete(pluginName);
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
                return this.buildTableClient(table);
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
                type = column.auto_increment ? "SERIAL" : "INTEGER";
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

    private buildTableClient(table: RegisteredTable): PluginTableClient {
        const knownColumns = (row: Record<string, unknown>): string[] => {
            const keys = Object.keys(row).filter((key) =>
                table.columnNames.has(key),
            );
            if (keys.length === 0) {
                throw new Error(
                    `No recognized columns provided for table "${table.physicalName}"`,
                );
            }
            return keys;
        };

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

            insert: async (row) => {
                const keys = knownColumns(row);
                const values = keys.map((key) => row[key]);
                const columns = keys
                    .map((key) => `"${key.replace(/"/g, '""')}"`)
                    .join(", ");
                const placeholders = keys.map((_, i) => `$${i + 1}`).join(", ");

                const result = await pool.query(
                    `INSERT INTO "${table.physicalName.replace(/"/g, '""')}" (${columns}) VALUES (${placeholders}) RETURNING *`,
                    values,
                );
                return result.rows[0];
            },

            update: async (id, patch) => {
                const keys = knownColumns(patch);
                const values = keys.map((key) => patch[key]);
                const assignments = keys
                    .map((key, i) => `"${key.replace(/"/g, '""')}" = $${i + 1}`)
                    .join(", ");

                const result = await pool.query(
                    `UPDATE "${table.physicalName.replace(/"/g, '""')}" SET ${assignments} WHERE "${table.primaryKey.replace(/"/g, '""')}" = $${keys.length + 1} RETURNING *`,
                    [...values, id],
                );
                return result.rows[0];
            },

            delete: async (id) => {
                await pool.query(
                    `DELETE FROM "${table.physicalName.replace(/"/g, '""')}" WHERE "${table.primaryKey.replace(/"/g, '""')}" = $1`,
                    [id],
                );
            },
        };
    }
}
