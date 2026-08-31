import { SquareClient, SquareEnvironment } from "square";
import type { ObtainTokenRequest, ObtainTokenResponse } from "square";
import { configDotenv } from "dotenv";
import { Logger } from "tslog";
import { decrypt, encrypt, randomToken, safeEqual } from "@/services/crypto";
import {
    deleteConfigSystem,
    getConfigSystem,
    upsertConfigSystem,
} from "@/services/db/configSystem";

configDotenv();

const logger = new Logger();

/**
 * Permissions requested from the seller. PAYMENTS_WRITE_IN_PERSON is what
 * lets the short-lived token authorize the Mobile Payments SDK on a phone.
 */
const SQUARE_SCOPES = [
    "MERCHANT_PROFILE_READ",
    "ITEMS_READ",
    "PAYMENTS_WRITE",
    "PAYMENTS_WRITE_IN_PERSON",
    "PAYMENTS_READ",
    "ORDERS_WRITE",
    "ORDERS_READ",
];

/**
 * Square deployment to talk to. SQUARE_ENVIRONMENT=sandbox runs the OAuth
 * flow and every provider call against Square's sandbox — a fake seller with
 * fake catalog and fake money, so testing never touches a real account.
 * Anything else is production.
 * @returns the SDK environment to build Square clients with
 */
export function getSquareEnvironment(): SquareEnvironment {
    return process.env.SQUARE_ENVIRONMENT === "sandbox"
        ? SquareEnvironment.Sandbox
        : SquareEnvironment.Production;
}

/** The SDK environment values are base URLs, so the authorize page hangs off them. */
function getAuthorizeUrl(): string {
    return `${getSquareEnvironment()}/oauth2/authorize`;
}

/** Code-flow access tokens live 30 days; renew once inside this window. */
const REFRESH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** How long a pending authorization's CSRF state stays valid. */
const STATE_TTL_MS = 10 * 60 * 1000;

/**
 * Pending CSRF state values. In-memory is fine because the state only has to
 * survive the seconds between building the authorize URL and Square calling
 * the callback on this same process — a multi-instance deployment behind a
 * load balancer would need this in Redis instead.
 */
const pendingStates = new Map<string, number>();

/** Deduplicates concurrent refreshes so we don't race Square's rotation. */
let inFlightRefresh: Promise<string | null> | null = null;

/**
 * The OAuth endpoints authenticate with the application secret rather than a
 * seller token, so every call below overrides the Authorization header the
 * client would otherwise send.
 */
const oauthClient = new SquareClient({
    token: () => process.env.SQUARE_APPLICATION_SECRET ?? "",
    environment: getSquareEnvironment(),
});

/**
 * Reads the application credentials this deployment was registered with.
 * @returns the Square application id, secret and redirect URL
 */
function getAppCredentials() {
    const clientId = process.env.SQUARE_APPLICATION_ID;
    const clientSecret = process.env.SQUARE_APPLICATION_SECRET;
    const redirectUrl = process.env.SQUARE_REDIRECT_URL;

    if (!clientId || !clientSecret) {
        throw new Error(
            "SQUARE_APPLICATION_ID and SQUARE_APPLICATION_SECRET must be set to use Square OAuth",
        );
    }

    return { clientId, clientSecret, redirectUrl };
}

/**
 * Creates and remembers a CSRF state value for an authorization attempt.
 * @returns the state to include in the authorize URL
 */
export function createAuthorizationState(): string {
    const now = Date.now();
    for (const [state, createdAt] of pendingStates) {
        if (now - createdAt > STATE_TTL_MS) {
            pendingStates.delete(state);
        }
    }

    const state = randomToken();
    pendingStates.set(state, now);
    return state;
}

/**
 * Builds the Square authorization URL the seller is sent to.
 * @param state the CSRF state from {@link createAuthorizationState}
 * @returns the fully-formed authorize URL
 */
export function getAuthorizationUrl(state: string): string {
    const { clientId, redirectUrl } = getAppCredentials();

    const params = new URLSearchParams({
        client_id: clientId,
        scope: SQUARE_SCOPES.join(" "),
        session: "false",
        state,
    });

    if (redirectUrl) {
        params.set("redirect_uri", redirectUrl);
    }

    return `${getAuthorizeUrl()}?${params.toString()}`;
}

/**
 * Checks a state value returned by Square against the pending set, consuming
 * it so a replayed callback fails.
 * @param state the state Square echoed back
 * @returns true if the state was issued by us and hasn't expired
 */
function consumeState(state: string): boolean {
    for (const [pending, createdAt] of pendingStates) {
        if (safeEqual(pending, state)) {
            pendingStates.delete(pending);
            return Date.now() - createdAt <= STATE_TTL_MS;
        }
    }
    return false;
}

/**
 * Looks up the seller's main location, since the code-flow token response
 * doesn't include one and every payment needs a location id.
 * @param accessToken a valid seller access token
 * @returns the location id, or null if the seller has none
 */
async function fetchPrimaryLocationId(
    accessToken: string,
): Promise<string | null> {
    const client = new SquareClient({
        token: accessToken,
        environment: getSquareEnvironment(),
    });

    const response = await client.locations.list();
    const locations = response.locations ?? [];
    const active = locations.find((location) => location.status === "ACTIVE");

    return active?.id ?? locations[0]?.id ?? null;
}

/**
 * Exchanges the authorization code Square sent to the callback for a token
 * pair and stores it encrypted. Rejects a state we didn't issue.
 * @param code the authorization code from the callback query
 * @param state the CSRF state from the callback query
 */
export async function handleCallback(
    code: string,
    state: string,
): Promise<void> {
    if (!consumeState(state)) {
        throw new Error("Invalid or expired OAuth state");
    }

    const { clientId, clientSecret, redirectUrl } = getAppCredentials();

    const response = await obtainToken({
        clientId,
        clientSecret,
        code,
        redirectUri: redirectUrl,
        grantType: "authorization_code",
    });

    const { accessToken, refreshToken } = response;
    if (!accessToken || !refreshToken) {
        throw new Error("Square did not return an access and refresh token");
    }

    const locationId = await fetchPrimaryLocationId(accessToken);

    await upsertConfigSystem({
        encryptedAccessToken: encrypt(accessToken),
        encryptedRefreshToken: encrypt(refreshToken),
        applicationId: clientId,
        locationId,
        merchantId: response.merchantId ?? null,
        tokenExpiresAt: response.expiresAt
            ? new Date(response.expiresAt)
            : null,
        refreshTokenExpiresAt: response.refreshTokenExpiresAt
            ? new Date(response.refreshTokenExpiresAt)
            : null,
        updatedAt: new Date(),
    });

    logger.info(
        `Square OAuth authorization stored for merchant ${response.merchantId}`,
    );
}

/**
 * Calls Square's ObtainToken endpoint. The Authorization header is dropped —
 * this endpoint authenticates with the credentials in the body.
 * @param request the ObtainToken request body
 * @returns Square's token response
 */
async function obtainToken(
    request: ObtainTokenRequest,
): Promise<ObtainTokenResponse> {
    return oauthClient.oAuth.obtainToken(request, {
        headers: { Authorization: null },
    });
}

/**
 * Trades the stored refresh token for a fresh long-lived access token and
 * persists it.
 * @returns the new access token, or null if this deployment isn't authorized
 */
async function refreshAccessToken(): Promise<string | null> {
    const config = await getConfigSystem();
    if (!config?.encryptedRefreshToken) {
        return null;
    }

    const { clientId, clientSecret } = getAppCredentials();

    const response = await obtainToken({
        clientId,
        clientSecret,
        refreshToken: decrypt(config.encryptedRefreshToken),
        grantType: "refresh_token",
    });

    if (!response.accessToken) {
        throw new Error("Square did not return an access token on refresh");
    }

    await upsertConfigSystem({
        encryptedAccessToken: encrypt(response.accessToken),
        // The code flow returns the same refresh token; PKCE rotates it.
        encryptedRefreshToken: response.refreshToken
            ? encrypt(response.refreshToken)
            : config.encryptedRefreshToken,
        applicationId: config.applicationId,
        locationId: config.locationId,
        merchantId: response.merchantId ?? config.merchantId,
        tokenExpiresAt: response.expiresAt
            ? new Date(response.expiresAt)
            : null,
        refreshTokenExpiresAt: response.refreshTokenExpiresAt
            ? new Date(response.refreshTokenExpiresAt)
            : config.refreshTokenExpiresAt,
        updatedAt: new Date(),
    });

    logger.info("Refreshed Square OAuth access token");
    return response.accessToken;
}

/**
 * Renews the stored access token if it's expired or close to it. Safe to call
 * on every request — it no-ops when the token is still comfortably valid.
 */
export async function refreshIfNeeded(): Promise<void> {
    const config = await getConfigSystem();
    if (!config?.encryptedRefreshToken) {
        return;
    }

    const expiresAt = config.tokenExpiresAt?.getTime();
    if (expiresAt && expiresAt - Date.now() > REFRESH_WINDOW_MS) {
        return;
    }

    inFlightRefresh ??= refreshAccessToken().finally(() => {
        inFlightRefresh = null;
    });

    await inFlightRefresh;
}

/**
 * Returns the seller access token the backend makes Square calls with.
 * @returns the decrypted access token, or null if OAuth hasn't been completed
 */
export async function getDecryptedAccessToken(): Promise<string | null> {
    const config = await getConfigSystem();
    if (!config?.encryptedAccessToken) {
        return null;
    }

    const expiresAt = config.tokenExpiresAt?.getTime();
    if (expiresAt && expiresAt - Date.now() <= REFRESH_WINDOW_MS) {
        inFlightRefresh ??= refreshAccessToken().finally(() => {
            inFlightRefresh = null;
        });
        const refreshed = await inFlightRefresh;
        if (refreshed) {
            return refreshed;
        }
    }

    return decrypt(config.encryptedAccessToken);
}

/**
 * Mints a 24-hour access token for a single on-device payment. The mobile app
 * authorizes the Mobile Payments SDK with this and deauthorizes afterwards,
 * so a stolen device holds nothing durable.
 * @returns the short-lived token, the location to charge at, and its expiry
 */
export async function getShortLivedAccessToken(): Promise<{
    accessToken: string;
    locationId: string | null;
    expiresAt: string | null;
    environment: "sandbox" | "production";
}> {
    const config = await getConfigSystem();
    if (!config?.encryptedRefreshToken) {
        throw new Error("Square is not connected");
    }

    const { clientId, clientSecret } = getAppCredentials();

    const response = await obtainToken({
        clientId,
        clientSecret,
        refreshToken: decrypt(config.encryptedRefreshToken),
        grantType: "refresh_token",
        shortLived: true,
    });

    if (!response.accessToken) {
        throw new Error("Square did not return a short-lived access token");
    }

    return {
        accessToken: response.accessToken,
        locationId: config.locationId,
        expiresAt: response.expiresAt ?? null,
        environment:
            getSquareEnvironment() === SquareEnvironment.Sandbox
                ? "sandbox"
                : "production",
    };
}

/**
 * @returns the Square location id authorized for this deployment
 */
export async function getStoredLocationId(): Promise<string | null> {
    const config = await getConfigSystem();
    return config?.locationId ?? null;
}

/**
 * @returns true if a seller has completed the OAuth flow
 */
export async function isAuthorized(): Promise<boolean> {
    const config = await getConfigSystem();
    return Boolean(config?.encryptedAccessToken);
}

/**
 * @returns connection state for the settings UI
 */
export async function getAuthorizationStatus(): Promise<{
    authorized: boolean;
    locationId: string | null;
    merchantId: string | null;
    tokenExpiresAt: Date | null;
}> {
    const config = await getConfigSystem();

    return {
        authorized: Boolean(config?.encryptedAccessToken),
        locationId: config?.locationId ?? null,
        merchantId: config?.merchantId ?? null,
        tokenExpiresAt: config?.tokenExpiresAt ?? null,
    };
}

/**
 * Revokes the seller's authorization at Square and drops the stored tokens.
 */
export async function revokeTokens(): Promise<void> {
    const config = await getConfigSystem();
    const { clientId, clientSecret } = getAppCredentials();

    if (config?.encryptedAccessToken) {
        await oauthClient.oAuth.revokeToken(
            {
                clientId,
                accessToken: decrypt(config.encryptedAccessToken),
            },
            // Revoke authenticates with the application secret, not a seller token.
            { headers: { Authorization: `Client ${clientSecret}` } },
        );
    }

    await deleteConfigSystem();
    logger.info("Revoked Square OAuth authorization");
}
