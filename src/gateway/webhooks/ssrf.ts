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

/**
 * Whether http to a loopback host is acceptable: only outside production.
 * Read at call time so a deployment's NODE_ENV always applies.
 */
export function loopbackHttpAllowed(): boolean {
    return process.env.NODE_ENV !== "production";
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
 * Expands an IPv6 literal (no brackets) to its 16 bytes, including `::`
 * compression and a trailing dotted IPv4 part. Returns null when malformed.
 */
function ipv6Bytes(address: string): number[] | null {
    let text = address.toLowerCase();
    const zone = text.indexOf("%");
    if (zone !== -1) text = text.slice(0, zone);
    const tail = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
    if (tail) {
        const v4 = tail.slice(1).map(Number);
        if (v4.some((n) => n > 255)) return null;
        const hi = ((v4[0] << 8) | v4[1]).toString(16);
        const lo = ((v4[2] << 8) | v4[3]).toString(16);
        text = `${text.slice(0, tail.index)}${hi}:${lo}`;
    }
    const halves = text.split("::");
    if (halves.length > 2) return null;
    const head = halves[0] ? halves[0].split(":") : [];
    const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
    const missing = 8 - head.length - rest.length;
    if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
    const groups = [...head, ...Array(Math.max(missing, 0)).fill("0"), ...rest];
    const bytes: number[] = [];
    for (const g of groups) {
        if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
        const n = parseInt(g, 16);
        bytes.push(n >> 8, n & 0xff);
    }
    return bytes;
}

/**
 * Whether an IP literal is loopback, private, link-local, unique-local,
 * metadata, unspecified, multicast or otherwise not a public address.
 * IPv6 forms that embed an IPv4 address (::ffff:0:0/96, the deprecated
 * ::/96) are judged by the embedded address; NAT64 (64:ff9b::/96) and 6to4
 * (2002::/16) are refused outright.
 * @param address an IPv4 or IPv6 literal (no brackets)
 * @returns true when deliveries to it must be refused
 */
export function isBlockedAddress(address: string): boolean {
    const kind = isIP(address);
    if (kind === 4) return blockedV4(address.split(".").map(Number));
    if (kind !== 6) return true;
    const b = ipv6Bytes(address);
    if (!b) return true;
    const zeroTo = (n: number) => b.slice(0, n).every((x) => x === 0);
    // ::ffff:a.b.c.d (mapped) and ::a.b.c.d (deprecated compatible); the
    // latter also covers :: and ::1, which stay blocked below.
    const mapped = zeroTo(10) && b[10] === 0xff && b[11] === 0xff;
    if (mapped || zeroTo(12)) {
        const v4 = b.slice(12);
        return v4[0] === 0 && v4.slice(0, 3).every((x) => x === 0)
            ? true // ::, ::1, ::0.0.0.x
            : blockedV4(v4);
    }
    const first = (b[0] << 8) | b[1];
    return (
        first === 0x2002 || // 2002::/16 6to4
        (first === 0x64 &&
            b[2] === 0xff &&
            b[3] === 0x9b &&
            b.slice(4, 12).every((x) => x === 0)) || // 64:ff9b::/96 NAT64
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
    if (
        url.protocol === "http:" &&
        isLoopbackHost(url.hostname) &&
        loopbackHttpAllowed()
    ) {
        return;
    }
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
