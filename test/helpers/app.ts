import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { surfaceMiddleware } from "@/middleware/surface";
import { authenticate } from "@/middleware/authenticate";

/** A running throwaway Express app for HTTP-level tests. */
export interface TestApp {
    app: express.Express;
    url: string;
    close(): Promise<void>;
}

/**
 * Starts an app with the surface and authenticate middleware mounted, as in
 * server.ts. Callers add routes via `setup` before it listens.
 * @param setup adds routes to the app
 * @returns the running app
 */
export async function startTestApp(
    setup: (app: express.Express) => void,
): Promise<TestApp> {
    const app = express();
    app.use(surfaceMiddleware);
    app.use(express.json());
    app.use(authenticate);
    setup(app);
    const server: Server = await new Promise((resolve) => {
        const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    const { port } = server.address() as AddressInfo;
    return {
        app,
        url: `http://127.0.0.1:${port}`,
        close: () =>
            new Promise<void>((resolve) => {
                server.closeAllConnections();
                server.close(() => resolve());
            }),
    };
}
