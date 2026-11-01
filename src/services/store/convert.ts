/**
 * The SDK types use "" for an unset string; the tables use null.
 * @param value the SDK value
 * @returns the value to persist
 */
export function nullIfEmpty(value: string | null | undefined): string | null {
    return value || null;
}

/**
 * Reverses nullIfEmpty when reading a row back into an SDK type.
 * @param value the persisted value
 * @returns the SDK value
 */
export function emptyIfNull(value: string | null | undefined): string {
    return value ?? "";
}
