import { generateId } from "../utils/validation.js";

// ── SMS ──

export interface SmsMessage {
  id: string;
  message_text: string;
  code: string | null;
  received_at: number;
  read_at: number | null;
}

export interface SmsRental {
  id: string;
  displayId: string;
  phoneNumber: string;
  service: string;
  serviceName: string;
  rentalType: "verification" | "rental" | "dedicated";
  duration: string | null;
  autoRenew: boolean;
  paidUntil: number | null;
  status: "active" | "completed" | "cancelled" | "expired";
  messages: SmsMessage[];
  expiresAt: number;
  createdAt: number;
  priceCents: number;
  reuseCounter: number;
}

// ── eSIM ──

export interface EsimOrder {
  id: string;
  displayId: string;
  planId: string;
  planTitle: string;
  countries: string[];
  dataLimitGb: number | null;
  dataUnlimited: boolean;
  validityDays: number;
  dataUsedMb: number;
  status: "active" | "completed" | "expired";
  retailPriceUsd: number;
  qrCodeData: string;
  activationCode: string;
  iccid: string;
  isTopup: boolean;
  parentOrderId: string | null;
  supportsTopup: boolean;
  expiresAt: number;
  createdAt: number;
}

// ── Proxy ──

export type ProxyType = "shared" | "dedicated_standard" | "dedicated_premium";

export interface ProxyEntry {
  id: string;
  displayId: string;
  type: ProxyType;
  status: "active" | "expired";
  proxyHost: string;
  proxyPort: number;
  socksPort: number | null;
  proxyUsername: string;
  proxyPassword: string;
  protocol: "http" | "socks5" | "vless";
  country: string;
  countryName: string;
  carrier: string;
  carrierName: string;
  currentIp: string;
  isOnline: boolean;
  dataTotal: number | null;
  dataUsed: number | null;
  rotationInterval: number | null;
  lastRotatedAt: number | null;
  autoRenew: boolean;
  expiresAt: number;
  createdAt: number;
  priceCents: number;
  features: string[];
  lists: ProxyList[];
}

export interface ProxyList {
  id: string;
  name: string;
  login: string;
  password: string;
  country: string | null;
  region: string | null;
  city: string | null;
  isp: string | null;
  locationPreset: string;
  countries: string[] | null;
  rotationPeriod: number;
}

// ── Wallet ──

export interface Deposit {
  invoiceId: string;
  amount: number;
  currency: string;
  walletAddress: string;
  qrCodeUrl: string;
  cryptoAmount: string;
  status: "pending" | "completed";
  expiresAt: number;
  createdAt: number;
}

export type TransactionType =
  | "deposit"
  | "sms_verification"
  | "sms_rental"
  | "sms_dedicated"
  | "sms_reuse"
  | "esim_purchase"
  | "esim_topup"
  | "proxy_purchase"
  | "refund";

export interface Transaction {
  id: string;
  type: TransactionType;
  amountCents: number;
  description: string;
  createdAt: number;
}

// ── State ──

class SandboxState {
  balanceCents = 5000;
  transactions: Transaction[] = [];
  smsRentals = new Map<string, SmsRental>();
  esimOrders = new Map<string, EsimOrder>();
  proxies = new Map<string, ProxyEntry>();
  deposits = new Map<string, Deposit>();

  deductBalance(cents: number, type: TransactionType, description: string): boolean {
    if (this.balanceCents < cents) return false;
    this.balanceCents -= cents;
    this.transactions.push({
      id: generateId("tx"),
      type,
      amountCents: -cents,
      description,
      createdAt: Date.now(),
    });
    return true;
  }

  addBalance(cents: number, type: TransactionType, description: string): void {
    this.balanceCents += cents;
    this.transactions.push({
      id: generateId("tx"),
      type,
      amountCents: cents,
      description,
      createdAt: Date.now(),
    });
  }

  resolvePendingDeposits(): void {
    const now = Date.now();
    for (const deposit of this.deposits.values()) {
      if (deposit.status === "pending" && now - deposit.createdAt > 5000) {
        deposit.status = "completed";
        const cents = Math.round(deposit.amount * 100);
        this.addBalance(cents, "deposit", `Crypto deposit (${deposit.currency})`);
      }
    }
  }
}

export const state = new SandboxState();
