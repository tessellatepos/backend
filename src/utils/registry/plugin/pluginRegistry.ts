import { Plugin } from "@/plugin/plugin";
import { TessellatePluginApiRegistry } from "@/utils/registry/api/pluginApiRegistry";
import type { PluginPermissionProvider } from "@tessellatepos/plugin-sdk";
import type {
    HookDefinition,
    HookResult,
    EventDefinition,
} from "@tessellatepos/plugin-sdk/server";
import { Logger } from "tslog";
import { TessellatePluginDatabaseRegistry } from "@/utils/registry/database/pluginDatabaseRegistry";
import { authProviders } from "@/auth/providers";

const logger = new Logger();

/** Narrows hook/event dispatch to plugins holding a permission. */
export interface DispatchOptions {
    /** Only plugins granted this permission are called. */
    requires?: keyof PluginPermissionProvider;
}

/** Options for hooks whose output type differs from their input type. */
export interface HookOptions<TInput, TOutput> extends DispatchOptions {
    /**
     * Builds the next handler's input from the previous handler's output.
     * Without it the output is passed on as-is, which only works when
     * TInput and TOutput are the same type.
     */
    carry?: (output: TOutput, input: TInput) => TInput;
}

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

        // Sign-in methods first: an id clash with another plugin refuses the
        // whole plugin before anything else of it is mounted.
        try {
            for (const provider of plugin.get("auth")) {
                authProviders.register({
                    pluginName: name,
                    authRoles: plugin.getManifest().tessellate.authRoles ?? [],
                    provider,
                });
            }
        } catch (err) {
            authProviders.removePlugin(name);
            throw err;
        }

        this.plugins.set(name, plugin);

        //load plugin api routes
        plugin.get("api").forEach((r) => {
            logger.debug(`Registering Plugin ${name}'s Endpoint: ${r.route}`);
            this.apiRegistry.register(name, r, plugin.getPermissions());
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
    // With `requires`, plugins lacking that permission are skipped entirely
    // (used for hooks that carry PII).

    public async runHook<TInput, TOutput>(
        def: HookDefinition<TInput, TOutput>,
        input: TInput,
        options: HookOptions<TInput, TOutput> = {},
    ): Promise<HookResult<TOutput>> {
        let value: unknown = input;
        let output: unknown = input; // the last handler's output
        for (const plugin of this.pluginsWith(options.requires)) {
            for (const handler of plugin.getHookHandlers(def.name)) {
                const result = (await handler(value)) as HookResult<unknown>;
                if (!result.ok) return result;
                output = result.value;
                value = options.carry
                    ? options.carry(result.value as TOutput, value as TInput)
                    : result.value;
            }
        }
        return { ok: true, value: output as TOutput };
    }

    // ── Event dispatch (fire and forget) ──
    // All listeners run, none block the caller, errors are caught.

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- any[] needed for Parameters<THandler> to extract arg types
    public emit<THandler extends (...args: any[]) => void>(
        def: EventDefinition<THandler>,
        ...args: Parameters<THandler>
    ): void {
        this.emitTo({}, def, ...args);
    }

    /**
     * Like emit, but only plugins granted `options.requires` are called.
     * Used for events that carry PII, such as customer events.
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- any[] needed for Parameters<THandler> to extract arg types
    public emitTo<THandler extends (...args: any[]) => void>(
        options: DispatchOptions,
        def: EventDefinition<THandler>,
        ...args: Parameters<THandler>
    ): void {
        for (const plugin of this.pluginsWith(options.requires)) {
            for (const handler of plugin.getEventListeners(def.name)) {
                Promise.resolve()
                    .then(() => handler(...args))
                    .catch((err) =>
                        logger.error(
                            `Plugin event "${def.name}" handler error:`,
                            err,
                        ),
                    );
            }
        }
    }

    private pluginsWith(requires?: keyof PluginPermissionProvider): Plugin[] {
        const all = [...this.plugins.values()];
        return requires
            ? all.filter((plugin) => plugin.getPermissions()[requires])
            : all;
    }
}
