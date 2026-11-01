import { randomBytes } from "node:crypto";
import { Logger } from "tslog";
import { safeEqual } from "@/services/crypto";
import { FixedWindowLimiter } from "@/utils/rateLimiter";

const logger = new Logger();

/** Held only in memory; never persisted, returned by an API, or re-logged. */
let setupToken: string | null = null;

/**
 * Decides whether this process needs a setup token and, if so, creates it
 * (or takes SETUP_TOKEN from the environment) and prints it once. Call at
 * startup. A restart while setup is incomplete yields a new random token.
 * @param needsToken true while no user exists yet
 * @returns true when a token is now active
 */
export function initSetupToken(needsToken: boolean): boolean {
    setupToken = null;
    if (!needsToken) return false;
    setupToken =
        process.env.SETUP_TOKEN?.trim() || randomBytes(18).toString("hex");
    const fromEnv = Boolean(process.env.SETUP_TOKEN?.trim());
    logger.info(
        [
            "",
            "==================== FIRST-RUN SETUP ====================",
            fromEnv
                ? "Setup token: (taken from SETUP_TOKEN)"
                : `Setup token: ${setupToken}`,
            "Enter it in the setup wizard to create the owner account.",
            "=========================================================",
        ].join("\n"),
    );
    return true;
}

/** Forgets the token, once the owner exists. */
export function clearSetupToken(): void {
    setupToken = null;
}

/**
 * Compares a candidate to the active token in constant time.
 * @param candidate what the caller supplied
 * @returns false when there is no active token or it does not match
 */
export function setupTokenMatches(candidate: unknown): boolean {
    if (setupToken === null || typeof candidate !== "string") return false;
    return safeEqual(candidate, setupToken);
}

/** Failed attempts allowed per window, per client. */
export const MAX_FAILED_ATTEMPTS = 10;
/** Length of the fixed window. */
export const FAILURE_WINDOW_MS = 15 * 60 * 1000;

// Per process, like every limiter built on FixedWindowLimiter.
const failures = new FixedWindowLimiter(MAX_FAILED_ATTEMPTS, FAILURE_WINDOW_MS);

/**
 * Whether a client has used up its failed-token attempts for this window.
 * @param key the client, e.g. req.ip
 * @param now current time in ms
 * @returns true when further attempts should get 429
 */
export function isRateLimited(key: string, now = Date.now()): boolean {
    return failures.isLimited(key, now);
}

/**
 * Records a failed token attempt (fixed window starting at the first one).
 * @param key the client, e.g. req.ip
 * @param now current time in ms
 */
export function recordFailure(key: string, now = Date.now()): void {
    failures.record(key, now);
}

/** Clears all rate-limit state (tests). */
export function resetRateLimits(): void {
    failures.reset();
}
