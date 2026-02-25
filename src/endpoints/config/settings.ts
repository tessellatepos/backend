import express from "express";
import { Request, Response, Router } from "express";
import { Logger } from "tslog";
import { getConfigSystem, updateConfigSystem } from "@/services/db/configSystem";
import { IConfigSystem } from "@tessellate-pos/common/src/types/database";

export const itemRouter: Router = express.Router();

const logger = new Logger();

itemRouter.get("/", async (req: Request, res: Response) => {
	logger.info(`Received GET request for system configuration`);
	const config = await getConfigSystem()
	res.json(config);
});

itemRouter.post("/", async (req: Request, res: Response) => {
	logger.info(`Received POST request for system configuration with body: ${JSON.stringify(req.body)}`);
	const updatedConfig = req.body as IConfigSystem;
	updateConfigSystem(updatedConfig);
	res.json(updatedConfig);
});
