import express, { Router } from "express";
import { Logger } from "tslog";

export const squareRouter: Router = express.Router();

const logger = new Logger();

squareRouter.get("/locations", async (req, res) => {
    logger.info("Received GET request for Square locations");
});
