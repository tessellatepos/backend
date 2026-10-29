import cors from "cors";
import type { NextFunction, Request, Response } from "express";
import { urlConfig, type UrlConfig } from "@/config/urls";

/**
 * Whether a browser Origin is one this deployment serves: same host as the
 * request, or one of the configured origins.
 * @param origin the Origin header
 * @param host the Host header
 * @param config the configuration to enforce
 * @returns true when allowed
 */
export function isOriginAllowed(
    origin: string | undefined,
    host: string | undefined,
    config: UrlConfig = urlConfig,
): boolean {
    if (!origin) return false;
    try {
        return (
            config.corsOrigins.includes(origin) || new URL(origin).host === host
        );
    } catch {
        return false;
    }
}

/**
 * Per-surface CORS. Internal routes allow same-origin requests plus the
 * configured origins (PUBLIC_URL, and the Vite dev origin outside
 * production). /gateway/* and /webhooks/* get no CORS headers here; the
 * gateway adds its own later.
 * @param config the configuration to enforce
 * @returns an Express middleware
 */
export function surfaceCors(config: UrlConfig = urlConfig) {
    const internal = cors((req, callback) => {
        const allowed = isOriginAllowed(
            req.headers.origin,
            req.headers.host,
            config,
        );
        callback(null, { origin: allowed });
    });
    return (req: Request, res: Response, next: NextFunction) => {
        if (req.surface !== "internal") {
            next();
            return;
        }
        internal(req, res, next);
    };
}
