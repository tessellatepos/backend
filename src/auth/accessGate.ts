/**
 * The single gate better-auth runs before it creates a user, links an
 * account, or signs an OAuth user in again (`user.validateUserInfo`). It is
 * where plugin sign-in methods are held to the role safety rule, for new and
 * returning users, for genericOAuth and social providers alike.
 */
import type { BetterAuthOptions } from "better-auth/minimal";
import { Logger } from "tslog";
import type { ExternalProfile } from "@tessellatepos/plugin-sdk/server";
import { DEFAULT_ROLE, resolveProviderAccess } from "@/auth/access";
import { authProviders, type AuthProviderRegistry } from "@/auth/providers";
import { parseRoles } from "@/auth/roles";

const logger = new Logger();

type ValidateUserInfo = NonNullable<
    NonNullable<BetterAuthOptions["user"]>["validateUserInfo"]
>;

const DENIED = {
    error: "access_denied",
    errorDescription: "Access denied",
};

function text(value: unknown): string | undefined {
    return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * Builds the external profile a plugin's `resolveAccess` sees.
 * @param providerId the plugin provider's id
 * @param raw the provider's unmapped profile
 * @param user better-auth's view of the user, for fields the profile lacks
 * @returns the profile, or null when the provider gave no stable subject
 */
export function toExternalProfile(
    providerId: string,
    raw: Record<string, unknown> | undefined,
    user: Record<string, unknown>,
): ExternalProfile | null {
    const profile = raw ?? {};
    const subject = profile.sub ?? profile.id;
    if (
        (typeof subject !== "string" && typeof subject !== "number") ||
        subject === ""
    ) {
        return null;
    }
    const verified = profile.email_verified ?? user.emailVerified;
    return {
        provider: providerId,
        subject: String(subject),
        email: text(profile.email) ?? text(user.email),
        email_verified: typeof verified === "boolean" ? verified : undefined,
        name: text(profile.name) ?? text(user.name),
        username:
            text(profile.preferred_username) ??
            text(profile.username) ??
            text(profile.login),
        raw: profile,
    };
}

/**
 * Creates the `validateUserInfo` hook.
 *
 * - OAuth logins through a plugin provider: `resolveAccess` decides. A deny,
 *   throw or malformed answer refuses the login. On `create-user` the capped
 *   roles are written to the new user, overwriting anything else; returning
 *   users keep the roles the owner gave them.
 * - Linking a plugin provider to an existing account is refused, so a
 *   provider cannot take over an account by asserting its email address.
 * - Any other OAuth user is created with the default role.
 * - Only the host's own admin path (`method: "admin"`, used by setup and
 *   user management) may create a user that holds `owner`.
 * @param registry the loaded plugins' providers
 * @returns the hook to give better-auth
 */
export function createAccessGate(
    registry: AuthProviderRegistry = authProviders,
): ValidateUserInfo {
    return async ({ user, source }) => {
        if (source.action === "create-user" && source.method !== "oauth") {
            const roles = parseRoles(
                typeof user.role === "string" ? user.role : undefined,
            );
            if (roles.includes("owner") && source.method !== "admin") {
                return {
                    error: "owner_not_grantable",
                    errorDescription: "Owner cannot be granted this way",
                };
            }
            return;
        }
        if (source.method !== "oauth") return;

        const oauthId = source.oauth?.providerId;
        const entry = registry.findByOAuthId(oauthId ?? null);
        if (!entry) {
            // Not a plugin provider (e.g. a custom betterAuthPlugin flow).
            if (source.action === "create-user") user.role = DEFAULT_ROLE;
            return;
        }
        if (source.action === "link-account") {
            logger.warn(
                `Refused to link "${entry.provider.id}" to an existing account`,
            );
            return DENIED;
        }

        const profile = toExternalProfile(
            entry.provider.id,
            source.oauth?.profile,
            user,
        );
        if (!profile) {
            logger.warn(
                `Refused a "${entry.provider.id}" login: no subject in the profile`,
            );
            return DENIED;
        }
        const outcome = await resolveProviderAccess(
            entry.provider,
            entry.authRoles,
            profile,
        );
        if (!outcome.allowed) {
            // The reason is plugin supplied; log it, do not hand it to the browser.
            logger.warn(
                `Refused a "${entry.provider.id}" login: ${outcome.reason}`,
            );
            return DENIED;
        }
        if (source.action === "create-user") {
            user.role = outcome.roles.join(",");
        }
    };
}
