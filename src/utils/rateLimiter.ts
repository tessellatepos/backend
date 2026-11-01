import type { NextFunction, Request, RequestHandler, Response } from "express";

/**
 * In-process fixed-window counter keyed by a string (usually `req.ip`).
 * The window starts at a key's first hit. State lives in this process only:
 * with several backend instances each keeps its own counts, so the effective
 * limit is the configured one multiplied by the number of instances.
 */
export class FixedWindowLimiter {
    private readonly entries = new Map<
        string,
        { count: number; resetAt: number }
    >();

    readonly max: number;
    readonly windowMs: number;

    /**
     * @param max hits allowed per window before the key is limited
     * @param windowMs length of the window in milliseconds
     */
    constructor(max: number, windowMs: number) {
        this.max = max;
        this.windowMs = windowMs;
    }

    /**
     * Whether a key has used up its hits for the current window.
     * @param key the client, e.g. req.ip
     * @param now current time in ms
     * @returns true when further requests should get 429
     */
    isLimited(key: string, now = Date.now()): boolean {
        const entry = this.entries.get(key);
        if (!entry) return false;
        if (entry.resetAt <= now) {
            this.entries.delete(key);
            return false;
        }
        return entry.count >= this.max;
    }

    /**
     * Records one hit (the window starts at the first one).
     * @param key the client, e.g. req.ip
     * @param now current time in ms
     */
    record(key: string, now = Date.now()): void {
        const entry = this.entries.get(key);
        if (!entry || entry.resetAt <= now) {
            // Keep the map from growing without bound under a spray of keys.
            if (this.entries.size >= 10_000) this.sweep(now);
            this.entries.set(key, { count: 1, resetAt: now + this.windowMs });
        } else {
            entry.count += 1;
        }
    }

    /**
     * Seconds until a limited key may try again.
     * @param key the client
     * @param now current time in ms
     * @returns whole seconds, at least 1
     */
    retryAfterSeconds(key: string, now = Date.now()): number {
        const entry = this.entries.get(key);
        return entry ? Math.max(1, Math.ceil((entry.resetAt - now) / 1000)) : 1;
    }

    /** Forgets every key (tests). */
    reset(): void {
        this.entries.clear();
    }

    private sweep(now: number): void {
        for (const [key, entry] of this.entries) {
            if (entry.resetAt <= now) this.entries.delete(key);
        }
    }
}

/**
 * Key for a request: the client IP (correct only with `trust proxy`
 * configured behind a proxy, which server.ts does).
 * @param req the request
 * @returns the key to count against
 */
export function clientKey(req: Request): string {
    return req.ip ?? "unknown";
}

/**
 * Middleware that counts every request against the limiter and answers 429
 * (with Retry-After) once the key has used its hits.
 * @param limiter the limiter to count against
 * @returns an Express middleware
 */
export function rateLimit(limiter: FixedWindowLimiter): RequestHandler {
    return (req: Request, res: Response, next: NextFunction) => {
        const key = clientKey(req);
        if (limiter.isLimited(key)) {
            res.setHeader("Retry-After", limiter.retryAfterSeconds(key));
            res.status(429).json({ message: "Too many requests" });
            return;
        }
        limiter.record(key);
        next();
    };
}
