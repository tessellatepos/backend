import { Plugin } from "@/plugin/plugin";
import { TessellatePluginApiRegistry } from "@/utils/registry/api/pluginApiRegistry";
import type {
    HookDefinition,
    HookResult,
    EventDefinition,
} from "@tessellatepos/plugin-sdk/server";
import { Logger } from "tslog";
import { TessellatePluginDatabaseRegistry } from "@/utils/registry/database/pluginDatabaseRegistry";

const logger = new Logger();

export class TessellatePluginRegistry {
    private plugins: Map<string, Plugin>;
    public apiRegistry: TessellatePluginApiRegistry;
    public databaseRegistry: TessellatePluginDatabaseRegistry;

    constructor() {
        this.plugins = new Map();
        this.databaseRegistry = new TessellatePluginDatabaseRegistry();
        this.apiRegistry = new TessellatePluginApiRegistry(
            this.databaseRegistry,
        );
    }

    public async loadPlugin(name: string, plugin: Plugin) {
        if (this.plugins.has(name)) {
            logger.error(`Duplicate plugins detected for name: ${name}`);
            throw new Error(`Duplicate plugins detected for name: ${name}`, {
                cause: plugin,
            });
        }

        this.plugins.set(name, plugin);

        //load plugin api routes
        plugin.get("api").forEach((r) => {
            logger.debug(`Registering Plugin ${name}'s Endpoint: ${r.route}`);
            this.apiRegistry.register(name, r);
        });

        //create plugin database tables
        const databaseMounts = plugin.get("database");
        if (databaseMounts.length > 0) {
            logger.debug(`Provisioning Plugin ${name}'s database tables`);
            await this.databaseRegistry.register(name, databaseMounts);
        }
    }

    public unloadPlugin() {
        //TODO add plugin unload function
    }

    public getPlugins() {
        return this.plugins;
    }

    // ── Hook dispatch (waterfall) ──
    // Each handler gets the previous one's output.
    // First ok:false stops the chain and returns to the caller.

    public async runHook<TInput, TOutput>(
        def: HookDefinition<TInput, TOutput>,
        input: TInput,
    ): Promise<HookResult<TOutput>> {
        let value = input;
        for (const plugin of this.plugins.values()) {
            for (const handler of plugin.getHookHandlers(def.name)) {
                const result = await handler(value);
                if (!result.ok) return result;
                value = result.value;
            }
        }
        return { ok: true, value: value as unknown as TOutput };
    }

    // ── Event dispatch (fire and forget) ──
    // All listeners run, none block the caller, errors are caught.

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- any[] needed for Parameters<THandler> to extract arg types
    public emit<THandler extends (...args: any[]) => void>(
        def: EventDefinition<THandler>,
        ...args: Parameters<THandler>
    ): void {
        for (const plugin of this.plugins.values()) {
            for (const handler of plugin.getEventListeners(def.name)) {
                Promise.resolve(handler(...args)).catch((err) =>
                    logger.error(
                        `Plugin event "${def.name}" handler error:`,
                        err,
                    ),
                );
            }
        }
    }
}
