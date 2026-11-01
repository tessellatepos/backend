/**
 * Owner-managed settings for plugin sign-in methods, and the rebuild of the
 * auth instance from them. Secrets are encrypted before they reach the
 * database and are never returned or logged.
 */
import { Logger } from "tslog";
import { drizzleDB } from "@/services/db/postgres";
import { authProviderSettingsTable } from "@/services/db/schema";
import { createAuth, type Auth } from "@/services/auth";
import { decrypt, encrypt } from "@/services/crypto";
import {
    authProviders,
    buildContributions,
    effectiveConfig,
    isConfigured,
    providerKind,
    type AuthProviderKind,
    type AuthProviderRegistry,
    type ProviderConfig,
    type ProviderSettings,
    type RegisteredAuthProvider,
} from "@/auth/providers";

const logger = new Logger();

/** One provider as the login screen sees it. */
export interface PublicAuthProvider {
    id: string;
    label: string;
    kind: AuthProviderKind;
}

/** One provider as the owner sees it in Settings. Never carries a secret. */
export interface AdminAuthProvider extends PublicAuthProvider {
    plugin: string;
    enabled: boolean;
    /** Whether the provider has everything it needs to run. */
    configured: boolean;
    fields: {
        discoveryUrl?: string;
        clientId?: string;
        hasSecret: boolean;
    };
}

/** What a PUT may change. An empty or absent `clientSecret` keeps the old one. */
export interface ProviderSettingsPatch {
    enabled?: boolean;
    clientId?: string;
    clientSecret?: string;
    discoveryUrl?: string;
    scopes?: string[];
}

const warnedCustom = new Set<string>();

/**
 * Reads the saved settings. A row that cannot be decrypted counts as
 * unconfigured (and disabled) rather than breaking sign-in for everyone.
 * @returns settings by provider id
 */
export async function loadSettings(): Promise<Map<string, ProviderSettings>> {
    const rows = await drizzleDB.select().from(authProviderSettingsTable);
    const out = new Map<string, ProviderSettings>();
    for (const row of rows) {
        try {
            const config = JSON.parse(decrypt(row.config)) as ProviderConfig;
            out.set(row.providerId, { enabled: row.enabled, config });
        } catch {
            logger.error(
                `Could not read the saved settings of sign-in method "${row.providerId}"; treating it as unconfigured`,
            );
            out.set(row.providerId, { enabled: false, config: {} });
        }
    }
    return out;
}

/**
 * Applies a change to one provider and stores it.
 * @param entry the registered provider
 * @param patch the new values; an empty clientSecret leaves the secret as is
 * @returns the settings now in effect
 */
export async function saveSettings(
    entry: RegisteredAuthProvider,
    patch: ProviderSettingsPatch,
): Promise<ProviderSettings> {
    const current = (await loadSettings()).get(entry.provider.id) ?? {
        enabled: false,
        config: {},
    };
    const config: ProviderConfig = { ...current.config };
    if (patch.clientId !== undefined) config.clientId = patch.clientId;
    if (patch.discoveryUrl !== undefined)
        config.discoveryUrl = patch.discoveryUrl;
    if (patch.scopes !== undefined) config.scopes = patch.scopes;
    if (patch.clientSecret) config.clientSecret = patch.clientSecret;
    const next: ProviderSettings = {
        enabled: patch.enabled ?? current.enabled,
        config,
    };
    const row = {
        providerId: entry.provider.id,
        pluginName: entry.pluginName,
        enabled: next.enabled,
        config: encrypt(JSON.stringify(config)),
        updatedAt: new Date(),
    };
    await drizzleDB
        .insert(authProviderSettingsTable)
        .values(row)
        .onConflictDoUpdate({
            target: authProviderSettingsTable.providerId,
            set: row,
        });
    return next;
}

/**
 * Describes a provider for the owner. Secrets are reduced to `hasSecret`.
 * @param entry the registered provider
 * @param settings its saved settings, if any
 * @returns the admin view
 */
export function toAdminView(
    entry: RegisteredAuthProvider,
    settings?: ProviderSettings,
): AdminAuthProvider {
    const { provider } = entry;
    const kind = providerKind(provider);
    const eff = effectiveConfig(provider, settings?.config);
    return {
        id: provider.id,
        label: provider.label,
        kind,
        plugin: entry.pluginName,
        enabled: settings?.enabled ?? false,
        configured: isConfigured(provider, settings?.config),
        fields: {
            ...(kind === "oidc" ? { discoveryUrl: eff.discoveryUrl } : {}),
            ...(kind !== "custom" ? { clientId: eff.clientId } : {}),
            hasSecret: kind !== "custom" && eff.clientSecret !== "",
        },
    };
}

/**
 * Lists every registered provider for the owner.
 * @param registry the loaded plugins' providers
 * @returns the admin views
 */
export async function listAdminProviders(
    registry: AuthProviderRegistry = authProviders,
): Promise<AdminAuthProvider[]> {
    const settings = await loadSettings();
    return registry
        .list()
        .map((e) => toAdminView(e, settings.get(e.provider.id)));
}

/**
 * Lists the providers the login screen may offer: enabled and configured.
 * @param registry the loaded plugins' providers
 * @returns id, label and kind only
 */
export async function listPublicProviders(
    registry: AuthProviderRegistry = authProviders,
): Promise<PublicAuthProvider[]> {
    const settings = await loadSettings();
    return registry
        .list()
        .filter((e) => {
            const s = settings.get(e.provider.id);
            return s?.enabled && isConfigured(e.provider, s.config);
        })
        .map(({ provider }) => ({
            id: provider.id,
            label: provider.label,
            kind: providerKind(provider),
        }));
}

let rebuilding: Promise<unknown> = Promise.resolve();

/**
 * Builds a new auth instance from the registered providers and the saved
 * settings, and makes it current. Sessions live in the database, so they
 * survive. Calls are serialised so the last change wins.
 * @param registry the loaded plugins' providers
 * @returns the new instance
 */
export function rebuildAuth(
    registry: AuthProviderRegistry = authProviders,
): Promise<Auth> {
    const run = async () => {
        const settings = await loadSettings();
        const contributions = buildContributions(
            registry.list().map((entry) => ({
                entry,
                settings: settings.get(entry.provider.id),
            })),
            (entry) => {
                if (warnedCustom.has(entry.provider.id)) return;
                warnedCustom.add(entry.provider.id);
                logger.warn(
                    `Sign-in method "${entry.provider.id}" from plugin "${entry.pluginName}" runs plugin code inside the auth layer`,
                );
            },
        );
        return createAuth(contributions);
    };
    const next = rebuilding.then(run, run);
    rebuilding = next.catch(() => undefined);
    return next;
}
