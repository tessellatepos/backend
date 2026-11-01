/**
 * Resolves `Authorization: Basic base64(client_id:client_secret)` to a
 * credential principal. Only the gateway surface runs this resolver, so a
 * credential is never accepted on an internal route.
 */
import type { Request } from "express";
import type { Principal } from "@tessellatepos/sdk";
import { registerPrincipalResolver } from "@/auth/principal";
import { authenticateCredential } from "@/services/credentials";

/** What the gateway guards need to know about the authenticated credential. */
export interface GatewayCredentialContext {
    id: string;
    publishable: boolean;
    origins: string[];
    rate_limit_per_minute: number;
}

declare global {
    // eslint-disable-next-line @typescript-eslint/no-namespace
    namespace Express {
        interface Request {
            /**
             * Set when a gateway credential authenticated for this request.
             * `publishable` is true when only the client id was sent.
             */
            gatewayCredential?: GatewayCredentialContext;
        }
    }
}

/**
 * Splits a Basic Authorization header into its client id and secret.
 * @param header the Authorization header value
 * @returns the parts, or null when the header is absent or malformed
 */
export function parseBasicCredentials(
    header: string | undefined,
): { clientId: string; clientSecret: string } | null {
    const match = /^Basic\s+(\S+)$/i.exec(header ?? "");
    if (!match) return null;
    const decoded = Buffer.from(match[1], "base64").toString("utf8");
    const colon = decoded.indexOf(":");
    if (colon <= 0) return null;
    return {
        clientId: decoded.slice(0, colon),
        clientSecret: decoded.slice(colon + 1),
    };
}

/**
 * The "credential" principal resolver.
 * @param req the gateway request
 * @returns the credential's principal, or null
 */
export async function resolveCredentialPrincipal(
    req: Request,
): Promise<Principal | null> {
    const parsed = parseBasicCredentials(req.headers.authorization);
    if (!parsed) return null;
    const auth = await authenticateCredential(
        parsed.clientId,
        parsed.clientSecret,
    );
    if (!auth) return null;
    const { credential, publishable } = auth;
    req.gatewayCredential = {
        id: credential.id,
        publishable,
        origins: credential.origins,
        rate_limit_per_minute: credential.rate_limit_per_minute,
    };
    return {
        kind: "credential",
        id: credential.id,
        display_name: credential.name,
        roles: [],
        scopes: credential.scopes,
        location_ids: credential.location_ids,
    };
}

let installed = false;

/**
 * Registers the credential resolver once per process. Called by createApp,
 * so every app (server and tests) gets it exactly once.
 */
export function installGatewayPrincipals(): void {
    if (installed) return;
    installed = true;
    registerPrincipalResolver("credential", resolveCredentialPrincipal);
}
