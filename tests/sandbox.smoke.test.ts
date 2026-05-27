// tests/sandbox.smoke.test.ts
import { describe, it, expect } from "vitest";
import { buildSandboxServer } from "../src/modes/sandbox.js";
import { buildLiveServer } from "../src/modes/live.js";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

function toolNames(server: ReturnType<typeof buildSandboxServer>): string[] {
  // @ts-expect-error - reach into internal map for the registered tool set
  return Object.keys(server._registeredTools).sort();
}

const liveServer = () =>
  buildLiveServer({ sandbox: false, apiKey: "vmk_live_" + "a".repeat(32), baseUrl: "https://x", debug: false });

describe("smoke (live)", () => {
  it("registers exactly 25 live tools matching the checked-in fixture", () => {
    const names = toolNames(liveServer());
    expect(names.length).toBe(25);

    const fixturePath = join(__dirname, "fixtures/tools-list-v1.json");
    const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as { tools: string[] };
    expect(names).toEqual([...fixture.tools].sort());
  });
});

describe("smoke (sandbox)", () => {
  it("exposes the EXACT same tool set as live (cannot drift)", () => {
    expect(toolNames(buildSandboxServer())).toEqual(toolNames(liveServer()));
  });
});
