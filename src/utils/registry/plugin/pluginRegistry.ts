import { Plugin } from "@/plugin/plugin";
import { TessellatePluginApiRegistry } from "@/utils/registry/api/pluginApiRegistry";
import { Logger } from "tslog";

const logger = new Logger();

export class TessellatePluginRegistry {
    private plugins: Map<string, Plugin>;
    public apiRegistry: TessellatePluginApiRegistry;

    constructor() {
        this.plugins = new Map();
        this.apiRegistry = new TessellatePluginApiRegistry();
    }

    public loadPlugin(name: string, plugin: Plugin) {
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
    }

    public unloadPlugin(plugin: Plugin) {
        //TODO add plugin unload function
    }

    public getPlugins() {
        return this.plugins;
    }
}
