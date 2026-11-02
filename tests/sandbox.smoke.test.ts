// tests/sandbox.smoke.test.ts
import { describe, it, expect } from "vitest";
import { buildSandboxServer } from "../src/modes/sandbox.js";
import { buildLiveServer } from "../src/modes/live.js";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_CONTROLS } from "../src/config.js";
import { toolNames } from "./connect.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const liveServer = () =>
  buildLiveServer({ sandbox: false, apiKey: "vmk_live_" + "a".repeat(32), baseUrl: "https://x", debug: false, controls: DEFAULT_CONTROLS });

describe("smoke (live)", () => {
  it("registers exactly 26 live tools matching the checked-in fixture", async () => {
    const names = await toolNames(liveServer());
    expect(names.length).toBe(26);

    const fixturePath = join(__dirname, "fixtures/tools-list-v1.json");
    const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as { tools: string[] };
    expect(names).toEqual([...fixture.tools].sort());
  });
});

describe("smoke (sandbox)", () => {
  it("exposes the EXACT same tool set as live (cannot drift)", async () => {
    expect(await toolNames(buildSandboxServer())).toEqual(await toolNames(liveServer()));
  });
});
