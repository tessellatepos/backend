import type { Express, RequestHandler } from "express";
import { Logger } from "tslog";
import { TessellatePluginApiRegistry } from "@/utils/registry/api/pluginApiRegistry";

const logger = new Logger();

export interface ITessellateApiRouter<R = RequestHandler>  {
    route_path: string;
    override_default?: boolean;
    version: string
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

        logger.debug("Loading Plugin API dispatcher");
        this.app.use("/plugins", this.pluginApiRegistry.dispatch);
    }

    private mountAll() {
        this.routers.forEach((r) => {
            if (r.override_default) {
                logger.debug(`Loading API Router(overriden path): ${r.route_path}@${r.version}`)
                this.app.use(`${r.route_path}`, r.router);
            } else {
                logger.debug(`Loading API Router: ${r.route_path}@${r.version}`);
                this.app.use(`/api/${r.version}/${r.route_path}`, r.router);
            }
        });
    }

    public registerRouter(router: ITessellateApiRouter) {
        this.routers.push(router);
    }
}