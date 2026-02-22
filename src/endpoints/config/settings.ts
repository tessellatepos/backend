import express from "express";
import { Request, Response, Router } from "express";
import {Logger} from "tslog";
import {getConfigSystem} from "../../services/db/configSystem";

export const itemRouter: Router = express.Router();

const logger = new Logger();

itemRouter.get("/", async (req: Request, res: Response) => {
    const config = await getConfigSystem()
    res.json(config);
});

itemRouter.post("/", async (req: Request, res: Response) => {
    // Placeholder: implement logic to update config system settings based on request body
    res.json({ message: "Config system update endpoint - not implemented yet" });
});