import type { Role, Scope } from "@tessellatepos/sdk";

/**
 * Scopes granted by each host role. Endpoints check scopes; roles are only
 * how users get them. `owner` holds the wildcard.
 */
export const ROLE_SCOPES: Readonly<Record<Role, readonly Scope[]>> = {
    owner: ["*"],
    manager: [
        "catalog:read",
        "catalog:write",
        "orders:read",
        "orders:write",
        "customers:read",
        "customers:write",
        "locations:read",
        "locations:write",
        "devices:read",
        "devices:write",
        "users:read",
        "dashboard:read",
        "settings:read",
        "payments:read",
        "payments:write",
        "plugins:read",
    ],
    cashier: [
        "catalog:read",
        "orders:read",
        "orders:write",
        "customers:read",
        "customers:write",
        "locations:read",
        "payments:write",
    ],
    viewer: [
        "catalog:read",
        "orders:read",
        "customers:read",
        "locations:read",
        "dashboard:read",
    ],
};

/**
 * Whether a name is one of the host's roles.
 * @param name a role name
 * @returns true for `owner`, `manager`, `cashier` and `viewer` only
 */
export function isRole(name: string): name is Role {
    return Object.hasOwn(ROLE_SCOPES, name);
}

/**
 * Splits better-auth's comma separated role string ("manager, cashier").
 * @param value the user's role column, or null/undefined
 * @returns trimmed, de-duplicated, non-empty role names
 */
export function parseRoles(value: string | null | undefined): string[] {
    if (!value) return [];
    return [
        ...new Set(
            value
                .split(",")
                .map((r) => r.trim())
                .filter(Boolean),
        ),
    ];
}

/**
 * Resolves role names to the scopes they grant.
 * @param roles role names, or better-auth's comma separated role string
 * @returns the de-duplicated scopes; unknown roles grant nothing, and "*" is
 * only ever granted through `owner`
 */
export function scopesForRoles(roles: string[] | string): Scope[] {
    const names = Array.isArray(roles)
        ? parseRoles(roles.join(","))
        : parseRoles(roles);
    const scopes = new Set<Scope>();
    for (const role of names) {
        if (!isRole(role)) continue;
        for (const scope of ROLE_SCOPES[role]) scopes.add(scope);
    }
    return [...scopes];
}
