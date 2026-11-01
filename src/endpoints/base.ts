import { ITessellateApiRouter } from "@/utils/registry/api/apiRegistry";
import express, { Router } from "express";
import { frontendUrl } from "@/config/urls";

const baseRouter: Router = express.Router();

export const baseEndpoint: ITessellateApiRouter = {
    route_path: "/",
    override_default: true,
    version: "v1",
    router: baseRouter,
};

baseRouter.get("/", (req, res) => {
    res.json({ message: "Welcome to the Tessellate POS API" });
});

baseRouter.get("/frontend", (req, res) => {
    res.json({ url: frontendUrl });
});
