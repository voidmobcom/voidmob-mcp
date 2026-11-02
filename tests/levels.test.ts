// Permission levels: each tool declares the highest level any API call it can
// make needs (view: reads; manage: changes that do not spend; buy: charges),
// and a server registers only the tools its level allows: the lower of the
// API key's or app connection's permission (from /v1/me) and the local
// controls. The table below is the 2.0.0 public surface: after 2.0.0 tools are
// only added, never renamed or removed.
import { describe, it, expect } from "vitest";
import { createSandboxHttpClient } from "../src/sandbox/mock-http.js";
import { buildSandboxServer } from "../src/modes/sandbox.js";
import { createVoidmobServer } from "../src/server.js";
import { DEFAULT_CONTROLS, type OwnerControls } from "../src/config.js";
import { loadConnection, type Connection } from "../src/connection.js";
import { levelAllows, type PermissionLevel } from "../src/tools/context.js";
import { connect, toolNames } from "./connect.js";

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

const key = (permission: PermissionLevel): Connection => ({ permission, autoMode: false, maxOrderCents: null, dailyLimitCents: null });

/** The tools the real server registers for a key at `permission` under these local controls. */
const namesFor = (permission: PermissionLevel, controls: Partial<OwnerControls> = {}) =>
  toolNames(createVoidmobServer(createSandboxHttpClient(), { ...DEFAULT_CONTROLS, ...controls }, key(permission)));

const expected = (level: PermissionLevel) =>
  Object.keys(LEVELS).filter((name) => levelAllows(level, LEVELS[name])).sort();

describe("permission levels", () => {
  it("the table covers exactly the tools the server registers: 26, 10 of them view", async () => {
    expect(Object.keys(LEVELS).sort()).toEqual(await toolNames(buildSandboxServer()));
    expect(Object.keys(LEVELS)).toHaveLength(26);
    expect(expected("view")).toHaveLength(10);
    expect(expected("manage")).toHaveLength(17);
  });

  it.each(["view", "manage", "buy"] as const)("a %s key gets exactly the tools at or below its level", async (level) => {
    expect(await namesFor(level)).toEqual(expected(level));
  });

  it("no key settings (unknown) leaves the local controls alone: every tool", async () => {
    expect(await toolNames(createVoidmobServer(createSandboxHttpClient()))).toEqual(expected("buy"));
  });

  it("VOIDMOB_READ_ONLY=1 is View, whatever the key allows", async () => {
    for (const level of ["view", "manage", "buy"] as const) {
      expect(await namesFor(level, { readOnly: true }), level).toEqual(expected("view"));
    }
    expect(await toolNames(buildSandboxServer({ ...DEFAULT_CONTROLS, readOnly: true }))).toEqual(expected("view"));
  });

  it("VOIDMOB_TOOLSETS still narrows a key's level", async () => {
    const names = await namesFor("manage", { toolsets: new Set(["esim"] as const) });
    expect(names).toEqual(["get_account", "get_esim_status", "get_geo", "list_orders", "search_esim_plans"]);
  });

  it("guided buying prompts appear only at Buy", async () => {
    for (const level of ["view", "manage"] as const) {
      const client = await connect(createVoidmobServer(createSandboxHttpClient(), DEFAULT_CONTROLS, key(level)));
      expect(client.getServerCapabilities()?.prompts, level).toBeUndefined();
    }
    const client = await connect(createVoidmobServer(createSandboxHttpClient(), DEFAULT_CONTROLS, key("buy")));
    expect((await client.listPrompts()).prompts.length).toBeGreaterThan(0);
  });

  it("end to end: the sandbox key's level, read through /v1/me, shapes the tool list", async () => {
    const http = createSandboxHttpClient({ key: { permission: "manage" } });
    const connection = await loadConnection(http, "levels-test-manage");
    expect(connection).toMatchObject({ permission: "manage", kind: "key" });
    expect(await toolNames(createVoidmobServer(http, DEFAULT_CONTROLS, connection))).toEqual(expected("manage"));
  });
});
