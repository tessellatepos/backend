/**
 * Member session tokens: random, shown once, stored only as a SHA-256 hash.
 */
import { createHash, randomBytes } from "node:crypto";

/** Prefix that marks a member session token. */
export const MEMBER_TOKEN_PREFIX = "tsm_";

/** Name of the session cookie. */
export const MEMBER_COOKIE = "tessellate_member";

/** How long a member session lasts. */
export const MEMBER_SESSION_MS = 30 * 24 * 60 * 60 * 1000;

/** @returns a new session token */
export function newMemberToken(): string {
    return MEMBER_TOKEN_PREFIX + randomBytes(32).toString("base64url");
}

/**
 * @param token a session token
 * @returns the hex SHA-256 the database stores
 */
export function hashMemberToken(token: string): string {
    return createHash("sha256").update(token).digest("hex");
}

/**
 * Reads one cookie from a Cookie header.
 * @param header the raw header
 * @param name the cookie name
 * @returns the value, or null
 */
export function readCookie(
    header: string | undefined,
    name: string,
): string | null {
    if (!header) return null;
    for (const part of header.split(";")) {
        const i = part.indexOf("=");
        if (i < 0) continue;
        if (part.slice(0, i).trim() === name) {
            return part.slice(i + 1).trim() || null;
        }
    }
    return null;
}

/**
 * Pulls the session token out of a request: the member cookie, else a bearer
 * token that carries the member prefix (so a staff bearer token is never read
 * as a member's).
 * @param cookieHeader the Cookie header
 * @param authorization the Authorization header
 * @returns the token, or null
 */
export function extractMemberToken(
    cookieHeader: string | undefined,
    authorization: string | undefined,
): string | null {
    const cookie = readCookie(cookieHeader, MEMBER_COOKIE);
    if (cookie?.startsWith(MEMBER_TOKEN_PREFIX)) return cookie;
    const bearer = /^Bearer\s+(\S+)$/i.exec(authorization ?? "")?.[1];
    return bearer?.startsWith(MEMBER_TOKEN_PREFIX) ? bearer : null;
}
