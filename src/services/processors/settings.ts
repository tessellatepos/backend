/**
 * Per-location processor settings. Keys and secrets are stored encrypted and
 * are write-only: nothing here returns a config value, only whether one is set.
 */
import type { PaymentProcessorInfo } from "@tessellatepos/sdk";
import { decrypt, encrypt } from "@/services/crypto";
import { getLocationById } from "@/services/db/locations";
import {
    getSettingsRow,
    listEnabledRowsForProcessor,
    listSettingsRows,
    upsertSettingsRow,
} from "@/services/db/processorSettings";
import { onlinePaymentsAvailable, webhookUrl } from "@/config/urls";
import { processorRegistry } from "./registry";

/** Thrown for input the service refuses. The message is safe to show. */
export class ProcessorSettingsError extends Error {}

/** Thrown when the processor or location does not exist. */
export class ProcessorNotFoundError extends Error {}

const MAX_CONFIG_KEYS = 20;
const MAX_VALUE_LENGTH = 4000;
const KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

export interface ProcessorLocationStatus extends PaymentProcessorInfo {
    enabled: boolean;
    /** Whether any keys are stored. Their values are never returned. */
    configured: boolean;
    /** Names of the stored keys, so the UI can show what is set. */
    configured_keys: string[];
    /** Where the processor posts events; null when PUBLIC_URL is not https. */
    webhook_url: string | null;
}

function parseConfig(encrypted: string | null): Record<string, string> {
    if (!encrypted) return {};
    return JSON.parse(decrypt(encrypted)) as Record<string, string>;
}

function validateConfig(value: unknown): Record<string, string> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new ProcessorSettingsError("config must be an object");
    }
    const entries = Object.entries(value);
    if (entries.length > MAX_CONFIG_KEYS) {
        throw new ProcessorSettingsError("config has too many keys");
    }
    const config: Record<string, string> = {};
    for (const [key, val] of entries) {
        if (!KEY_PATTERN.test(key)) {
            throw new ProcessorSettingsError("config has an invalid key name");
        }
        if (
            typeof val !== "string" ||
            val.length === 0 ||
            val.length > MAX_VALUE_LENGTH
        ) {
            throw new ProcessorSettingsError(
                `config.${key} must be a non-empty string`,
            );
        }
        config[key] = val;
    }
    return config;
}

async function requireLocationAndProcessor(
    processorId: string,
    locationId: string,
): Promise<void> {
    if (!processorRegistry.get(processorId)) {
        throw new ProcessorNotFoundError("Payment processor not found");
    }
    if (!(await getLocationById(locationId))) {
        throw new ProcessorNotFoundError("Location not found");
    }
}

/**
 * @param locationId a location id
 * @returns every registered processor with its state at the location
 */
export async function listProcessorsForLocation(
    locationId: string,
): Promise<ProcessorLocationStatus[]> {
    if (!(await getLocationById(locationId))) {
        throw new ProcessorNotFoundError("Location not found");
    }
    const rows = new Map(
        (await listSettingsRows(locationId)).map((r) => [r.processor_id, r]),
    );
    return processorRegistry.list().map((info) => {
        const row = rows.get(info.id);
        const keys = Object.keys(parseConfig(row?.config_encrypted ?? null));
        return {
            ...info,
            enabled: row?.enabled ?? false,
            configured: keys.length > 0,
            configured_keys: keys,
            webhook_url: onlinePaymentsAvailable() ? webhookUrl(info.id) : null,
        };
    });
}

/**
 * Enables, disables or configures a processor at a location. Config keys in
 * the input are merged over the stored ones; a key cannot be read back.
 * @param processorId a registered processor id
 * @param locationId an existing location id
 * @param input the changes; omitted fields stay as they are
 * @returns the new state, without any config value
 */
export async function updateProcessorSettings(
    processorId: string,
    locationId: string,
    input: { enabled?: unknown; config?: unknown },
): Promise<ProcessorLocationStatus> {
    await requireLocationAndProcessor(processorId, locationId);
    if (input.enabled !== undefined && typeof input.enabled !== "boolean") {
        throw new ProcessorSettingsError("enabled must be a boolean");
    }
    const existing = await getSettingsRow(processorId, locationId);
    let config = parseConfig(existing?.config_encrypted ?? null);
    if (input.config !== undefined) {
        config = { ...config, ...validateConfig(input.config) };
    }
    const enabled = input.enabled ?? existing?.enabled ?? false;
    await upsertSettingsRow({
        processor_id: processorId,
        location_id: locationId,
        enabled,
        config_encrypted:
            Object.keys(config).length > 0
                ? encrypt(JSON.stringify(config))
                : null,
        updated_at: new Date(),
    });
    const [status] = (await listProcessorsForLocation(locationId)).filter(
        (p) => p.id === processorId,
    );
    return status;
}

/**
 * For processor implementations only: the decrypted config of a processor
 * that is enabled at the location.
 * @param processorId a processor id
 * @param locationId a location id
 * @returns the config, or null when disabled or unset
 */
export async function getEnabledProcessorConfig(
    processorId: string,
    locationId: string,
): Promise<Record<string, string> | null> {
    const row = await getSettingsRow(processorId, locationId);
    if (!row?.enabled) return null;
    return parseConfig(row.config_encrypted);
}

/**
 * For processor implementations only: the decrypted config of every location
 * where the processor is enabled. For credentials that belong to the whole
 * account rather than a location, such as a webhook signature key.
 * @param processorId a processor id
 * @returns the configs, one per enabled location
 */
export async function listEnabledProcessorConfigs(
    processorId: string,
): Promise<Record<string, string>[]> {
    const rows = await listEnabledRowsForProcessor(processorId);
    return rows.map((row) => parseConfig(row.config_encrypted));
}
