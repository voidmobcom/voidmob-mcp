// Drives every sandbox tool against the in-memory mock client and asserts none
// return an error result. An error here means the mock's response shape no
// longer satisfies the live Zod schema / renderer - i.e. sandbox has drifted
// from live. Timing-gated transitions (verification code arrival, proxy going
// active) are exercised in their pre-transition state, which is still valid.
import { describe, it, expect } from "vitest";
import type { ToolResult } from "../src/utils/render.js";
import { createSandboxHttpClient } from "../src/sandbox/mock-http.js";
import { getAccountHandler } from "../src/tools/account.js";
import {
  searchSmsServicesHandler, getRentalHandler, rentNumberHandler,
  cancelRentalHandler, reuseNumberHandler, reRentRentalHandler, toggleAutoRenewHandler,
} from "../src/tools/sms.js";
import {
  searchEsimPlansHandler, purchaseEsimHandler, getEsimStatusHandler,
  topupEsimHandler, getEsimQrHandler,
} from "../src/tools/esim.js";
import {
  searchProxiesHandler, purchaseProxyHandler, getProxyStatusHandler, rotateProxyIpHandler,
  renewProxyHandler, topupProxyHandler, regenerateProxyPasswordHandler,
  listProxyListsHandler, createProxyListHandler, deleteProxyListHandler,
} from "../src/tools/proxy.js";
import { getGeoHandler } from "../src/tools/geo.js";
import { listOrdersHandler } from "../src/tools/orders.js";

const http = createSandboxHttpClient();
const sc = (r: ToolResult) => r.structuredContent as Record<string, any>;
const okResult = (r: ToolResult) => {
  expect(r.isError ?? false, (r.content[0] as { text?: string })?.text).toBe(false);
  return r;
};

describe("sandbox e2e (every tool resolves against the mock)", () => {
  it("account + catalogs + geo cascade", async () => {
    okResult(await getAccountHandler(http)());
    okResult(await searchSmsServicesHandler(http)({}));
    okResult(await searchEsimPlansHandler(http)({ country: "US" }));
    okResult(await searchProxiesHandler(http)({ country: "US" }));
    okResult(await getGeoHandler(http)({}));
    okResult(await getGeoHandler(http)({ country: "US" }));
    okResult(await getGeoHandler(http)({ country: "US", region: "California" }));
    okResult(await getGeoHandler(http)({ country: "US", region: "California", city: "Los Angeles" }));
  });

  it("SMS verification lifecycle", async () => {
    const ver = okResult(await rentNumberHandler(http)({ service_id: "svc_telegram", kind: "verification" }));
    const id = sc(ver).verification.id as string;
    expect(id.startsWith("ver_")).toBe(true);
    okResult(await getRentalHandler(http)({ rental_id: id }));
    okResult(await reuseNumberHandler(http)({ rental_id: id }));
    okResult(await reuseNumberHandler(http)({ rental_id: id, paid: true }));
  });

  it("SMS long-term + dedicated lifecycle", async () => {
    const ren = okResult(await rentNumberHandler(http)({ service_id: "svc_telegram", kind: "rental", duration: "7d" }));
    const id = sc(ren).rental.id as string;
    expect(id.startsWith("ren_")).toBe(true);
    okResult(await toggleAutoRenewHandler(http)({ rental_id: id, auto_renew: true }));
    okResult(await getRentalHandler(http)({ rental_id: id }));
    okResult(await reRentRentalHandler(http)({ rental_id: id }));
    okResult(await cancelRentalHandler(http)({ rental_id: id }));
    okResult(await rentNumberHandler(http)({ service_id: "svc_dedicated_28d", kind: "dedicated" }));
  });

  it("eSIM lifecycle", async () => {
    const esim = okResult(await purchaseEsimHandler(http)({ plan_id: "prod_us_5gb_30d" }));
    const id = sc(esim).esim.id as string;
    okResult(await getEsimStatusHandler(http)({ esim_id: id }));
    okResult(await getEsimQrHandler(http)({ esim_id: id }));
    okResult(await topupEsimHandler(http)({ esim_id: id }));
    okResult(await topupEsimHandler(http)({ esim_id: id, topup_product_id: "prod_topup_5gb" }));
  });

  it("proxy lifecycle + lists", async () => {
    const prx = okResult(await purchaseProxyHandler(http)({ plan_id: "pplan_us_5gb_30d" }));
    const id = sc(prx).proxy.id as string;
    okResult(await getProxyStatusHandler(http)({ proxy_id: id }));
    okResult(await rotateProxyIpHandler(http)({ proxy_id: id }));
    okResult(await topupProxyHandler(http)({ proxy_id: id, additional_gb: 5 }));
    okResult(await renewProxyHandler(http)({ proxy_id: id }));
    okResult(await regenerateProxyPasswordHandler(http)({ proxy_id: id }));
    const list = okResult(await createProxyListHandler(http)({ proxy_id: id, name: "la", country: "us", city: "Los Angeles" }));
    const listId = sc(list).list.id as string;
    okResult(await listProxyListsHandler(http)({ proxy_id: id }));
    okResult(await deleteProxyListHandler(http)({ proxy_id: id, list_id: listId }));
  });

  it("list_orders aggregates across kinds", async () => {
    okResult(await listOrdersHandler(http)({}));
  });
});
