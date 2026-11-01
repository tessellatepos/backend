import type { ProviderId } from "@tessellatepos/sdk";
import { getStoredProvider, storeProvider } from "@/services/db/configProvider";
import { squareProvider } from "./square";
import { localProvider } from "./local";
import type {
    CatalogProvider,
    CatalogWriteProvider,
    CustomerProvider,
    PaymentProvider,
    DevicePairingProvider,
    ProviderInfo,
} from "./types";

export type ActiveProvider = CatalogProvider &
    PaymentProvider &
    DevicePairingProvider &
    CustomerProvider &
    Partial<CatalogWriteProvider>;

const providers: Record<ProviderId, ActiveProvider> = {
    square: squareProvider,
    local: localProvider,
};

export const providerInfo: Record<ProviderId, ProviderInfo> = {
    square: {
        id: "square",
        requiresTerminalDevice: true,
        canManageStorefronts: false,
        canManageCatalog: false,
    },
    local: {
        id: "local",
        requiresTerminalDevice: false,
        canManageStorefronts: true,
        canManageCatalog: true,
    },
};

/**
 * @param value anything from a request body
 * @returns true when value names a provider this deployment ships
 */
export function isProviderId(value: unknown): value is ProviderId {
    return typeof value === "string" && Object.hasOwn(providers, value);
}

/** The default until a choice is stored: PROVIDER=local, otherwise Square. */
let activeId: ProviderId =
    process.env.PROVIDER === "local" ? "local" : "square";

/**
 * Loads the persisted provider choice. The PROVIDER env var only seeds the
 * default for a deployment that has never picked one.
 */
export async function initActiveProvider(): Promise<void> {
    const stored = await getStoredProvider();
    if (stored && isProviderId(stored)) activeId = stored;
}

/** @returns the id of the provider currently in use */
export function getActiveProviderId(): ProviderId {
    return activeId;
}

/**
 * Resolved per call so a runtime switch takes effect immediately. Handlers
 * that make several provider calls should read it once and reuse the result.
 * @returns the provider currently in use
 */
export function getActiveProvider(): ActiveProvider {
    return providers[activeId];
}

/**
 * @returns the active provider's catalog writes, or null when it does not
 * own its catalog (Square) and the catalog is read-only here
 */
export function getCatalogWriter(): CatalogWriteProvider | null {
    const provider = getActiveProvider();
    if (!providerInfo[activeId].canManageCatalog) return null;
    return provider.createItem ? (provider as CatalogWriteProvider) : null;
}

/**
 * Which catalog rows the active provider shows. Local items stay in the
 * database when Square is active, but only Square-synced rows are shown.
 * @returns the scope to read the catalog with
 */
export function visibleCatalogScope(): { origin?: "synced" } {
    return providerInfo[activeId].canManageCatalog ? {} : { origin: "synced" };
}

/**
 * Persists and activates a provider.
 * @param id the provider to switch to
 */
export async function setActiveProvider(id: ProviderId): Promise<void> {
    await storeProvider(id);
    activeId = id;
}
