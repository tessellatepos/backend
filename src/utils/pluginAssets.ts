import path from "node:path";

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Resolves a plugin client asset to a path inside `<pluginDir>/<name>/dist`.
 * Express decodes %2F in route params, so both parts are untrusted: anything
 * that is not a plain file name, or that resolves outside dist, is refused.
 * @returns the absolute path, or null if the request is not a safe asset path
 */
export function resolvePluginAsset(
    pluginDir: string,
    pluginName: string,
    filename: string,
): string | null {
    if (!SAFE_NAME.test(pluginName) || pluginName.includes("..")) return null;
    if (!SAFE_NAME.test(filename) || filename.includes("..")) return null;
    const dist = path.resolve(pluginDir, pluginName, "dist");
    const target = path.resolve(dist, filename);
    return target.startsWith(dist + path.sep) ? target : null;
}
