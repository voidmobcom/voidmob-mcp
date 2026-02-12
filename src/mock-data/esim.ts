export interface EsimPlan {
  planId: string;
  name: string;
  country: string;
  region: string;
  data: number; // GB (999 = unlimited)
  duration: number; // days
  price: number; // USD
  carrier: string;
  apn: string;
  routing: string;
  topupAvailable: boolean;
  topupPrice: number; // per GB
}

export const esimPlans: EsimPlan[] = [
  { planId: "esim_jp_3g_7d", name: "Japan 3GB / 7 Days", country: "JP", region: "Asia", data: 3, duration: 7, price: 4.50, carrier: "IIJmio", apn: "iijmio.jp", routing: "Tokyo, Japan", topupAvailable: true, topupPrice: 1.80 },
  { planId: "esim_jp_5g_14d", name: "Japan 5GB / 14 Days", country: "JP", region: "Asia", data: 5, duration: 14, price: 7.50, carrier: "IIJmio", apn: "iijmio.jp", routing: "Tokyo, Japan", topupAvailable: true, topupPrice: 1.80 },
  { planId: "esim_jp_10g_30d", name: "Japan 10GB / 30 Days", country: "JP", region: "Asia", data: 10, duration: 30, price: 12.00, carrier: "IIJmio", apn: "iijmio.jp", routing: "Tokyo, Japan", topupAvailable: true, topupPrice: 1.50 },
  { planId: "esim_jp_unl_30d", name: "Japan Unlimited / 30 Days", country: "JP", region: "Asia", data: 999, duration: 30, price: 22.00, carrier: "SoftBank", apn: "plus.4g", routing: "Tokyo, Japan", topupAvailable: false, topupPrice: 0 },
  { planId: "esim_us_5g_7d", name: "USA 5GB / 7 Days", country: "US", region: "North America", data: 5, duration: 7, price: 6.00, carrier: "T-Mobile", apn: "fast.t-mobile.com", routing: "Los Angeles, US", topupAvailable: true, topupPrice: 1.50 },
  { planId: "esim_us_10g_30d", name: "USA 10GB / 30 Days", country: "US", region: "North America", data: 10, duration: 30, price: 11.00, carrier: "T-Mobile", apn: "fast.t-mobile.com", routing: "Los Angeles, US", topupAvailable: true, topupPrice: 1.30 },
  { planId: "esim_us_20g_30d", name: "USA 20GB / 30 Days", country: "US", region: "North America", data: 20, duration: 30, price: 18.00, carrier: "T-Mobile", apn: "fast.t-mobile.com", routing: "Los Angeles, US", topupAvailable: true, topupPrice: 1.10 },
  { planId: "esim_gb_5g_7d", name: "UK 5GB / 7 Days", country: "GB", region: "Europe", data: 5, duration: 7, price: 5.50, carrier: "Three", apn: "three.co.uk", routing: "London, UK", topupAvailable: true, topupPrice: 1.40 },
  { planId: "esim_gb_10g_30d", name: "UK 10GB / 30 Days", country: "GB", region: "Europe", data: 10, duration: 30, price: 10.00, carrier: "Three", apn: "three.co.uk", routing: "London, UK", topupAvailable: true, topupPrice: 1.20 },
  { planId: "esim_de_5g_7d", name: "Germany 5GB / 7 Days", country: "DE", region: "Europe", data: 5, duration: 7, price: 5.00, carrier: "O2", apn: "internet", routing: "Frankfurt, DE", topupAvailable: true, topupPrice: 1.30 },
  { planId: "esim_de_10g_30d", name: "Germany 10GB / 30 Days", country: "DE", region: "Europe", data: 10, duration: 30, price: 9.00, carrier: "O2", apn: "internet", routing: "Frankfurt, DE", topupAvailable: true, topupPrice: 1.10 },
  { planId: "esim_th_5g_7d", name: "Thailand 5GB / 7 Days", country: "TH", region: "Asia", data: 5, duration: 7, price: 3.50, carrier: "AIS", apn: "internet", routing: "Bangkok, TH", topupAvailable: true, topupPrice: 0.90 },
  { planId: "esim_th_15g_30d", name: "Thailand 15GB / 30 Days", country: "TH", region: "Asia", data: 15, duration: 30, price: 8.00, carrier: "AIS", apn: "internet", routing: "Bangkok, TH", topupAvailable: true, topupPrice: 0.70 },
  { planId: "esim_tr_5g_7d", name: "Turkey 5GB / 7 Days", country: "TR", region: "Europe", data: 5, duration: 7, price: 4.00, carrier: "Turkcell", apn: "internet", routing: "Istanbul, TR", topupAvailable: true, topupPrice: 1.00 },
  { planId: "esim_br_5g_7d", name: "Brazil 5GB / 7 Days", country: "BR", region: "South America", data: 5, duration: 7, price: 5.50, carrier: "Claro", apn: "claro.com.br", routing: "Sao Paulo, BR", topupAvailable: true, topupPrice: 1.30 },
];

export function searchPlans(country?: string, duration?: number, dataAmount?: number): EsimPlan[] {
  let results = esimPlans;
  if (country) results = results.filter((p) => p.country === country);
  if (duration) results = results.filter((p) => p.duration >= duration);
  if (dataAmount) results = results.filter((p) => p.data >= dataAmount);
  return results.sort((a, b) => a.price - b.price);
}

export function getPlan(planId: string): EsimPlan | undefined {
  return esimPlans.find((p) => p.planId === planId);
}
