import { match, type MatchFunction } from "path-to-regexp";
import type { RequestHandler } from "express";
import type {
    PluginApiMountDefinition,
    PluginApiMethod,
    PluginApiRequest,
} from "@tessellatepos/plugin-sdk";

interface RegisteredRoute {
    pluginName: string;
    method: PluginApiMethod;
    matcher: MatchFunction<Record<string, string>>;
    handler: PluginApiMountDefinition["handler"];
}

export class TessellatePluginApiRegistry {
    private routes: RegisteredRoute[] = [];

    public register(pluginName: string, mount: PluginApiMountDefinition) {
        this.routes.push({
            pluginName,
            method: mount.method,
            matcher: match(mount.route),
            handler: mount.handler,
        });
    }

    public unregister(pluginName: string) {
        this.routes = this.routes.filter((r) => r.pluginName !== pluginName);
    }

    public dispatch: RequestHandler = async (req, res, next) => {
        for (const route of this.routes) {
            if (route.method !== req.method) continue;
            const matched = route.matcher(req.path);
            if (!matched) continue;

            const apiReq: PluginApiRequest = {
                params: matched.params,
                query: req.query as Record<string, string>,
                body: req.body,
            };
            // const ctx = buildPluginServerContext(req); // db/hooks/session for this plugin

            const response = await route.handler(apiReq, ctx);
            res.status(response.status ?? 200).json(response.body);
            return;
        }
        next(); // no plugin claimed this request
    };
}
