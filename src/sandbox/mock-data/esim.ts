export interface EsimPlan {
  id: string;
  title: string;
  countries: string[];
  dataLimitGb: number | null;
  dataUnlimited: boolean;
  validityDays: number;
  retailPriceUsd: number;
  has5g: boolean;
  hasHotspot: boolean;
  supportsTopup: boolean;
  routingLocation: string;
  networkType: string;
  speed: string;
  activationPolicy: string;
  tags: string[];
}

export interface EsimTopupProduct {
  id: string;
  parentPlanId: string;
  title: string;
  dataLimitGb: number;
  validityDays: number;
  retailPriceUsd: number;
}

export const esimPlans: EsimPlan[] = [
  { id: "esim_jp_3g_7d", title: "Japan 3GB / 7 Days", countries: ["JP"], dataLimitGb: 3, dataUnlimited: false, validityDays: 7, retailPriceUsd: 4.50, has5g: false, hasHotspot: true, supportsTopup: true, routingLocation: "Japan", networkType: "4G LTE", speed: "Up to 50 Mbps", activationPolicy: "First data usage", tags: ["Budget"] },
  { id: "esim_jp_5g_14d", title: "Japan 5GB / 14 Days", countries: ["JP"], dataLimitGb: 5, dataUnlimited: false, validityDays: 14, retailPriceUsd: 7.50, has5g: true, hasHotspot: true, supportsTopup: true, routingLocation: "Japan", networkType: "5G/LTE", speed: "Up to 100 Mbps", activationPolicy: "First data usage", tags: ["Popular"] },
  { id: "esim_jp_10g_30d", title: "Japan 10GB / 30 Days", countries: ["JP"], dataLimitGb: 10, dataUnlimited: false, validityDays: 30, retailPriceUsd: 12.00, has5g: true, hasHotspot: true, supportsTopup: true, routingLocation: "Japan", networkType: "5G/LTE", speed: "Up to 100 Mbps", activationPolicy: "First data usage", tags: ["Best Value"] },
  { id: "esim_jp_unl_30d", title: "Japan Unlimited / 30 Days", countries: ["JP"], dataLimitGb: null, dataUnlimited: true, validityDays: 30, retailPriceUsd: 22.00, has5g: true, hasHotspot: false, supportsTopup: false, routingLocation: "Japan", networkType: "5G/LTE", speed: "Up to 100 Mbps", activationPolicy: "First data usage", tags: ["Unlimited"] },
  { id: "esim_us_5g_7d", title: "USA 5GB / 7 Days", countries: ["US"], dataLimitGb: 5, dataUnlimited: false, validityDays: 7, retailPriceUsd: 6.00, has5g: true, hasHotspot: true, supportsTopup: true, routingLocation: "United States", networkType: "5G/LTE", speed: "Up to 150 Mbps", activationPolicy: "First data usage", tags: [] },
  { id: "esim_us_10g_30d", title: "USA 10GB / 30 Days", countries: ["US"], dataLimitGb: 10, dataUnlimited: false, validityDays: 30, retailPriceUsd: 11.00, has5g: true, hasHotspot: true, supportsTopup: true, routingLocation: "United States", networkType: "5G/LTE", speed: "Up to 150 Mbps", activationPolicy: "First data usage", tags: ["Popular"] },
  { id: "esim_us_20g_30d", title: "USA 20GB / 30 Days", countries: ["US"], dataLimitGb: 20, dataUnlimited: false, validityDays: 30, retailPriceUsd: 18.00, has5g: true, hasHotspot: true, supportsTopup: true, routingLocation: "United States", networkType: "5G/LTE", speed: "Up to 150 Mbps", activationPolicy: "First data usage", tags: ["Best Value"] },
  { id: "esim_gb_5g_7d", title: "UK 5GB / 7 Days", countries: ["GB"], dataLimitGb: 5, dataUnlimited: false, validityDays: 7, retailPriceUsd: 5.50, has5g: true, hasHotspot: true, supportsTopup: true, routingLocation: "United Kingdom", networkType: "5G/LTE", speed: "Up to 100 Mbps", activationPolicy: "First data usage", tags: [] },
  { id: "esim_gb_10g_30d", title: "UK 10GB / 30 Days", countries: ["GB"], dataLimitGb: 10, dataUnlimited: false, validityDays: 30, retailPriceUsd: 10.00, has5g: true, hasHotspot: true, supportsTopup: true, routingLocation: "United Kingdom", networkType: "5G/LTE", speed: "Up to 100 Mbps", activationPolicy: "First data usage", tags: ["Popular"] },
  { id: "esim_de_5g_7d", title: "Germany 5GB / 7 Days", countries: ["DE"], dataLimitGb: 5, dataUnlimited: false, validityDays: 7, retailPriceUsd: 5.00, has5g: false, hasHotspot: true, supportsTopup: true, routingLocation: "Germany", networkType: "4G LTE", speed: "Up to 50 Mbps", activationPolicy: "First data usage", tags: [] },
  { id: "esim_de_10g_30d", title: "Germany 10GB / 30 Days", countries: ["DE"], dataLimitGb: 10, dataUnlimited: false, validityDays: 30, retailPriceUsd: 9.00, has5g: false, hasHotspot: true, supportsTopup: true, routingLocation: "Germany", networkType: "4G LTE", speed: "Up to 50 Mbps", activationPolicy: "First data usage", tags: ["Best Value"] },
  { id: "esim_th_5g_7d", title: "Thailand 5GB / 7 Days", countries: ["TH"], dataLimitGb: 5, dataUnlimited: false, validityDays: 7, retailPriceUsd: 3.50, has5g: false, hasHotspot: true, supportsTopup: true, routingLocation: "Thailand", networkType: "4G LTE", speed: "Up to 50 Mbps", activationPolicy: "First data usage", tags: ["Budget"] },
  { id: "esim_th_15g_30d", title: "Thailand 15GB / 30 Days", countries: ["TH"], dataLimitGb: 15, dataUnlimited: false, validityDays: 30, retailPriceUsd: 8.00, has5g: false, hasHotspot: true, supportsTopup: true, routingLocation: "Thailand", networkType: "4G LTE", speed: "Up to 50 Mbps", activationPolicy: "First data usage", tags: ["Best Value"] },
  { id: "esim_tr_5g_7d", title: "Turkey 5GB / 7 Days", countries: ["TR"], dataLimitGb: 5, dataUnlimited: false, validityDays: 7, retailPriceUsd: 4.00, has5g: false, hasHotspot: true, supportsTopup: true, routingLocation: "Turkey", networkType: "4G LTE", speed: "Up to 50 Mbps", activationPolicy: "First data usage", tags: [] },
  { id: "esim_br_5g_7d", title: "Brazil 5GB / 7 Days", countries: ["BR"], dataLimitGb: 5, dataUnlimited: false, validityDays: 7, retailPriceUsd: 5.50, has5g: false, hasHotspot: true, supportsTopup: true, routingLocation: "Brazil", networkType: "4G LTE", speed: "Up to 50 Mbps", activationPolicy: "First data usage", tags: [] },
  { id: "esim_eu_5g_7d", title: "Europe 30 Countries / 5GB / 7 Days", countries: ["GB", "DE", "FR", "IT", "ES", "NL", "BE", "AT", "CH", "PT", "SE", "NO", "DK", "FI", "IE", "PL", "CZ", "RO", "HU", "GR", "HR", "BG", "SK", "SI", "LT", "LV", "EE", "CY", "MT", "LU"], dataLimitGb: 5, dataUnlimited: false, validityDays: 7, retailPriceUsd: 8.00, has5g: false, hasHotspot: true, supportsTopup: true, routingLocation: "Germany", networkType: "4G LTE", speed: "Up to 50 Mbps", activationPolicy: "First data usage", tags: ["Regional", "Popular"] },
  { id: "esim_eu_10g_30d", title: "Europe 30 Countries / 10GB / 30 Days", countries: ["GB", "DE", "FR", "IT", "ES", "NL", "BE", "AT", "CH", "PT", "SE", "NO", "DK", "FI", "IE", "PL", "CZ", "RO", "HU", "GR", "HR", "BG", "SK", "SI", "LT", "LV", "EE", "CY", "MT", "LU"], dataLimitGb: 10, dataUnlimited: false, validityDays: 30, retailPriceUsd: 14.00, has5g: false, hasHotspot: true, supportsTopup: true, routingLocation: "Germany", networkType: "4G LTE", speed: "Up to 50 Mbps", activationPolicy: "First data usage", tags: ["Regional", "Best Value"] },
  { id: "esim_sea_5g_7d", title: "Southeast Asia 8 Countries / 5GB / 7 Days", countries: ["TH", "VN", "MY", "SG", "ID", "PH", "KH", "LA"], dataLimitGb: 5, dataUnlimited: false, validityDays: 7, retailPriceUsd: 6.00, has5g: false, hasHotspot: true, supportsTopup: false, routingLocation: "Singapore", networkType: "4G LTE", speed: "Up to 50 Mbps", activationPolicy: "First data usage", tags: ["Regional"] },
];

export const esimTopupProducts: EsimTopupProduct[] = [
  { id: "topup_1g_7d", parentPlanId: "*", title: "1GB Top-up / 7 Days", dataLimitGb: 1, validityDays: 7, retailPriceUsd: 2.00 },
  { id: "topup_3g_30d", parentPlanId: "*", title: "3GB Top-up / 30 Days", dataLimitGb: 3, validityDays: 30, retailPriceUsd: 4.50 },
  { id: "topup_5g_30d", parentPlanId: "*", title: "5GB Top-up / 30 Days", dataLimitGb: 5, validityDays: 30, retailPriceUsd: 7.00 },
  { id: "topup_10g_30d", parentPlanId: "*", title: "10GB Top-up / 30 Days", dataLimitGb: 10, validityDays: 30, retailPriceUsd: 12.00 },
];

export function searchPlans(opts: {
  country?: string; duration?: number; dataAmount?: number;
  has5g?: boolean; hasHotspot?: boolean; search?: string;
  limit?: number;
}): EsimPlan[] {
  let results = esimPlans;
  if (opts.country) {
    const c = opts.country.toUpperCase();
    results = results.filter((p) => p.countries.includes(c));
  }
  if (opts.duration) results = results.filter((p) => p.validityDays >= opts.duration!);
  if (opts.dataAmount) results = results.filter((p) => p.dataUnlimited || (p.dataLimitGb !== null && p.dataLimitGb >= opts.dataAmount!));
  if (opts.has5g) results = results.filter((p) => p.has5g);
  if (opts.hasHotspot) results = results.filter((p) => p.hasHotspot);
  if (opts.search) {
    const q = opts.search.toLowerCase();
    results = results.filter((p) => p.title.toLowerCase().includes(q));
  }
  results = results.sort((a, b) => a.retailPriceUsd - b.retailPriceUsd);
  return results.slice(0, opts.limit ?? 20);
}

export function getPlan(planId: string): EsimPlan | undefined {
  return esimPlans.find((p) => p.id === planId);
}

export function getTopupProducts(planId: string): EsimTopupProduct[] {
  const plan = getPlan(planId);
  if (!plan || !plan.supportsTopup) return [];
  return esimTopupProducts.filter((t) => t.parentPlanId === "*" || t.parentPlanId === planId);
}

export function getTopupProduct(topupId: string): EsimTopupProduct | undefined {
  return esimTopupProducts.find((t) => t.id === topupId);
}
