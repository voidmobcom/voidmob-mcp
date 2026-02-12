export function formatUsd(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

export function formatGb(gb: number): string {
  if (gb < 1) return `${(gb * 1024).toFixed(0)} MB`;
  return `${gb.toFixed(1)} GB`;
}

export function formatTimeRemaining(expiryMs: number): string {
  const remaining = expiryMs - Date.now();
  if (remaining <= 0) return "expired";
  const hours = Math.floor(remaining / 3600000);
  const minutes = Math.floor((remaining % 3600000) / 60000);
  if (hours > 24) return `${Math.floor(hours / 24)}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

export function generatePhoneNumber(country: string): string {
  const formats: Record<string, () => string> = {
    US: () => `+1${rand(200, 999)}${rand(200, 999)}${rand(1000, 9999)}`,
    GB: () => `+447${rand(100, 999)}${rand(100000, 999999)}`,
    CA: () => `+1${rand(200, 999)}${rand(200, 999)}${rand(1000, 9999)}`,
    DE: () => `+491${rand(50, 79)}${rand(1000000, 9999999)}`,
    FR: () => `+336${rand(10000000, 99999999)}`,
    NL: () => `+316${rand(10000000, 99999999)}`,
    BR: () => `+5511${rand(90000, 99999)}${rand(1000, 9999)}`,
    JP: () => `+8190${rand(1000, 9999)}${rand(1000, 9999)}`,
    AU: () => `+614${rand(10, 99)}${rand(100000, 999999)}`,
    IN: () => `+91${rand(70000, 99999)}${rand(10000, 99999)}`,
  };
  const gen = formats[country] || (() => `+${rand(1, 99)}${rand(100000000, 999999999)}`);
  return gen();
}

function rand(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export function generateProxyCredentials(country: string): {
  host: string; port: number; username: string; password: string;
} {
  const r = () => Math.random().toString(36).substring(2, 8);
  return {
    host: `${country.toLowerCase()}.proxy.voidmob.com`,
    port: 10000 + Math.floor(Math.random() * 5000),
    username: `vm_${r()}`,
    password: r() + r(),
  };
}

export function generateIp(): string {
  const o = () => Math.floor(Math.random() * 254) + 1;
  return `${o()}.${o()}.${o()}.${o()}`;
}

export function generateVerificationCode(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}
