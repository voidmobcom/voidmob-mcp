// Drives every sandbox tool against the in-memory mock client and asserts none
// return an error result. An error here means the mock's response shape no
// longer satisfies the live Zod schema / renderer - i.e. sandbox has drifted
// from live. Timing-gated transitions (verification code arrival, proxy going
// active) are exercised in their pre-transition state, which is still valid.
import { describe, it, expect } from "vitest";
import type { ToolResult } from "../src/utils/render.js";
import { createSandboxHttpClient, READY_AFTER_MS } from "../src/sandbox/mock-http.js";
import { getAccountHandler } from "../src/tools/account.js";
import {
  searchSmsServicesHandler, getRentalHandler, rentNumberHandler,
  cancelRentalHandler, reuseNumberHandler, reRentRentalHandler, toggleAutoRenewHandler,
} from "../src/tools/sms.js";
import {
  searchDedicatedCountriesHandler, purchaseDedicatedNumberHandler, getDedicatedNumberHandler,
} from "../src/tools/dedicated.js";
import {
  searchEsimPlansHandler, purchaseEsimHandler, getEsimStatusHandler,
  topupEsimHandler, getEsimQrHandler,
} from "../src/tools/esim.js";
import {
  searchProxiesHandler, purchaseProxyHandler, getProxyStatusHandler, rotateProxyIpHandler,
  renewProxyHandler, topupProxyHandler, regenerateProxyPasswordHandler,
  listProxyListsHandler, createProxyListHandler, deleteProxyListHandler, updateProxyListHandler,
} from "../src/tools/proxy.js";
import { getGeoHandler } from "../src/tools/geo.js";
import { listOrdersHandler } from "../src/tools/orders.js";
import { toolContext } from "../src/tools/context.js";

const http = createSandboxHttpClient();
const ctx = toolContext(http);
const sc = (r: ToolResult) => r.structuredContent as Record<string, any>;
const okResult = (r: ToolResult) => {
  expect(r.isError ?? false, (r.content[0] as { text?: string })?.text).toBe(false);
  return r;
};
// Timing-gated transitions elsewhere in this file are exercised pre-transition
// (see file header); the dedicated lifecycle below is the one flow that needs
// to observe a post-transition state (the first message arriving), so it waits
// past the mock's READY_AFTER_MS.
const waitUntilReady = () => new Promise((r) => setTimeout(r, READY_AFTER_MS + 100));

describe("sandbox e2e (every tool resolves against the mock)", () => {
  it("account + catalogs + geo cascade", async () => {
    okResult(await getAccountHandler(ctx)({}));
    okResult(await searchSmsServicesHandler(ctx)({}));
    okResult(await searchEsimPlansHandler(ctx)({ country: "US" }));
    okResult(await searchProxiesHandler(ctx)({ country: "US" }));
    okResult(await getGeoHandler(ctx)({}));
    okResult(await getGeoHandler(ctx)({ country: "US" }));
    okResult(await getGeoHandler(ctx)({ country: "US", region: "California" }));
    okResult(await getGeoHandler(ctx)({ country: "US", region: "California", city: "Los Angeles" }));
  });

  it("SMS verification lifecycle", async () => {
    const ver = okResult(await rentNumberHandler(ctx)({ service_id: "svc_telegram", kind: "verification", max_price_cents: 150 }));
    const id = sc(ver).verification.id as string;
    expect(id.startsWith("ver_")).toBe(true);
    // Prod window: 15 minutes.
    const expiresInMs = new Date(sc(ver).verification.expires_at).getTime() - Date.now();
    expect(expiresInMs).toBeGreaterThan(14 * 60_000);
    expect(expiresInMs).toBeLessThanOrEqual(15 * 60_000);
    okResult(await getRentalHandler(ctx)({ rental_id: id }));
    okResult(await reuseNumberHandler(ctx)({ rental_id: id }));
    okResult(await reuseNumberHandler(ctx)({ rental_id: id, paid: true, max_price_cents: 50 }));
    // Verifications are listable (the recovery path after a lost response).
    const orders = okResult(await listOrdersHandler(ctx)({ kind: "verification", status: "waiting_for_code" }));
    expect((sc(orders).orders as Array<{ id: string }>).some((o) => o.id === id)).toBe(true);
    // A price below the current one is refused by the (mock) API, uncharged.
    const low = await rentNumberHandler(ctx)({ service_id: "svc_telegram", max_price_cents: 100 });
    expect(low.isError).toBe(true);
    expect((low.content[0] as { text: string }).text).toContain("max_price_cents=150");
  });

  it("SMS long-term rental lifecycle", async () => {
    const ren = okResult(await rentNumberHandler(ctx)({ service_id: "svc_telegram", kind: "rental", duration: "7d", max_price_cents: 600 }));
    const id = sc(ren).rental.id as string;
    expect(id.startsWith("ren_")).toBe(true);
    expect(sc(ren).rental.charged_price_cents).toBe(600);
    okResult(await toggleAutoRenewHandler(ctx)({ rental_id: id, auto_renew: true }));
    okResult(await getRentalHandler(ctx)({ rental_id: id }));
    // An active rental is not re-rentable; the seeded expired one is.
    expect((await reRentRentalHandler(ctx)({ rental_id: id, max_price_cents: 600 })).isError).toBe(true);
    okResult(await reRentRentalHandler(ctx)({ rental_id: "ren_sandboxexpired1", max_price_cents: 600 }));
    const cancelled = okResult(await cancelRentalHandler(ctx)({ rental_id: id }));
    expect((cancelled.content[0] as { text: string }).text).toContain("Refunded");
  });

  it("eSIM lifecycle", async () => {
    const esim = okResult(await purchaseEsimHandler(ctx)({ plan_id: "prod_us_5gb_30d", max_price_cents: 1500 }));
    const id = sc(esim).esim.id as string;
    expect((esim.content[0] as { text: string }).text).toMatch(/LPA string: +LPA:1\$[^$]+\$K2-/);
    okResult(await getEsimStatusHandler(ctx)({ esim_id: id }));
    okResult(await getEsimQrHandler(ctx)({ esim_id: id }));
    okResult(await topupEsimHandler(ctx)({ esim_id: id }));
    okResult(await topupEsimHandler(ctx)({ esim_id: id, topup_product_id: "prod_topup_5gb", max_price_cents: 1400 }));
    // After a top-up the status shows both packages and a total.
    const status = okResult(await getEsimStatusHandler(ctx)({ esim_id: id }));
    const text = (status.content[0] as { text: string }).text;
    expect(text).toContain("Usage (2 packages)");
    expect(text).toContain("Total:");
  });

  it("proxy lifecycle + lists", async () => {
    const prx = okResult(await purchaseProxyHandler(ctx)({ plan_id: "plan_US5GB30D", max_price_cents: 1800 }));
    const id = sc(prx).proxy.id as string;
    okResult(await getProxyStatusHandler(ctx)({ proxy_id: id })); // still provisioning
    await waitUntilReady();
    const status = okResult(await getProxyStatusHandler(ctx)({ proxy_id: id })); // active: gateway set up
    expect((status.content[0] as { text: string }).text).toMatch(/HTTP URL: +http:\/\/vm_\w+:\w+@proxy\.voidmob\.com:10092/);
    okResult(await topupProxyHandler(ctx)({ proxy_id: id, additional_gb: 5, max_price_cents: 1800 }));
    okResult(await renewProxyHandler(ctx)({ proxy_id: id, max_price_cents: 1800 }));
    okResult(await regenerateProxyPasswordHandler(ctx)({ proxy_id: id }));
    const list = okResult(await createProxyListHandler(ctx)({ proxy_id: id, name: "la", country: "us", city: "Los Angeles" }));
    const listId = sc(list).list.id as string;
    expect(listId.startsWith("list_")).toBe(true);
    expect(sc(list).list.entries[0]).toMatch(/^vm_\w+:\w+@proxy\.voidmob\.com:10000$/);
    const moved = okResult(await updateProxyListHandler(ctx)({ proxy_id: id, list_id: listId, country: "DE", city: "Berlin", rotation_period_seconds: 300 }));
    expect(sc(moved).list).toMatchObject({ country: "DE", city: "Berlin", rotation_period_seconds: 300 });
    const rotated = okResult(await regenerateProxyPasswordHandler(ctx)({ proxy_id: id, list_id: listId }));
    expect(sc(rotated).list.credentials.password).not.toBe(sc(list).list.credentials.password);
    const ipList = okResult(await createProxyListHandler(ctx)({ proxy_id: id, name: "vm", country: "US", network: "203.0.113.7" }));
    expect(sc(ipList).list).toMatchObject({ credentials: null, network: "203.0.113.7", entries: ["proxy.voidmob.com:10000"] });
    okResult(await listProxyListsHandler(ctx)({ proxy_id: id }));
    okResult(await deleteProxyListHandler(ctx)({ proxy_id: id, list_id: listId }));

    // IP rotation is a dedicated-proxy action.
    const ded = okResult(await purchaseProxyHandler(ctx)({ plan_id: "plan_DEDUSNY30D", max_price_cents: 6900 }));
    okResult(await rotateProxyIpHandler(ctx)({ proxy_id: sc(ded).proxy.id as string }));
  }, 10_000);

  it("list_orders aggregates across kinds", async () => {
    okResult(await listOrdersHandler(ctx)({}));
  });

  it("dedicated number lifecycle: search -> purchase -> poll messages -> auto-renew -> list", async () => {
    const search = okResult(await searchDedicatedCountriesHandler(ctx)({}));
    expect((search.structuredContent?.countries as unknown[]).length).toBeGreaterThan(0);

    const buy = okResult(await purchaseDedicatedNumberHandler(ctx)({ country: "uk", max_price_cents: 1699 }));
    const id = (buy.structuredContent?.dedicated_number as { id: string }).id;
    expect(id.startsWith("ded_")).toBe(true);

    await waitUntilReady();

    const got = okResult(await getDedicatedNumberHandler(ctx)({ number_id: id }));
    const msgs = (got.structuredContent?.dedicated_number as { messages: unknown[] }).messages;
    expect(msgs.length).toBeGreaterThan(0);

    const tog = okResult(await toggleAutoRenewHandler(ctx)({ rental_id: id, auto_renew: true }));
    expect((tog.structuredContent?.dedicated_number as { auto_renew: boolean }).auto_renew).toBe(true);

    const orders = okResult(await listOrdersHandler(ctx)({ kind: "dedicated" }));
    expect((orders.structuredContent?.orders as unknown[]).length).toBeGreaterThan(0);
  }, 10_000);
});
