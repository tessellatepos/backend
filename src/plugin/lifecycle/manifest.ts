import { existsSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
    PluginManifest,
    PluginPermission,
    type PluginPermissionProvider,
} from "@tessellatepos/plugin-sdk";
import { Logger } from "tslog";

const logger = new Logger();

const VALID_PERMISSIONS = new Set<string>(Object.values(PluginPermission));

// each subfolder of the plugin directory is a plugin; its package.json IS
// the plugin manifest. a plugin whose package.json fails validation is skipped rather than activated.
export async function getManifestList(
    dir: string,
): Promise<{ folder: string; manifest: PluginManifest }[]> {
    const pluginFolders = readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);

    const manifests: { folder: string; manifest: PluginManifest }[] = [];

    for (const folder of pluginFolders) {
        const manifest = await validateManifest(dir, folder);
        if (manifest) {
            manifests.push({ folder, manifest });
        }
    }

    return manifests;
}

async function validateManifest(
    dir: string,
    folder: string,
): Promise<PluginManifest | null> {
    const packageJsonPath = path.join(dir, folder, "package.json");

    if (!existsSync(packageJsonPath)) {
        logger.warn(`Skipping "${folder}": no package.json found`);
        return null;
    }

    let pkg: unknown;
    try {
        pkg = JSON.parse(await readFile(packageJsonPath, "utf-8"));
    } catch (err) {
        logger.warn(
            `Skipping "${folder}": package.json is not valid JSON`,
            err,
        );
        return null;
    }

    if (!isPluginManifest(pkg)) {
        logger.warn(
            `Skipping "${folder}": package.json failed manifest validation`,
        );
        return null;
    }

    return pkg;
}

// Runtime check for a parsed package.json read off disk — a TS interface
// only protects code we wrote ourselves, not a third-party plugin's
// manifest. This is host-loader policy, so it lives here rather than in
// the SDK: it can change independently of the published SDK contract.
function isPluginManifest(pkg: unknown): pkg is PluginManifest {
    if (typeof pkg !== "object" || pkg === null) return false;
    const p = pkg as Record<string, unknown>;

    if (typeof p.name !== "string" || p.name.length === 0) return false;
    if (typeof p.version !== "string" || p.version.length === 0) return false;
    if (typeof p.main !== "string" || p.main.length === 0) return false;

    if (p.author !== undefined) {
        const isAuthorString = typeof p.author === "string";
        const isAuthorObject =
            typeof p.author === "object" &&
            p.author !== null &&
            typeof (p.author as Record<string, unknown>).name === "string";
        if (!isAuthorString && !isAuthorObject) return false;
    }

    const engines = p.engines as Record<string, unknown> | undefined;
    if (typeof engines?.tessellate !== "string") return false;

    const tessellate = p.tessellate as Record<string, unknown> | undefined;
    if (typeof tessellate !== "object" || tessellate === null) return false;

    const permissions = tessellate.permissions;
    if (
        !Array.isArray(permissions) ||
        !permissions.every(
            (perm) => typeof perm === "string" && VALID_PERMISSIONS.has(perm),
        )
    ) {
        return false;
    }

    return true;
}

//TODO add plugin permission approval flow from the user to grant the permissions requested instead of just granting them.
export function grantedPermissions(
    manifest: PluginManifest,
): PluginPermissionProvider {
    const requested = new Set(manifest.tessellate.permissions);
    return {
        cart: requested.has(PluginPermission.CART),
        catalog: requested.has(PluginPermission.CATALOG),
        checkout: requested.has(PluginPermission.CHECKOUT),
        device: requested.has(PluginPermission.DEVICE),
        order: requested.has(PluginPermission.ORDER),
    };
}
