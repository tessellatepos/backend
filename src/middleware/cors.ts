import cors from "cors";
import type { NextFunction, Request, Response } from "express";
import { isDevLocalOrigin, urlConfig, type UrlConfig } from "@/config/urls";

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
            config.corsOrigins.includes(origin) ||
            (config.allowDevOrigins && isDevLocalOrigin(origin)) ||
            new URL(origin).host === host
        );
    } catch {
        return false;
    }
}

/**
 * Per-surface CORS. Internal routes allow same-origin requests plus the
 * configured origins (PUBLIC_URL) and, outside production, any local dev
 * origin (localhost / 127.0.0.1 on any port). /member/* allows the same plus
 * MEMBER_ORIGINS, with credentials, so a plugin's member site can use the
 * session cookie. /gateway/* and /webhooks/* get no CORS headers here; the
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
    const member = cors((req, callback) => {
        const origin = req.headers.origin;
        const allowed =
            isOriginAllowed(origin, req.headers.host, config) ||
            (!!origin && config.memberOrigins.includes(origin));
        callback(null, { origin: allowed, credentials: allowed });
    });
    return (req: Request, res: Response, next: NextFunction) => {
        if (req.surface === "internal") {
            internal(req, res, next);
        } else if (req.surface === "member") {
            member(req, res, next);
        } else {
            next();
        }
    };
}
