import {
    PluginApiMountDefinition,
    PluginDatabaseMount,
    PluginManifest,
    PluginPermissionProvider,
    PluginUIMountDefinition,
} from "@tessellatepos/plugin-sdk";
import type {
    HookDefinition,
    HookResult,
    EventDefinition,
} from "@tessellatepos/plugin-sdk/server";

interface PluginMounts {
    ui: PluginUIMountDefinition[];
    api: PluginApiMountDefinition[];
    database: PluginDatabaseMount[];
}

type HookHandler = (...args: unknown[]) => unknown;
type EventHandler = (...args: unknown[]) => void;

export class Plugin {
    protected manifest: PluginManifest;
    protected permissions: PluginPermissionProvider;
    private mounts: PluginMounts = { ui: [], api: [], database: [] };
    private hookHandlers: Map<string, HookHandler[]> = new Map();
    private eventListeners: Map<string, EventHandler[]> = new Map();

    constructor(
        manifest: PluginManifest,
        permissions: PluginPermissionProvider,
    ) {
        this.manifest = manifest;
        this.permissions = permissions;
    }

    // ── Mounts ──

    public register<K extends keyof PluginMounts>(
        kind: K,
        mount: PluginMounts[K][number],
    ) {
        this.mounts[kind].push(mount as PluginMounts[K][number]);
    }

    public get<K extends keyof PluginMounts>(kind: K): PluginMounts[K] {
        return this.mounts[kind];
    }

    public getManifest(): PluginManifest {
        return this.manifest;
    }

    // ── Hooks (pre-event, can modify or block) ──
    // Type is inferred from the HookDefinition the plugin passes in.

    public hook<TInput, TOutput>(
        def: HookDefinition<TInput, TOutput>,
        handler: (
            input: TInput,
        ) => HookResult<TOutput> | Promise<HookResult<TOutput>>,
    ): void {
        const list = this.hookHandlers.get(def.name) ?? [];
        list.push(handler as unknown as HookHandler);
        this.hookHandlers.set(def.name, list);
    }

    public getHookHandlers(name: string): HookHandler[] {
        return this.hookHandlers.get(name) ?? [];
    }

    // ── Events (post-event, fire and forget) ──
    // Type is inferred from the EventDefinition.

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- any[] needed for Parameters<THandler> to extract arg types
    public on<THandler extends (...args: any[]) => void>(
        def: EventDefinition<THandler>,
        handler: THandler,
    ): void {
        const list = this.eventListeners.get(def.name) ?? [];
        list.push(handler as unknown as EventHandler);
        this.eventListeners.set(def.name, list);
    }

    public getEventListeners(name: string): EventHandler[] {
        return this.eventListeners.get(name) ?? [];
    }
}
