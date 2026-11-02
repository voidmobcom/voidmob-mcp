// Permission levels: each tool declares the highest level any API call it can
// make needs (view: reads; manage: changes that do not spend; buy: charges),
// and a server registers only the tools its level allows. The table below is
// the 2.0.0 public surface: after 2.0.0 tools are only added, never renamed
// or removed.
import { describe, it, expect } from "vitest";
import { McpServer } from "@modelcontextprotocol/server";
import { createSandboxHttpClient } from "../src/sandbox/mock-http.js";
import { buildSandboxServer } from "../src/modes/sandbox.js";
import { DEFAULT_CONTROLS } from "../src/config.js";
import { createToolContext, levelAllows, type PermissionLevel, type ToolContext } from "../src/tools/context.js";
import { registerAccountTools } from "../src/tools/account.js";
import { registerSmsTools } from "../src/tools/sms.js";
import { registerDedicatedTools } from "../src/tools/dedicated.js";
import { registerEsimTools } from "../src/tools/esim.js";
import { registerProxyTools } from "../src/tools/proxy.js";
import { registerGeoTools } from "../src/tools/geo.js";
import { registerOrdersTools } from "../src/tools/orders.js";
import { toolNames } from "./connect.js";

const LEVELS: Record<string, PermissionLevel> = {
  get_account: "view",
  list_orders: "view",
  get_geo: "view",
  search_sms_services: "view",
  get_rental: "view",
  search_dedicated_countries: "view",
  search_esim_plans: "view",
  get_esim_status: "view",
  search_proxies: "view",
  get_proxy_status: "view",
  cancel_rental: "manage",
  toggle_auto_renew: "manage",
  rotate_proxy_ip: "manage",
  regenerate_proxy_password: "manage",
  create_proxy_list: "manage",
  update_proxy_list: "manage",
  delete_proxy_list: "manage",
  rent_number: "buy",
  reuse_number: "buy",
  re_rent_rental: "buy",
  purchase_dedicated_number: "buy",
  purchase_esim: "buy",
  topup_esim: "buy",
  purchase_proxy: "buy",
  renew_proxy: "buy",
  topup_proxy: "buy",
};

const REGISTER = [
  registerAccountTools, registerSmsTools, registerDedicatedTools, registerEsimTools,
  registerProxyTools, registerGeoTools, registerOrdersTools,
];

/** The tools a server at `level` registers (createVoidmobServer takes no level yet). */
function namesAt(level: PermissionLevel): Promise<string[]> {
  const ctx: ToolContext = { ...createToolContext(createSandboxHttpClient(), DEFAULT_CONTROLS), level };
  const server = new McpServer({ name: "levels", version: "0.0.0" });
  for (const register of REGISTER) register(server, ctx);
  return toolNames(server);
}

const expected = (level: PermissionLevel) =>
  Object.keys(LEVELS).filter((name) => levelAllows(level, LEVELS[name])).sort();

describe("permission levels", () => {
  it("the table covers exactly the tools the server registers: 26, 10 of them view", async () => {
    expect(await namesAt("buy")).toEqual(await toolNames(buildSandboxServer()));
    expect(Object.keys(LEVELS).sort()).toEqual(await toolNames(buildSandboxServer()));
    expect(Object.keys(LEVELS)).toHaveLength(26);
    expect(expected("view")).toHaveLength(10);
  });

  it.each(["view", "manage", "buy"] as const)("a %s server registers exactly the tools at or below its level", async (level) => {
    expect(await namesAt(level)).toEqual(expected(level));
  });

  it("VOIDMOB_READ_ONLY=1 is the view level", async () => {
    expect(createToolContext(createSandboxHttpClient(), { ...DEFAULT_CONTROLS, readOnly: true }).level).toBe("view");
    expect(createToolContext(createSandboxHttpClient(), DEFAULT_CONTROLS).level).toBe("buy");
    expect(await toolNames(buildSandboxServer({ ...DEFAULT_CONTROLS, readOnly: true }))).toEqual(expected("view"));
  });
});
