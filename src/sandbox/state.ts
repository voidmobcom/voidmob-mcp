import { generateId } from "../utils/validation.js";

export interface SmsMessage {
  from: string;
  text: string;
  receivedAt: number;
}

export interface SmsRental {
  rentalId: string;
  number: string;
  service: string;
  country: string;
  status: "active" | "completed" | "cancelled" | "expired";
  messages: SmsMessage[];
  expiry: number;
  createdAt: number;
  price: number;
}

export interface EsimOrder {
  orderId: string;
  planId: string;
  planName: string;
  country: string;
  dataTotal: number;
  dataUsed: number;
  status: "active" | "completed" | "expired";
  qrUrl: string;
  apn: string;
  expiry: number;
  createdAt: number;
  price: number;
}

export interface ProxyEntry {
  proxyId: string;
  type: "gb" | "dedicated";
  country: string;
  carrier: string;
  credentials: { host: string; port: number; username: string; password: string };
  bandwidthUsed: number;
  bandwidthTotal: number;
  status: "active" | "expired";
  ip: string;
  createdAt: number;
  price: number;
}

export interface Deposit {
  invoiceId: string;
  amount: number;
  currency: string;
  status: "pending" | "completed";
  createdAt: number;
}

export interface Transaction {
  id: string;
  type: "deposit" | "sms_rental" | "esim_purchase" | "proxy_purchase" | "refund" | "topup";
  amount: number;
  description: string;
  createdAt: number;
}

class SandboxState {
  balance = 50.0;
  transactions: Transaction[] = [];
  smsRentals = new Map<string, SmsRental>();
  esimOrders = new Map<string, EsimOrder>();
  proxies = new Map<string, ProxyEntry>();
  deposits = new Map<string, Deposit>();

  deductBalance(amount: number, type: Transaction["type"], description: string): boolean {
    if (this.balance < amount) return false;
    this.balance = Math.round((this.balance - amount) * 100) / 100;
    this.transactions.push({
      id: generateId("tx"),
      type,
      amount: -amount,
      description,
      createdAt: Date.now(),
    });
    return true;
  }

  addBalance(amount: number, type: Transaction["type"], description: string): void {
    this.balance = Math.round((this.balance + amount) * 100) / 100;
    this.transactions.push({
      id: generateId("tx"),
      type,
      amount,
      description,
      createdAt: Date.now(),
    });
  }

  resolvePendingDeposits(): void {
    const now = Date.now();
    for (const deposit of this.deposits.values()) {
      if (deposit.status === "pending" && now - deposit.createdAt > 5000) {
        deposit.status = "completed";
        this.addBalance(deposit.amount, "deposit", `Crypto deposit (${deposit.currency})`);
      }
    }
  }
}

export const state = new SandboxState();
