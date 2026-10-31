import { betterAuth, type BetterAuthOptions } from "better-auth/minimal";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { adminAc, userAc } from "better-auth/plugins/admin/access";
import { admin, bearer, genericOAuth, username } from "better-auth/plugins";
import { drizzleDB } from "./db/postgres";
import { authSchema } from "./db/schema";
import { urlConfig, trustedOrigins } from "@/config/urls";
import { createAccessGate } from "@/auth/accessGate";

/** Where the auth router is mounted; better-auth must agree with Express. */
export const AUTH_BASE_PATH = "/api/v1/auth";

/**
 * Header the /auth route stamps with Express's `req.ip` before better-auth
 * sees the request. better-auth only reads headers (never the socket) for the
 * client IP its rate limiter keys on, and its default `x-forwarded-for` is
 * client-controlled: rotating it would dodge the limit when the backend is
 * reachable directly, and behind a proxy that appends to it every client
 * would share the proxy's bucket. `req.ip` already follows TRUST_PROXY (the
 * socket address with no trusted proxy, the first untrusted hop otherwise),
 * so better-auth is told to read only this header, which the route overwrites.
 */
export const CLIENT_IP_HEADER = "x-tessellate-client-ip";

/**
 * better-auth's sign-in rate limit (3 per 10 s on /sign-in/*, 100 per 10 s
 * elsewhere, per client IP) is on everywhere except under NODE_ENV=test,
 * where the suite signs in repeatedly from one address.
 */
function rateLimitEnabled(): boolean {
    return process.env.NODE_ENV !== "test";
}

type GenericOAuthConfig = Parameters<typeof genericOAuth>[0]["config"];

/** Extras that are only known after plugins have loaded. */
export interface CreateAuthOptions {
    /** Additional better-auth plugins contributed by plugins. */
    plugins?: NonNullable<BetterAuthOptions["plugins"]>;
    /** Built-in social providers (github, google, ...). */
    socialProviders?: BetterAuthOptions["socialProviders"];
    /** genericOAuth provider configs (OIDC and custom OAuth). */
    genericOAuth?: GenericOAuthConfig;
}

/**
 * better-auth access control for our roles, so role names validate. Only
 * owner may use better-auth's admin endpoints; what each role may do in the
 * POS is decided by scopes (src/auth/roles.ts), not by this table.
 */
const adminRoles = {
    owner: adminAc,
    manager: userAc,
    cashier: userAc,
    viewer: userAc,
};

function buildAuth(options: CreateAuthOptions = {}) {
    return betterAuth({
        basePath: AUTH_BASE_PATH,
        baseURL: urlConfig.authBaseUrl,
        trustedOrigins: (request) => trustedOrigins(request),
        database: drizzleAdapter(drizzleDB, {
            provider: "pg",
            schema: authSchema,
        }),
        emailAndPassword: {
            enabled: true,
            // Accounts are created server-side (setup flow, admin tooling).
            disableSignUp: true,
        },
        // Plugin providers never attach to an existing account (that would
        // let a provider claim a user by asserting their email address).
        account: { accountLinking: { enabled: false } },
        // Runs for every create, link and OAuth sign-in: the role safety rule.
        user: { validateUserInfo: createAccessGate() },
        socialProviders: options.socialProviders,
        rateLimit: { enabled: rateLimitEnabled() },
        advanced: { ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] } },
        plugins: [
            username(),
            admin({
                roles: adminRoles,
                adminRoles: ["owner"],
                defaultRole: "viewer",
            }),
            bearer(),
            genericOAuth({ config: options.genericOAuth ?? [] }),
            ...(options.plugins ?? []),
        ],
    });
}

/** The better-auth instance type. */
export type Auth = ReturnType<typeof buildAuth>;

let current: Auth | null = null;

/**
 * Builds the better-auth instance and makes it the current one. Call after
 * plugins have loaded and migrations have run; calling again replaces it.
 * @param options contributions from plugins and configured providers
 * @returns the new instance
 */
export function createAuth(options: CreateAuthOptions = {}): Auth {
    current = buildAuth(options);
    return current;
}

/**
 * The current better-auth instance.
 * @returns the instance built by {@link createAuth}
 * @throws when createAuth has not been called yet
 */
export function getAuth(): Auth {
    if (!current) {
        throw new Error("Auth has not been created; call createAuth() first");
    }
    return current;
}
