// ── Formatters ──

export function formatUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export function formatGb(gb: number): string {
  if (gb < 1) return `${(gb * 1024).toFixed(0)} MB`;
  return `${gb.toFixed(1)} GB`;
}

export function formatData(gb: number | null, unlimited: boolean): string {
  if (unlimited || gb === null) return "Unlimited";
  return formatGb(gb);
}

export function formatMb(mb: number): string {
  if (mb >= 1024) return formatGb(mb / 1024);
  return `${mb.toFixed(0)} MB`;
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

// ── Generators ──

function rand(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomHex(length: number): string {
  return Array.from({ length }, () => rand(0, 15).toString(16)).join("");
}

function randomAlphanumeric(length: number): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({ length }, () => chars[rand(0, chars.length - 1)]).join("");
}

export function generateDisplayId(prefix: string): string {
  return `${prefix}${randomAlphanumeric(7)}`;
}

export function generatePhoneNumber(): string {
  return `+1${rand(200, 999)}${rand(200, 999)}${rand(1000, 9999)}`;
}

export function generateVerificationCode(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

export function generateIp(): string {
  const o = () => rand(1, 254);
  return `${o()}.${o()}.${o()}.${o()}`;
}

export function generateProxyCredentials(country: string): {
  host: string; port: number; socksPort: number; username: string; password: string;
} {
  const r = () => Math.random().toString(36).substring(2, 8);
  return {
    host: `${country.toLowerCase()}.proxy.voidmob.com`,
    port: 10000 + rand(0, 4999),
    socksPort: 20000 + rand(0, 4999),
    username: `vm_${r()}`,
    password: r() + r(),
  };
}

export function generateIccid(): string {
  return `8901${rand(1000, 9999)}${rand(10000000, 99999999)}${rand(0, 9)}`;
}

export function generateActivationCode(): string {
  return `LPA:1$smdp.voidmob.com$${randomHex(32).toUpperCase()}`;
}

export function generateMockWalletAddress(currency: string): string {
  switch (currency) {
    case "BTC": return `bc1q${randomHex(38)}`;
    case "ETH":
    case "BNB":
    case "USDC_ETH": return `0x${randomHex(40)}`;
    case "SOL":
    case "USDT_SOL":
    case "USDC_SOL": return randomAlphanumeric(44);
    case "LTC": return `ltc1q${randomHex(38)}`;
    case "XMR": return `4${randomAlphanumeric(94)}`;
    case "TRX":
    case "USDT_TRX": return `T${randomAlphanumeric(33)}`;
    case "TON": return `UQ${randomAlphanumeric(46)}`;
    default: return `0x${randomHex(40)}`;
  }
}

export function generateMockCryptoAmount(usdAmount: number, currency: string): string {
  const rates: Record<string, number> = {
    BTC: 95000, ETH: 3800, SOL: 180, LTC: 90,
    XMR: 170, TRX: 0.25, TON: 6, BNB: 600,
    USDT_TRX: 1, USDT_SOL: 1, USDC_SOL: 1, USDC_ETH: 1,
  };
  const rate = rates[currency] ?? 1;
  return (usdAmount / rate).toFixed(rate >= 100 ? 8 : 4);
}

export function generateConnectionString(
  host: string, port: number, username: string, password: string
): string {
  return `${username}:${password}@${host}:${port}`;
}

export function generateVlessUri(
  host: string, port: number, country: string
): { uri: string; uuid: string } {
  const uuid = `${randomHex(8)}-${randomHex(4)}-4${randomHex(3)}-${randomHex(4)}-${randomHex(12)}`;
  const uri = `vless://${uuid}@${host}:${port}?security=tls&type=tcp#VoidMob-${country}`;
  return { uri, uuid };
}

export function generateOpenvpnConfig(
  host: string, username: string, password: string, country: string, carrier: string
): { config: string; filename: string } {
  const filename = `voidmob-${country.toLowerCase()}-${carrier.toLowerCase().replace(/\s+/g, "-")}.ovpn`;
  const mockCert = btoa(`MOCK-CERTIFICATE-${randomHex(32)}`);
  const config = `# VoidMob Proxy - OpenVPN Configuration
# ${country} / ${carrier}
# Generated for sandbox mode

client
dev tun
proto udp
remote ${host} 1194
resolv-retry infinite
nobind
persist-key
persist-tun

auth-user-pass
# Username: ${username}
# Password: ${password}

cipher AES-256-GCM
auth SHA256
tls-client
remote-cert-tls server
verb 3

<ca>
-----BEGIN CERTIFICATE-----
${mockCert}
-----END CERTIFICATE-----
</ca>

<tls-auth>
-----BEGIN OpenVPN Static key V1-----
${randomHex(64)}
${randomHex(64)}
${randomHex(64)}
${randomHex(64)}
-----END OpenVPN Static key V1-----
</tls-auth>
key-direction 1`;
  return { config, filename };
}
