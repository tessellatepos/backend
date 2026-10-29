import cors from "cors";
import type { NextFunction, Request, Response } from "express";
import { urlConfig, type UrlConfig } from "@/config/urls";

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
        const origin = req.headers.origin;
        const host = req.headers.host;
        let allowed = false;
        if (origin) {
            try {
                allowed =
                    config.corsOrigins.includes(origin) ||
                    new URL(origin).host === host;
            } catch {
                allowed = false;
            }
        }
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
