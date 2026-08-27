// tests/unconfigured.test.ts
import { describe, it, expect } from "vitest";
import { buildUnconfiguredServer, createUnconfiguredClient } from "../src/modes/unconfigured.js";
import { buildLiveServer } from "../src/modes/live.js";
import { getAccountHandler } from "../src/tools/account.js";
import type { ToolResult } from "../src/utils/render.js";

function toolNames(server: ReturnType<typeof buildUnconfiguredServer>): string[] {
  // @ts-expect-error - reach into internal map for the registered tool set
  return Object.keys(server._registeredTools).sort();
}

const liveServer = () =>
  buildLiveServer({ sandbox: false, apiKey: "vmk_live_" + "a".repeat(32), baseUrl: "https://x", debug: false });

describe("unconfigured mode", () => {
  it("exposes the EXACT same tool set as live (cannot drift)", () => {
    expect(toolNames(buildUnconfiguredServer())).toEqual(toolNames(liveServer()));
  });

  it("tool calls fail with setup instructions instead of crashing", async () => {
    const result = (await getAccountHandler(createUnconfiguredClient())({})) as ToolResult;
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain("VOIDMOB_API_KEY is not set");
    expect(text).toContain("dashboard.voidmob.com/developers/api-keys");
    expect(text).toContain("VOIDMOB_SANDBOX=1");
  });
});
