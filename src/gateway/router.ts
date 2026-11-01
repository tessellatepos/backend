/**
 * The gateway's router. It is mounted once at /gateway/v1 (see routes.ts) and
 * populated from the registry at startup. Populating replaces what was there,
 * so mounting twice in one process (tests) does not duplicate routes.
 */
import express, { type Request, type Response, type Router } from "express";
import { Logger } from "tslog";
import { listAllowedOrigins } from "@/services/credentials";
import { requireGatewayCredential, sendGatewayError } from "@/gateway/guards";
import { GATEWAY_PREFIX, type GatewayRegistry } from "@/gateway/registry";
import { operationChain } from "@/gateway/operation";
import { buildOpenApiDocument } from "@/gateway/openapi";
import { docsPage } from "@/gateway/docs";

const logger = new Logger({ name: "gateway" });

/** The router mounted at /gateway/v1. */
export const gatewayRouter: Router = express.Router();

const PREFLIGHT_HEADERS = "Authorization, Content-Type, Idempotency-Key";

/**
 * Answers a CORS preflight when the origin belongs to a live credential.
 * Any other preflight gets 204 without the allow-origin header, which the
 * browser treats as refused. Non-preflight requests pass through.
 * @param req the request
 * @param res the response
 * @param next continues the chain
 */
async function preflight(req: Request, res: Response, next: () => void) {
    if (req.method !== "OPTIONS") {
        next();
        return;
    }
    res.set("Vary", "Origin");
    try {
        const origin = req.headers.origin;
        if (origin && (await listAllowedOrigins()).has(origin)) {
            res.set("Access-Control-Allow-Origin", origin);
            res.set(
                "Access-Control-Allow-Methods",
                "GET, POST, PUT, PATCH, DELETE",
            );
            res.set("Access-Control-Allow-Headers", PREFLIGHT_HEADERS);
            res.set("Access-Control-Max-Age", "600");
        }
        res.status(204).end();
    } catch (err) {
        logger.error("Could not answer a gateway preflight", err);
        sendGatewayError(
            res,
            503,
            "unavailable",
            "The gateway is temporarily unavailable",
        );
    }
}

/**
 * Replaces the router's routes with the registry's operations.
 * @param registry every declared operation
 */
export function populateGatewayRouter(registry: GatewayRegistry): void {
    // express keeps routes in `stack`; replacing it is how a router is reset.
    (gatewayRouter as unknown as { stack: unknown[] }).stack.splice(0);

    gatewayRouter.use((req, res, next) => {
        void preflight(req, res, next);
    });

    // The document and the reference are for credential holders only.
    gatewayRouter.get("/openapi.json", requireGatewayCredential, (req, res) => {
        const scopes = req.principal?.scopes ?? [];
        res.set("Content-Type", "application/json");
        res.send(JSON.stringify(buildOpenApiDocument(registry, scopes)));
    });
    gatewayRouter.get("/docs", requireGatewayCredential, (_req, res) => {
        res.type("html").send(docsPage());
    });

    for (const entry of registry.list()) {
        const path = entry.publicPath.slice(GATEWAY_PREFIX.length) || "/";
        const method = entry.operation.method.toLowerCase() as
            "get" | "post" | "put" | "patch" | "delete";
        gatewayRouter[method](path, ...operationChain(entry));
    }

    // Deny by default: anything not declared is a 404, however it is spelled.
    gatewayRouter.use((_req, res) => {
        sendGatewayError(res, 404, "not_found", "Not found");
    });
}
