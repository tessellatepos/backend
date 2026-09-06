import {
    PluginApiMountDefinition,
    PluginDatabaseMount,
    PluginManifest,
    PluginPermissionProvider,
    PluginUIMountDefinition,
} from "@tessellatepos/plugin-sdk";

interface PluginMounts {
    ui: PluginUIMountDefinition;
    api: PluginApiMountDefinition;
    database: PluginDatabaseMount;
}

export class Plugin {
    protected manifest: PluginManifest;
    protected permissions: PluginPermissionProvider;
    private mounts: { [K in keyof PluginMounts]: PluginMounts[K][]} = {
        ui: [],
        api: [],
        database: [],
    }

    constructor(
        manifest: PluginManifest,
        permissions: PluginPermissionProvider,
    ) {
        this.manifest = manifest;
        this.permissions = permissions;
    }

    public register<K extends keyof PluginMounts>(kind: K, mount: PluginMounts[K]) {
        this.mounts[kind].push(mount);
    }

    public get<K extends keyof PluginMounts>(kind: K) {
        return this.mounts[kind];
    }

    public getManifest(): PluginManifest {
        return this.manifest;
    }

}
