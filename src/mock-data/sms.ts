export interface SmsService {
  id: string;
  name: string;
  category: string;
  price: number; // USD price for US number
  estimatedDelivery: string;
}

export const smsServices: SmsService[] = [
  { id: "whatsapp", name: "WhatsApp", category: "messaging", price: 2.50, estimatedDelivery: "1-3 minutes" },
  { id: "telegram", name: "Telegram", category: "messaging", price: 1.50, estimatedDelivery: "1-2 minutes" },
  { id: "google", name: "Google / Gmail", category: "email", price: 1.80, estimatedDelivery: "1-3 minutes" },
  { id: "twitter", name: "Twitter / X", category: "social", price: 2.00, estimatedDelivery: "1-5 minutes" },
  { id: "instagram", name: "Instagram", category: "social", price: 2.20, estimatedDelivery: "1-3 minutes" },
  { id: "discord", name: "Discord", category: "messaging", price: 1.20, estimatedDelivery: "1-2 minutes" },
  { id: "tiktok", name: "TikTok", category: "social", price: 2.50, estimatedDelivery: "1-5 minutes" },
  { id: "facebook", name: "Facebook", category: "social", price: 1.80, estimatedDelivery: "1-3 minutes" },
  { id: "uber", name: "Uber", category: "ride-hailing", price: 2.00, estimatedDelivery: "1-3 minutes" },
  { id: "openai", name: "OpenAI / ChatGPT", category: "ai", price: 3.00, estimatedDelivery: "1-3 minutes" },
];

export function searchServices(query?: string): SmsService[] {
  if (!query) return smsServices;
  const q = query.toLowerCase();
  return smsServices.filter(
    (s) => s.name.toLowerCase().includes(q) || s.category.toLowerCase().includes(q) || s.id.toLowerCase().includes(q)
  );
}

export function getServicePrice(serviceId: string): { service: SmsService; price: number } | null {
  const service = smsServices.find((s) => s.id === serviceId);
  if (!service) return null;
  return { service, price: service.price };
}
