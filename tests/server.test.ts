// Protocol-level checks over a real MCP client/server pair (in-memory
// transport): every tool carries a title and explicit annotation booleans, the
// server sends instructions, and nothing agent-visible names a supplier or says
// "provider". Runs against live (fetch stubbed to throw), sandbox and
// unconfigured servers so all three stay consistent.
import { describe, it, expect, afterEach, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { buildLiveServer } from "../src/modes/live.js";
import { buildSandboxServer } from "../src/modes/sandbox.js";
import { buildUnconfiguredServer } from "../src/modes/unconfigured.js";

const FORBIDDEN =
  /provider|coronium|cyber ?yozh|infatica|pva ?deals|hero-?sms|sms-?man|text ?verified|quackr|mobimatter|esim ?go|plisio/i;

async function connect(server: McpServer) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return client;
}

const modes: Array<[string, () => McpServer]> = [
  ["live", () => buildLiveServer({ sandbox: false, apiKey: "vmk_live_" + "a".repeat(32), baseUrl: "https://x", debug: false })],
  ["sandbox", buildSandboxServer],
  ["unconfigured", buildUnconfiguredServer],
];

afterEach(() => vi.restoreAllMocks());

describe.each(modes)("%s server over MCP", (_mode, build) => {
  it("lists 29 tools, each with a title and explicit annotation booleans", async () => {
    const client = await connect(build());
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(29);
    for (const tool of tools) {
      expect(tool.title, tool.name).toBeTruthy();
      for (const hint of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"] as const) {
        expect(typeof tool.annotations?.[hint], `${tool.name}.${hint}`).toBe("boolean");
      }
      // A read-only tool is never destructive.
      if (tool.annotations?.readOnlyHint) expect(tool.annotations.destructiveHint, tool.name).toBe(false);
    }
  });

  it("sends server instructions covering quote-then-confirm, the auto-refund and re-buy safety", async () => {
    const client = await connect(build());
    const instructions = client.getInstructions() ?? "";
    expect(instructions).toContain("prepaid USD balance");
    expect(instructions).toContain("Quote first");
    expect(instructions).toContain("refunded automatically");
    expect(instructions).toContain("do not buy again");
    const words = instructions.split(/\s+/).length;
    expect(words).toBeGreaterThan(100);
    expect(words).toBeLessThan(200);
  });

  it("nothing agent-visible names a supplier or says 'provider', and no em-dashes", async () => {
    const client = await connect(build());
    const { tools } = await client.listTools();
    const visible = JSON.stringify({ tools, instructions: client.getInstructions() });
    expect(visible).not.toMatch(FORBIDDEN);
    expect(visible).not.toContain("—");
  });
});

describe("spending tools are flagged for confirmation", () => {
  it("buy / renew / top-up tools are destructive and not read-only; searches and gets are read-only", async () => {
    const client = await connect(buildSandboxServer());
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t.annotations]));
    for (const name of ["rent_number", "purchase_esim", "purchase_proxy", "purchase_dedicated_number", "renew_proxy", "topup_proxy", "topup_esim", "re_rent_rental", "reuse_number"]) {
      expect(byName.get(name)).toMatchObject({ readOnlyHint: false, destructiveHint: true, openWorldHint: true });
    }
    for (const name of ["get_account", "search_sms_services", "get_rental", "list_orders", "search_esim_plans", "get_esim_status", "get_esim_qr", "search_proxies", "get_geo", "list_proxy_lists", "search_dedicated_countries", "get_dedicated_number"]) {
      expect(byName.get(name)).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    }
  });
});

describe("input validation at the protocol boundary", () => {
  it("rejects an id without its prefix or with path characters before any request is made", async () => {
    const fetchSpy = vi.fn(() => Promise.reject(new Error("network must not be touched")));
    vi.stubGlobal("fetch", fetchSpy);
    const client = await connect(buildLiveServer({ sandbox: false, apiKey: "vmk_live_" + "a".repeat(32), baseUrl: "https://x", debug: false }));
    const bad = [
      { name: "get_esim_status", arguments: { esim_id: "../me" } },
      { name: "delete_proxy_list", arguments: { proxy_id: "prx_1", list_id: "../../../rentals/ren_x" } },
      { name: "get_rental", arguments: { rental_id: "ded_1" } },
      { name: "cancel_rental", arguments: { rental_id: "ver_x#" } },
      { name: "purchase_proxy", arguments: { plan_id: "plan_1/../x" } },
    ];
    for (const call of bad) {
      const res = await client.callTool(call);
      expect(res.isError, call.name).toBe(true);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("sandbox: a full call round-trips over the protocol with no network", async () => {
    const fetchSpy = vi.fn(() => Promise.reject(new Error("network must not be touched")));
    vi.stubGlobal("fetch", fetchSpy);
    const client = await connect(buildSandboxServer());
    const account = await client.callTool({ name: "get_account", arguments: {} });
    expect(account.isError ?? false).toBe(false);
    const rent = await client.callTool({ name: "rent_number", arguments: { service_id: "svc_telegram" } });
    expect(rent.isError ?? false).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
