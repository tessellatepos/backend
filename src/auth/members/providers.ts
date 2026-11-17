/**
 * Plugin-contributed member logins: validation, the registry of what the
 * loaded plugins declared, and the effective configuration (the plugin's code
 * defaults overridden by what the owner saved in Settings).
 */
import type { MemberSignupPolicy, Scope } from "@tessellatepos/sdk";
import type { MemberAuthProvider } from "@tessellatepos/plugin-sdk/server";

const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/;

/** Values the owner can set; they override the plugin's code defaults. */
export interface MemberSourceConfig {
    clientId?: string;
    clientSecret?: string;
}

/** Owner-managed state for one member login. */
export interface MemberSourceSettings {
    enabled: boolean;
    /** Overrides the provider's `signup`; null keeps the plugin's choice. */
    signup: MemberSignupPolicy | null;
    config: MemberSourceConfig;
}

/** A member login as registered by a loaded plugin. */
export interface RegisteredMemberProvider {
    pluginName: string;
    provider: MemberAuthProvider;
}

/** Thrown when a plugin's member login (or member route) is refused. */
export class MemberAuthError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "MemberAuthError";
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isHttpUrl(value: unknown): boolean {
    if (typeof value !== "string") return false;
    try {
        const { protocol } = new URL(value);
        return protocol === "https:" || protocol === "http:";
    } catch {
        return false;
    }
}

/**
 * The one scope a member principal holds.
 * @param pluginName the plugin the member belongs to
 * @returns `plugin:<name>:member`
 */
export function memberScope(pluginName: string): Scope {
    return `plugin:${pluginName}:member`;
}

/**
 * Checks that a plugin may register a member login and that its shape is
 * valid. Credentials may be empty strings: the owner can supply them in
 * Settings, and the login stays inactive until they are present.
 * @param pluginName the registering plugin
 * @param permitted whether the plugin holds the MEMBER_AUTH permission
 * @param provider the value the plugin passed to `register("memberAuth", ...)`
 * @throws MemberAuthError when the plugin lacks the permission or the
 * provider is malformed
 */
export function validateMemberAuthProvider(
    pluginName: string,
    permitted: boolean,
    provider: unknown,
): asserts provider is MemberAuthProvider {
    if (!permitted) {
        throw new MemberAuthError(
            `Plugin "${pluginName}" registered a member login without the MEMBER_AUTH permission; add "MEMBER_AUTH" to tessellate.permissions in its package.json`,
        );
    }
    if (!isRecord(provider)) {
        throw new MemberAuthError(
            `Plugin "${pluginName}": member login must be an object`,
        );
    }
    const { id, label, oauth, signup, resolveMember } = provider;
    if (typeof id !== "string" || !ID_PATTERN.test(id)) {
        throw new MemberAuthError(
            `Plugin "${pluginName}": member login id must be lower-case letters, digits, "-" or "_" (max 63 characters)`,
        );
    }
    if (typeof label !== "string" || label.trim() === "") {
        throw new MemberAuthError(
            `Plugin "${pluginName}": member login "${id}" needs a label`,
        );
    }
    if (!isRecord(oauth)) {
        throw new MemberAuthError(
            `Plugin "${pluginName}": member login "${id}" needs an oauth object`,
        );
    }
    for (const key of ["clientId", "clientSecret"]) {
        if (typeof oauth[key] !== "string") {
            throw new MemberAuthError(
                `Plugin "${pluginName}": member login "${id}" oauth.${key} must be a string`,
            );
        }
    }
    for (const key of ["authorizationUrl", "tokenUrl", "userInfoUrl"]) {
        if (!isHttpUrl(oauth[key])) {
            throw new MemberAuthError(
                `Plugin "${pluginName}": member login "${id}" oauth.${key} must be an http(s) URL`,
            );
        }
    }
    const scopes = oauth.scopes;
    if (
        scopes !== undefined &&
        (!Array.isArray(scopes) || !scopes.every((s) => typeof s === "string"))
    ) {
        throw new MemberAuthError(
            `Plugin "${pluginName}": member login "${id}" oauth.scopes must be strings`,
        );
    }
    if (signup !== undefined && signup !== "open" && signup !== "approval") {
        throw new MemberAuthError(
            `Plugin "${pluginName}": member login "${id}" signup must be "open" or "approval"`,
        );
    }
    if (resolveMember !== undefined && typeof resolveMember !== "function") {
        throw new MemberAuthError(
            `Plugin "${pluginName}": member login "${id}" resolveMember must be a function`,
        );
    }
}

/** The member logins of the loaded plugins. Ids are unique per plugin. */
export class MemberProviderRegistry {
    private entries: RegisteredMemberProvider[] = [];

    /**
     * Adds a provider.
     * @param entry the plugin and its provider
     * @throws MemberAuthError when the plugin already has a login with that id
     */
    register(entry: RegisteredMemberProvider): void {
        if (this.get(entry.pluginName, entry.provider.id)) {
            throw new MemberAuthError(
                `Plugin "${entry.pluginName}" registered member login "${entry.provider.id}" twice`,
            );
        }
        this.entries.push(entry);
    }

    /**
     * Removes every login a plugin registered.
     * @param pluginName the plugin
     */
    removePlugin(pluginName: string): void {
        this.entries = this.entries.filter((e) => e.pluginName !== pluginName);
    }

    /**
     * @param pluginName the plugin
     * @param providerId the login's id within the plugin
     * @returns the registration, or undefined
     */
    get(
        pluginName: string,
        providerId: string,
    ): RegisteredMemberProvider | undefined {
        return this.entries.find(
            (e) => e.pluginName === pluginName && e.provider.id === providerId,
        );
    }

    /**
     * @param pluginName limit to one plugin, or omit for all
     * @returns the registrations
     */
    list(pluginName?: string): RegisteredMemberProvider[] {
        return pluginName
            ? this.entries.filter((e) => e.pluginName === pluginName)
            : [...this.entries];
    }
}

/** The registry the host uses. */
export const memberProviders = new MemberProviderRegistry();

/** What the flow needs once code defaults and owner settings are merged. */
export interface EffectiveMemberConfig {
    authorizationUrl: string;
    tokenUrl: string;
    userInfoUrl: string;
    clientId: string;
    clientSecret: string;
    scopes: string[];
    signup: MemberSignupPolicy;
}

/**
 * Merges a provider's code defaults with the owner's saved settings. The
 * owner's non-empty values win. Signup defaults to "approval".
 * @param provider the provider
 * @param settings the saved settings, if any
 * @returns the configuration to run the flow with
 */
export function effectiveMemberConfig(
    provider: MemberAuthProvider,
    settings?: MemberSourceSettings,
): EffectiveMemberConfig {
    const { oauth } = provider;
    return {
        authorizationUrl: oauth.authorizationUrl,
        tokenUrl: oauth.tokenUrl,
        userInfoUrl: oauth.userInfoUrl,
        clientId: settings?.config.clientId || oauth.clientId,
        clientSecret: settings?.config.clientSecret || oauth.clientSecret,
        scopes: oauth.scopes ?? [],
        signup: settings?.signup ?? provider.signup ?? "approval",
    };
}

/**
 * Whether a login can run: the owner enabled it and credentials are present.
 * @param config the effective configuration
 * @param settings the saved settings, if any
 * @returns true when sign-in may start
 */
export function isMemberSourceActive(
    config: EffectiveMemberConfig,
    settings?: MemberSourceSettings,
): boolean {
    return !!settings?.enabled && !!config.clientId && !!config.clientSecret;
}
