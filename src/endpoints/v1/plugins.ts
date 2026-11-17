import express, { Router } from "express";
import { existsSync } from "node:fs";
import path from "node:path";
import { ITessellateApiRouter } from "@/utils/registry/api/apiRegistry";
import type { TessellatePluginRegistry } from "@/utils/registry/plugin/pluginRegistry";

const pluginRouter: Router = express.Router();

export const pluginsv1Endpoint: ITessellateApiRouter = {
    route_path: "/plugins-discovery",
    version: "v1",
    router: pluginRouter,
};

// The plugin registry is attached to app.locals in server.ts after plugins
// are loaded. Each handler reads it from the request so we don't need a
// factory or module-level mutable state.
function getPluginRegistry(req: express.Request): TessellatePluginRegistry {
    return (req.app.locals as { pluginRegistry: TessellatePluginRegistry })
        .pluginRegistry;
}

/**
 * GET /api/v1/plugins-discovery
 *
 * Returns the list of installed plugins with their display metadata
 * (description, author, license, homepage, permissions). Each entry includes a
 * `clientEntryUrl` only if the plugin has a built client bundle
 * (dist/client.js) on disk — server-only plugins are listed without one.
 *
 * The frontend uses this to discover which plugins to dynamically import
 * for UI mount rendering.
 */
pluginRouter.get("/", (req, res) => {
    const registry = getPluginRegistry(req);
    const plugins = registry.getPlugins();

    const PLUGIN_DIR = path.join(process.cwd(), "plugins");

    const result = [...plugins.entries()].map(([name, plugin]) => {
        const manifest = plugin.getManifest();
        const clientBundlePath = path.join(
            PLUGIN_DIR,
            name,
            "dist",
            "client.js",
        );

        const hasClientBundle = existsSync(clientBundlePath);

        const author =
            typeof manifest.author === "string"
                ? manifest.author
                : manifest.author?.name;

        return {
            name,
            version: manifest.version,
            description: manifest.description ?? null,
            author: author ?? null,
            license: manifest.license ?? null,
            homepage: manifest.homepage ?? null,
            permissions: manifest.tessellate.permissions,
            clientEntryUrl: hasClientBundle
                ? `/plugins/${name}/assets/client.js`
                : null,
        };
    });

    res.json({ plugins: result });
});
