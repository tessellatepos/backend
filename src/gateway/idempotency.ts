/**
 * Idempotency for gateway writes. A key is scoped to the credential and
 * remembered for 24 hours with a hash of the request it first came with, so a
 * retry with the same body replays the first answer and the same key with a
 * different body is refused. The first use claims the key atomically, so two
 * concurrent first uses cannot both run.
 */
import { createHash } from "node:crypto";
import { bigintReplacer } from "@tessellatepos/sdk";
import { getRedisClient } from "@/services/redis";
import type { CapturedResponse } from "@/gateway/invoke";

/** How long a finished answer is kept. */
export const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;

/** How long a claimed but unfinished key blocks retries (crash safety). */
const PENDING_TTL_MS = 120_000;

const KEY_PATTERN = /^[\x21-\x7e]{1,255}$/;

type Stored =
    | { hash: string; state: "pending" }
    | {
          hash: string;
          state: "done";
          response: { status: number; body: unknown };
      };

/** What claiming a key found. */
export type IdempotencyClaim =
    | {
          kind: "claimed";
          /** Remembers the answer for replays. */
          complete(response: CapturedResponse): Promise<void>;
          /** Forgets the key so a retry may run again (the call failed). */
          release(): Promise<void>;
      }
    | { kind: "replay"; response: CapturedResponse }
    | { kind: "mismatch" }
    | { kind: "in_progress" };

/**
 * Whether a header value is usable as an idempotency key.
 * @param key the Idempotency-Key header value
 * @returns true for 1 to 255 printable ASCII characters, no spaces
 */
export function isValidIdempotencyKey(key: string): boolean {
    return KEY_PATTERN.test(key);
}

function canonical(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonical);
    if (typeof value === "object" && value !== null) {
        return Object.fromEntries(
            Object.entries(value as Record<string, unknown>)
                .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
                .map(([k, v]) => [k, canonical(v)]),
        );
    }
    return value;
}

/**
 * Hashes a request body independent of key order.
 * @param body the validated request body
 * @returns a hex digest
 */
export function hashBody(body: unknown): string {
    return createHash("sha256")
        .update(JSON.stringify(canonical(body), bigintReplacer))
        .digest("hex");
}

/**
 * Claims a key for a credential, or reports what the earlier use left.
 * @param credentialId the calling credential
 * @param key the Idempotency-Key value
 * @param bodyHash {@link hashBody} of the request
 * @returns the claim
 * @throws when Redis is unreachable (callers fail closed)
 */
export async function claimIdempotencyKey(
    credentialId: string,
    key: string,
    bodyHash: string,
): Promise<IdempotencyClaim> {
    const redis = await getRedisClient();
    const redisKey = `gw:idem:${credentialId}:${createHash("sha256").update(key).digest("hex")}`;
    const pending: Stored = { hash: bodyHash, state: "pending" };

    // A key can expire between the failed claim and the read; try twice.
    for (let attempt = 0; attempt < 2; attempt++) {
        const won = await redis.set(redisKey, JSON.stringify(pending), {
            condition: "NX",
            expiration: { type: "PX", value: PENDING_TTL_MS },
        });
        if (won) {
            return {
                kind: "claimed",
                complete: async (response) => {
                    const done: Stored = {
                        hash: bodyHash,
                        state: "done",
                        response: {
                            status: response.status,
                            body: response.body,
                        },
                    };
                    await redis.set(redisKey, JSON.stringify(done), {
                        expiration: {
                            type: "EX",
                            value: IDEMPOTENCY_TTL_SECONDS,
                        },
                    });
                },
                release: async () => {
                    await redis.del(redisKey);
                },
            };
        }
        const raw = await redis.get(redisKey);
        if (raw === null) continue;
        const stored = JSON.parse(raw) as Stored;
        if (stored.hash !== bodyHash) return { kind: "mismatch" };
        if (stored.state === "pending") return { kind: "in_progress" };
        return {
            kind: "replay",
            response: {
                status: stored.response.status,
                headers: {},
                body: stored.response.body,
            },
        };
    }
    return { kind: "in_progress" };
}
