import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { VERSION_FILES, changelogSection } from "./version-files";

const root = path.resolve(import.meta.dir, "..");
const read = (file: string): string => fs.readFileSync(path.join(root, file), "utf8");
const version = (JSON.parse(read("package.json")) as { version: string }).version;

describe("version", () => {
    test.each(VERSION_FILES.map((v) => [v.file, v.pattern] as const))(
        "%s states the package.json version, exactly once",
        (file, pattern) => {
            const text = read(file);
            const all = text.match(new RegExp(pattern.source, "g")) ?? [];
            expect(all).toHaveLength(1);
            expect(text.match(pattern)?.[1]).toBe(version);
        },
    );

    // The release job publishes this section as the release notes: a version without
    // its CHANGELOG entry must not reach main.
    test("CHANGELOG.md has a section for the package.json version", () => {
        expect(changelogSection(read("CHANGELOG.md"), version)).not.toBe("");
    });
});
