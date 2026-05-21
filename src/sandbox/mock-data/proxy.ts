import type { ProxyType } from "../state.js";

export interface ProxyProduct {
  id: string;
  type: ProxyType;
  name: string;
  country: string;
  countryName: string;
  carrier: string;
  carrierName: string;
  dataGb: number | null;
  durationDays: number;
  period: string;
  priceCents: number;
  features: string[];
}

export const proxyProducts: ProxyProduct[] = [
  { id: "prx_sh_us_1g", type: "shared", name: "US Shared 1GB", country: "US", countryName: "United States", carrier: "verizon", carrierName: "Verizon", dataGb: 1, durationDays: 30, period: "monthly", priceCents: 299, features: [] },
  { id: "prx_sh_us_5g", type: "shared", name: "US Shared 5GB", country: "US", countryName: "United States", carrier: "tmobile", carrierName: "T-Mobile", dataGb: 5, durationDays: 30, period: "monthly", priceCents: 1249, features: [] },
  { id: "prx_sh_gb_1g", type: "shared", name: "UK Shared 1GB", country: "GB", countryName: "United Kingdom", carrier: "vodafone", carrierName: "Vodafone", dataGb: 1, durationDays: 30, period: "monthly", priceCents: 299, features: [] },
  { id: "prx_sh_de_1g", type: "shared", name: "DE Shared 1GB", country: "DE", countryName: "Germany", carrier: "telekom", carrierName: "Deutsche Telekom", dataGb: 1, durationDays: 30, period: "monthly", priceCents: 329, features: [] },
  { id: "prx_sh_br_1g", type: "shared", name: "BR Shared 1GB", country: "BR", countryName: "Brazil", carrier: "claro", carrierName: "Claro", dataGb: 1, durationDays: 30, period: "monthly", priceCents: 199, features: [] },
  { id: "prx_sh_in_1g", type: "shared", name: "IN Shared 1GB", country: "IN", countryName: "India", carrier: "jio", carrierName: "Jio", dataGb: 1, durationDays: 30, period: "monthly", priceCents: 99, features: [] },
  { id: "prx_ds_us_mo", type: "dedicated_standard", name: "US Dedicated Standard", country: "US", countryName: "United States", carrier: "verizon", carrierName: "Verizon", dataGb: null, durationDays: 30, period: "monthly", priceCents: 8000, features: ["socks5", "rotation"] },
  { id: "prx_ds_gb_mo", type: "dedicated_standard", name: "UK Dedicated Standard", country: "GB", countryName: "United Kingdom", carrier: "vodafone", carrierName: "Vodafone", dataGb: null, durationDays: 30, period: "monthly", priceCents: 8500, features: ["socks5", "rotation"] },
  { id: "prx_ds_de_mo", type: "dedicated_standard", name: "DE Dedicated Standard", country: "DE", countryName: "Germany", carrier: "telekom", carrierName: "Deutsche Telekom", dataGb: null, durationDays: 30, period: "monthly", priceCents: 9000, features: ["socks5", "rotation"] },
  { id: "prx_ds_nl_mo", type: "dedicated_standard", name: "NL Dedicated Standard", country: "NL", countryName: "Netherlands", carrier: "kpn", carrierName: "KPN", dataGb: null, durationDays: 30, period: "monthly", priceCents: 7500, features: ["socks5", "rotation"] },
  { id: "prx_dp_us_mo", type: "dedicated_premium", name: "US Dedicated Premium", country: "US", countryName: "United States", carrier: "verizon", carrierName: "Verizon", dataGb: null, durationDays: 30, period: "monthly", priceCents: 12000, features: ["vless", "p0f", "socks5", "rotation", "dedicated_dns"] },
  { id: "prx_dp_gb_mo", type: "dedicated_premium", name: "UK Dedicated Premium", country: "GB", countryName: "United Kingdom", carrier: "vodafone", carrierName: "Vodafone", dataGb: null, durationDays: 30, period: "monthly", priceCents: 13000, features: ["vless", "p0f", "socks5", "rotation", "dedicated_dns"] },
  { id: "prx_dp_de_mo", type: "dedicated_premium", name: "DE Dedicated Premium", country: "DE", countryName: "Germany", carrier: "telekom", carrierName: "Deutsche Telekom", dataGb: null, durationDays: 30, period: "monthly", priceCents: 13500, features: ["vless", "p0f", "socks5", "rotation", "dedicated_dns"] },
];

export function searchProducts(opts?: {
  country?: string;
  type?: ProxyType;
}): ProxyProduct[] {
  let results = proxyProducts;
  if (opts?.country) {
    const c = opts.country.toUpperCase();
    results = results.filter((p) => p.country === c);
  }
  if (opts?.type) results = results.filter((p) => p.type === opts.type);
  return results;
}

export function getProduct(productId: string): ProxyProduct | undefined {
  return proxyProducts.find((p) => p.id === productId);
}
