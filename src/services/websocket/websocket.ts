import { WebSocket, WebSocketServer } from "ws";
import { Server } from "http";
import type { Duplex } from "node:stream";
import { Logger } from "tslog";
import { appEvents } from "@/services/websocket/events";
import { evaluateHost, normalizeHost } from "@/config/urls";

const logger = new Logger();

const clients = new Set<WebSocket>();

/** The only path that accepts WebSocket upgrades. */
export const WS_PATH = "/ws";

function rejectUpgrade(socket: Duplex, status: string) {
    socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
}

export function setupWebSocket(server: Server) {
    const wss = new WebSocketServer({ noServer: true });

    // Upgrades bypass Express, so apply the same host rules here: only /ws,
    // and never on the public host unless admin is exposed there.
    server.on("upgrade", (req, socket, head) => {
        const { pathname } = new URL(req.url ?? "/", "http://localhost");
        const host = normalizeHost(req.headers.host);
        if (pathname !== WS_PATH) {
            rejectUpgrade(socket, "404 Not Found");
        } else if (evaluateHost(host, pathname) !== "ok") {
            rejectUpgrade(socket, "404 Not Found");
        } else {
            wss.handleUpgrade(req, socket, head, (ws) =>
                wss.emit("connection", ws, req),
            );
        }
    });

    wss.on("connection", (ws: WebSocket) => {
        logger.debug("WebSocket client connected");
        clients.add(ws);

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

    appEvents.on("db_update", (event) => {
        const message = JSON.stringify(event);
        for (const client of clients) {
            if (client.readyState === WebSocket.OPEN) {
                client.send(message);
            }
        }
    });

    appEvents.on("payment_status", (event) => {
        const message = JSON.stringify(event);
        for (const client of clients) {
            if (client.readyState === WebSocket.OPEN) {
                client.send(message);
            }
        }
    });

    logger.info("WebSocket server initialized");
    return wss;
}
