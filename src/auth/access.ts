/**
 * The role safety rule for plugin sign-in methods. A plugin's
 * `resolveAccess` only ever narrows what a user gets: its answer is capped
 * here, and anything unusual fails closed.
 */
import type {
    AuthProvider,
    ExternalProfile,
} from "@tessellatepos/plugin-sdk/server";
import { isRole } from "@/auth/roles";

/** Role given when a provider grants nothing usable or has no resolveAccess. */
export const DEFAULT_ROLE = "viewer";

/** How long `resolveAccess` may take before the login is refused. */
export const RESOLVE_ACCESS_TIMEOUT_MS = 10_000;

/** The outcome of {@link resolveProviderAccess}. */
export type AccessOutcome =
    { allowed: true; roles: string[] } | { allowed: false; reason: string };

/**
 * Caps the roles a plugin asked for. A role survives only if the host knows
 * it, the plugin's manifest lists it in `tessellate.authRoles`, and it is not
 * `owner` (no plugin can ever grant owner, whatever its manifest says).
 * @param requested what the plugin returned; anything that is not an array
 * of strings yields no roles
 * @param authRoles the manifest's `tessellate.authRoles`
 * @returns the surviving roles, de-duplicated in request order, or the
 * default role when nothing survives
 */
export function capRoles(
    requested: unknown,
    authRoles: readonly string[] | undefined,
): string[] {
    const allowed = new Set(Array.isArray(authRoles) ? authRoles : []);
    const kept: string[] = [];
    if (Array.isArray(requested)) {
        for (const role of requested) {
            if (
                typeof role === "string" &&
                role !== "owner" &&
                isRole(role) &&
                allowed.has(role) &&
                !kept.includes(role)
            ) {
                kept.push(role);
            }
        }
    }
    return kept.length > 0 ? kept : [DEFAULT_ROLE];
}

function timeout(ms: number): { promise: Promise<never>; clear: () => void } {
    let timer: NodeJS.Timeout | undefined;
    const promise = new Promise<never>((_, reject) => {
        timer = setTimeout(
            () => reject(new Error("resolveAccess timed out")),
            ms,
        );
    });
    return { promise, clear: () => clearTimeout(timer) };
}

/**
 * Asks a provider's `resolveAccess` what a profile may do and applies the
 * cap. Fails closed: a `deny`, a throw, a rejected promise, a timeout or an
 * answer that is neither `{ roles }` nor `{ deny }` all refuse the login.
 * @param provider the plugin's auth provider
 * @param authRoles the owning plugin's manifest `tessellate.authRoles`
 * @param profile the external profile to decide on
 * @param timeoutMs how long to wait for the plugin
 * @returns the capped roles, or the reason for refusing
 */
export async function resolveProviderAccess(
    provider: Pick<AuthProvider, "resolveAccess">,
    authRoles: readonly string[] | undefined,
    profile: ExternalProfile,
    timeoutMs: number = RESOLVE_ACCESS_TIMEOUT_MS,
): Promise<AccessOutcome> {
    if (typeof provider.resolveAccess !== "function") {
        return { allowed: true, roles: [DEFAULT_ROLE] };
    }
    const limit = timeout(timeoutMs);
    try {
        const decision: unknown = await Promise.race([
            Promise.resolve().then(() => provider.resolveAccess?.(profile)),
            limit.promise,
        ]);
        if (typeof decision !== "object" || decision === null) {
            return { allowed: false, reason: "invalid access decision" };
        }
        if ("deny" in decision) {
            const { deny } = decision as { deny: unknown };
            return {
                allowed: false,
                reason: typeof deny === "string" && deny ? deny : "denied",
            };
        }
        if (!("roles" in decision)) {
            return { allowed: false, reason: "invalid access decision" };
        }
        return {
            allowed: true,
            roles: capRoles((decision as { roles: unknown }).roles, authRoles),
        };
    } catch (err) {
        return {
            allowed: false,
            reason: `resolveAccess failed: ${err instanceof Error ? err.message : "unknown error"}`,
        };
    } finally {
        limit.clear();
    }
}
