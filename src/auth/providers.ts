/**
 * Plugin-contributed sign-in methods: validation, the registry of what the
 * loaded plugins declared, and the pure translations from a declared provider
 * (plus the owner's settings) into better-auth configuration.
 */
import type { BetterAuthOptions } from "better-auth/minimal";
import type { BetterAuthPlugin } from "better-auth";
import type { GenericOAuthConfig } from "better-auth/plugins";
import type {
    AuthProvider,
    BetterAuthPluginLike,
} from "@tessellatepos/plugin-sdk/server";

/** Ids a plugin provider may not take: better-auth's own or already routed. */
export const RESERVED_PROVIDER_IDS: readonly string[] = [
    "credential",
    "username",
    "email",
    "email-password",
    "admin",
    "bearer",
    "anonymous",
    "generic-oauth",
    "device",
    "setup",
    "google",
    "github",
    "microsoft",
    "apple",
    "discord",
];

const SOCIAL_PROVIDERS = new Set([
    "google",
    "github",
    "microsoft",
    "apple",
    "discord",
]);

const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/;

/** What kind of sign-in a provider declares. */
export type AuthProviderKind = "oidc" | "oauth" | "social" | "custom";

/** Values the owner can set; they override the plugin's code defaults. */
export interface ProviderConfig {
    clientId?: string;
    clientSecret?: string;
    discoveryUrl?: string;
    scopes?: string[];
}

/** Owner-managed state for one provider. */
export interface ProviderSettings {
    enabled: boolean;
    config: ProviderConfig;
}

/** A provider as registered by a loaded plugin. */
export interface RegisteredAuthProvider {
    pluginName: string;
    /** The plugin manifest's `tessellate.authRoles`. */
    authRoles: string[];
    provider: AuthProvider;
}

/** Thrown when a plugin's auth provider is refused. */
export class AuthProviderError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "AuthProviderError";
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isHttpUrl(value: string): boolean {
    try {
        const { protocol } = new URL(value);
        return protocol === "https:" || protocol === "http:";
    } catch {
        return false;
    }
}

/**
 * Which kind of sign-in a provider declares.
 * @param provider the provider
 * @returns "oidc", "oauth", "social" or "custom" (a betterAuthPlugin)
 */
export function providerKind(provider: AuthProvider): AuthProviderKind {
    if (provider.oidc) return "oidc";
    if (provider.oauth) return "oauth";
    if (provider.social) return "social";
    return "custom";
}

/**
 * The id better-auth uses for the provider's OAuth callback, which is also
 * what a login's `source.oauth.providerId` carries. Social logins are keyed
 * by the social provider's name, everything else by the provider id.
 * @param provider the provider
 * @returns the OAuth provider id, or null for a custom betterAuthPlugin
 */
export function oauthProviderId(provider: AuthProvider): string | null {
    if (provider.social) return provider.social.provider;
    if (provider.oidc || provider.oauth) return provider.id;
    return null;
}

function checkStrings(
    where: string,
    value: Record<string, unknown>,
    keys: string[],
    pluginName: string,
) {
    for (const key of keys) {
        if (typeof value[key] !== "string") {
            throw new AuthProviderError(
                `Plugin "${pluginName}": auth provider ${where}.${key} must be a string`,
            );
        }
    }
}

/**
 * Checks that a plugin may register an auth provider and that its shape is
 * valid. Credentials may be empty strings: the owner can supply them in
 * Settings, and the provider stays inactive until they are present.
 * @param pluginName the registering plugin
 * @param permitted whether the plugin holds the AUTH permission
 * @param provider the value the plugin passed to `register("auth", ...)`
 * @throws AuthProviderError when the plugin lacks the permission or the
 * provider is malformed
 */
export function validateAuthProvider(
    pluginName: string,
    permitted: boolean,
    provider: unknown,
): asserts provider is AuthProvider {
    if (!permitted) {
        throw new AuthProviderError(
            `Plugin "${pluginName}" registered an auth provider without the AUTH permission; add "AUTH" to tessellate.permissions in its package.json`,
        );
    }
    if (!isRecord(provider)) {
        throw new AuthProviderError(
            `Plugin "${pluginName}": auth provider must be an object`,
        );
    }
    const { id, label } = provider;
    if (typeof id !== "string" || !ID_PATTERN.test(id)) {
        throw new AuthProviderError(
            `Plugin "${pluginName}": auth provider id must be lower-case letters, digits, "-" or "_" (max 63 characters)`,
        );
    }
    if (RESERVED_PROVIDER_IDS.includes(id)) {
        throw new AuthProviderError(
            `Plugin "${pluginName}": auth provider id "${id}" is reserved`,
        );
    }
    if (typeof label !== "string" || label.trim() === "") {
        throw new AuthProviderError(
            `Plugin "${pluginName}": auth provider "${id}" needs a label`,
        );
    }
    const declared = (["oidc", "oauth", "social", "betterAuthPlugin"] as const)
        .filter((key) => provider[key] !== undefined)
        .map(String);
    if (declared.length !== 1) {
        throw new AuthProviderError(
            `Plugin "${pluginName}": auth provider "${id}" must declare exactly one of oidc, oauth, social or betterAuthPlugin (found ${declared.length === 0 ? "none" : declared.join(", ")})`,
        );
    }
    if (
        provider.resolveAccess !== undefined &&
        typeof provider.resolveAccess !== "function"
    ) {
        throw new AuthProviderError(
            `Plugin "${pluginName}": auth provider "${id}" resolveAccess must be a function`,
        );
    }
    const { oidc, oauth, social, betterAuthPlugin } = provider;
    if (oidc !== undefined) {
        if (!isRecord(oidc)) throw badShape(pluginName, id, "oidc");
        checkStrings(
            "oidc",
            oidc,
            ["discoveryUrl", "clientId", "clientSecret"],
            pluginName,
        );
        if (oidc.discoveryUrl !== "" && !isHttpUrl(oidc.discoveryUrl as string))
            throw badUrl(pluginName, id, "oidc.discoveryUrl");
        checkScopes(oidc.scopes, pluginName, id);
    } else if (oauth !== undefined) {
        if (!isRecord(oauth)) throw badShape(pluginName, id, "oauth");
        checkStrings(
            "oauth",
            oauth,
            [
                "authorizationUrl",
                "tokenUrl",
                "userInfoUrl",
                "clientId",
                "clientSecret",
            ],
            pluginName,
        );
        for (const key of ["authorizationUrl", "tokenUrl", "userInfoUrl"]) {
            if (!isHttpUrl(oauth[key] as string)) {
                throw badUrl(pluginName, id, `oauth.${key}`);
            }
        }
        checkScopes(oauth.scopes, pluginName, id);
    } else if (social !== undefined) {
        if (!isRecord(social)) throw badShape(pluginName, id, "social");
        checkStrings(
            "social",
            social,
            ["clientId", "clientSecret"],
            pluginName,
        );
        if (
            typeof social.provider !== "string" ||
            !SOCIAL_PROVIDERS.has(social.provider)
        ) {
            throw new AuthProviderError(
                `Plugin "${pluginName}": auth provider "${id}" social.provider must be one of ${[...SOCIAL_PROVIDERS].join(", ")}`,
            );
        }
    } else if (
        !isRecord(betterAuthPlugin) ||
        typeof betterAuthPlugin.id !== "string" ||
        betterAuthPlugin.id === ""
    ) {
        throw badShape(pluginName, id, "betterAuthPlugin");
    }
}

function badShape(pluginName: string, id: string, field: string) {
    return new AuthProviderError(
        `Plugin "${pluginName}": auth provider "${id}" has an invalid ${field}`,
    );
}

function badUrl(pluginName: string, id: string, field: string) {
    return new AuthProviderError(
        `Plugin "${pluginName}": auth provider "${id}" ${field} must be an http(s) URL`,
    );
}

function checkScopes(scopes: unknown, pluginName: string, id: string) {
    if (
        scopes !== undefined &&
        (!Array.isArray(scopes) || !scopes.every((s) => typeof s === "string"))
    ) {
        throw badShape(pluginName, id, "scopes");
    }
}

/** The providers the loaded plugins declared. */
export class AuthProviderRegistry {
    private entries = new Map<string, RegisteredAuthProvider>();

    /**
     * Adds a provider.
     * @param entry the provider with its plugin and role allow-list
     * @throws AuthProviderError when the id (or the social provider it
     * uses) is already taken by another provider
     */
    register(entry: RegisteredAuthProvider): void {
        const { provider, pluginName } = entry;
        const taken = this.entries.get(provider.id);
        if (taken) {
            throw new AuthProviderError(
                `Plugin "${pluginName}": auth provider id "${provider.id}" is already registered by plugin "${taken.pluginName}"`,
            );
        }
        const oauthId = oauthProviderId(provider);
        const clash = this.findByOAuthId(oauthId);
        if (clash) {
            throw new AuthProviderError(
                `Plugin "${pluginName}": auth provider "${provider.id}" uses ${oauthId}, which plugin "${clash.pluginName}" already uses`,
            );
        }
        this.entries.set(provider.id, entry);
    }

    /**
     * Removes every provider a plugin registered.
     * @param pluginName the plugin
     */
    removePlugin(pluginName: string): void {
        for (const [id, entry] of this.entries) {
            if (entry.pluginName === pluginName) this.entries.delete(id);
        }
    }

    /** Removes everything (tests). */
    clear(): void {
        this.entries.clear();
    }

    /**
     * @param id a provider id
     * @returns the registered provider, if any
     */
    get(id: string): RegisteredAuthProvider | undefined {
        return this.entries.get(id);
    }

    /**
     * @returns every registered provider, in registration order
     */
    list(): RegisteredAuthProvider[] {
        return [...this.entries.values()];
    }

    /**
     * Finds the provider behind an OAuth callback id.
     * @param oauthId the id in the callback path (see {@link oauthProviderId})
     * @returns the registered provider, if any
     */
    findByOAuthId(oauthId: string | null): RegisteredAuthProvider | undefined {
        if (!oauthId) return undefined;
        return this.list().find((e) => oauthProviderId(e.provider) === oauthId);
    }
}

/** The registry the running host uses; populated as plugins load. */
export const authProviders = new AuthProviderRegistry();

/**
 * The values a provider would run with: the owner's settings override the
 * plugin's code-supplied defaults field by field. Empty strings do not
 * override.
 * @param provider the provider
 * @param config the owner's values
 * @returns the effective values
 */
export function effectiveConfig(
    provider: AuthProvider,
    config: ProviderConfig = {},
): Required<ProviderConfig> {
    const base = provider.oidc ?? provider.oauth ?? provider.social;
    const pick = (own: string | undefined, fallback: unknown) =>
        own ? own : typeof fallback === "string" ? fallback : "";
    return {
        clientId: pick(config.clientId, base?.clientId),
        clientSecret: pick(config.clientSecret, base?.clientSecret),
        discoveryUrl: pick(config.discoveryUrl, provider.oidc?.discoveryUrl),
        scopes:
            config.scopes && config.scopes.length > 0
                ? config.scopes
                : ((provider.oidc ?? provider.oauth)?.scopes ?? []),
    };
}

/**
 * Whether a provider has everything it needs to run.
 * @param provider the provider
 * @param config the owner's values
 * @returns true when credentials (and the discovery URL for OIDC) are set;
 * a custom betterAuthPlugin needs no configuration
 */
export function isConfigured(
    provider: AuthProvider,
    config: ProviderConfig = {},
): boolean {
    const kind = providerKind(provider);
    if (kind === "custom") return true;
    const eff = effectiveConfig(provider, config);
    if (!eff.clientId || !eff.clientSecret) return false;
    return (
        kind !== "oidc" || (!!eff.discoveryUrl && isHttpUrl(eff.discoveryUrl))
    );
}

/** An entry of better-auth's `genericOAuth` config list. */
export type GenericOAuthEntry = GenericOAuthConfig;

/**
 * Translates an `oidc` or `oauth` provider into a genericOAuth config.
 * @param provider the provider
 * @param config the owner's values
 * @returns the config, or null for other kinds or when not configured
 */
export function toGenericOAuthConfig(
    provider: AuthProvider,
    config: ProviderConfig = {},
): GenericOAuthEntry | null {
    if (!provider.oidc && !provider.oauth) return null;
    if (!isConfigured(provider, config)) return null;
    const eff = effectiveConfig(provider, config);
    const common = {
        providerId: provider.id,
        name: provider.label,
        clientId: eff.clientId,
        clientSecret: eff.clientSecret,
        scopes: eff.scopes,
        pkce: true,
    };
    if (provider.oidc) {
        return { ...common, discoveryUrl: eff.discoveryUrl };
    }
    return {
        ...common,
        authorizationUrl: provider.oauth?.authorizationUrl,
        tokenUrl: provider.oauth?.tokenUrl,
        userInfoUrl: provider.oauth?.userInfoUrl,
    };
}

/**
 * Translates a `social` provider into a socialProviders entry.
 * @param provider the provider
 * @param config the owner's values
 * @returns the key and options, or null for other kinds or when not configured
 */
export function toSocialProviderEntry(
    provider: AuthProvider,
    config: ProviderConfig = {},
): [string, { clientId: string; clientSecret: string }] | null {
    if (!provider.social || !isConfigured(provider, config)) return null;
    const eff = effectiveConfig(provider, config);
    return [
        provider.social.provider,
        { clientId: eff.clientId, clientSecret: eff.clientSecret },
    ];
}

/**
 * Passes a custom provider's better-auth plugin through unchanged.
 * @param provider the provider
 * @returns the plugin, or null when the provider is not a custom one
 */
export function toBetterAuthPlugin(
    provider: AuthProvider,
): BetterAuthPluginLike | null {
    return provider.betterAuthPlugin ?? null;
}

/** What `createAuth` receives from the active providers. */
export interface AuthContributions {
    genericOAuth: GenericOAuthEntry[];
    socialProviders: NonNullable<BetterAuthOptions["socialProviders"]>;
    plugins: BetterAuthPlugin[];
}

/**
 * Builds the better-auth contributions of every provider that is enabled
 * and fully configured; the rest contribute nothing.
 * @param providers registered providers with the owner's settings for each
 * @param onCustomPlugin called for each betterAuthPlugin passed through
 * @returns the contributions to hand to `createAuth`
 */
export function buildContributions(
    providers: { entry: RegisteredAuthProvider; settings?: ProviderSettings }[],
    onCustomPlugin?: (entry: RegisteredAuthProvider) => void,
): AuthContributions {
    const out: AuthContributions = {
        genericOAuth: [],
        socialProviders: {},
        plugins: [],
    };
    for (const { entry, settings } of providers) {
        if (!settings?.enabled) continue;
        const { provider } = entry;
        const generic = toGenericOAuthConfig(provider, settings.config);
        if (generic) out.genericOAuth.push(generic);
        const social = toSocialProviderEntry(provider, settings.config);
        if (social) {
            (out.socialProviders as Record<string, unknown>)[social[0]] =
                social[1];
        }
        const custom = toBetterAuthPlugin(provider);
        if (custom) {
            onCustomPlugin?.(entry);
            out.plugins.push(custom as unknown as BetterAuthPlugin);
        }
    }
    return out;
}
