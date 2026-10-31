/**
 * API credentials for the gateway: a client id (public) and a client secret
 * (shown once, stored as a sha-256 hash). Rotation keeps the client id and
 * the previous secret until its overlap ends. The webhook secret signs
 * deliveries and is stored encrypted.
 */
import { createHash, randomBytes } from "node:crypto";
import { Logger } from "tslog";
import {
    CORE_SCOPES,
    type ApiCredential,
    type ApiCredentialInput,
    type ApiCredentialSecret,
    type Scope,
} from "@tessellatepos/sdk";
import { decrypt, encrypt, safeEqual } from "@/services/crypto";
import { getLocationById } from "@/services/db/locations";
import {
    getCredentialRow,
    insertCredential,
    listCredentialRows,
    updateCredentialRow,
    type CredentialRow,
} from "@/services/db/credentials";

const logger = new Logger({ name: "credentials" });

/** Thrown for input the service refuses. The message is safe to show. */
export class CredentialValidationError extends Error {}

/** Thrown when a credential id does not exist. */
export class CredentialNotFoundError extends Error {}

const DEFAULT_RATE_LIMIT = 120;
const MAX_RATE_LIMIT = 10_000;
const MAX_OVERLAP_SECONDS = 86_400;

/** A credential that authenticated. `publishable` means no secret was sent. */
export interface AuthenticatedCredential {
    credential: ApiCredential;
    publishable: boolean;
}

/**
 * SHA-256 (hex) of a secret. Secrets carry 256 random bits, so a fast hash is
 * sufficient and lets lookups compare in constant time.
 * @param secret the client secret
 * @returns the hex digest
 */
export function hashSecret(secret: string): string {
    return createHash("sha256").update(secret).digest("hex");
}

function randomId(prefix: string, bytes: number): string {
    return `${prefix}${randomBytes(bytes).toString("base64url")}`;
}

/**
 * Maps a stored row to the public shape. Hashes and the encrypted webhook
 * secret are never copied across.
 * @param row the stored row
 * @returns the credential without any secret material
 */
export function toApiCredential(row: CredentialRow): ApiCredential {
    return {
        id: row.id,
        name: row.name,
        scopes: row.scopes as Scope[],
        location_ids: row.location_ids,
        rate_limit_per_minute: row.rate_limit_per_minute,
        expires_at: row.expires_at?.toISOString() ?? null,
        origins: row.origins,
        ...(row.webhook_url ? { webhook_url: row.webhook_url } : {}),
        created_by: row.created_by,
        created_at: row.created_at.toISOString(),
        last_used_at: row.last_used_at?.toISOString() ?? null,
        ...(row.revoked_at ? { revoked_at: row.revoked_at.toISOString() } : {}),
    };
}

/**
 * Whether a scope may be granted to a credential. Core scopes must be
 * known; `*` and `credentials:admin` are never grantable (owner only).
 * @param scope the scope
 * @returns true when it may be granted
 */
export function isGrantableScope(scope: string): boolean {
    if (scope === "*" || scope === "credentials:admin") return false;
    if (/^plugin:[a-z0-9-]+:[a-z0-9-]+$/.test(scope)) return true;
    return (CORE_SCOPES as readonly string[]).includes(scope);
}

function validateScopes(scopes: unknown): Scope[] {
    if (!Array.isArray(scopes) || scopes.length === 0) {
        throw new CredentialValidationError("Choose at least one scope");
    }
    if (scopes.length > 50) {
        throw new CredentialValidationError("Too many scopes");
    }
    const unique = [...new Set(scopes)];
    for (const scope of unique) {
        if (typeof scope !== "string" || !isGrantableScope(scope)) {
            throw new CredentialValidationError(
                `Scope "${String(scope)}" cannot be granted`,
            );
        }
    }
    return unique as Scope[];
}

async function validateLocations(ids: unknown): Promise<string[]> {
    if (!Array.isArray(ids) || ids.length === 0) {
        throw new CredentialValidationError("Choose at least one location");
    }
    const unique = [...new Set(ids)];
    if (unique.length > 50) {
        throw new CredentialValidationError("Too many locations");
    }
    for (const id of unique) {
        if (typeof id !== "string" || !id) {
            throw new CredentialValidationError("Invalid location id");
        }
        if (!(await getLocationById(id))) {
            throw new CredentialValidationError(`Unknown location "${id}"`);
        }
    }
    return unique as string[];
}

function isLoopback(host: string): boolean {
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}

function validateOrigins(origins: unknown): string[] {
    if (origins === undefined) return [];
    if (!Array.isArray(origins) || origins.length > 20) {
        throw new CredentialValidationError(
            "origins must be a list of up to 20",
        );
    }
    const out: string[] = [];
    for (const origin of [...new Set(origins)]) {
        let url: URL;
        try {
            url = new URL(String(origin));
        } catch {
            throw new CredentialValidationError(
                `Invalid origin "${String(origin)}"`,
            );
        }
        const ok =
            url.origin === origin &&
            (url.protocol === "https:" ||
                (url.protocol === "http:" && isLoopback(url.hostname)));
        if (!ok) {
            throw new CredentialValidationError(
                `Origin "${String(origin)}" must be an https origin with no path`,
            );
        }
        out.push(origin as string);
    }
    return out;
}

/**
 * Validates a webhook URL: https, or http to a loopback host for local
 * development. No credentials in the URL.
 * @param value the URL, or undefined/null to clear it
 * @returns the normalised URL, or null
 */
export function validateWebhookUrl(value: unknown): string | null {
    if (value === undefined || value === null || value === "") return null;
    let url: URL;
    try {
        url = new URL(String(value));
    } catch {
        throw new CredentialValidationError("webhook_url is not a valid URL");
    }
    const ok =
        url.protocol === "https:" ||
        (url.protocol === "http:" && isLoopback(url.hostname));
    // Link-local addresses (cloud metadata services) are never a webhook target.
    const linkLocal = url.hostname.startsWith("169.254.");
    if (!ok || linkLocal || url.username || url.password) {
        throw new CredentialValidationError(
            "webhook_url must be https (http only to localhost)",
        );
    }
    return url.toString();
}

function validateExpiry(value: unknown): Date | null {
    if (value === undefined || value === null) return null;
    const date = new Date(String(value));
    if (Number.isNaN(date.getTime())) {
        throw new CredentialValidationError("expires_at is not a valid date");
    }
    if (date.getTime() <= Date.now()) {
        throw new CredentialValidationError("expires_at must be in the future");
    }
    return date;
}

function validateRateLimit(value: unknown): number {
    if (value === undefined || value === null) return DEFAULT_RATE_LIMIT;
    if (
        typeof value !== "number" ||
        !Number.isInteger(value) ||
        value < 1 ||
        value > MAX_RATE_LIMIT
    ) {
        throw new CredentialValidationError(
            `rate_limit_per_minute must be 1 to ${MAX_RATE_LIMIT}`,
        );
    }
    return value;
}

function validateName(value: unknown): string {
    const name = typeof value === "string" ? value.trim() : "";
    if (!name || name.length > 100) {
        throw new CredentialValidationError("Name must be 1 to 100 characters");
    }
    return name;
}

/**
 * Creates a credential. The client secret and webhook secret are returned
 * here and nowhere else.
 * @param input the credential's settings
 * @param createdBy the user id of the owner creating it
 * @returns the credential and its secrets
 */
export async function createCredential(
    input: ApiCredentialInput,
    createdBy: string,
): Promise<ApiCredentialSecret> {
    const name = validateName(input.name);
    const scopes = validateScopes(input.scopes);
    const location_ids = await validateLocations(input.location_ids);
    const rate = validateRateLimit(input.rate_limit_per_minute);
    const expires = validateExpiry(input.expires_at);
    const origins = validateOrigins(input.origins);
    const webhookUrl = validateWebhookUrl(input.webhook_url);

    const id = randomId("tcid_", 16);
    const secret = randomId("tcs_", 32);
    const webhookSecret = randomId("whsec_", 32);
    const now = new Date();

    await insertCredential({
        id,
        name,
        scopes,
        location_ids,
        origins,
        rate_limit_per_minute: rate,
        expires_at: expires,
        webhook_url: webhookUrl,
        webhook_secret_encrypted: encrypt(webhookSecret),
        secret_hash: hashSecret(secret),
        created_by: createdBy,
        created_at: now,
        updated_at: now,
    });
    logger.info(`API credential ${id} created`);

    const row = await getCredentialRow(id);
    if (!row) throw new Error("Credential vanished after insert");
    return {
        credential: toApiCredential(row),
        client_id: id,
        client_secret: secret,
        webhook_secret: webhookSecret,
    };
}

/**
 * Lists every credential without secrets.
 * @returns the credentials, oldest first
 */
export async function listCredentials(): Promise<ApiCredential[]> {
    return (await listCredentialRows()).map(toApiCredential);
}

/**
 * Reads one credential without secrets.
 * @param id the client id
 * @returns the credential, or null
 */
export async function getCredential(id: string): Promise<ApiCredential | null> {
    const row = await getCredentialRow(id);
    return row ? toApiCredential(row) : null;
}

/**
 * Updates the editable settings. Secrets are changed only by rotation.
 * @param id the client id
 * @param patch the fields to change
 * @returns the updated credential
 */
export async function updateCredential(
    id: string,
    patch: Partial<ApiCredentialInput>,
): Promise<ApiCredential> {
    const row = await getCredentialRow(id);
    if (!row) throw new CredentialNotFoundError("Credential not found");
    const changes: Partial<Parameters<typeof insertCredential>[0]> = {};
    if (patch.name !== undefined) changes.name = validateName(patch.name);
    if (patch.scopes !== undefined)
        changes.scopes = validateScopes(patch.scopes);
    if (patch.location_ids !== undefined) {
        changes.location_ids = await validateLocations(patch.location_ids);
    }
    if (patch.rate_limit_per_minute !== undefined) {
        changes.rate_limit_per_minute = validateRateLimit(
            patch.rate_limit_per_minute,
        );
    }
    if (patch.expires_at !== undefined) {
        changes.expires_at = validateExpiry(patch.expires_at);
    }
    if (patch.origins !== undefined) {
        changes.origins = validateOrigins(patch.origins);
    }
    if (patch.webhook_url !== undefined) {
        changes.webhook_url = validateWebhookUrl(patch.webhook_url);
    }
    const updated = await updateCredentialRow(id, changes);
    if (!updated) throw new CredentialNotFoundError("Credential not found");
    return toApiCredential(updated);
}

/**
 * Issues a new client secret. The old one keeps working for
 * `overlapSeconds` (0 ends it at once). A second rotation within an overlap
 * ends the earlier secret at that point.
 * @param id the client id
 * @param overlapSeconds how long the old secret stays valid, 0 to 86400
 * @returns the credential and the new secret, shown once
 */
export async function rotateSecret(
    id: string,
    overlapSeconds = 0,
): Promise<{ credential: ApiCredential; client_secret: string }> {
    if (
        !Number.isInteger(overlapSeconds) ||
        overlapSeconds < 0 ||
        overlapSeconds > MAX_OVERLAP_SECONDS
    ) {
        throw new CredentialValidationError(
            `overlap_seconds must be 0 to ${MAX_OVERLAP_SECONDS}`,
        );
    }
    const row = await getCredentialRow(id);
    if (!row) throw new CredentialNotFoundError("Credential not found");
    if (row.revoked_at) {
        throw new CredentialValidationError(
            "A revoked credential cannot be rotated",
        );
    }
    const secret = randomId("tcs_", 32);
    const hasOverlap = overlapSeconds > 0;
    const updated = await updateCredentialRow(id, {
        secret_hash: hashSecret(secret),
        previous_secret_hash: hasOverlap ? row.secret_hash : null,
        previous_secret_expires_at: hasOverlap
            ? new Date(Date.now() + overlapSeconds * 1000)
            : null,
    });
    if (!updated) throw new CredentialNotFoundError("Credential not found");
    logger.info(`API credential ${id} secret rotated`);
    return { credential: toApiCredential(updated), client_secret: secret };
}

/**
 * Issues a new webhook secret. The old one stops signing at once.
 * @param id the client id
 * @returns the credential and the new webhook secret, shown once
 */
export async function rotateWebhookSecret(
    id: string,
): Promise<{ credential: ApiCredential; webhook_secret: string }> {
    const secret = randomId("whsec_", 32);
    const updated = await updateCredentialRow(id, {
        webhook_secret_encrypted: encrypt(secret),
    });
    if (!updated) throw new CredentialNotFoundError("Credential not found");
    logger.info(`API credential ${id} webhook secret rotated`);
    return { credential: toApiCredential(updated), webhook_secret: secret };
}

/**
 * Revokes a credential. Revocation is permanent and immediate.
 * @param id the client id
 * @returns the credential
 */
export async function revokeCredential(id: string): Promise<ApiCredential> {
    const updated = await updateCredentialRow(id, { revoked_at: new Date() });
    if (!updated) throw new CredentialNotFoundError("Credential not found");
    logger.info(`API credential ${id} revoked`);
    return toApiCredential(updated);
}

/**
 * Reads the decrypted webhook secret for signing. Internal to the webhook
 * sender; never returned by an API.
 * @param id the client id
 * @returns the secret, or null when the credential or its secret is gone
 */
export async function getWebhookSecret(id: string): Promise<string | null> {
    const row = await getCredentialRow(id);
    if (!row?.webhook_secret_encrypted) return null;
    return decrypt(row.webhook_secret_encrypted);
}

/** Browser origins a live credential allows, across all credentials. */
export async function listAllowedOrigins(): Promise<Set<string>> {
    const rows = await listCredentialRows();
    const origins = new Set<string>();
    for (const row of rows) {
        if (row.revoked_at) continue;
        for (const origin of row.origins) origins.add(origin);
    }
    return origins;
}

const USE_WRITE_INTERVAL_MS = 60_000;
const lastUseWritten = new Map<string, number>();

/**
 * Records that a credential was used, at most once a minute per credential
 * per process, so the request path does not write on every call. A failure
 * is logged and ignored: it must not fail the request.
 * @param id the client id
 * @param now current time in ms, injectable for tests
 */
export async function recordCredentialUse(
    id: string,
    now = Date.now(),
): Promise<void> {
    const last = lastUseWritten.get(id) ?? 0;
    if (now - last < USE_WRITE_INTERVAL_MS) return;
    lastUseWritten.set(id, now);
    try {
        await updateCredentialRow(id, { last_used_at: new Date(now) });
    } catch (err) {
        lastUseWritten.delete(id);
        logger.warn(`Could not record use of credential ${id}`, err);
    }
}

/**
 * Checks a presented client id and secret. A missing secret (empty string)
 * makes a publishable call, allowed only by the gateway's origin rule.
 * A revoked, expired or unknown credential never authenticates, and neither
 * does a wrong or expired secret.
 * @param clientId the client id from the Authorization header
 * @param clientSecret the client secret, or "" for a publishable call
 * @param now current time, injectable for tests
 * @returns the credential, or null
 */
export async function authenticateCredential(
    clientId: string,
    clientSecret: string,
    now = new Date(),
): Promise<AuthenticatedCredential | null> {
    const row = await getCredentialRow(clientId);
    if (!row || row.revoked_at) return null;
    if (row.expires_at && row.expires_at.getTime() <= now.getTime())
        return null;

    if (clientSecret === "") {
        return { credential: toApiCredential(row), publishable: true };
    }
    const presented = hashSecret(clientSecret);
    const current = safeEqual(presented, row.secret_hash);
    const previous =
        row.previous_secret_hash !== null &&
        row.previous_secret_expires_at !== null &&
        row.previous_secret_expires_at.getTime() > now.getTime() &&
        safeEqual(presented, row.previous_secret_hash);
    if (!current && !previous) return null;
    return { credential: toApiCredential(row), publishable: false };
}
