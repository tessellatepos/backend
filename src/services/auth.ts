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
