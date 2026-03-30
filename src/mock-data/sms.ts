export interface SmsService {
  id: string;
  service: string;
  serviceName: string;
  available: boolean;
  priceUsdCents: number;
  ltr3PriceCents: number;
  ltr7PriceCents: number;
  ltr14PriceCents: number;
  ltr30PriceCents: number;
  dedicatedPriceCents: number;
  hasIcon: boolean;
}

export const smsServices: SmsService[] = [
  { id: "wa", service: "wa", serviceName: "WhatsApp", available: true, priceUsdCents: 250, ltr3PriceCents: 550, ltr7PriceCents: 900, ltr14PriceCents: 1500, ltr30PriceCents: 2500, dedicatedPriceCents: 3000, hasIcon: true },
  { id: "tg", service: "tg", serviceName: "Telegram", available: true, priceUsdCents: 150, ltr3PriceCents: 350, ltr7PriceCents: 600, ltr14PriceCents: 1000, ltr30PriceCents: 1700, dedicatedPriceCents: 2200, hasIcon: true },
  { id: "go", service: "go", serviceName: "Google / Gmail", available: true, priceUsdCents: 180, ltr3PriceCents: 400, ltr7PriceCents: 700, ltr14PriceCents: 1200, ltr30PriceCents: 2000, dedicatedPriceCents: 2500, hasIcon: true },
  { id: "tw", service: "tw", serviceName: "Twitter / X", available: true, priceUsdCents: 200, ltr3PriceCents: 450, ltr7PriceCents: 750, ltr14PriceCents: 1300, ltr30PriceCents: 2200, dedicatedPriceCents: 2700, hasIcon: true },
  { id: "ig", service: "ig", serviceName: "Instagram", available: true, priceUsdCents: 220, ltr3PriceCents: 500, ltr7PriceCents: 850, ltr14PriceCents: 1400, ltr30PriceCents: 2400, dedicatedPriceCents: 2900, hasIcon: true },
  { id: "ds", service: "ds", serviceName: "Discord", available: true, priceUsdCents: 120, ltr3PriceCents: 280, ltr7PriceCents: 480, ltr14PriceCents: 800, ltr30PriceCents: 1400, dedicatedPriceCents: 1800, hasIcon: true },
  { id: "tk", service: "tk", serviceName: "TikTok", available: true, priceUsdCents: 250, ltr3PriceCents: 550, ltr7PriceCents: 900, ltr14PriceCents: 1500, ltr30PriceCents: 2500, dedicatedPriceCents: 3000, hasIcon: true },
  { id: "fb", service: "fb", serviceName: "Facebook", available: true, priceUsdCents: 180, ltr3PriceCents: 400, ltr7PriceCents: 700, ltr14PriceCents: 1200, ltr30PriceCents: 2000, dedicatedPriceCents: 2500, hasIcon: true },
  { id: "ub", service: "ub", serviceName: "Uber", available: true, priceUsdCents: 200, ltr3PriceCents: 450, ltr7PriceCents: 750, ltr14PriceCents: 1300, ltr30PriceCents: 2200, dedicatedPriceCents: 2700, hasIcon: true },
  { id: "oa", service: "oa", serviceName: "OpenAI / ChatGPT", available: true, priceUsdCents: 300, ltr3PriceCents: 650, ltr7PriceCents: 1100, ltr14PriceCents: 1800, ltr30PriceCents: 3000, dedicatedPriceCents: 3500, hasIcon: true },
];

export function searchServices(query?: string): SmsService[] {
  if (!query) return smsServices.filter((s) => s.available);
  const q = query.toLowerCase();
  return smsServices.filter(
    (s) => s.available && (
      s.serviceName.toLowerCase().includes(q) ||
      s.id.toLowerCase().includes(q) ||
      s.service.toLowerCase().includes(q)
    )
  );
}

export function getService(serviceId: string): SmsService | undefined {
  return smsServices.find((s) => s.id === serviceId || s.service === serviceId);
}
