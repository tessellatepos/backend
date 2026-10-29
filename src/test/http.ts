import "@/test/localProvider";
import express from "express";
import { customersv1Endpoint } from "@/endpoints/v1/customers";
import { ordersv1Endpoint } from "@/endpoints/v1/orders";
import "@/middleware/authenticate";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { TessellatePluginRegistry } from "@/utils/registry/plugin/pluginRegistry";

/** A running test server and a small JSON fetch helper. */
export interface TestApp {
    baseUrl: string;
    close(): Promise<void>;
    /** Sends a request and returns the status and parsed JSON body. */
    request(
        method: string,
        path: string,
        body?: unknown,
    ): Promise<{ status: number; body: any; headers: Headers }>; // eslint-disable-line @typescript-eslint/no-explicit-any -- tests inspect arbitrary JSON
}

/**
 * Starts the customers and orders routers on an ephemeral port with the local
 * provider (see localProvider.ts, imported first for that reason).
 * @param pluginRegistry the registry exposed to handlers on app.locals
 * @returns the running app
 */
export async function startTestApp(
    pluginRegistry: TessellatePluginRegistry,
): Promise<TestApp> {
    const app = express();
    app.use(express.json());
    // These tests are about customers and orders, not auth: act as the owner.
    app.use((req, _res, next) => {
        req.principal = {
            kind: "user",
            id: "test-owner",
            display_name: "Test Owner",
            roles: ["owner"],
            scopes: ["*"],
            location_ids: "all",
        };
        next();
    });
    app.locals.pluginRegistry = pluginRegistry;
    app.use("/customers", customersv1Endpoint.router);
    app.use("/orders", ordersv1Endpoint.router);

    const server: Server = await new Promise((resolve) => {
        const s = app.listen(0, () => resolve(s));
    });
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return {
        baseUrl,
        close: () =>
            new Promise((resolve) => {
                server.close(() => resolve());
                server.closeAllConnections();
            }),
        request: async (method, path, body) => {
            const res = await fetch(`${baseUrl}${path}`, {
                method,
                headers: { "Content-Type": "application/json" },
                body: body === undefined ? undefined : JSON.stringify(body),
            });
            const text = await res.text();
            return {
                status: res.status,
                body: text ? JSON.parse(text) : undefined,
                headers: res.headers,
            };
        },
    };
}
