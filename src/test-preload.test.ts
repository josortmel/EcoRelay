import { describe, expect, test } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";

// Guards src/test-preload.ts: if the preload is not loaded, tests run against the
// real home of whoever runs them (see the comment there).
describe("test isolation", () => {
    test("tests run with a throwaway home directory", () => {
        expect(path.basename(os.homedir())).toStartWith("ecorelay-test-home-");
    });

    test("relay settings of a live session do not leak into tests", () => {
        expect(process.env.RELAY_HUB_SOCKET).toBeUndefined();
        expect(process.env.RELAY_PEER_ID).toBeUndefined();
    });
});
