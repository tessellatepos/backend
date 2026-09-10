import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { Logger } from "tslog";
import { Plugin } from "@/plugin/plugin";
import {
    getManifestList,
    grantedPermissions,
} from "@/plugin/lifecycle/manifest";
import { TessellatePluginRegistry } from "@/utils/registry/plugin/pluginRegistry";

const logger = new Logger();

interface PluginModule {
    default: (plugin: Plugin) => void | Promise<void>;
}

export async function loadPlugins(registry: TessellatePluginRegistry) {
    const pluginDir = await checkPluginDirectoryExists();
    const manifests = await getManifestList(pluginDir);

    for (const { folder, manifest } of manifests) {
        try {
            const entryPath = path.join(pluginDir, folder, manifest.main);
            const module = (await import(entryPath)) as PluginModule;

            const plugin = new Plugin(manifest, grantedPermissions(manifest));
            await module.default(plugin);

            registry.loadPlugin(manifest.name, plugin);
            logger.info(
                `Activated plugin "${manifest.name}"@${manifest.version}`,
            );
        } catch (err) {
            logger.error(`Failed to activate plugin "${folder}":`, err);
        }
    }
}

// check that the plugin directory exists before searching for plugins
// returns the plugin directory
async function checkPluginDirectoryExists(): Promise<string> {
    //TODO in the future replace with a config option, might be useful for test cases.
    const PLUGIN_DIR_NAME = "plugins";
    const PLUGIN_DIR = path.join(process.cwd(), PLUGIN_DIR_NAME);

    try {
        if (!existsSync(PLUGIN_DIR)) {
            await mkdir(PLUGIN_DIR);
            logger.debug("Creating Plugin Directory at " + PLUGIN_DIR);
        } else {
            logger.debug("Plugin Directory already exists at " + PLUGIN_DIR);
        }
        return PLUGIN_DIR;
    } catch (err) {
        logger.error("Plugin Startup error:", err);
        process.exit(1);
    }
}
