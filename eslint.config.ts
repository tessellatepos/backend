import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import eslintPluginPrettierRecommended from "eslint-plugin-prettier/recommended";
import { defineConfig } from "eslint/config";

export default defineConfig([
    {
        ignores: ["dist/**", "drizzle/**"],
    },
    {
        files: ["**/*.{ts,mts,cts,tsx}"],
        plugins: {
            "@typescript-eslint": tseslint.plugin,
        },
        extends: [
            js.configs.recommended,
            ...tseslint.configs.recommended,
            eslintPluginPrettierRecommended,
        ],
        languageOptions: {
            parserOptions: {
                ecmaVersion: "latest",
            },
            globals: globals.node,
        },
    },
]);
