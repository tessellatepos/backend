import type { ProviderId } from "@tessellatepos/sdk";
import { getStoredProvider, storeProvider } from "@/services/db/configProvider";
import { squareProvider } from "./square";
import { localProvider } from "./local";
import type {
    CatalogProvider,
    CustomerProvider,
    PaymentProvider,
    DevicePairingProvider,
    ProviderInfo,
} from "./types";

export type ActiveProvider = CatalogProvider &
    PaymentProvider &
    DevicePairingProvider &
    CustomerProvider;

const providers: Record<ProviderId, ActiveProvider> = {
    square: squareProvider,
    local: localProvider,
};

export const providerInfo: Record<ProviderId, ProviderInfo> = {
    square: {
        id: "square",
        requiresTerminalDevice: true,
        canManageStorefronts: false,
    },
    local: {
        id: "local",
        requiresTerminalDevice: false,
        canManageStorefronts: true,
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
 * Persists and activates a provider.
 * @param id the provider to switch to
 */
export async function setActiveProvider(id: ProviderId): Promise<void> {
    await storeProvider(id);
    activeId = id;
}
