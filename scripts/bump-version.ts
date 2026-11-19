// Usage: bun scripts/bump-version.ts <new-version>
// Rewrites the version in every file listed in src/version-files.ts, so they never drift.
// Then write the CHANGELOG.md section for the new version: CI fails without it.
import * as fs from "node:fs";
import * as path from "node:path";
import { VERSION_FILES } from "../src/version-files";

const next = process.argv[2];
if (!next || !/^\d+\.\d+\.\d+$/.test(next)) {
    console.error("usage: bun scripts/bump-version.ts X.Y.Z");
    process.exit(2);
}
const root = path.resolve(import.meta.dir, "..");
for (const { file, pattern } of VERSION_FILES) {
    const full = path.join(root, file);
    const text = fs.readFileSync(full, "utf8");
    const m = text.match(pattern);
    if (!m || m.index === undefined || m[1] === undefined) {
        console.error(`version not found in ${file}`);
        process.exit(1);
    }
    const at = m.index + m[0].indexOf(m[1]);
    fs.writeFileSync(full, text.slice(0, at) + next + text.slice(at + m[1].length));
    console.log(`${file}: ${m[1]} -> ${next}`);
}
console.log(`\nNow add "## [${next}] — <date>" to CHANGELOG.md, then open the release PR.`);
