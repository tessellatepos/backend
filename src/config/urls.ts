/**
 * The single place that reads deployment URL / host configuration from the
 * environment: PUBLIC_URL, EXPOSE_ADMIN_ON_PUBLIC_URL, ALLOWED_HOSTS,
 * TRUST_PROXY and the legacy FRONTEND_URL / BETTER_AUTH_URL /
 * SQUARE_REDIRECT_URL overrides. Everything else imports from here.
 *
 * Unset PUBLIC_URL means LAN / dev mode: any Host is accepted and nothing is
 * restricted.
 */
import { configDotenv } from "dotenv";
import { Logger } from "tslog";

configDotenv({ quiet: true });

const logger = new Logger();

/** The Vite dev server origin, trusted outside production. */
export const DEV_FRONTEND_ORIGIN = "http://localhost:5173";

/** Matches `http://localhost:<port>` and `http://127.0.0.1:<port>`. */
const DEV_LOCAL_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1):\d{1,5}$/;

/**
 * Whether an Origin is a local dev origin on any port.
 * @param origin the Origin header value
 * @returns true for http://localhost:<port> and http://127.0.0.1:<port>
 */
export function isDevLocalOrigin(origin: string | undefined): boolean {
    return !!origin && DEV_LOCAL_ORIGIN.test(origin);
}

/** Value accepted by Express's `trust proxy` setting. */
export type TrustProxy = boolean | number | string[];

/** Parsed, normalised URL configuration. */
export interface UrlConfig {
    /** Externally reachable origin (no trailing slash), or null in LAN mode. */
    publicUrl: string | null;
    /** Lower-case hostname of publicUrl (no port), or null. */
    publicHost: string | null;
    /** True when the public host may also serve the app/admin (mode C). */
    exposeAdminOnPublicUrl: boolean;
    /** Lower-case allowed hostnames, or null when any host is accepted. */
    allowedHosts: string[] | null;
    /** Value for `app.set("trust proxy", ...)`. */
    trustProxy: TrustProxy;
    /** Where the browser app lives, when known. */
    frontendUrl: string | undefined;
    /** OAuth redirect URL registered with Square, when known. */
    squareRedirectUrl: string | undefined;
    /** Explicit better-auth base URL (legacy override), when set. */
    authBaseUrl: string | undefined;
    /** Origins allowed to make cross-origin calls to internal routes. */
    corsOrigins: string[];
    /** True outside production: any local dev port is trusted as an origin. */
    allowDevOrigins: boolean;
}

const LEGACY_VARS = [
    "FRONTEND_URL",
    "BETTER_AUTH_URL",
    "SQUARE_REDIRECT_URL",
] as const;

const warnedLegacy = new Set<string>();

function warnLegacy(name: string, warn: (message: string) => void) {
    if (warnedLegacy.has(name)) return;
    warnedLegacy.add(name);
    warn(
        `${name} is deprecated and only kept as an override; set PUBLIC_URL instead.`,
    );
}

/**
 * Lower-cases a Host header (or ALLOWED_HOSTS entry) and drops the port.
 * @param host a host, optionally with a port
 * @returns the bare hostname, or null when it cannot be parsed
 */
export function normalizeHost(host: string | undefined): string | null {
    if (!host) return null;
    try {
        return new URL(`http://${host.trim()}`).hostname.toLowerCase();
    } catch {
        return null;
    }
}

function trimmed(value: string | undefined): string | undefined {
    const v = value?.trim();
    return v ? v : undefined;
}

function parsePublicUrl(raw: string | undefined): URL | null {
    const value = trimmed(raw);
    if (!value) return null;
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        throw new Error(`PUBLIC_URL is not a valid URL: ${value}`);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Error(`PUBLIC_URL must be http(s): ${value}`);
    }
    return url;
}

function parseTrustProxy(
    raw: string | undefined,
    publicUrl: URL | null,
): TrustProxy {
    const value = trimmed(raw);
    if (value === undefined) {
        return publicUrl?.protocol === "https:" ? 1 : 0;
    }
    if (value === "true") return true;
    if (value === "false") return false;
    if (/^\d+$/.test(value)) return Number(value);
    return value
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
}

function originOf(value: string | undefined): string | undefined {
    if (!value) return undefined;
    try {
        return new URL(value).origin;
    } catch {
        return undefined;
    }
}

/**
 * Builds the URL configuration from an environment. Exported for tests; the
 * app uses the module-level exports below.
 * @param env the environment to read
 * @param warn receives one-time deprecation warnings
 * @returns the parsed configuration
 */
export function loadUrlConfig(
    env: NodeJS.ProcessEnv = process.env,
    warn: (message: string) => void = (m) => logger.warn(m),
): UrlConfig {
    for (const name of LEGACY_VARS) {
        if (trimmed(env[name])) warnLegacy(name, warn);
    }

    const url = parsePublicUrl(env.PUBLIC_URL);
    const publicUrl = url ? url.origin : null;
    const exposeAdminOnPublicUrl =
        trimmed(env.EXPOSE_ADMIN_ON_PUBLIC_URL)?.toLowerCase() === "true";

    const hosts = (trimmed(env.ALLOWED_HOSTS) ?? "")
        .split(",")
        .map((h) => normalizeHost(h))
        .filter((h): h is string => h !== null);

    const frontendUrl =
        trimmed(env.FRONTEND_URL) ??
        (publicUrl && exposeAdminOnPublicUrl ? publicUrl : undefined);
    const squareRedirectUrl =
        trimmed(env.SQUARE_REDIRECT_URL) ??
        (publicUrl && exposeAdminOnPublicUrl
            ? `${publicUrl}/api/v1/square/oauth/callback`
            : undefined);

    const corsOrigins = [
        publicUrl,
        originOf(trimmed(env.FRONTEND_URL)),
        env.NODE_ENV !== "production" ? DEV_FRONTEND_ORIGIN : undefined,
    ].filter((o): o is string => !!o);

    return {
        publicUrl,
        publicHost: url ? url.hostname.toLowerCase() : null,
        exposeAdminOnPublicUrl,
        allowedHosts: hosts.length ? hosts : null,
        trustProxy: parseTrustProxy(env.TRUST_PROXY, url),
        frontendUrl,
        squareRedirectUrl,
        authBaseUrl: trimmed(env.BETTER_AUTH_URL),
        corsOrigins: [...new Set(corsOrigins)],
        allowDevOrigins: env.NODE_ENV !== "production",
    };
}

/** The configuration for this process. */
export const urlConfig: UrlConfig = loadUrlConfig();

/** Externally reachable origin, or null in LAN / dev mode. */
export const publicUrl = urlConfig.publicUrl;
/** Browser app URL when known (override or public admin), else undefined. */
export const frontendUrl = urlConfig.frontendUrl;
/** Square OAuth redirect URL when known, else undefined. */
export const squareRedirectUrl = urlConfig.squareRedirectUrl;

/**
 * Base URL of the developer gateway.
 * @param requestOrigin the request's own origin, used when PUBLIC_URL is unset
 * @param config the configuration to use
 * @returns `${PUBLIC_URL}/gateway/v1`, or the request origin based equivalent
 */
export function gatewayBase(
    requestOrigin?: string,
    config: UrlConfig = urlConfig,
): string | null {
    const base = config.publicUrl ?? requestOrigin;
    return base ? `${base}/gateway/v1` : null;
}

/**
 * URL a payment processor should call back on.
 * @param processor processor name, e.g. "square"
 * @param config the configuration to use
 * @returns the webhook URL, or null when PUBLIC_URL is unset (unreachable)
 */
export function webhookUrl(
    processor: string,
    config: UrlConfig = urlConfig,
): string | null {
    return config.publicUrl
        ? `${config.publicUrl}/webhooks/${encodeURIComponent(processor)}`
        : null;
}

/**
 * Whether a hostname is the PUBLIC_URL host.
 * @param hostname bare hostname
 * @param config the configuration to use
 * @returns true when it matches the public host
 */
export function isPublicHost(
    hostname: string | null,
    config: UrlConfig = urlConfig,
): boolean {
    return !!hostname && hostname === config.publicHost;
}

/**
 * Whether ALLOWED_HOSTS (when set) permits a hostname.
 * @param hostname bare hostname
 * @param config the configuration to use
 * @returns true when allowed, or when ALLOWED_HOSTS is unset
 */
export function isHostAllowed(
    hostname: string | null,
    config: UrlConfig = urlConfig,
): boolean {
    if (!config.allowedHosts) return true;
    return !!hostname && config.allowedHosts.includes(hostname);
}

/**
 * Whether a path may be served on the public host while admin is not exposed.
 * @param path request path
 * @returns true for /gateway/*, /webhooks/* and /health
 */
export function isPublicPath(path: string): boolean {
    const p = path.toLowerCase();
    return (
        p === "/health" ||
        p === "/gateway" ||
        p.startsWith("/gateway/") ||
        p === "/webhooks" ||
        p.startsWith("/webhooks/")
    );
}

/**
 * Decides what to do with a request given its host and path.
 * @param hostname bare hostname the request was addressed to
 * @param path request path
 * @param config the configuration to use
 * @returns "ok", "misdirected" (421) or "not-found" (404)
 */
export function evaluateHost(
    hostname: string | null,
    path: string,
    config: UrlConfig = urlConfig,
): "ok" | "misdirected" | "not-found" {
    if (!isHostAllowed(hostname, config)) return "misdirected";
    if (
        config.publicUrl &&
        !config.exposeAdminOnPublicUrl &&
        isPublicHost(hostname, config) &&
        !isPublicPath(path)
    ) {
        return "not-found";
    }
    return "ok";
}

/**
 * Origins better-auth should trust for a request.
 * @param request the incoming request, when better-auth has one
 * @param config the configuration to use
 * @returns the request's own origin plus PUBLIC_URL when set, and outside
 * production any local dev origin (`http://localhost:*`, `http://127.0.0.1:*`)
 */
export function trustedOrigins(
    request?: Request,
    config: UrlConfig = urlConfig,
): string[] {
    const origins: string[] = [];
    const own = originOf(request?.url);
    if (own) origins.push(own);
    if (config.publicUrl) origins.push(config.publicUrl);
    origins.push(...config.corsOrigins);
    if (config.allowDevOrigins) {
        origins.push("http://localhost:*", "http://127.0.0.1:*");
    }
    return [...new Set(origins)];
}
