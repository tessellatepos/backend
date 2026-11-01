/**
 * The extra rules around `orders.create`: the Idempotency-Key header and the
 * cap on a credential's open unpaid orders. Runs after validation, around the
 * in-process call; every refusal uses the gateway error shape.
 */
import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import { and, count, eq } from "drizzle-orm";
import { Logger } from "tslog";
import { drizzleDB } from "@/services/db/postgres";
import { ordersTable } from "@/services/db/schema";
import { openUnpaidOrder } from "@/services/db/orders";
import { getRedisClient } from "@/services/redis";
import { sendGatewayError } from "@/gateway/guards";
import {
    claimIdempotencyKey,
    hashBody,
    isValidIdempotencyKey,
} from "@/gateway/idempotency";
import { openOrderCap } from "@/gateway/lifecycleConfig";
import type { CapturedResponse } from "@/gateway/invoke";

const logger = new Logger({ name: "gateway" });

/** The operation these rules apply to. */
export const GUARDED_CREATE_OPERATION = "orders.create";

const LOCK_TTL_MS = 30_000;
const LOCK_WAIT_MS = 5_000;

const RELEASE_LOCK = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

/**
 * Counts a credential's open orders with no tender.
 * @param credentialId the credential
 * @returns how many it holds
 */
export async function countOpenOrders(credentialId: string): Promise<number> {
    const [row] = await drizzleDB
        .select({ n: count() })
        .from(ordersTable)
        .where(
            and(
                eq(ordersTable.createdByCredential, credentialId),
                openUnpaidOrder,
            ),
        );
    return row?.n ?? 0;
}

/**
 * Runs `fn` while holding a Redis lock on `key`, so work that must not
 * interleave (on this or another instance) is serialised.
 * @param key the lock's Redis key
 * @param fn the work
 * @returns the result, or null when the lock could not be taken in time
 */
export async function withRedisLock<T>(
    key: string,
    fn: () => Promise<T>,
): Promise<{ value: T } | null> {
    const redis = await getRedisClient();
    const token = randomUUID();
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
        const won = await redis.set(key, token, {
            condition: "NX",
            expiration: { type: "PX", value: LOCK_TTL_MS },
        });
        if (won) break;
        if (Date.now() >= deadline) return null;
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    try {
        return { value: await fn() };
    } finally {
        await redis.eval(RELEASE_LOCK, { keys: [key], arguments: [token] });
    }
}

/**
 * Serialises the cap check and the order it admits for one credential.
 */
function withCreateLock<T>(
    credentialId: string,
    fn: () => Promise<T>,
): Promise<{ value: T } | null> {
    return withRedisLock(`gw:create-lock:${credentialId}`, fn);
}

/**
 * Applies idempotency and the open-order cap around an order creation.
 * @param req the gateway request (credential and Idempotency-Key header)
 * @param res the gateway response; set when the guard answers itself
 * @param payload the validated body, hashed for idempotency
 * @param run performs the creation
 * @returns what to relay, or null when this function already answered
 */
export async function guardedCreate(
    req: Request,
    res: Response,
    payload: unknown,
    run: () => Promise<CapturedResponse>,
): Promise<CapturedResponse | null> {
    const credential = req.gatewayCredential;
    if (!credential) {
        sendGatewayError(res, 401, "unauthorized", "Unauthorized");
        return null;
    }
    const header = req.get("idempotency-key");
    if (header !== undefined && !isValidIdempotencyKey(header)) {
        sendGatewayError(
            res,
            400,
            "invalid_idempotency_key",
            "Idempotency-Key must be 1 to 255 printable characters",
        );
        return null;
    }

    try {
        const claim =
            header === undefined
                ? null
                : await claimIdempotencyKey(
                      credential.id,
                      header,
                      hashBody(payload),
                  );
        if (claim?.kind === "mismatch") {
            sendGatewayError(
                res,
                422,
                "idempotency_key_reused",
                "This Idempotency-Key was used with a different request",
            );
            return null;
        }
        if (claim?.kind === "in_progress") {
            sendGatewayError(
                res,
                409,
                "idempotency_in_progress",
                "A request with this Idempotency-Key is still in progress",
            );
            return null;
        }
        if (claim?.kind === "replay") {
            res.set("Idempotent-Replayed", "true");
            return claim.response;
        }

        let result: CapturedResponse | null = null;
        try {
            const locked = await withCreateLock(credential.id, async () => {
                if ((await countOpenOrders(credential.id)) >= openOrderCap()) {
                    sendGatewayError(
                        res,
                        429,
                        "open_order_limit",
                        "Too many unpaid orders are open for this credential",
                    );
                    return null;
                }
                return run();
            });
            if (!locked) {
                sendGatewayError(
                    res,
                    503,
                    "unavailable",
                    "The gateway is temporarily unavailable",
                );
            } else {
                result = locked.value;
            }
        } catch (err) {
            await claim?.release();
            throw err;
        }

        // Only a success is remembered: a refusal or failure may be retried.
        if (claim) {
            if (result && result.status < 400) {
                // The order exists; failing to remember it must not hide it.
                await claim.complete(result).catch((err: unknown) => {
                    logger.error("Could not store idempotent answer", err);
                });
            } else {
                await claim.release().catch(() => undefined);
            }
        }
        return result;
    } catch (err) {
        logger.error("Order create guard failed", err);
        sendGatewayError(res, 500, "internal_error", "Internal error");
        return null;
    }
}
