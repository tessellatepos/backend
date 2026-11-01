/**
 * Seam for per-surface authentication. Every request is tagged with the
 * surface its path belongs to so later middleware can pick the right
 * principal:
 *
 * - "gateway":  /gateway/*  (credential auth only, own CORS)
 * - "webhook":  /webhooks/* (signature verification, no CORS)
 * - "internal": everything else (staff sessions, same-origin only)
 *
 * This module intentionally contains no auth logic yet.
 */
import type { NextFunction, Request, Response } from "express";

/** Which part of the API a request targets. */
export type Surface = "gateway" | "webhook" | "internal";

declare global {
    // eslint-disable-next-line @typescript-eslint/no-namespace
    namespace Express {
        interface Request {
            /** Set by {@link surfaceMiddleware}. */
            surface: Surface;
        }
    }
}

/**
 * Classifies a request path.
 * @param path request path
 * @returns the surface the path belongs to
 */
export function surfaceOf(path: string): Surface {
    const p = path.toLowerCase();
    if (p === "/gateway" || p.startsWith("/gateway/")) return "gateway";
    if (p === "/webhooks" || p.startsWith("/webhooks/")) return "webhook";
    return "internal";
}

/**
 * Express middleware that sets `req.surface`.
 * @param req the request
 * @param _res the response
 * @param next continues the chain
 */
export function surfaceMiddleware(
    req: Request,
    _res: Response,
    next: NextFunction,
) {
    req.surface = surfaceOf(req.path);
    next();
}
