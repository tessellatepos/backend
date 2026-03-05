import { WebSocket, WebSocketServer } from "ws";
import { Server } from "http";
import { Logger } from "tslog";
import { appEvents } from "@/services/websocket/events";

const logger = new Logger();

const clients = new Set<WebSocket>();

export function setupWebSocket(server: Server) {
    const wss = new WebSocketServer({ server });

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

    logger.info("WebSocket server initialized");
    return wss;
}
