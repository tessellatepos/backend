import type { Plugin } from "@/plugin/plugin";

const VERB = /^[a-z0-9-]+$/;

/** Thrown when a plugin declares or uses a scope it may not. */
export class GatewayScopeError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "GatewayScopeError";
    }
}

/**
 * The scopes a plugin declared in `tessellate.gatewayScopes`, checked: each
 * must be `plugin:<plugin name>:<verb>`, so a plugin can never declare a core
 * scope or another plugin's.
 * @param name the plugin's name
 * @param plugin the plugin
 * @returns the declared scopes
 * @throws GatewayScopeError when one is outside the plugin's namespace
 */
export function declaredGatewayScopes(name: string, plugin: Plugin): string[] {
    const declared = plugin.getManifest().tessellate?.gatewayScopes ?? [];
    const prefix = `plugin:${name}:`;
    for (const scope of declared) {
        if (
            !scope.startsWith(prefix) ||
            !VERB.test(scope.slice(prefix.length))
        ) {
            throw new GatewayScopeError(
                `Plugin "${name}": gateway scope "${scope}" must be "${prefix}<verb>" (lower-case letters, digits, "-")`,
            );
        }
    }
    return declared;
}

/**
 * Refuses a plugin whose gateway operations use a scope it did not declare.
 * @param name the plugin's name
 * @param plugin the plugin
 * @throws GatewayScopeError when a scope is invalid or undeclared
 */
export function assertGatewayScopes(name: string, plugin: Plugin): void {
    const declared = declaredGatewayScopes(name, plugin);
    for (const mount of plugin.get("api")) {
        const scope = mount.gateway?.scope;
        if (scope !== undefined && !declared.includes(scope)) {
            throw new GatewayScopeError(
                `Plugin "${name}": route ${mount.route} uses gateway scope "${scope}", which is not listed in tessellate.gatewayScopes`,
            );
        }
    }
}
