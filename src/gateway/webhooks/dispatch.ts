/**
 * Outbound webhooks: a host event becomes one delivery row per credential
 * that subscribes to it (has the read scope and, for a located event, the
 * location), then the worker sends each row as a signed POST.
 *
 * The queue is the delivery table behind this module's functions, so it can
 * move to a worker process later without changing callers.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { Logger } from "tslog";
import { bigintReplacer } from "@tessellatepos/sdk";
import {
    claimDueDeliveries,
    getDelivery,
    insertDeliveries,
    updateDelivery,
    type DeliveryRow,
} from "@/services/db/webhookDeliveries";
import {
    listCredentialRows,
    getCredentialRow,
} from "@/services/db/credentials";
import { getWebhookSecret } from "@/services/credentials";
import { WEBHOOK_EVENTS } from "@/gateway/webhooks/events";
import { SIGNATURE_HEADER, signWebhook } from "@/gateway/webhooks/sign";

const logger = new Logger({ name: "webhooks" });

/** Sends stop after this many attempts; the row is then `failed`. */
export const MAX_ATTEMPTS = 8;
/** A claimed row is held this long before another sender may retry it. */
export const LEASE_MS = 60_000;
/** One POST may take this long. */
export const TIMEOUT_MS = 10_000;
const BASE_BACKOFF_MS = 60_000;
const MAX_BACKOFF_MS = 6 * 60 * 60 * 1000;

/**
 * Delay before the next attempt, after `attempts` tries: 1, 2, 4 minutes and
 * so on, capped at six hours.
 * @param attempts the attempts made so far (at least 1)
 * @returns milliseconds
 */
export function backoffMs(attempts: number): number {
    return Math.min(
        BASE_BACKOFF_MS * 2 ** Math.max(0, attempts - 1),
        MAX_BACKOFF_MS,
    );
}

/**
 * Builds the event envelope. The id is stable across retries and replays, so
 * a receiver can de-duplicate.
 * @param type the webhook type, e.g. "order.created"
 * @param data the public data
 * @param now the event time
 * @returns the JSON body, as sent
 */
export function eventBody(type: string, data: unknown, now: Date): string {
    const envelope = {
        id: `evt_${randomBytes(12).toString("base64url")}`,
        type,
        created_at: now.toISOString(),
        data,
    };
    return JSON.stringify(envelope, bigintReplacer);
}

/**
 * Fans a host event out to the credentials that subscribe to it.
 * @param name the host event name, e.g. "orderCreated"
 * @param args the event's arguments
 * @param now the event time
 * @returns the number of deliveries queued
 */
export async function queueEvent(
    name: string,
    args: unknown[],
    now = new Date(),
): Promise<number> {
    const spec = WEBHOOK_EVENTS[name];
    if (!spec) return 0;
    const built = spec.toData(args);
    if (!built) {
        logger.warn(
            `Dropped webhook event ${name}: its data did not match the schema`,
        );
        return 0;
    }
    const body = eventBody(spec.type, built.data, now);
    const rows = (await listCredentialRows())
        .filter(
            (c) =>
                c.webhook_url !== null &&
                c.revoked_at === null &&
                (c.expires_at === null ||
                    c.expires_at.getTime() > now.getTime()) &&
                c.scopes.includes(spec.scope) &&
                (built.locationId === undefined ||
                    c.location_ids.includes(built.locationId)),
        )
        .map((c) => ({
            id: `whd_${randomUUID()}`,
            event_id: JSON.parse(body).id as string,
            event_type: spec.type,
            credential_id: c.id,
            body,
            status: "pending",
            attempts: 0,
            next_attempt_at: now,
            created_at: now,
        }));
    await insertDeliveries(rows);
    return rows.length;
}

/**
 * Publishes a host event to the webhook queue. Never throws: a failure to
 * queue is logged, and the request that caused the event is not affected.
 * @param name the host event name
 * @param args the event's arguments
 */
export function publishGatewayEvent(name: string, args: unknown[]): void {
    queueEvent(name, args).catch((err) =>
        logger.error(`Could not queue webhook for ${name}`, err),
    );
}

async function finish(
    row: DeliveryRow,
    now: Date,
    outcome:
        | { ok: true; status: number }
        | { ok: false; status: number | null; error: string },
): Promise<void> {
    if (outcome.ok) {
        await updateDelivery(row.id, {
            status: "delivered",
            last_status_code: outcome.status,
            last_error: null,
            delivered_at: now,
        });
        return;
    }
    const exhausted = row.attempts >= MAX_ATTEMPTS;
    await updateDelivery(row.id, {
        status: exhausted ? "failed" : "pending",
        last_status_code: outcome.status,
        last_error: outcome.error.slice(0, 200),
        next_attempt_at: exhausted
            ? now
            : new Date(now.getTime() + backoffMs(row.attempts)),
    });
}

/**
 * Sends one claimed delivery.
 * @param row the claimed row
 * @param now the attempt time
 * @param fetchImpl the fetch to use (tests inject one)
 */
export async function sendDelivery(
    row: DeliveryRow,
    now: Date,
    fetchImpl: typeof fetch = fetch,
): Promise<void> {
    const credential = await getCredentialRow(row.credential_id);
    if (!credential?.webhook_url || credential.revoked_at) {
        await finish(row, now, {
            ok: false,
            status: null,
            error: "credential has no webhook",
        });
        return;
    }
    const secret = await getWebhookSecret(row.credential_id);
    if (!secret) {
        await finish(row, now, {
            ok: false,
            status: null,
            error: "no webhook secret",
        });
        return;
    }
    const signature = signWebhook(
        secret,
        Math.floor(now.getTime() / 1000),
        row.body,
    );
    try {
        const res = await fetchImpl(credential.webhook_url, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                [SIGNATURE_HEADER]: signature,
                "user-agent": "Tessellate-Webhooks/1",
            },
            body: row.body,
            // A redirect would send the signed body somewhere the owner did not set.
            redirect: "manual",
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        await res.body?.cancel().catch(() => undefined);
        if (res.status >= 200 && res.status < 300) {
            await finish(row, now, { ok: true, status: res.status });
        } else {
            await finish(row, now, {
                ok: false,
                status: res.status,
                error: `HTTP ${res.status}`,
            });
        }
    } catch (err) {
        // The error name only: messages can carry the URL.
        const name = err instanceof Error ? err.name : "Error";
        await finish(row, now, { ok: false, status: null, error: name });
    }
}

/**
 * One pass of the worker: claims what is due and sends it.
 * @param options the clock, batch size and fetch to use
 * @param options.now the current time
 * @param options.limit the most deliveries per pass
 * @param options.fetchImpl the fetch to use
 * @returns how many deliveries were attempted
 */
export async function deliverDue(
    options: {
        now?: Date;
        limit?: number;
        fetchImpl?: typeof fetch;
    } = {},
): Promise<number> {
    const now = options.now ?? new Date();
    const rows = await claimDueDeliveries(now, options.limit ?? 20, LEASE_MS);
    for (const row of rows) {
        await sendDelivery(row, now, options.fetchImpl);
    }
    return rows.length;
}

/**
 * Queues a new attempt of an earlier delivery: same event id, same body.
 * @param credentialId the credential the delivery belongs to
 * @param deliveryId the delivery to replay
 * @param now the time
 * @returns the new row, or null when the delivery does not exist
 */
export async function replayDelivery(
    credentialId: string,
    deliveryId: string,
    now = new Date(),
): Promise<DeliveryRow | null> {
    const original = await getDelivery(credentialId, deliveryId);
    if (!original) return null;
    const row = {
        id: `whd_${randomUUID()}`,
        event_id: original.event_id,
        event_type: original.event_type,
        credential_id: credentialId,
        body: original.body,
        status: "pending",
        attempts: 0,
        next_attempt_at: now,
        replay_of: original.id,
        created_at: now,
    };
    await insertDeliveries([row]);
    return {
        ...row,
        last_status_code: null,
        last_error: null,
        delivered_at: null,
    } as DeliveryRow;
}
