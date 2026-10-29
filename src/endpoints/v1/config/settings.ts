import express from "express";
import { Request, Response, Router } from "express";
import { Logger } from "tslog";
import {
    getConfigSystem,
    updateConfigSystem,
} from "@/services/db/configSystem";
import { type IConfigSystem } from "@/types/database";
import { requireScope } from "@/middleware/authenticate";
import { ITessellateApiRouter } from "@/utils/registry/api/apiRegistry";

const configSettingRouter: Router = express.Router();

const logger = new Logger();

export const configSettingsv1Endpoint: ITessellateApiRouter = {
    route_path: "/config/settings",
    version: "v1",
    router: configSettingRouter,
};

configSettingRouter.get(
    "/",
    requireScope("settings:read"),
    async (req: Request, res: Response) => {
        logger.info(`Received GET request for system configuration`);
        const config = await getConfigSystem();
        // The encrypted Square tokens never leave the server, even to settings:read.
        const safe: Record<string, unknown> | null = config && { ...config };
        delete safe?.encryptedAccessToken;
        delete safe?.encryptedRefreshToken;
        res.json(safe);
    },
);

configSettingRouter.post(
    "/",
    requireScope("settings:admin"),
    async (req: Request, res: Response) => {
        logger.info(
            `Received POST request for system configuration with body: ${JSON.stringify(req.body)}`,
        );
        const updatedConfig = req.body as IConfigSystem;
        const persistedConfig = await updateConfigSystem(updatedConfig);
        res.json(persistedConfig);
    },
);
