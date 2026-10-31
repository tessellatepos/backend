/**
 * The gateway's middleware chain. Each guard answers with the same error
 * shape, `{ message, code }`, and never with a body, a secret or a stack.
 * Order (see gateway.md): credential, origin, scope, rate limit, validation
 * and location (in the operation runner), then the audit line.
 */
import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { GatewayLocation } from "@tessellatepos/plugin-sdk";
import type { Scope } from "@tessellatepos/sdk";
import { Logger } from "tslog";
import { hasScope } from "@/middleware/authenticate";
import { takeToken } from "@/gateway/rateLimit";

const logger = new Logger({ name: "gateway" });

/** Per-IP budget for publishable (client id only) calls, per minute. */
export const PUBLISHABLE_PER_IP_PER_MINUTE = 60;

/** The gateway's error body. */
export interface GatewayErrorBody {
    message: string;
    code: string;
}

/**
 * Sends a gateway error.
 * @param res the response
 * @param status the HTTP status
 * @param code a stable machine-readable code
 * @param message a short human message, safe to show
 */
export function sendGatewayError(
    res: Response,
    status: number,
    code: string,
    message: string,
): void {
    const body: GatewayErrorBody = { message, code };
    res.status(status).json(body);
}

/** Whether a scope only reads. */
export function isReadScope(scope: Scope): boolean {
    return scope.endsWith(":read");
}

/**
 * 401 unless the request carries an authenticated gateway credential.
 * @param req the request
 * @param res the response
 * @param next continues the chain
 */
export const requireGatewayCredential: RequestHandler = (req, res, next) => {
    if (!req.principal || !req.gatewayCredential) {
        res.set("WWW-Authenticate", 'Basic realm="Tessellate gateway"');
        sendGatewayError(res, 401, "unauthorized", "Unauthorized");
        return;
    }
    next();
};

/** Per-IP budget for the public docs and OpenAPI document, per minute. */
export const PUBLIC_DOCS_PER_IP_PER_MINUTE = 60;

/**
 * Rate limits the public docs routes per IP. Fails closed (503) when the
 * limiter is unavailable.
 * @param req the request
 * @param res the response
 * @param next continues the chain
 */
export const limitPublicDocs: RequestHandler = async (req, res, next) => {
    try {
        const result = await takeToken(
            `gw:rl:docs:${req.ip ?? "unknown"}`,
            PUBLIC_DOCS_PER_IP_PER_MINUTE,
            PUBLIC_DOCS_PER_IP_PER_MINUTE,
        );
        if (!result.allowed) {
            limited(res, result.retryAfterMs);
            return;
        }
    } catch (err) {
        logger.error("Rate limiter unavailable", err);
        sendGatewayError(res, 503, "unavailable", "Service unavailable");
        return;
    }
    next();
};

/**
 * The browser origin rule. A credential's origins allow CORS for that origin
 * only. A publishable call (client id only) must come from an allowed origin
 * and may only read. A call with the secret is server-to-server and is not
 * limited by origin.
 * @param scope the operation's scope
 * @returns an Express middleware
 */
export function gatewayOrigin(scope: Scope): RequestHandler {
    return (req, res, next) => {
        const credential = req.gatewayCredential;
        if (!credential) {
            sendGatewayError(res, 401, "unauthorized", "Unauthorized");
            return;
        }
        const origin = req.headers.origin;
        const fromAllowedOrigin =
            typeof origin === "string" && credential.origins.includes(origin);
        if (fromAllowedOrigin) {
            res.set("Access-Control-Allow-Origin", origin);
            res.vary("Origin");
        }
        if (credential.publishable) {
            if (!fromAllowedOrigin) {
                sendGatewayError(
                    res,
                    403,
                    "origin_not_allowed",
                    "This client id may only be used from an allowed origin",
                );
                return;
            }
            if (!isReadScope(scope)) {
                sendGatewayError(
                    res,
                    403,
                    "secret_required",
                    "Writes need the client secret",
                );
                return;
            }
        }
        next();
    };
}

/**
 * 403 unless the principal holds the operation's scope.
 * @param scope the required scope
 * @returns an Express middleware
 */
export function gatewayScope(scope: Scope): RequestHandler {
    return (req, res, next) => {
        if (!req.principal || !hasScope(req.principal, scope)) {
            sendGatewayError(res, 403, "missing_scope", "Forbidden");
            return;
        }
        next();
    };
}

/**
 * Rate limits: the credential's own budget, and for publishable calls a
 * per-IP budget too. A Redis failure fails closed with 503.
 * @returns an Express middleware
 */
export function gatewayRateLimit(): RequestHandler {
    return async (req, res, next) => {
        const credential = req.gatewayCredential;
        if (!credential) {
            sendGatewayError(res, 401, "unauthorized", "Unauthorized");
            return;
        }
        try {
            const perMinute = credential.rate_limit_per_minute;
            const own = await takeToken(
                `gw:rl:cred:${credential.id}`,
                perMinute,
                perMinute,
            );
            if (!own.allowed) {
                limited(res, own.retryAfterMs);
                return;
            }
            if (credential.publishable) {
                const ip = req.ip ?? "unknown";
                const perIp = await takeToken(
                    `gw:rl:ip:${ip}`,
                    PUBLISHABLE_PER_IP_PER_MINUTE,
                    PUBLISHABLE_PER_IP_PER_MINUTE,
                );
                if (!perIp.allowed) {
                    limited(res, perIp.retryAfterMs);
                    return;
                }
            }
        } catch (err) {
            logger.error("Rate limiter unavailable", err);
            sendGatewayError(
                res,
                503,
                "unavailable",
                "The gateway is temporarily unavailable",
            );
            return;
        }
        next();
    };
}

function limited(res: Response, retryAfterMs: number): void {
    res.set("Retry-After", String(Math.max(1, Math.ceil(retryAfterMs / 1000))));
    sendGatewayError(res, 429, "rate_limited", "Too many requests");
}

/** The outcome of checking a request's location. */
export type LocationDecision =
    | { ok: true; fill?: { field: "body" | "query"; value: string } }
    | { ok: false; status: number; code: string; message: string };

/**
 * Checks the location an operation acts on against the credential's
 * locations. A missing location is filled when the credential has exactly one
 * and refused otherwise. Run after the request has been validated, so a body
 * field is the parsed value.
 * @param location where the location id travels for this operation
 * @param allowed the credential's location ids
 * @param sources the request parts the id may come from
 * @param sources.params route parameters
 * @param sources.query parsed query string
 * @param sources.body the validated body
 * @returns the decision
 */
export function decideLocation(
    location: GatewayLocation,
    allowed: readonly string[],
    sources: {
        params: Record<string, string | undefined>;
        query: Record<string, unknown>;
        body: unknown;
    },
): LocationDecision {
    if (location === "none") return { ok: true };
    const bodyId =
        typeof sources.body === "object" && sources.body !== null
            ? (sources.body as Record<string, unknown>).location_id
            : undefined;
    const present =
        location === "path"
            ? sources.params.locationId
            : location === "query"
              ? sources.query.location_id
              : bodyId;
    if (typeof present === "string" && present !== "") {
        if (!allowed.includes(present)) {
            return {
                ok: false,
                status: 403,
                code: "location_forbidden",
                message: "Forbidden",
            };
        }
        return { ok: true };
    }
    if (location === "path") {
        return {
            ok: false,
            status: 400,
            code: "location_required",
            message: "A location is required",
        };
    }
    if (allowed.length === 1) {
        return {
            ok: true,
            fill: { field: location, value: allowed[0] },
        };
    }
    return {
        ok: false,
        status: 400,
        code: "location_required",
        message: "location_id is required for this credential",
    };
}

/**
 * The audit line for one call: who, what, outcome, latency. It never holds
 * a body, a header or a secret.
 * @param info the facts about the call
 * @param info.credentialId the client id
 * @param info.operationId the operation
 * @param info.status the HTTP status sent
 * @param info.latencyMs time taken
 * @returns the line
 */
export function auditLine(info: {
    credentialId: string;
    operationId: string;
    status: number;
    latencyMs: number;
}): string {
    return `gateway credential=${info.credentialId} operation=${info.operationId} status=${info.status} latency_ms=${info.latencyMs}`;
}

/**
 * Writes one audit line when the response finishes.
 * @param operationId the operation being called
 * @returns an Express middleware
 */
export function gatewayAudit(operationId: string): RequestHandler {
    return (req: Request, res: Response, next: NextFunction) => {
        const started = Date.now();
        res.on("finish", () => {
            logger.info(
                auditLine({
                    credentialId: req.gatewayCredential?.id ?? "anonymous",
                    operationId,
                    status: res.statusCode,
                    latencyMs: Date.now() - started,
                }),
            );
        });
        next();
    };
}
