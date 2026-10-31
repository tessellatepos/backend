/**
 * Keeps webhook deliveries away from the store's own network. A URL passes
 * when it is http to a loopback host (local development), or when every
 * address its hostname resolves to is public.
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/** Resolves a hostname to all of its addresses. Tests inject a stub. */
export type LookupAll = (host: string) => Promise<{ address: string }[]>;

const resolveAll: LookupAll = (host) => lookup(host, { all: true });

/** Whether a URL hostname names the local machine (the dev exception). */
export function isLoopbackHost(host: string): boolean {
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}

function blockedV4(parts: number[]): boolean {
    const [a, b] = parts;
    return (
        a === 0 ||
        a === 10 ||
        a === 127 ||
        (a === 100 && b >= 64 && b <= 127) ||
        (a === 169 && b === 254) ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 168) ||
        a >= 224
    );
}

/**
 * Whether an IP literal is loopback, private, link-local, unique-local,
 * metadata, unspecified, multicast or otherwise not a public address.
 * @param address an IPv4 or IPv6 literal (no brackets)
 * @returns true when deliveries to it must be refused
 */
export function isBlockedAddress(address: string): boolean {
    const kind = isIP(address);
    if (kind === 4) return blockedV4(address.split(".").map(Number));
    if (kind !== 6) return true;
    const lower = address.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped) return blockedV4(mapped[1].split(".").map(Number));
    // Expand just enough to read the first group.
    const first = parseInt(lower.split(":")[0] || "0", 16);
    return (
        lower === "::" ||
        lower === "::1" ||
        (first & 0xfe00) === 0xfc00 || // fc00::/7 unique local
        (first & 0xffc0) === 0xfe80 || // fe80::/10 link-local
        (first & 0xff00) === 0xff00 // ff00::/8 multicast
    );
}

/**
 * Throws unless a webhook URL may be delivered to right now.
 * @param value the stored webhook URL
 * @param lookupAll resolves a hostname (tests inject one)
 */
export async function assertPublicTarget(
    value: string,
    lookupAll: LookupAll = resolveAll,
): Promise<void> {
    const url = new URL(value);
    if (url.protocol === "http:" && isLoopbackHost(url.hostname)) return;
    if (url.protocol !== "https:") throw new Error("webhook url not allowed");
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const addresses = isIP(host) ? [{ address: host }] : await lookupAll(host);
    if (
        addresses.length === 0 ||
        addresses.some((a) => isBlockedAddress(a.address))
    ) {
        throw new Error("webhook target is not a public address");
    }
}
