/**
 * Resolves `req.principal` for every request and provides the guards that
 * endpoints use. `authenticate` never rejects; `requireScope` does.
 */
import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { Principal, Scope } from "@tessellatepos/sdk";
import { resolvePrincipal } from "@/auth/principal";

declare global {
    // eslint-disable-next-line @typescript-eslint/no-namespace
    namespace Express {
        interface Request {
            /** Set by {@link authenticate}; null when unauthenticated. */
            principal: Principal | null;
        }
    }
}

/**
 * Express middleware that sets `req.principal`. It never rejects a request.
 * @param req the request
 * @param _res the response
 * @param next continues the chain
 */
export async function authenticate(
    req: Request,
    _res: Response,
    next: NextFunction,
) {
    try {
        req.principal = await resolvePrincipal(req);
    } catch {
        req.principal = null;
    }
    next();
}

/**
 * Whether a principal holds a scope. "*" satisfies everything; any other
 * scope (including `plugin:<name>:<verb>`) must match exactly.
 * @param principal the principal to check
 * @param scope the required scope
 * @returns true when held
 */
export function hasScope(principal: Principal, scope: Scope): boolean {
    return principal.scopes.includes("*") || principal.scopes.includes(scope);
}

/**
 * Guard: 401 without a principal, 403 unless the principal holds at least
 * one of the scopes.
 * @param scopes accepted scopes (any one is enough)
 * @returns an Express middleware
 */
export function requireScope(...scopes: Scope[]): RequestHandler {
    return (req, res, next) => {
        const principal = req.principal;
        if (!principal) {
            res.status(401).json({ message: "Unauthorized" });
        } else if (!scopes.some((s) => hasScope(principal, s))) {
            res.status(403).json({ message: "Forbidden" });
        } else {
            next();
        }
    };
}

/**
 * Guard: 401 without a principal, otherwise any authenticated principal
 * passes. For surfaces whose handlers decide their own authorization (plugin
 * API routes).
 * @param req the request
 * @param res the response
 * @param next continues the chain
 */
export function requireAuthenticated(
    req: Request,
    res: Response,
    next: NextFunction,
) {
    if (req.principal) {
        next();
    } else {
        res.status(401).json({ message: "Unauthorized" });
    }
}

/**
 * Guard: 403 when the principal is restricted to locations that do not
 * include the one the request targets. Run after {@link requireScope}.
 * @param getLocationId reads the target location id from the request
 * @returns an Express middleware
 */
export function requireLocation(
    getLocationId: (req: Request) => string | undefined,
): RequestHandler {
    return (req, res, next) => {
        const principal = req.principal;
        if (!principal) {
            res.status(401).json({ message: "Unauthorized" });
            return;
        }
        if (principal.location_ids === "all") {
            next();
            return;
        }
        const id = getLocationId(req);
        if (id && principal.location_ids.includes(id)) {
            next();
        } else {
            res.status(403).json({ message: "Forbidden" });
        }
    };
}
