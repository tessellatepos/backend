import { Plugin } from "@/plugin/plugin";
import { publishGatewayEvent } from "@/gateway/webhooks/dispatch";
import { TessellatePluginApiRegistry } from "@/utils/registry/api/pluginApiRegistry";
import type { PluginPermissionProvider } from "@tessellatepos/plugin-sdk";
import type {
    HookContext,
    HookDefinition,
    HookResult,
    EventDefinition,
} from "@tessellatepos/plugin-sdk/server";
import { Logger } from "tslog";
import { TessellatePluginDatabaseRegistry } from "@/utils/registry/database/pluginDatabaseRegistry";
import { authProviders } from "@/auth/providers";
import {
    processorRegistry,
    type PaymentProcessorRegistry,
} from "@/services/processors/registry";
import { wrapPluginProcessor } from "@/services/processors/plugin";
import {
    assertGatewayScopes,
    declaredGatewayScopes,
} from "@/plugin/lifecycle/gatewayScopes";

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
    /** Who caused the action; handlers get it as their second argument. */
    context?: HookContext;
}

const NO_CONTEXT: HookContext = { principal: null, source: null };

export class TessellatePluginRegistry {
    private plugins: Map<string, Plugin>;
    public apiRegistry: TessellatePluginApiRegistry;
    public databaseRegistry: TessellatePluginDatabaseRegistry;

    private readonly processors: PaymentProcessorRegistry;

    constructor(processors: PaymentProcessorRegistry = processorRegistry) {
        this.processors = processors;
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

        // Declared gateway scopes and the scopes the mounts use are checked
        // before anything of the plugin is mounted.
        assertGatewayScopes(name, plugin);

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

        // Processors next, for the same reason: an id clash refuses the whole
        // plugin. Registered under the id the plugin declared, which
        // validation tied to the plugin's name.
        const added: string[] = [];
        try {
            for (const processor of plugin.get("paymentProcessor")) {
                this.processors.register(wrapPluginProcessor(name, processor));
                added.push(processor.id);
            }
        } catch (err) {
            for (const id of added) this.processors.unregister(id);
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

    /**
     * Removes a plugin's contributions: processors, sign-in methods, API
     * routes, tables handles, hooks and events. Gateway routes are built at
     * startup and keep serving until the next restart, but their handlers
     * are gone, so they answer 404.
     * @param name the plugin's name
     * @returns false when no such plugin is loaded
     */
    public unloadPlugin(name: string): boolean {
        const plugin = this.plugins.get(name);
        if (!plugin) return false;
        for (const processor of plugin.get("paymentProcessor")) {
            this.processors.unregister(processor.id);
        }
        authProviders.removePlugin(name);
        this.apiRegistry.unregister(name);
        this.databaseRegistry.unregister(name);
        this.plugins.delete(name);
        return true;
    }

    /**
     * Scopes the loaded plugins declared for their gateway routes.
     * @returns each scope with the plugin that owns it
     */
    public gatewayScopes(): { plugin: string; scope: string }[] {
        return [...this.plugins].flatMap(([name, plugin]) =>
            declaredGatewayScopes(name, plugin).map((scope) => ({
                plugin: name,
                scope,
            })),
        );
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
                const result = (await handler(
                    value,
                    options.context ?? NO_CONTEXT,
                )) as HookResult<unknown>;
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
        // Outbound webhooks observe every event, whatever plugins it reaches.
        publishGatewayEvent(def.name, args);
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
