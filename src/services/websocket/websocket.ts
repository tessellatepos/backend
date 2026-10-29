import { WebSocket, WebSocketServer } from "ws";
import { Server } from "http";
import type { IncomingMessage } from "node:http";
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

/** Connected clients and who each one is. */
const clients = new Map<WebSocket, Principal>();

/** The only path that accepts WebSocket upgrades. */
export const WS_PATH = "/ws";

/** Query parameter that carries a device token (browsers cannot set headers). */
export const TOKEN_PARAM = "access_token";

function rejectUpgrade(socket: Duplex, status: string) {
    socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
}

/**
 * Resolves who is opening a WebSocket: a better-auth session cookie, or a
 * device token passed as `?access_token=` (or the usual Authorization
 * header). A cookie is only honoured from an Origin this deployment serves,
 * so another website cannot open a socket with the visitor's cookie.
 * The token is never logged.
 * @param req the upgrade request
 * @returns the principal, or null when unauthenticated
 */
export async function authenticateUpgrade(
    req: IncomingMessage,
): Promise<Principal | null> {
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
    try {
        return await resolvePrincipal({
            headers,
            surface: "internal",
        } as unknown as Request);
    } catch {
        return null;
    }
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
    if (!hasScope(principal, "orders:read")) return false;
    const locationId = event.payload.locationId;
    if (!locationId || principal.location_ids === "all") return true;
    return principal.location_ids.includes(locationId);
}

function broadcast(event: SocketEvent) {
    const message = JSON.stringify(event);
    for (const [client, principal] of clients) {
        if (
            client.readyState === WebSocket.OPEN &&
            canReceive(principal, event)
        ) {
            client.send(message);
        }
    }
}

export function setupWebSocket(server: Server) {
    const wss = new WebSocketServer({ noServer: true });

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
            void authenticateUpgrade(req).then((principal) => {
                if (socket.destroyed) return;
                if (!principal) {
                    rejectUpgrade(socket, "401 Unauthorized");
                    return;
                }
                wss.handleUpgrade(req, socket, head, (ws) => {
                    clients.set(ws, principal);
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
