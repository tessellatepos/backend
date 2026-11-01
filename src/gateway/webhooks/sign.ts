/**
 * Webhook signing. The header is `Tessellate-Signature: t=<unix>,v1=<hex>`
 * where the signature is HMAC-SHA256 over `<t>.<raw body>` with the
 * credential's webhook secret. The plugin-sdk gateway client verifies it with
 * the same construction.
 */
import { createHmac } from "node:crypto";

export const SIGNATURE_HEADER = "Tessellate-Signature";

/**
 * Signs a raw body for a timestamp.
 * @param secret the credential's webhook secret
 * @param timestampSeconds unix time in seconds
 * @param body the exact bytes sent
 * @returns the header value
 */
export function signWebhook(
    secret: string,
    timestampSeconds: number,
    body: string,
): string {
    const digest = createHmac("sha256", secret)
        .update(`${timestampSeconds}.${body}`)
        .digest("hex");
    return `t=${timestampSeconds},v1=${digest}`;
}
