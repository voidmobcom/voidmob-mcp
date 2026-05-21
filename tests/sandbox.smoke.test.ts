// tests/sandbox.smoke.test.ts
import { describe, it, expect } from "vitest";
import { buildSandboxServer } from "../src/modes/sandbox.js";
import { buildLiveServer } from "../src/modes/live.js";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("smoke (sandbox)", () => {
  it("boots and registers all sandbox tools without throwing", () => {
    const server = buildSandboxServer();
    // @ts-expect-error - reach into internal map for sanity check
    const tools = Object.keys(server._registeredTools);
    expect(tools.length).toBeGreaterThanOrEqual(20);
  });
});

describe("smoke (live)", () => {
  it("registers exactly 25 live tools matching the checked-in fixture", () => {
    const server = buildLiveServer({
      sandbox: false,
      apiKey: "vmk_live_" + "a".repeat(32),
      baseUrl: "https://x",
      debug: false,
    });
    // @ts-expect-error - reach into internal map
    const names = Object.keys(server._registeredTools).sort();
    expect(names.length).toBe(25);

    const fixturePath = join(__dirname, "fixtures/tools-list-v1.json");
    const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as { tools: string[] };
    expect(names).toEqual(fixture.tools);
  });
});
