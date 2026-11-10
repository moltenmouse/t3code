// @effect-diagnostics nodeBuiltinImport:off -- tests write real option files.
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";

import { takeAivaNativeImport } from "./imports.ts";

describe("aiva native imports", () => {
  it("reads the import named for a launch once", () => {
    const dir = mkdtempSync(join(tmpdir(), "aiva-imports-"));
    writeFileSync(join(dir, "req-1.json"), JSON.stringify({ nativeId: "019a2b3c-4d5e-7f00-8123-456789abcdef", title: " Fix login " }));
    expect(takeAivaNativeImport("req-1", dir)).toEqual({ nativeId: "019a2b3c-4d5e-7f00-8123-456789abcdef", title: "Fix login" });
    expect(existsSync(join(dir, "req-1.json"))).toBe(false);
    expect(takeAivaNativeImport("req-1", dir)).toBeNull();
  });

  it("ignores launches without one and bad input", () => {
    const dir = mkdtempSync(join(tmpdir(), "aiva-imports-"));
    expect(takeAivaNativeImport(undefined, dir)).toBeNull();
    expect(takeAivaNativeImport("../etc/passwd", dir)).toBeNull();
    writeFileSync(join(dir, "req-2.json"), JSON.stringify({ nativeId: "bad id with spaces" }));
    expect(takeAivaNativeImport("req-2", dir)).toBeNull();
  });
});
