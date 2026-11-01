/**
 * Runs one gateway operation: the middleware chain, then validation, the
 * location rule, the in-process call and response validation. Every error
 * leaves in the gateway's `{ message, code }` shape.
 */
import { createHash } from "node:crypto";
import type { Request, RequestHandler, Response } from "express";
import { Logger } from "tslog";
import { bigintReplacer } from "@tessellatepos/sdk";
import type { GatewayEntry } from "@/gateway/registry";
import { invokeEntry, type CapturedResponse } from "@/gateway/invoke";
import { GUARDED_CREATE_OPERATION, guardedCreate } from "@/gateway/createGuard";
import {
    decideLocation,
    gatewayAudit,
    gatewayOrigin,
    gatewayRateLimit,
    gatewayScope,
    requireGatewayCredential,
    sendGatewayError,
} from "@/gateway/guards";

const logger = new Logger({ name: "gateway" });

/** Maps an internal failure status to a stable gateway code. */
function codeFor(status: number): string {
    switch (status) {
        case 400:
            return "invalid_request";
        case 403:
            return "forbidden";
        case 404:
            return "not_found";
        case 409:
            return "conflict";
        default:
            return status >= 500 ? "internal_error" : "request_failed";
    }
}

function messageOf(body: unknown, status: number): string {
    if (
        typeof body === "object" &&
        body !== null &&
        typeof (body as { message?: unknown }).message === "string"
    ) {
        const message = (body as { message: string }).message;
        if (message.length <= 200) return message;
    }
    return status >= 500 ? "Internal error" : "Request failed";
}

const CODE_PATTERN = /^[a-z][a-z0-9_]{1,63}$/;

/**
 * A code a handler chose on purpose (`{ message, code }`). Handlers without
 * one fall back to the generic code for their status.
 * @param body the handler's JSON body
 * @returns the code, or undefined
 */
function handlerCode(body: unknown): string | undefined {
    const code = (body as { code?: unknown } | null)?.code;
    return typeof code === "string" && CODE_PATTERN.test(code)
        ? code
        : undefined;
}

function parseIfJson(body: unknown): unknown {
    if (typeof body !== "string") return body;
    try {
        return JSON.parse(body);
    } catch {
        return undefined;
    }
}

/**
 * Whether an `If-None-Match` header names the current ETag. Weak and strong
 * forms compare equal, as the spec says for this header.
 * @param header the request header
 * @param etag the ETag of the answer about to be sent
 * @returns true when the caller already holds this answer
 */
function matchesEtag(header: string | undefined, etag: string): boolean {
    if (!header) return false;
    const strip = (tag: string) => tag.trim().replace(/^W\//, "");
    return header.split(",").some((tag) => {
        const candidate = strip(tag);
        return candidate === "*" || candidate === etag;
    });
}

/**
 * Turns a captured internal answer into the gateway's answer.
 * @param req the gateway request
 * @param res the gateway response
 * @param entry the operation that produced it
 * @param result what the handler answered
 */
function relay(
    req: Request,
    res: Response,
    entry: GatewayEntry,
    result: CapturedResponse,
) {
    if (result.status >= 400) {
        // Internal failures keep their status. A 5xx is generic unless the
        // handler named a code, which only a deliberate refusal does.
        const code = handlerCode(parseIfJson(result.body));
        const generic = result.status >= 500 && !code;
        sendGatewayError(
            res,
            result.status,
            code ?? codeFor(result.status),
            generic
                ? "Internal error"
                : messageOf(parseIfJson(result.body), result.status),
        );
        return;
    }
    const parsed = entry.operation.response.safeParse(parseIfJson(result.body));
    if (!parsed.success) {
        // Log the paths that failed, never the values.
        const paths = parsed.error.issues.map(
            (i) => i.path.join(".") || "(root)",
        );
        logger.error(
            `Gateway response for ${entry.operation.operationId} does not match its schema at: ${paths.join(", ")}`,
        );
        sendGatewayError(res, 500, "internal_error", "Internal error");
        return;
    }
    const body = JSON.stringify(parsed.data, bigintReplacer);
    if (entry.cacheSeconds !== undefined && result.status === 200) {
        const etag = `"${createHash("sha256").update(body).digest("base64url").slice(0, 27)}"`;
        // The body depends on the credential's locations, so a shared cache
        // must not serve it to another credential.
        res.set("ETag", etag).set(
            "Cache-Control",
            `private, max-age=${entry.cacheSeconds}`,
        );
        res.vary("Authorization");
        if (matchesEtag(req.headers["if-none-match"], etag)) {
            res.status(304).end();
            return;
        }
    }
    res.status(result.status)
        .set("Content-Type", "application/json")
        .send(body);
}

/**
 * The handler for one operation, after its guards.
 * @param entry the operation
 * @returns an Express handler
 */
function runOperation(entry: GatewayEntry): RequestHandler {
    return async (req: Request, res: Response) => {
        const op = entry.operation;
        const principal = req.principal;
        if (!principal) {
            sendGatewayError(res, 401, "unauthorized", "Unauthorized");
            return;
        }
        const isQuery = op.method === "GET" || op.method === "DELETE";
        const raw = isQuery ? req.query : (req.body ?? {});

        let payload: unknown = raw;
        if (op.request) {
            const parsed = op.request.safeParse(raw);
            if (!parsed.success) {
                const paths = parsed.error.issues.map(
                    (i) => i.path.join(".") || "(root)",
                );
                sendGatewayError(
                    res,
                    400,
                    "invalid_request",
                    `Invalid request at: ${paths.join(", ")}`,
                );
                return;
            }
            payload = parsed.data;
        }

        const allowed =
            principal.location_ids === "all" ? [] : principal.location_ids;
        const params = req.params as Record<string, string>;
        const decision = decideLocation(op.location, allowed, {
            params,
            query: isQuery
                ? (payload as Record<string, unknown>)
                : (req.query as Record<string, unknown>),
            body: isQuery ? undefined : payload,
        });
        if (!decision.ok) {
            sendGatewayError(
                res,
                decision.status,
                decision.code,
                decision.message,
            );
            return;
        }
        if (decision.fill) {
            payload = {
                ...(payload as object),
                location_id: decision.fill.value,
            };
        }

        const internal = entry.toInternal ? entry.toInternal(payload) : payload;
        const call = () =>
            invokeEntry(entry, req, {
                params,
                query: isQuery ? internal : undefined,
                body: isQuery ? undefined : internal,
            });
        try {
            const result =
                op.operationId === GUARDED_CREATE_OPERATION
                    ? await guardedCreate(req, res, payload, call)
                    : await call();
            if (result) relay(req, res, entry, result);
        } catch (err) {
            logger.error(`Gateway operation ${op.operationId} failed`, err);
            sendGatewayError(res, 500, "internal_error", "Internal error");
        }
    };
}

/**
 * The full route chain for one operation: audit, credential, origin, scope,
 * rate limit, then the operation itself.
 * @param entry the operation
 * @returns the handlers, in order
 */
export function operationChain(entry: GatewayEntry): RequestHandler[] {
    const { operationId, scope } = entry.operation;
    return [
        gatewayAudit(operationId),
        requireGatewayCredential,
        gatewayOrigin(scope),
        gatewayScope(scope),
        gatewayRateLimit(),
        runOperation(entry),
    ];
}
