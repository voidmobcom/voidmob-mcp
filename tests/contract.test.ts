// Contract test against the dashboard's bundled OpenAPI document
// (tests/fixtures/openapi.json, refreshed with scripts/refresh-openapi.mjs):
//  - every /v1 path written in src/ exists in the spec;
//  - every request the tools make (driven over MCP against the sandbox,
//    including the price-mismatch lookups) uses a documented method and path,
//    documented query parameters, and only documented request body fields.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { HttpClient } from "../src/client/http.js";
import { createSandboxHttpClient, READY_AFTER_MS } from "../src/sandbox/mock-http.js";
import { createVoidmobServer } from "../src/server.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

interface Schema {
  $ref?: string;
  properties?: Record<string, unknown>;
  oneOf?: Schema[];
  anyOf?: Schema[];
  allOf?: Schema[];
}
interface Operation {
  parameters?: Array<{ $ref?: string; name?: string; in?: string }>;
  requestBody?: { $ref?: string; content?: Record<string, { schema?: Schema }> };
}
const spec = JSON.parse(readFileSync(join(root, "tests/fixtures/openapi.json"), "utf8")) as {
  servers: Array<{ url: string }>;
  paths: Record<string, Record<string, Operation> & { parameters?: Operation["parameters"] }>;
};

function deref<T>(obj: T & { $ref?: string }): T {
  if (!obj?.$ref) return obj;
  let node: unknown = spec;
  for (const key of obj.$ref.replace(/^#\//, "").split("/")) node = (node as Record<string, unknown>)[key];
  return deref(node as T & { $ref?: string });
}

// The spec's paths are relative to the server URL, which ends in /api/v1.
expect(spec.servers[0].url.endsWith("/api/v1")).toBe(true);

const templates = Object.keys(spec.paths).map((p) => ({
  template: p,
  re: new RegExp(`^${p.replace(/[.]/g, "\\.").replace(/\{[^}]+\}/g, "[^/]+")}$`),
}));

function findOperation(method: string, path: string): { template: string; op: Operation } | null {
  const rel = path.replace(/^\/v1/, "");
  const hit = templates.find((t) => t.re.test(rel));
  if (!hit) return null;
  const op = spec.paths[hit.template][method.toLowerCase()];
  return op ? { template: hit.template, op } : null;
}

function bodyFields(op: Operation): Set<string> {
  const body = op.requestBody ? deref(op.requestBody) : undefined;
  const schema = body?.content?.["application/json"]?.schema;
  const fields = new Set<string>();
  const collect = (s: Schema | undefined) => {
    if (!s) return;
    const r = deref(s);
    for (const k of Object.keys(r.properties ?? {})) fields.add(k);
    for (const sub of [...(r.oneOf ?? []), ...(r.anyOf ?? []), ...(r.allOf ?? [])]) collect(sub);
  };
  collect(schema);
  return fields;
}

function queryParams(template: string, op: Operation): Set<string> {
  const all = [...(spec.paths[template].parameters ?? []), ...(op.parameters ?? [])].map((p) => deref(p));
  return new Set(all.filter((p) => p.in === "query").map((p) => p.name as string));
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === "sandbox" ? [] : sourceFiles(full);
    return full.endsWith(".ts") ? [full] : [];
  });
}

describe("contract: src/ against the OpenAPI spec", () => {
  it("every /v1 path literal in src/ exists in the spec", () => {
    const found = new Set<string>();
    for (const file of sourceFiles(join(root, "src"))) {
      const text = readFileSync(file, "utf8");
      // "/v1/..." up to the end of the literal; ${...} after a slash is an id,
      // anything else (a query string) ends the path.
      for (const m of text.matchAll(/["`](\/v1\/[^"`]*)/g)) {
        let p = m[1].split("?")[0];
        p = p.replace(/\$\{[^}]*\}(?=\/|$)/g, (seg, offset: number) => (p[offset - 1] === "/" ? "{x}" : seg));
        p = p.replace(/\$\{.*$/, "");
        found.add(p);
      }
    }
    expect(found.size).toBeGreaterThan(30);
    const missing = [...found].filter((p) => !templates.some((t) => t.re.test(p.replace(/^\/v1/, "").replace(/\{x\}/g, "x"))));
    expect(missing).toEqual([]);
  });
});

describe("contract: every request the tools make", () => {
  it("uses a documented method, path, query parameters and body fields", async () => {
    const sandbox = createSandboxHttpClient();
    const seen: Array<{ method: string; path: string; body?: unknown }> = [];
    const http: HttpClient = {
      request(method, path, opts) {
        seen.push({ method, path, body: opts?.body });
        return sandbox.request(method, path, opts);
      },
    };
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "contract", version: "0" });
    await Promise.all([createVoidmobServer(http).connect(serverSide), client.connect(clientSide)]);
    const call = async (name: string, args: Record<string, unknown> = {}) =>
      (await client.callTool({ name, arguments: args })).structuredContent as Record<string, any>;

    // Every tool, every branch that reaches a different endpoint.
    await call("get_account");
    await call("search_sms_services");
    await call("search_sms_services", { query: "tele" });
    const ver = (await call("rent_number", { service_id: "svc_telegram", max_price_cents: 150 })).verification.id;
    await call("get_rental", { rental_id: ver });
    await call("reuse_number", { rental_id: ver });
    await call("reuse_number", { rental_id: ver, paid: true, max_price_cents: 50 });
    await call("cancel_rental", { rental_id: ver });
    const ren = (await call("rent_number", { service_id: "svc_telegram", kind: "rental", duration: "7d", max_price_cents: 600 })).rental.id;
    await call("get_rental", { rental_id: ren });
    await call("toggle_auto_renew", { rental_id: ren, auto_renew: true });
    await call("cancel_rental", { rental_id: ren });
    await call("re_rent_rental", { rental_id: "ren_sandboxexpired1", max_price_cents: 600 });
    await call("search_dedicated_countries");
    const ded = (await call("purchase_dedicated_number", { country: "uk", max_price_cents: 1699, auto_renew: true })).dedicated_number.id;
    await call("get_dedicated_number", { number_id: ded });
    await call("toggle_auto_renew", { rental_id: ded, auto_renew: false });
    await call("search_esim_plans", { country: "us", min_data_gb: 1, min_days: 5, has_5g: true, query: "USA", limit: 5, cursor: "x" });
    const esim = (await call("purchase_esim", { plan_id: "prod_us_5gb_30d", max_price_cents: 1500 })).esim.id;
    await call("get_esim_status", { esim_id: esim });
    await call("topup_esim", { esim_id: esim });
    await call("topup_esim", { esim_id: esim, topup_product_id: "prod_topup_5gb", max_price_cents: 1400 });
    await call("get_esim_qr", { esim_id: esim });
    await call("search_proxies", { type: "dedicated", country: "US", min_data_gb: 0, available_only: true, cursor: "x" });
    await call("purchase_proxy", { plan_id: "plan_US5GB30D", max_price_cents: 100 }); // PRICE_MISMATCH -> plan lookup
    const prx = (await call("purchase_proxy", { plan_id: "plan_US5GB30D", max_price_cents: 1800 })).proxy.id;
    await new Promise((r) => setTimeout(r, READY_AFTER_MS + 100));
    await call("get_proxy_status", { proxy_id: prx });
    await call("topup_proxy", { proxy_id: prx, additional_gb: 1, max_price_cents: 1 }); // PRICE_MISMATCH -> proxy + plan lookup
    await call("topup_proxy", { proxy_id: prx, additional_gb: 1, max_price_cents: 400 });
    await call("renew_proxy", { proxy_id: prx, max_price_cents: 1 }); // PRICE_MISMATCH -> proxy lookup
    await call("renew_proxy", { proxy_id: prx, max_price_cents: 1800 });
    await call("regenerate_proxy_password", { proxy_id: prx });
    const list = (await call("create_proxy_list", {
      proxy_id: prx, name: "a", country: "US", region: "California", city: "Los Angeles", isp: "Carrier A", zip: "90001",
      rotation_period_seconds: 60, rotation_mode: "delayed_5s", format: "socks5_url",
    })).list.id;
    await call("create_proxy_list", { proxy_id: prx, name: "b", countries: ["US", "CA"], network: "203.0.113.7" });
    await call("update_proxy_list", {
      proxy_id: prx, list_id: list, name: "a2", country: "DE", region: "Berlin", city: "Berlin", isp: "x", zip: "10115",
      rotation_period_seconds: -1, rotation_mode: "instant", format: "json",
    });
    await call("update_proxy_list", { proxy_id: prx, list_id: list, countries: ["DE", "FR"] });
    await call("regenerate_proxy_password", { proxy_id: prx, list_id: list });
    await call("list_proxy_lists", { proxy_id: prx });
    await call("delete_proxy_list", { proxy_id: prx, list_id: list });
    const dedPrx = (await call("purchase_proxy", { plan_id: "plan_DEDUSNY30D", max_price_cents: 6900 })).proxy.id;
    await call("set_proxy_auto_renew", { proxy_id: dedPrx, enabled: true });
    await call("rotate_proxy_ip", { proxy_id: dedPrx });
    await call("get_geo", {});
    await call("get_geo", { country: "US", region: "California", city: "Los Angeles" });
    await call("list_orders");
    for (const kind of ["verification", "rental", "dedicated", "esim", "proxy"]) {
      await call("list_orders", { kind, limit: 2, cursor: "x" });
    }
    await call("list_orders", { kind: "verification", status: "cancelled" });

    const problems: string[] = [];
    for (const req of seen) {
      const [path, qs = ""] = req.path.split("?");
      const hit = findOperation(req.method, path);
      if (!hit) {
        problems.push(`${req.method} ${path} is not in the spec`);
        continue;
      }
      const params = queryParams(hit.template, hit.op);
      for (const name of new URLSearchParams(qs).keys()) {
        if (!params.has(name)) problems.push(`${req.method} ${hit.template}: query '${name}' is not declared`);
      }
      if (req.body !== undefined) {
        const fields = bodyFields(hit.op);
        for (const key of Object.keys(req.body as Record<string, unknown>)) {
          if (!fields.has(key)) problems.push(`${req.method} ${hit.template}: body field '${key}' is not declared`);
        }
      }
    }
    expect(problems).toEqual([]);

    // The drive reached every endpoint the tools use (a guard against a
    // silently shrinking drive).
    const endpoints = new Set(seen.map((r) => `${r.method} ${findOperation(r.method, r.path.split("?")[0])?.template}`));
    expect(endpoints.size).toBeGreaterThanOrEqual(38);
  }, 15_000);
});
