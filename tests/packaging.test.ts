// Packaging metadata stays in step with the server: the Claude Desktop bundle
// manifest lists exactly the registered tools and maps every setting to an
// env var the server reads; server.json declares the same env vars.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSandboxServer } from "../src/modes/sandbox.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const json = (file: string) => JSON.parse(readFileSync(join(root, file), "utf8"));
const manifest = json("manifest.json");
const serverJson = json("server.json");
const pkg = json("package.json");

// Every env var src/config.ts reads.
const ENV_VARS = [
  "VOIDMOB_API_KEY", "VOIDMOB_SANDBOX", "VOIDMOB_READ_ONLY", "VOIDMOB_MAX_ORDER_CENTS",
  "VOIDMOB_BUDGET_CENTS", "VOIDMOB_TOOLSETS", "VOIDMOB_BASE_URL", "VOIDMOB_DEBUG",
];

describe("manifest.json (Claude Desktop bundle)", () => {
  it("lists exactly the registered tools, at the package version", () => {
    // @ts-expect-error - reach into internal map for the registered tool set
    const registered = Object.keys(buildSandboxServer()._registeredTools).sort();
    expect(manifest.tools.map((t: { name: string }) => t.name).sort()).toEqual(registered);
    expect(manifest.version).toBe(pkg.version);
    expect(manifest.server.entry_point).toBe(pkg.main.replace(/^\.\//, ""));
  });

  it("wires every setting to a server env var, with the key secret and nothing required", () => {
    const env: Record<string, string> = manifest.server.mcp_config.env;
    for (const [name, value] of Object.entries(env)) {
      expect(ENV_VARS, name).toContain(name);
      const key = /^\$\{user_config\.([a-z_]+)\}$/.exec(value)?.[1];
      expect(key && manifest.user_config[key], name).toBeTruthy();
    }
    const referenced = Object.values(env).map((v) => v.replace(/^\$\{user_config\.|\}$/g, ""));
    expect(Object.keys(manifest.user_config).sort()).toEqual(referenced.sort());
    expect(manifest.user_config.api_key.sensitive).toBe(true);
    for (const cfg of Object.values(manifest.user_config) as Array<{ required?: boolean }>) expect(cfg.required).toBe(false);
  });
});

describe("server.json", () => {
  it("declares the owner controls and only env vars the server reads", () => {
    const declared = serverJson.packages[0].environmentVariables.map((e: { name: string }) => e.name);
    expect(declared).toEqual(expect.arrayContaining([
      "VOIDMOB_API_KEY", "VOIDMOB_SANDBOX", "VOIDMOB_READ_ONLY", "VOIDMOB_MAX_ORDER_CENTS", "VOIDMOB_BUDGET_CENTS", "VOIDMOB_TOOLSETS",
    ]));
    for (const name of declared) expect(ENV_VARS).toContain(name);
  });

  it("ships the skill that the resources read", () => {
    expect(pkg.files).toContain("skills");
  });
});
