import express from "express";
import { Request, Response, Router } from "express";
import { Logger } from "tslog";
import {
    getConfigSystem,
    updateConfigSystem,
} from "@/services/db/configSystem";
import { type IConfigSystem } from "@/types/database";
import { ITessellateApiRouter } from "@/utils/registry/api/apiRegistry";

const configSettingRouter: Router = express.Router();

const logger = new Logger();

export const configSettingsv1Endpoint: ITessellateApiRouter = {
    route_path: "/config/settings",
    version: "v1",
    router: configSettingRouter,
};

configSettingRouter.get("/", async (req: Request, res: Response) => {
    logger.info(`Received GET request for system configuration`);
    const config = await getConfigSystem();
    res.json(config);
});

configSettingRouter.post("/", async (req: Request, res: Response) => {
    logger.info(
        `Received POST request for system configuration with body: ${JSON.stringify(req.body)}`,
    );
    const updatedConfig = req.body as IConfigSystem;
    const persistedConfig = await updateConfigSystem(updatedConfig);
    res.json(persistedConfig);
});
