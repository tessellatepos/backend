import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Principal, Scope } from "@tessellatepos/sdk";
import {
    getConfigDeviceByID,
    getConfigDeviceByTokenHash,
    updateConfigDevice,
} from "@/services/db/configDevice";

/** Prefix that marks a bearer value as a device token. */
export const DEVICE_TOKEN_PREFIX = "tsd_";

/** What a till needs: sell, look things up, nothing administrative. */
export const DEVICE_SCOPES: readonly Scope[] = [
    "catalog:read",
    "orders:read",
    "orders:write",
    "customers:read",
    "customers:write",
    "locations:read",
    "devices:read",
];

/**
 * Hashes a device token for storage and lookup. Tokens are 256 random bits,
 * so a fast hash is sufficient.
 * @param token the plaintext token
 * @returns lowercase hex sha-256
 */
export function hashDeviceToken(token: string): string {
    return createHash("sha256").update(token).digest("hex");
}

/**
 * Compares a presented pairing code to the stored one without leaking
 * timing. Never matches when either side is missing.
 * @param presented what the caller sent
 * @param stored the device's current pairing code
 * @returns true on an exact match
 */
export function pairingCodeMatches(
    presented: unknown,
    stored: string | null,
): boolean {
    if (typeof presented !== "string" || !presented || !stored) return false;
    const a = Buffer.from(presented);
    const b = Buffer.from(stored);
    return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Issues a new token for a device, replacing (revoking) any previous one.
 * Only the hash is stored.
 * @param deviceId the devices row id
 * @returns the plaintext token (shown once), or null when no such device
 */
export async function issueDeviceToken(
    deviceId: string,
): Promise<string | null> {
    if (!(await getConfigDeviceByID(deviceId))) return null;
    const token = DEVICE_TOKEN_PREFIX + randomBytes(32).toString("base64url");
    await updateConfigDevice(deviceId, {
        device_token_hash: hashDeviceToken(token),
    });
    return token;
}

/**
 * Revokes a device's token by clearing its hash.
 * @param deviceId the devices row id
 * @returns false when no such device
 */
export async function revokeDeviceToken(deviceId: string): Promise<boolean> {
    if (!(await getConfigDeviceByID(deviceId))) return false;
    await updateConfigDevice(deviceId, { device_token_hash: null });
    return true;
}

/**
 * Resolves a presented device token to a device principal. Only paired
 * devices resolve; re-pairing a device therefore suspends its token.
 * @param token the plaintext token
 * @returns the principal, or null when unknown, revoked or unpaired
 */
export async function resolveDeviceToken(
    token: string,
): Promise<Principal | null> {
    if (!token.startsWith(DEVICE_TOKEN_PREFIX)) return null;
    const device = await getConfigDeviceByTokenHash(hashDeviceToken(token));
    if (!device?.paired_at || device.device_type === "LOCAL") return null;
    return {
        kind: "device",
        id: device.id,
        roles: ["device"],
        scopes: [...DEVICE_SCOPES],
        location_ids: device.square_location ? [device.square_location] : "all",
    };
}
