/**
 * The OAuth 2 authorization-code flow (with PKCE) a member login runs. The
 * functions take a `fetch` so tests can stand in for the provider.
 */
import { createHash, randomBytes } from "node:crypto";
import type { MemberProfile } from "@tessellatepos/plugin-sdk/server";
import type { EffectiveMemberConfig } from "@/auth/members/providers";

export type FetchLike = typeof fetch;

/** Thrown when the provider's answer cannot be used. Never carries a secret. */
export class MemberOAuthError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "MemberOAuthError";
    }
}

/** A PKCE pair. */
export interface Pkce {
    verifier: string;
    challenge: string;
}

/**
 * @returns a fresh PKCE verifier and its S256 challenge
 */
export function createPkce(): Pkce {
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    return { verifier, challenge };
}

/**
 * Builds the URL to send the browser to.
 * @param config the effective configuration
 * @param redirectUri the callback URL registered at the provider
 * @param state the CSRF state value
 * @param challenge the PKCE S256 challenge
 * @returns the authorization URL
 */
export function buildAuthorizeUrl(
    config: EffectiveMemberConfig,
    redirectUri: string,
    state: string,
    challenge: string,
): string {
    const url = new URL(config.authorizationUrl);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", config.clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    if (config.scopes.length) {
        url.searchParams.set("scope", config.scopes.join(" "));
    }
    return url.toString();
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
    try {
        const body: unknown = await res.json();
        if (typeof body === "object" && body !== null && !Array.isArray(body)) {
            return body as Record<string, unknown>;
        }
    } catch {
        // fall through
    }
    throw new MemberOAuthError("The provider returned an unreadable response");
}

/**
 * Exchanges an authorization code for an access token.
 * @param config the effective configuration
 * @param redirectUri the same callback URL used to start the flow
 * @param code the code from the callback
 * @param verifier the PKCE verifier from the flow start
 * @param doFetch the fetch to use
 * @returns the access token
 * @throws MemberOAuthError when the provider refuses or answers badly
 */
export async function exchangeCode(
    config: EffectiveMemberConfig,
    redirectUri: string,
    code: string,
    verifier: string,
    doFetch: FetchLike = fetch,
): Promise<string> {
    const res = await doFetch(config.tokenUrl, {
        method: "POST",
        headers: {
            "content-type": "application/x-www-form-urlencoded",
            accept: "application/json",
        },
        body: new URLSearchParams({
            grant_type: "authorization_code",
            code,
            redirect_uri: redirectUri,
            client_id: config.clientId,
            client_secret: config.clientSecret,
            code_verifier: verifier,
        }),
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
        throw new MemberOAuthError(
            `The provider's token endpoint answered ${res.status}`,
        );
    }
    const body = await readJson(res);
    if (typeof body.access_token !== "string" || body.access_token === "") {
        throw new MemberOAuthError("The provider returned no access token");
    }
    return body.access_token;
}

function text(value: unknown): string | undefined {
    return typeof value === "string" && value.trim() !== ""
        ? value.trim()
        : undefined;
}

/**
 * Normalises a user-info response. The subject is `sub`, else `id`.
 * @param provider the member login's id
 * @param raw the user-info JSON
 * @returns the profile
 * @throws MemberOAuthError when no subject can be found
 */
export function toMemberProfile(
    provider: string,
    raw: Record<string, unknown>,
): MemberProfile {
    const subject =
        typeof raw.sub === "string" || typeof raw.sub === "number"
            ? String(raw.sub)
            : typeof raw.id === "string" || typeof raw.id === "number"
              ? String(raw.id)
              : "";
    if (subject === "") {
        throw new MemberOAuthError("The provider returned no user id");
    }
    const verified = raw.email_verified ?? raw.verified;
    return {
        provider,
        subject,
        email: text(raw.email),
        email_verified: typeof verified === "boolean" ? verified : undefined,
        name: text(raw.name) ?? text(raw.global_name) ?? text(raw.username),
        username: text(raw.username),
        raw,
    };
}

/**
 * Fetches the signed-in person's profile.
 * @param provider the member login's id
 * @param config the effective configuration
 * @param accessToken the token from {@link exchangeCode}
 * @param doFetch the fetch to use
 * @returns the profile
 * @throws MemberOAuthError when the provider refuses or answers badly
 */
export async function fetchMemberProfile(
    provider: string,
    config: EffectiveMemberConfig,
    accessToken: string,
    doFetch: FetchLike = fetch,
): Promise<MemberProfile> {
    const res = await doFetch(config.userInfoUrl, {
        headers: {
            authorization: `Bearer ${accessToken}`,
            accept: "application/json",
        },
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
        throw new MemberOAuthError(
            `The provider's user-info endpoint answered ${res.status}`,
        );
    }
    return toMemberProfile(provider, await readJson(res));
}

/**
 * Whether a return URL is safe to redirect to after login: a path on this
 * host, or an origin the deployment trusts.
 * @param value the `returnTo` value
 * @param trustedOrigins origins that are allowed
 * @returns true when safe
 */
export function isSafeReturnTo(
    value: string,
    trustedOrigins: readonly string[],
): boolean {
    if (value.startsWith("/")) {
        return !value.startsWith("//") && !value.includes("\\");
    }
    try {
        const url = new URL(value);
        return (
            (url.protocol === "https:" || url.protocol === "http:") &&
            trustedOrigins.includes(url.origin)
        );
    } catch {
        return false;
    }
}
