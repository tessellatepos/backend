import express, { Request, Response, Router } from "express";
import { Logger } from "tslog";
import { requireScope } from "@/middleware/authenticate";
import { ITessellateApiRouter } from "@/utils/registry/api/apiRegistry";
import {
    SetupError,
    completeSetup,
    createOwner,
    createStore,
    getSetupStatus,
} from "@/services/setup";
import { isRateLimited, recordFailure } from "@/services/setupToken";

const setupRouter: Router = express.Router();

const logger = new Logger();

export const setupv1Endpoint: ITessellateApiRouter = {
    route_path: "/setup",
    version: "v1",
    router: setupRouter,
};

function body(req: Request): Record<string, unknown> {
    return req.body && typeof req.body === "object" ? req.body : {};
}

function fail(res: Response, err: unknown, what: string) {
    if (err instanceof SetupError) {
        res.status(err.status).json({
            message: err.message,
            ...(err.code ? { code: err.code } : {}),
            ...(err.missing ? { missing: err.missing } : {}),
        });
        return;
    }
    logger.error(`${what} failed:`, err);
    res.status(500).json({ message: `${what} failed` });
}

// Public and read-only; stays available after setup completes.
setupRouter.get("/status", async (_req: Request, res: Response) => {
    try {
        res.json(await getSetupStatus());
    } catch (err) {
        fail(res, err, "Reading setup status");
    }
});

// Public only while no user exists (createOwner answers 409 afterwards).
// Failed token attempts are rate limited per client IP.
setupRouter.post("/owner", async (req: Request, res: Response) => {
    const key = req.ip ?? "unknown";
    if (isRateLimited(key)) {
        res.status(429).json({ message: "Too many failed attempts" });
        return;
    }
    try {
        const { user, setCookies } = await createOwner(
            body(req).setupToken,
            body(req),
        );
        for (const cookie of setCookies) res.append("set-cookie", cookie);
        res.status(201).json({ user });
    } catch (err) {
        if (err instanceof SetupError && err.status === 403) {
            recordFailure(key);
        }
        fail(res, err, "Creating the owner");
    }
});

setupRouter.post(
    "/store",
    requireScope("settings:admin"),
    async (req: Request, res: Response) => {
        try {
            res.status(201).json(await createStore(body(req)));
        } catch (err) {
            fail(res, err, "Creating the store");
        }
    },
);

setupRouter.post(
    "/complete",
    requireScope("settings:admin"),
    async (_req: Request, res: Response) => {
        try {
            await completeSetup();
            res.json({ done: true });
        } catch (err) {
            fail(res, err, "Completing setup");
        }
    },
);
