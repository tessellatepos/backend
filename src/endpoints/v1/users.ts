import express, { Request, Response, Router } from "express";
import { Logger } from "tslog";
import { requireScope } from "@/middleware/authenticate";
import { ITessellateApiRouter } from "@/utils/registry/api/apiRegistry";
import {
    UserError,
    createUser,
    listUsers,
    resetPassword,
    updateUser,
} from "@/services/users";

const userRouter: Router = express.Router();

const logger = new Logger();

export const usersv1Endpoint: ITessellateApiRouter = {
    route_path: "/users",
    version: "v1",
    router: userRouter,
};

// Owner only today (users:admin). Bodies and logs never carry passwords.
userRouter.use(requireScope("users:admin"));

function body(req: Request): Record<string, unknown> {
    return req.body && typeof req.body === "object" ? req.body : {};
}

function fail(res: Response, err: unknown, what: string) {
    if (err instanceof UserError) {
        res.status(err.status).json({
            message: err.message,
            ...(err.code ? { code: err.code } : {}),
        });
        return;
    }
    logger.error(
        `${what} failed:`,
        err instanceof Error ? err.message : "unknown error",
    );
    res.status(500).json({ message: `${what} failed` });
}

const first = (value: unknown) =>
    typeof value === "string" ? value : undefined;

userRouter.get("/", async (req: Request, res: Response) => {
    try {
        const raw = first(req.query.limit);
        if (raw !== undefined && !/^\d+$/.test(raw)) {
            throw new UserError(400, "limit must be an integer");
        }
        res.json(
            await listUsers(
                raw === undefined ? undefined : Number(raw),
                first(req.query.cursor),
            ),
        );
    } catch (err) {
        fail(res, err, "Listing users");
    }
});

userRouter.post("/", async (req: Request, res: Response) => {
    try {
        res.status(201).json(await createUser(body(req)));
    } catch (err) {
        fail(res, err, "Creating the user");
    }
});

userRouter.patch(
    "/:id",
    async (req: Request<{ id: string }>, res: Response) => {
        try {
            res.json(
                await updateUser(
                    req.principal?.id ?? "",
                    req.params.id,
                    body(req),
                ),
            );
        } catch (err) {
            fail(res, err, "Updating the user");
        }
    },
);

userRouter.post(
    "/:id/password",
    async (req: Request<{ id: string }>, res: Response) => {
        try {
            await resetPassword(req.params.id, body(req).password);
            res.status(204).end();
        } catch (err) {
            fail(res, err, "Resetting the password");
        }
    },
);
