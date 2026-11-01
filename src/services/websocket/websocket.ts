import { WebSocket, WebSocketServer } from "ws";
import { Server } from "http";
import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { Logger } from "tslog";
import type { Request } from "express";
import type { Principal } from "@tessellatepos/sdk";
import {
    appEvents,
    type DatabaseEvent,
    type PaymentStatusEvent,
} from "@/services/websocket/events";
import { evaluateHost, normalizeHost } from "@/config/urls";
import { resolvePrincipal } from "@/auth/principal";
import { hasScope } from "@/middleware/authenticate";
import { isOriginAllowed } from "@/middleware/cors";

const logger = new Logger();

/** How often open sockets are re-checked against their credentials. */
export const WS_REVALIDATE_INTERVAL_MS = 60_000;

/** Close code sent when a socket's principal no longer resolves. */
export const WS_SESSION_ENDED_CODE = 4401;
/** Close reason sent with {@link WS_SESSION_ENDED_CODE}. */
export const WS_SESSION_ENDED_REASON = "session ended";

/**
 * A connected client: who it is, and the request headers (session cookie or
 * device token) captured at upgrade so it can be resolved again later. The
 * headers hold credentials and are never logged.
 */
interface Client {
    principal: Principal;
    headers: IncomingHttpHeaders;
}

/** Connected clients. */
const clients = new Map<WebSocket, Client>();

/** The only path that accepts WebSocket upgrades. */
export const WS_PATH = "/ws";

/** Query parameter that carries a device token (browsers cannot set headers). */
export const TOKEN_PARAM = "access_token";

function rejectUpgrade(socket: Duplex, status: string) {
    socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
}

/**
 * Builds the headers a socket is authenticated with: a device token passed
 * as `?access_token=` becomes a bearer Authorization header, and a cookie is
 * only kept from an Origin this deployment serves, so another website cannot
 * open a socket with the visitor's cookie.
 * @param req the upgrade request
 * @returns the headers to resolve a principal from
 */
function upgradeHeaders(req: IncomingMessage): IncomingHttpHeaders {
    const headers = { ...req.headers };
    const token = new URL(req.url ?? "/", "http://localhost").searchParams.get(
        TOKEN_PARAM,
    );
    if (token && !headers.authorization) {
        headers.authorization = `Bearer ${token}`;
    }
    if (
        headers.cookie &&
        headers.origin &&
        !isOriginAllowed(headers.origin, headers.host)
    ) {
        delete headers.cookie;
    }
    return headers;
}

async function resolveHeaders(
    headers: IncomingHttpHeaders,
): Promise<Principal | null> {
    try {
        return await resolvePrincipal({
            headers,
            surface: "internal",
        } as unknown as Request);
    } catch {
        return null;
    }
}

/**
 * Resolves who is opening a WebSocket: a better-auth session cookie, or a
 * device token passed as `?access_token=` (or the usual Authorization
 * header). A cookie is only honoured from an Origin this deployment serves.
 * The token is never logged.
 * @param req the upgrade request
 * @returns the principal, or null when unauthenticated
 */
export async function authenticateUpgrade(
    req: IncomingMessage,
): Promise<Principal | null> {
    return resolveHeaders(upgradeHeaders(req));
}

function endSession(ws: WebSocket) {
    clients.delete(ws);
    ws.close(WS_SESSION_ENDED_CODE, WS_SESSION_ENDED_REASON);
}

/**
 * Closes every open socket belonging to a principal (code 4401, "session
 * ended"). Call when that principal's access is revoked: a device token
 * revoked, a user banned or given a new password.
 * @param principalId the user id or device id
 * @returns how many sockets were closed
 */
export function closeSocketsForPrincipal(principalId: string): number {
    let closed = 0;
    for (const [ws, client] of clients) {
        if (client.principal.id === principalId) {
            endSession(ws);
            closed++;
        }
    }
    return closed;
}

/**
 * Re-resolves every open socket's principal from the credentials captured at
 * upgrade, closing sockets whose principal no longer resolves. A socket that
 * still resolves takes on its current principal (role or location changes).
 * @returns how many sockets were closed
 */
export async function revalidateSockets(): Promise<number> {
    let closed = 0;
    await Promise.all(
        [...clients].map(async ([ws, client]) => {
            const principal = await resolveHeaders(client.headers);
            if (!clients.has(ws)) return;
            if (principal) {
                client.principal = principal;
            } else {
                endSession(ws);
                closed++;
            }
        }),
    );
    return closed;
}

type SocketEvent = DatabaseEvent | PaymentStatusEvent;

/**
 * Whether a principal may receive an event. Order and payment events need
 * `orders:read` and, when the event names a location, a principal that may
 * see it; device events need `devices:read`. Events without a location go to
 * every principal holding the scope.
 * @param principal the connected client
 * @param event the event about to be sent
 * @returns true when the client may see it
 */
export function canReceive(principal: Principal, event: SocketEvent): boolean {
    if (event.type === "device_paired") {
        return hasScope(principal, "devices:read");
    }
    if (event.type === "catalog_updated") {
        if (!hasScope(principal, "catalog:read")) return false;
    } else if (!hasScope(principal, "orders:read")) {
        return false;
    }
    const locationId = event.payload.locationId;
    if (!locationId || principal.location_ids === "all") return true;
    return principal.location_ids.includes(locationId);
}

function broadcast(event: SocketEvent) {
    const message = JSON.stringify(event);
    for (const [ws, { principal }] of clients) {
        if (ws.readyState === WebSocket.OPEN && canReceive(principal, event)) {
            ws.send(message);
        }
    }
}

/**
 * Attaches the authenticated WebSocket endpoint to an HTTP server, and starts
 * re-checking open sockets on an interval (stopped when the server closes).
 * @param server the HTTP server
 * @param revalidateIntervalMs how often to re-check open sockets
 * @returns the WebSocket server
 */
export function setupWebSocket(
    server: Server,
    revalidateIntervalMs = WS_REVALIDATE_INTERVAL_MS,
) {
    const wss = new WebSocketServer({ noServer: true });

    let revalidating = false;
    const timer = setInterval(() => {
        if (revalidating) return;
        revalidating = true;
        void revalidateSockets()
            .catch(() => undefined)
            .finally(() => {
                revalidating = false;
            });
    }, revalidateIntervalMs);
    timer.unref();
    server.on("close", () => clearInterval(timer));

    // Upgrades bypass Express, so apply the same host rules here: only /ws,
    // and never on the public host unless admin is exposed there. Then
    // authenticate: no valid session or device token, no socket.
    server.on("upgrade", (req, socket, head) => {
        const { pathname } = new URL(req.url ?? "/", "http://localhost");
        const host = normalizeHost(req.headers.host);
        if (pathname !== WS_PATH) {
            rejectUpgrade(socket, "404 Not Found");
        } else if (evaluateHost(host, pathname) !== "ok") {
            rejectUpgrade(socket, "404 Not Found");
        } else {
            const headers = upgradeHeaders(req);
            void resolveHeaders(headers).then((principal) => {
                if (socket.destroyed) return;
                if (!principal) {
                    rejectUpgrade(socket, "401 Unauthorized");
                    return;
                }
                wss.handleUpgrade(req, socket, head, (ws) => {
                    clients.set(ws, { principal, headers });
                    wss.emit("connection", ws, req);
                });
            });
        }
    });

    wss.on("connection", (ws: WebSocket) => {
        logger.debug("WebSocket client connected");

        ws.send(JSON.stringify({ type: "connection", payload: null }));

        ws.on("close", () => {
            logger.debug("WebSocket client disconnected");
            clients.delete(ws);
        });

        ws.on("error", (error) => {
            logger.error("WebSocket error:", error);
            clients.delete(ws);
        });
    });

    appEvents.on("db_update", broadcast);
    appEvents.on("payment_status", broadcast);

    logger.info("WebSocket server initialized");
    return wss;
}
