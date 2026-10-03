import { existsSync } from "node:fs";
import path from "node:path";
import type { Express, RequestHandler } from "express";
import { Logger } from "tslog";
import { TessellatePluginApiRegistry } from "@/utils/registry/api/pluginApiRegistry";

const logger = new Logger();

export interface ITessellateApiRouter<R = RequestHandler> {
    route_path: string;
    override_default?: boolean;
    version: string;
    router: R;
}

export class TessellateApiRegistry {
    protected routers: ITessellateApiRouter[];
    protected pluginApiRegistry: TessellatePluginApiRegistry;
    protected app: Express;

    constructor(app: Express, pluginApiRegistry: TessellatePluginApiRegistry) {
        this.app = app;
        this.routers = [];
        this.pluginApiRegistry = pluginApiRegistry;
    }

    public loadRoutes() {
        logger.debug("Loading Tessellate API Routes");
        this.mountAll();

        // Serve plugin client bundles as static assets.
        // /plugins/:pluginName/assets/:filename → plugins/:pluginName/dist/:filename
        // Mounted before the API dispatcher so asset requests are served
        // directly without hitting the route matcher.
        const PLUGIN_DIR = path.join(process.cwd(), "plugins");
        this.app.get(
            "/plugins/:pluginName/assets/:filename",
            (req, res, next) => {
                const { pluginName, filename } = req.params;
                const filePath = path.join(
                    PLUGIN_DIR,
                    pluginName,
                    "dist",
                    filename,
                );
                if (!existsSync(filePath)) {
                    next();
                    return;
                }
                res.sendFile(path.resolve(filePath), (err) => {
                    if (err) next();
                });
            },
        );

        logger.debug("Loading Plugin API dispatcher");
        // Scoped by pluginName so a plugin can only hit its own API mounts.
        this.app.use("/plugins/:pluginName", this.pluginApiRegistry.dispatch);
    }

    private mountAll() {
        this.routers.forEach((r) => {
            if (r.override_default) {
                logger.debug(
                    `Loading API Router(overriden path): ${r.route_path}@${r.version}`,
                );
                this.app.use(`${r.route_path}`, r.router);
            } else {
                logger.debug(
                    `Loading API Router: ${r.route_path}@${r.version}`,
                );
                this.app.use(`/api/${r.version}${r.route_path}`, r.router);
            }
        });
    }

    public registerRouter(router: ITessellateApiRouter) {
        this.routers.push(router);
    }
}
