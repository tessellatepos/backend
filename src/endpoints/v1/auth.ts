import { auth } from "@/services/auth";
import { ITessellateApiRouter } from "@/utils/registry/api/apiRegistry";
import { toNodeHandler } from "better-auth/node";
import express from "express";
import { Request, Response, Router } from "express";

const authRouter: Router = express.Router();

export const authv1Endpoint: ITessellateApiRouter = {
    route_path: "/auth",
    version: "v1",
    router: authRouter,
};

authRouter.all("/*splat", toNodeHandler(auth));
