import express, { type Request, type Response, Router } from "express";
import { Logger } from "tslog";
import type { ApiCredentialInput } from "@tessellatepos/sdk";
import { CORE_SCOPES } from "@tessellatepos/sdk";
import type { TessellatePluginRegistry } from "@/utils/registry/plugin/pluginRegistry";
import { requireScope } from "@/middleware/authenticate";
import { listDeliveries } from "@/services/db/webhookDeliveries";
import { replayDelivery } from "@/gateway/webhooks/dispatch";
import { ITessellateApiRouter } from "@/utils/registry/api/apiRegistry";
import {
    CredentialNotFoundError,
    CredentialValidationError,
    createCredential,
    getCredential,
    listCredentials,
    revokeCredential,
    rotateSecret,
    rotateWebhookSecret,
    updateCredential,
} from "@/services/credentials";

const credentialRouter: Router = express.Router();

const logger = new Logger();

export const credentialsv1Endpoint: ITessellateApiRouter = {
    route_path: "/credentials",
    version: "v1",
    router: credentialRouter,
};

/** The fields a PATCH may change. Secrets are changed only by rotation. */
const EDITABLE = [
    "name",
    "scopes",
    "location_ids",
    "rate_limit_per_minute",
    "expires_at",
    "origins",
    "webhook_url",
] as const;

function sendError(res: Response, err: unknown, action: string): void {
    if (err instanceof CredentialValidationError) {
        res.status(400).json({ message: err.message });
    } else if (err instanceof CredentialNotFoundError) {
        res.status(404).json({ message: err.message });
    } else {
        logger.error(`Failed to ${action} credential`, err);
        res.status(500).json({ message: `Failed to ${action} credential` });
    }
}

function bodyOf(req: Request): Record<string, unknown> {
    const body: unknown = req.body ?? {};
    return typeof body === "object" && body !== null && !Array.isArray(body)
        ? (body as Record<string, unknown>)
        : {};
}

credentialRouter.get(
    "/",
    requireScope("credentials:admin"),
    async (_req: Request, res: Response) => {
        try {
            res.json(await listCredentials());
        } catch (err) {
            sendError(res, err, "list");
        }
    },
);

// The scopes an owner can grant: the core ones a credential may hold, plus
// what loaded plugins declared in tessellate.gatewayScopes. Before "/:id".
credentialRouter.get(
    "/scopes",
    requireScope("credentials:admin"),
    (req: Request, res: Response) => {
        const plugins = (
            req.app.locals as { pluginRegistry?: TessellatePluginRegistry }
        ).pluginRegistry;
        res.json({
            core: CORE_SCOPES,
            plugin: plugins?.gatewayScopes() ?? [],
        });
    },
);

credentialRouter.post(
    "/",
    requireScope("credentials:admin"),
    async (req: Request, res: Response) => {
        const userId = req.principal?.id;
        if (!userId) {
            res.status(401).json({ message: "Unauthorized" });
            return;
        }
        try {
            const created = await createCredential(
                bodyOf(req) as unknown as ApiCredentialInput,
                userId,
            );
            res.status(201).json(created);
        } catch (err) {
            sendError(res, err, "create");
        }
    },
);

credentialRouter.get(
    "/:id",
    requireScope("credentials:admin"),
    async (req: Request<{ id: string }>, res: Response) => {
        try {
            const credential = await getCredential(req.params.id);
            if (!credential) {
                res.status(404).json({ message: "Credential not found" });
                return;
            }
            res.json(credential);
        } catch (err) {
            sendError(res, err, "fetch");
        }
    },
);

credentialRouter.patch(
    "/:id",
    requireScope("credentials:admin"),
    async (req: Request<{ id: string }>, res: Response) => {
        const body = bodyOf(req);
        const unknown = Object.keys(body).filter(
            (key) => !(EDITABLE as readonly string[]).includes(key),
        );
        if (unknown.length > 0) {
            res.status(400).json({
                message: `Cannot change: ${unknown.join(", ")}`,
            });
            return;
        }
        try {
            res.json(
                await updateCredential(
                    req.params.id,
                    body as Partial<ApiCredentialInput>,
                ),
            );
        } catch (err) {
            sendError(res, err, "update");
        }
    },
);

credentialRouter.post(
    "/:id/rotate",
    requireScope("credentials:admin"),
    async (req: Request<{ id: string }>, res: Response) => {
        const overlap = bodyOf(req).overlap_seconds ?? 0;
        try {
            const rotated = await rotateSecret(
                req.params.id,
                typeof overlap === "number" ? overlap : Number.NaN,
            );
            res.json({ ...rotated, client_id: rotated.credential.id });
        } catch (err) {
            sendError(res, err, "rotate");
        }
    },
);

credentialRouter.post(
    "/:id/rotate-webhook-secret",
    requireScope("credentials:admin"),
    async (req: Request<{ id: string }>, res: Response) => {
        try {
            res.json(await rotateWebhookSecret(req.params.id));
        } catch (err) {
            sendError(res, err, "rotate");
        }
    },
);

credentialRouter.post(
    "/:id/revoke",
    requireScope("credentials:admin"),
    async (req: Request<{ id: string }>, res: Response) => {
        try {
            res.json(await revokeCredential(req.params.id));
        } catch (err) {
            sendError(res, err, "revoke");
        }
    },
);

credentialRouter.get(
    "/:id/deliveries",
    requireScope("credentials:admin"),
    async (req: Request<{ id: string }>, res: Response) => {
        try {
            const rows = await listDeliveries(req.params.id, 100);
            res.json(
                rows.map((row) => ({
                    id: row.id,
                    event_id: row.event_id,
                    type: row.event_type,
                    status: row.status,
                    attempts: row.attempts,
                    last_status_code: row.last_status_code,
                    last_error: row.last_error,
                    replay_of: row.replay_of,
                    created_at: row.created_at.toISOString(),
                    delivered_at: row.delivered_at?.toISOString() ?? null,
                    body: JSON.parse(row.body),
                })),
            );
        } catch (err) {
            sendError(res, err, "list deliveries of");
        }
    },
);

credentialRouter.post(
    "/:id/deliveries/:deliveryId/replay",
    requireScope("credentials:admin"),
    async (req: Request<{ id: string; deliveryId: string }>, res: Response) => {
        try {
            const row = await replayDelivery(
                req.params.id,
                req.params.deliveryId,
            );
            if (!row) {
                res.status(404).json({ message: "Delivery not found" });
                return;
            }
            res.status(201).json({
                id: row.id,
                status: row.status,
                replay_of: row.replay_of,
            });
        } catch (err) {
            sendError(res, err, "replay a delivery of");
        }
    },
);
