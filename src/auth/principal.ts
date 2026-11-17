import type { Request } from "express";
import { fromNodeHeaders } from "better-auth/node";
import type { Principal, PrincipalKind } from "@tessellatepos/sdk";
import { getAuth } from "@/services/auth";
import { resolveDeviceToken } from "@/auth/deviceToken";
import { parseRoles, scopesForRoles } from "@/auth/roles";
import { extractMemberToken } from "@/auth/members/sessions";
import { resolveMemberPrincipal } from "@/services/members";

/** Kinds an extra resolver may produce. Users and devices are built in. */
export type ExtraPrincipalKind = Extract<
    PrincipalKind,
    "credential" | "service"
>;

/** Resolves a request to a principal, or null when it does not recognise it. */
export type PrincipalResolver = (req: Request) => Promise<Principal | null>;

const extraResolvers: {
    kind: ExtraPrincipalKind;
    resolve: PrincipalResolver;
}[] = [];

/**
 * Registers an extra principal resolver (e.g. gateway API credentials).
 * "credential" resolvers run only on the gateway surface; "service"
 * resolvers run only on the internal surface, after sessions and devices.
 * @param kind which kind of principal the resolver produces
 * @param resolve returns a principal or null; a throw counts as null
 * @returns a function that unregisters the resolver
 */
export function registerPrincipalResolver(
    kind: ExtraPrincipalKind,
    resolve: PrincipalResolver,
): () => void {
    if (kind !== "credential" && kind !== "service") {
        throw new Error(`Cannot register a resolver for kind "${kind}"`);
    }
    const entry = { kind, resolve };
    extraResolvers.push(entry);
    return () => {
        const i = extraResolvers.indexOf(entry);
        if (i >= 0) extraResolvers.splice(i, 1);
    };
}

async function runExtra(
    req: Request,
    kind: ExtraPrincipalKind,
): Promise<Principal | null> {
    for (const entry of extraResolvers) {
        if (entry.kind !== kind) continue;
        try {
            const principal = await entry.resolve(req);
            if (principal) return principal;
        } catch {
            // A broken resolver must not authenticate anyone.
        }
    }
    return null;
}

async function resolveSession(req: Request): Promise<Principal | null> {
    const result = await getAuth().api.getSession({
        headers: fromNodeHeaders(req.headers),
    });
    if (!result) return null;
    const { user } = result;
    const banExpires = user.banExpires ? new Date(user.banExpires) : null;
    if (user.banned && (!banExpires || banExpires.getTime() > Date.now())) {
        return null;
    }
    const roles = parseRoles(user.role);
    return {
        kind: "user",
        id: user.id,
        display_name: user.name,
        roles,
        scopes: scopesForRoles(roles),
        location_ids: "all",
    };
}

async function resolveDevice(req: Request): Promise<Principal | null> {
    const match = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? "");
    return match ? resolveDeviceToken(match[1]) : null;
}

// /member/<plugin>/... : the plugin in the path is the only one a session may
// act for, so a member of one plugin never reaches another plugin's routes.
async function resolveMemberSession(
    req: Request,
    strict: boolean,
): Promise<Principal | null> {
    const plugin = /^\/member\/([^/]+)/i.exec(req.path)?.[1];
    const token = extractMemberToken(
        req.headers.cookie,
        req.headers.authorization,
    );
    if (!plugin || !token) return null;
    try {
        return await resolveMemberPrincipal(token, decodeURIComponent(plugin));
    } catch (error) {
        if (strict) throw error;
        return null;
    }
}

/**
 * Resolves who is making a request. The gateway surface only ever sees
 * credential resolvers; the member surface only ever sees a plugin member's
 * session (never staff sessions, devices or credentials), and the internal
 * surface never accepts a member session; the internal surface tries a better-auth session
 * (cookie or bearer), then a device token, then extra "service" resolvers, and never credentials.
 * Webhooks authenticate by signature, so they get no principal.
 * @param req the request, tagged with `req.surface`
 * @param options `strict` rethrows a failed lookup instead of answering
 *   null, so a caller can tell "unknown" from "the database is down"
 * @returns the principal, or null when unauthenticated
 */
export async function resolvePrincipal(
    req: Request,
    { strict = false }: { strict?: boolean } = {},
): Promise<Principal | null> {
    const surface = req.surface ?? "internal";
    if (surface === "gateway") return runExtra(req, "credential");
    if (surface === "webhook") return null;
    if (surface === "member") return resolveMemberSession(req, strict);

    try {
        const user = await resolveSession(req);
        if (user) return user;
    } catch (error) {
        if (strict) throw error;
        // Treat an unreadable session as unauthenticated.
    }
    try {
        const device = await resolveDevice(req);
        if (device) return device;
    } catch (error) {
        if (strict) throw error;
        // Treat an unreadable device record as unauthenticated.
    }
    return runExtra(req, "service");
}
