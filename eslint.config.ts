import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
    eslint.configs.recommended,
    ...tseslint.configs.strict,
    {
        languageOptions: {
            parserOptions: {
                projectService: {
                    // Plain-JS Copilot extension: not in tsconfig, linted with a default project.
                    allowDefaultProject: ["src/copilot-extension/*.mjs"],
                },
                tsconfigRootDir: import.meta.dirname,
            },
        },
        rules: {
            "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
            "@typescript-eslint/no-explicit-any": "error",
            // Relay uses `try { ... } catch {}` as intentional best-effort cleanup
            // for socket teardown and similar idempotent operations. Not a real bug.
            "no-empty": ["error", { allowEmptyCatch: true }],
            // Logger sanitizes control characters on purpose; the regex is correct.
            "no-control-regex": "off",
        },
    },
    {
        // Non-null assertions are the standard pattern in bun:test for narrowing
        // optionals after existence checks. Disabling in test files only.
        files: ["**/*.test.ts", "**/test-helpers.ts"],
        rules: {
            "@typescript-eslint/no-non-null-assertion": "off",
        },
    },
    {
        // The Copilot extension is plain JS that runs in Node: declare the Node globals it
        // uses (TypeScript does this for the .ts files).
        files: ["src/copilot-extension/*.mjs"],
        languageOptions: {
            globals: {
                process: "readonly",
                setTimeout: "readonly",
                clearTimeout: "readonly",
                WebSocket: "readonly",
                crypto: "readonly",
            },
        },
    },
    {
        ignores: ["dist/", "node_modules/", "scripts/"],
    },
);
