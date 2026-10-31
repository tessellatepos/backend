import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { resolvePluginAsset } from "../src/utils/pluginAssets.ts";

const DIR = path.resolve("/srv/app/plugins");

describe("resolvePluginAsset", () => {
    it("resolves a plain file inside the plugin's dist", () => {
        assert.equal(
            resolvePluginAsset(DIR, "loyalty-sidebar", "client.js"),
            path.join(DIR, "loyalty-sidebar", "dist", "client.js"),
        );
    });

    it("refuses traversal in the file name (decoded %2F)", () => {
        for (const f of [
            "../../../etc/hosts",
            "..",
            "../package.json",
            "a/../../b",
            "sub/file.js",
            "..\\..\\x",
        ]) {
            assert.equal(resolvePluginAsset(DIR, "p", f), null, f);
        }
    });

    it("refuses traversal or odd plugin names", () => {
        for (const n of ["..", ".", "../x", "a/b", "", ".hidden", "a\0b"]) {
            assert.equal(resolvePluginAsset(DIR, n, "client.js"), null, n);
        }
    });

    it("refuses dotfiles and empty names", () => {
        assert.equal(resolvePluginAsset(DIR, "p", ".env"), null);
        assert.equal(resolvePluginAsset(DIR, "p", ""), null);
    });
});
