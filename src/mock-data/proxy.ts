export type ProxyOption =
  | { country: string; carrier: string; type: "gb"; pricePerGb: number; network: string }
  | { country: string; carrier: string; type: "dedicated"; pricePerMonth: number; bandwidth: number; network: string };

export const proxyOptions: ProxyOption[] = [
  { country: "US", carrier: "Verizon", type: "gb", pricePerGb: 2.99, network: "5G" },
  { country: "US", carrier: "T-Mobile", type: "gb", pricePerGb: 2.49, network: "5G" },
  { country: "US", carrier: "AT&T", type: "gb", pricePerGb: 2.79, network: "5G" },
  { country: "US", carrier: "Verizon", type: "dedicated", pricePerMonth: 80, bandwidth: 30, network: "5G" },
  { country: "US", carrier: "T-Mobile", type: "dedicated", pricePerMonth: 70, bandwidth: 30, network: "5G" },
  { country: "GB", carrier: "Vodafone", type: "gb", pricePerGb: 2.99, network: "5G" },
  { country: "GB", carrier: "EE", type: "gb", pricePerGb: 2.79, network: "5G" },
  { country: "GB", carrier: "Vodafone", type: "dedicated", pricePerMonth: 85, bandwidth: 30, network: "5G" },
  { country: "DE", carrier: "Telekom", type: "gb", pricePerGb: 3.29, network: "5G" },
  { country: "DE", carrier: "Telekom", type: "dedicated", pricePerMonth: 90, bandwidth: 25, network: "5G" },
  { country: "NL", carrier: "KPN", type: "gb", pricePerGb: 2.79, network: "4G LTE" },
  { country: "NL", carrier: "KPN", type: "dedicated", pricePerMonth: 75, bandwidth: 25, network: "4G LTE" },
  { country: "BR", carrier: "Claro", type: "gb", pricePerGb: 1.99, network: "4G LTE" },
  { country: "IN", carrier: "Jio", type: "gb", pricePerGb: 0.99, network: "5G" },
  { country: "JP", carrier: "NTT Docomo", type: "gb", pricePerGb: 3.49, network: "5G" },
  { country: "JP", carrier: "NTT Docomo", type: "dedicated", pricePerMonth: 100, bandwidth: 25, network: "5G" },
];

export function searchProxyOptions(country?: string, type?: string): ProxyOption[] {
  let results = proxyOptions;
  if (country) results = results.filter((p) => p.country === country);
  if (type) results = results.filter((p) => p.type === type);
  return results;
}

export function getProxyPricing(type: string, country: string): ProxyOption[] {
  return proxyOptions.filter((p) => p.type === type && p.country === country);
}
