/**
 * Unit tests for the auth-mode selection logic — the bug-prone core of the MCP
 * server's request layer. resolveAuthMode is a pure function extracted from
 * index.ts, so it runs fully offline with NO network and NO key.
 *
 * Importing index.ts is safe: an autorun guard (RHC_MCP_NO_AUTORUN=1) keeps
 * main() from starting the server when the module is imported by a test.
 */
import { describe, it, expect, beforeAll } from "vitest";

// Prevent main() from running when we import the module for its exports.
process.env.RHC_MCP_NO_AUTORUN = "1";

let resolveAuthMode: typeof import("../src/index.ts").resolveAuthMode;

beforeAll(async () => {
  const mod = await import("../src/index.ts");
  resolveAuthMode = mod.resolveAuthMode;
});

describe("resolveAuthMode (key-mode only)", () => {
  it("returns madeonsol when MADEONSOL_API_KEY is set", () => {
    expect(resolveAuthMode({ MADEONSOL_API_KEY: "msk_test" })).toBe("madeonsol");
  });

  it("returns none when no key is set", () => {
    expect(resolveAuthMode({})).toBe("none");
  });

  it("treats an empty-string key as unset", () => {
    expect(resolveAuthMode({ MADEONSOL_API_KEY: "" })).toBe("none");
  });
});
