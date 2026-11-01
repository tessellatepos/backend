/**
 * Runs one gateway operation: the middleware chain, then validation, the
 * location rule, the in-process call and response validation. Every error
 * leaves in the gateway's `{ message, code }` shape.
 */
import type { Request, RequestHandler, Response } from "express";
import { Logger } from "tslog";
import { bigintReplacer } from "@tessellatepos/sdk";
import type { GatewayEntry } from "@/gateway/registry";
import { invokeEntry, type CapturedResponse } from "@/gateway/invoke";
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

function parseIfJson(body: unknown): unknown {
    if (typeof body !== "string") return body;
    try {
        return JSON.parse(body);
    } catch {
        return undefined;
    }
}

/**
 * Turns a captured internal answer into the gateway's answer.
 * @param res the gateway response
 * @param entry the operation that produced it
 * @param result what the handler answered
 */
function relay(res: Response, entry: GatewayEntry, result: CapturedResponse) {
    if (result.status >= 400) {
        // Internal failures keep their status; 5xx is always generic.
        sendGatewayError(
            res,
            result.status,
            codeFor(result.status),
            result.status >= 500
                ? "Internal error"
                : messageOf(result.body, result.status),
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
    res.status(result.status)
        .set("Content-Type", "application/json")
        .send(JSON.stringify(parsed.data, bigintReplacer));
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
        try {
            const result = await invokeEntry(entry, req, {
                params,
                query: isQuery ? internal : undefined,
                body: isQuery ? undefined : internal,
            });
            relay(res, entry, result);
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
