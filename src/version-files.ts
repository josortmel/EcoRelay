// Every place that states EcoRelay's version. Each program reads its own copy, so they
// cannot be reduced to one file: package.json is the source, the others must match it.
// scripts/bump-version.ts rewrites them all; src/version.test.ts fails CI if they differ.
export const VERSION_FILES: ReadonlyArray<{ file: string; pattern: RegExp }> = [
    { file: "package.json", pattern: /"version": "([^"]+)"/ },
    { file: ".claude-plugin/plugin.json", pattern: /"version": "([^"]+)"/ },
    { file: ".claude-plugin/marketplace.json", pattern: /"version": "([^"]+)"/ },
    { file: "src/opencode-plugin/ecorelay.ts", pattern: /const PLUGIN_VERSION = "([^"]+)"/ },
    { file: "src/copilot-extension/ecorelay.mjs", pattern: /const PLUGIN_VERSION = "([^"]+)"/ },
    { file: "src/codex-adapter/index.ts", pattern: /\{ name: "ecorelay", version: "([^"]+)" \}/ },
    { file: "src/codex-adapter/app-server-client.ts", pattern: /\n\s+version: "([^"]+)",/ },
    {
        file: "src/antigravity-adapter/index.ts",
        pattern: /\{ name: "ecorelay", version: "([^"]+)" \}/,
    },
    { file: "src/cursor-adapter/index.ts", pattern: /\{ name: "ecorelay", version: "([^"]+)" \}/ },
];

/** Lines of the CHANGELOG section for `version` (between its heading and the next one). */
export function changelogSection(changelog: string, version: string): string {
    const lines = changelog.split("\n");
    const start = lines.findIndex((l) => l.startsWith(`## [${version}]`));
    if (start === -1) return "";
    const rest = lines.slice(start + 1);
    const end = rest.findIndex((l) => l.startsWith("## ["));
    return (end === -1 ? rest : rest.slice(0, end)).join("\n").trim();
}
