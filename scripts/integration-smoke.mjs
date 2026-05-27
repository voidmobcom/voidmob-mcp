#!/usr/bin/env node
/**
 * Live integration smoke against the real VoidMob API.
 *
 * Drives the SAME production tool handlers the MCP registers, through a real
 * HTTP client, against dashboard.voidmob.com. This is the only test layer that
 * validates the hand-written Zod schemas against real API responses - the
 * vitest suite runs entirely against mocks.
 *
 * Read-only by default (zero spend). Pass --with-purchases to run ONE SMS
 * verification (cancelled for refund where possible) and ONE 1GB shared proxy
 * purchase (real, mostly non-refundable spend).
 *
 *   VOIDMOB_API_KEY=vmk_live_... node scripts/integration-smoke.mjs
 *   VOIDMOB_API_KEY=vmk_live_... node scripts/integration-smoke.mjs --with-purchases
 *
 * A Zod parse failure throws out of the handler (wrapToolErrors only catches
 * HttpError/NetworkError) - the harness reports those as SCHEMA MISMATCH.
 */
import { createHttpClient } from "../dist/client/http.js";
import { getAccountHandler } from "../dist/tools/account.js";
import {
  searchSmsServicesHandler,
  rentNumberHandler,
  getRentalHandler,
  cancelRentalHandler,
} from "../dist/tools/sms.js";
import { searchEsimPlansHandler } from "../dist/tools/esim.js";
import {
  searchProxiesHandler,
  purchaseProxyHandler,
  getProxyStatusHandler,
  createProxyListHandler,
  listProxyListsHandler,
  deleteProxyListHandler,
} from "../dist/tools/proxy.js";
import { getGeoHandler } from "../dist/tools/geo.js";
import { listOrdersHandler } from "../dist/tools/orders.js";

const KEY = process.env.VOIDMOB_API_KEY;
if (!KEY) {
  console.error("Set VOIDMOB_API_KEY");
  process.exit(1);
}
const BASE = process.env.VOIDMOB_BASE_URL ?? "https://dashboard.voidmob.com/api";
const WITH_PURCHASES = process.argv.includes("--with-purchases");

const http = createHttpClient({
  apiKey: KEY,
  baseUrl: BASE,
  debug: process.env.VOIDMOB_DEBUG === "1",
  userAgent: "voidmob-mcp-integration/smoke",
});

let pass = 0;
let fail = 0;
const failures = [];

function textOf(res) {
  const t = res?.content?.find((c) => c.type === "text");
  return t ? t.text : "(no text block)";
}

async function check(name, fn) {
  try {
    const res = await fn();
    if (res.isError) {
      console.log(`  FAIL ${name}: tool error -> ${textOf(res).split("\n")[0]}`);
      failures.push(`${name}: ${textOf(res).split("\n")[0]}`);
      fail++;
      return null;
    }
    const keys = res.structuredContent ? Object.keys(res.structuredContent).join(", ") : "(none)";
    console.log(`  ok   ${name}  [structured: ${keys}]`);
    pass++;
    return res;
  } catch (e) {
    const kind = e?.name === "ZodError" ? "SCHEMA MISMATCH" : `THREW ${e?.name}`;
    const detail = e?.name === "ZodError"
      ? JSON.stringify(e.issues?.slice(0, 4))
      : (e?.message ?? String(e)).slice(0, 300);
    console.log(`  FAIL ${name}: ${kind} -> ${detail}`);
    failures.push(`${name}: ${kind} ${detail}`);
    fail++;
    return null;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function readOnly() {
  console.log("\n== Read-only (zero spend) ==");
  await check("get_account", () => getAccountHandler(http)({}));
  await check("search_sms_services", () => searchSmsServicesHandler(http)({}));
  await check("search_esim_plans", () => searchEsimPlansHandler(http)({ limit: 5 }));
  await check("search_proxies", () => searchProxiesHandler(http)({}));
  await check("get_geo (countries)", () => getGeoHandler(http)({}));
  await check("get_geo (regions)", () => getGeoHandler(http)({ country: "US" }));
  await check("list_orders", () => listOrdersHandler(http)({ limit: 10 }));
}

async function purchases() {
  console.log("\n== Money ops (real spend) ==");

  // --- SMS verification (cheapest service), then cancel for refund ---
  const svcRes = await check("search_sms_services (pick cheapest)", () =>
    searchSmsServicesHandler(http)({}),
  );
  if (svcRes?.structuredContent?.services?.length) {
    const services = svcRes.structuredContent.services;
    const cheapest = services.reduce((m, s) =>
      s.quoted_price_cents < m.quoted_price_cents ? s : m,
    );
    console.log(`  -> cheapest service: ${cheapest.name} (${cheapest.id}) @ ${cheapest.quoted_price_cents}c`);

    const rented = await check(`rent_number(${cheapest.id}, verification)`, () =>
      rentNumberHandler(http)({ service_id: cheapest.id, kind: "verification" }),
    );
    const verId = rented?.structuredContent?.verification?.id;
    if (verId) {
      console.log(`  -> rented ${verId}`);
      await check(`get_rental(${verId})`, () => getRentalHandler(http)({ rental_id: verId }));
      // Cancel for refund. May hit CANCEL_WINDOW_NOT_OPEN cooldown; report either way.
      await check(`cancel_rental(${verId})`, () => cancelRentalHandler(http)({ rental_id: verId }));
    }
  }

  // --- Shared proxy, smallest GB, then list create/list/delete ---
  const proxRes = await check("search_proxies (shared)", () =>
    searchProxiesHandler(http)({ type: "shared" }),
  );
  if (proxRes?.structuredContent?.proxy_plans?.length) {
    const plans = proxRes.structuredContent.proxy_plans;
    // Prefer a 1GB plan; otherwise smallest data_gb; otherwise cheapest.
    const oneGb = plans.find((p) => p.data_gb === 1);
    const target = oneGb ?? plans
      .filter((p) => p.data_gb != null)
      .reduce((m, p) => (p.data_gb < m.data_gb ? p : m), plans[0]);
    console.log(`  -> target plan: ${target.name} (${target.id}) ${target.data_gb}GB @ ${target.quoted_price_cents}c`);

    const bought = await check(`purchase_proxy(${target.id})`, () =>
      purchaseProxyHandler(http)({ plan_id: target.id }),
    );
    const proxyId = bought?.structuredContent?.proxy?.id;
    if (proxyId) {
      console.log(`  -> bought ${proxyId}, polling for active (up to ~2min)...`);
      let active = false;
      for (let i = 0; i < 12; i++) {
        await sleep(10_000);
        const st = await getProxyStatusHandler(http)({ proxy_id: proxyId });
        const status = st?.structuredContent?.proxy?.status;
        console.log(`     poll ${i + 1}: status=${status}`);
        if (status === "active") { active = true; break; }
        if (status === "refunded" || status === "expired") break;
      }
      await check(`get_proxy_status(${proxyId})`, () => getProxyStatusHandler(http)({ proxy_id: proxyId }));
      if (active) {
        const created = await check(`create_proxy_list(${proxyId})`, () =>
          createProxyListHandler(http)({
            proxy_id: proxyId,
            name: "smoke-test",
            location_preset: "world_mix",
            rotation_period: 0,
          }),
        );
        await check(`list_proxy_lists(${proxyId})`, () => listProxyListsHandler(http)({ proxy_id: proxyId }));
        const listId = created?.structuredContent?.list?.id;
        if (listId) {
          await check(`delete_proxy_list(${proxyId}, ${listId})`, () =>
            deleteProxyListHandler(http)({ proxy_id: proxyId, list_id: listId }),
          );
        }
      } else {
        console.log("  (proxy never went active - skipping list create/delete)");
      }
    }
  }
}

(async () => {
  console.log(`Integration smoke against ${BASE}`);
  console.log(`Mode: ${WITH_PURCHASES ? "READ-ONLY + PURCHASES" : "READ-ONLY"}`);
  await readOnly();
  if (WITH_PURCHASES) await purchases();
  console.log(`\n== Result: ${pass} passed, ${fail} failed ==`);
  if (failures.length) {
    console.log("Failures:");
    for (const f of failures) console.log(`  - ${f}`);
  }
  process.exit(fail > 0 ? 1 : 0);
})();
