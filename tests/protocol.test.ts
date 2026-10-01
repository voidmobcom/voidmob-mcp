// End-to-end over the MCP protocol (in-memory transport, sandbox data):
// every tool's structuredContent validates against its outputSchema, the
// owner controls shape the tool list and refuse spending, and the guides and
// prompts are served.
import { describe, it, expect, afterEach, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { buildSandboxServer } from "../src/modes/sandbox.js";
import { buildLiveServer } from "../src/modes/live.js";
import { DEFAULT_CONTROLS, parseControls, type OwnerControls } from "../src/config.js";
import { READY_AFTER_MS } from "../src/sandbox/mock-http.js";

async function connect(server: McpServer) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return client;
}

const sandbox = (controls: Partial<OwnerControls> = {}) => connect(buildSandboxServer({ ...DEFAULT_CONTROLS, ...controls }));
type Result = Awaited<ReturnType<Client["callTool"]>>;
const text = (r: Result) => (r.content as Array<{ text?: string }>)[0]?.text ?? "";
const sc = (r: Result) => r.structuredContent as Record<string, any>;

const WRITE_TOOLS = [
  "rent_number", "cancel_rental", "reuse_number", "re_rent_rental", "toggle_auto_renew",
  "purchase_dedicated_number", "purchase_esim", "topup_esim",
  "purchase_proxy", "rotate_proxy_ip", "renew_proxy", "set_proxy_auto_renew", "topup_proxy",
  "regenerate_proxy_password", "create_proxy_list", "update_proxy_list", "delete_proxy_list",
];

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("structuredContent matches outputSchema for every tool (sandbox)", () => {
  it("drives all 30 tools over the protocol and validates each result against its declared schema", async () => {
    const fetchSpy = vi.fn(() => Promise.reject(new Error("network must not be touched")));
    vi.stubGlobal("fetch", fetchSpy);
    const client = await sandbox();
    const { tools } = await client.listTools();
    const validator = new AjvJsonSchemaValidator();
    const schemas = new Map(tools.map((t) => [t.name, validator.getValidator(t.outputSchema as never)]));
    const called = new Set<string>();

    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const res = await client.callTool({ name, arguments: args });
      expect(res.isError ?? false, `${name}: ${text(res)}`).toBe(false);
      const check = schemas.get(name)!(res.structuredContent);
      expect(check.valid, `${name}: ${check.errorMessage}`).toBe(true);
      called.add(name);
      return res;
    };

    await call("get_account");
    await call("search_sms_services", { query: "tele" });
    const ver = sc(await call("rent_number", { service_id: "svc_telegram", max_price_cents: 150 })).verification.id;
    await call("get_rental", { rental_id: ver });
    await call("reuse_number", { rental_id: ver });
    await call("reuse_number", { rental_id: ver, paid: true, max_price_cents: 50 });
    await call("cancel_rental", { rental_id: ver });
    const ren = sc(await call("rent_number", { service_id: "svc_telegram", kind: "rental", duration: "7d", max_price_cents: 600 })).rental.id;
    await call("toggle_auto_renew", { rental_id: ren, auto_renew: true });
    await call("re_rent_rental", { rental_id: "ren_sandboxexpired1", max_price_cents: 600 });
    await call("search_dedicated_countries");
    const ded = sc(await call("purchase_dedicated_number", { country: "uk", max_price_cents: 1699 })).dedicated_number.id;
    await call("get_dedicated_number", { number_id: ded });
    await call("search_esim_plans", { country: "us" });
    const esim = sc(await call("purchase_esim", { plan_id: "prod_us_5gb_30d", max_price_cents: 1500 })).esim.id;
    await call("get_esim_status", { esim_id: esim });
    await call("topup_esim", { esim_id: esim });
    await call("topup_esim", { esim_id: esim, topup_product_id: "prod_topup_5gb", max_price_cents: 1400 });
    await call("get_esim_qr", { esim_id: esim });
    await call("search_proxies", { type: "all" });
    const prx = sc(await call("purchase_proxy", { plan_id: "plan_US5GB30D", max_price_cents: 1800 })).proxy.id;
    await new Promise((r) => setTimeout(r, READY_AFTER_MS + 100));
    await call("get_proxy_status", { proxy_id: prx });
    await call("topup_proxy", { proxy_id: prx, additional_gb: 2, max_price_cents: 720 });
    await call("renew_proxy", { proxy_id: prx, max_price_cents: 1800 });
    await call("regenerate_proxy_password", { proxy_id: prx });
    const list = sc(await call("create_proxy_list", { proxy_id: prx, name: "la", country: "US", city: "Los Angeles" })).list.id;
    await call("update_proxy_list", { proxy_id: prx, list_id: list, rotation_period_seconds: -1 });
    await call("regenerate_proxy_password", { proxy_id: prx, list_id: list });
    await call("list_proxy_lists", { proxy_id: prx });
    await call("delete_proxy_list", { proxy_id: prx, list_id: list });
    const dedPrx = sc(await call("purchase_proxy", { plan_id: "plan_DEDUSNY30D", max_price_cents: 6900 })).proxy.id;
    await call("set_proxy_auto_renew", { proxy_id: dedPrx, enabled: true });
    await call("rotate_proxy_ip", { proxy_id: dedPrx });
    await call("get_geo", { country: "US" });
    await call("list_orders");
    await call("list_orders", { kind: "verification", status: "cancelled", limit: 5 });

    expect([...called].sort()).toEqual(tools.map((t) => t.name).sort());
    expect(fetchSpy).not.toHaveBeenCalled();
  }, 15_000);
});

describe("price commitment at the protocol boundary", () => {
  it("a purchase without max_price_cents is rejected before any request", async () => {
    const fetchSpy = vi.fn(() => Promise.reject(new Error("network must not be touched")));
    vi.stubGlobal("fetch", fetchSpy);
    const client = await connect(buildLiveServer({
      sandbox: false, apiKey: "vmk_live_" + "a".repeat(32), baseUrl: "https://x", debug: false, controls: DEFAULT_CONTROLS,
    }));
    for (const call of [
      { name: "rent_number", arguments: { service_id: "svc_telegram" } },
      { name: "purchase_esim", arguments: { plan_id: "prod_x" } },
      { name: "purchase_proxy", arguments: { plan_id: "plan_X" } },
      { name: "purchase_dedicated_number", arguments: { country: "us" } },
      { name: "renew_proxy", arguments: { proxy_id: "prx_1" } },
      { name: "topup_proxy", arguments: { proxy_id: "prx_1", additional_gb: 1 } },
      { name: "re_rent_rental", arguments: { rental_id: "ren_1" } },
      { name: "rent_number", arguments: { service_id: "svc_telegram", max_price_cents: 0 } },
    ]) {
      const res = await client.callTool(call);
      expect(res.isError, call.name).toBe(true);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("with max_price_cents the purchase goes through and charges the current price", async () => {
    const client = await sandbox();
    const res = await client.callTool({ name: "purchase_esim", arguments: { plan_id: "prod_jp_3gb_15d", max_price_cents: 1200 } });
    expect(res.isError ?? false).toBe(false);
    expect(sc(res).esim.charged_price_cents).toBe(1100);
  });
});

describe("owner controls (sandbox behaves like live)", () => {
  it("read-only: no tool that spends or changes anything is registered, and no buying prompts", async () => {
    const client = await sandbox({ readOnly: true });
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toHaveLength(13);
    for (const w of WRITE_TOOLS) expect(names).not.toContain(w);
    expect(client.getServerCapabilities()?.prompts).toBeUndefined();
    expect(client.getInstructions()).toContain("read-only");
    const acct = await client.callTool({ name: "get_account", arguments: {} });
    expect(sc(acct).owner_limits).toMatchObject({ read_only: true });
    expect(text(acct)).toContain("Read-only:");
  });

  it("toolsets: only the chosen groups plus account, orders and geo", async () => {
    const counts: Array<[string, number, string[]]> = [
      ["sms", 10, ["get_verification_code"]],
      ["numbers", 7, []],
      ["esim", 8, ["buy_travel_esim"]],
      ["proxy", 15, ["setup_mobile_proxy"]],
      ["sms,proxy", 22, ["get_verification_code", "setup_mobile_proxy"]],
    ];
    for (const [sets, n, prompts] of counts) {
      const client = await sandbox(parseControls({ VOIDMOB_TOOLSETS: sets }));
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names, sets).toHaveLength(n);
      expect(names, sets).toEqual(expect.arrayContaining(["get_account", "list_orders", "get_geo"]));
      const listed = client.getServerCapabilities()?.prompts ? (await client.listPrompts()).prompts.map((p) => p.name).sort() : [];
      expect(listed, sets).toEqual([...prompts].sort());
    }
  });

  it("max order: refuses above VOIDMOB_MAX_ORDER_CENTS with nothing charged", async () => {
    const client = await sandbox({ maxOrderCents: 1000 });
    const before = sc(await client.callTool({ name: "get_account", arguments: {} })).account.balance.amount_cents;
    const res = await client.callTool({ name: "purchase_esim", arguments: { plan_id: "prod_us_5gb_30d", max_price_cents: 1500 } });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("VOIDMOB_MAX_ORDER_CENTS");
    expect(text(res)).toContain("Nothing was charged");
    const after = sc(await client.callTool({ name: "get_account", arguments: {} })).account.balance.amount_cents;
    expect(after).toBe(before);
  });

  it("budget: counts charges across calls and refuses the purchase that would exceed it", async () => {
    const client = await sandbox({ budgetCents: 2000 });
    expect(client.getInstructions()).toContain("spend limits");
    const first = await client.callTool({ name: "purchase_esim", arguments: { plan_id: "prod_jp_3gb_15d", max_price_cents: 1200 } });
    expect(first.isError ?? false).toBe(false);
    const second = await client.callTool({ name: "purchase_esim", arguments: { plan_id: "prod_jp_3gb_15d", max_price_cents: 1200 } });
    expect(second.isError).toBe(true);
    expect(text(second)).toContain("$9.00 is left of this session's $20.00 budget");
    expect(text(second)).toContain("per-session safety net");
    expect(text(second)).toContain("Nothing was charged");
    // A purchase that fits the rest still goes through.
    const third = await client.callTool({ name: "rent_number", arguments: { service_id: "svc_telegram", max_price_cents: 150 } });
    expect(third.isError ?? false).toBe(false);
    const acct = await client.callTool({ name: "get_account", arguments: {} });
    expect(sc(acct).owner_limits).toMatchObject({ budget_cents: 2000, budget_counted_cents: 1250, budget_remaining_cents: 750 });
  });
});

describe("resources and prompts", () => {
  it("serves the skill's guides as markdown resources", async () => {
    const client = await sandbox();
    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri).sort()).toEqual([
      "voidmob://guides/dedicated-numbers",
      "voidmob://guides/errors",
      "voidmob://guides/esim",
      "voidmob://guides/money-rules",
      "voidmob://guides/proxies",
      "voidmob://guides/sms",
    ]);
    const read = async (uri: string) => {
      const out = await client.readResource({ uri });
      expect(out.contents[0].mimeType).toBe("text/markdown");
      return String((out.contents[0] as { text: string }).text);
    };
    const money = await read("voidmob://guides/money-rules");
    expect(money.startsWith("## Money rules")).toBe(true);
    expect(money).toContain("max_price_cents");
    expect(money).not.toContain("## Responsible use");
    expect(await read("voidmob://guides/proxies")).toContain("_c_US");
    expect(await read("voidmob://guides/proxies")).toContain("socks5");
    expect(await read("voidmob://guides/sms")).toContain("refunded");
    expect(await read("voidmob://guides/esim")).toContain("LPA:1$");
  });

  it("offers three prompts, each with the confirm-the-price step", async () => {
    const client = await sandbox();
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name).sort()).toEqual(["buy_travel_esim", "get_verification_code", "setup_mobile_proxy"]);
    const args: Record<string, Record<string, string>> = {
      get_verification_code: { service: "Telegram" },
      setup_mobile_proxy: { country: "DE", usage: "sticky sessions" },
      buy_travel_esim: { destination: "JP", days: "10", data_gb: "5" },
    };
    for (const p of prompts) {
      const got = await client.getPrompt({ name: p.name, arguments: args[p.name] });
      const body = (got.messages[0].content as { text: string }).text;
      expect(body, p.name).toContain("wait for an explicit yes");
      expect(body, p.name).toContain("max_price_cents");
    }
  });
});
