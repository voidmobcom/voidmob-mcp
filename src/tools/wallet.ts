import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { state } from "../sandbox/state.js";
import { generateId } from "../utils/validation.js";
import {
  formatUsd,
  generateMockWalletAddress,
  generateMockCryptoAmount,
} from "../utils/format.js";
import { textResponse } from "../utils/response.js";

export function registerWalletTools(server: McpServer) {
  server.tool(
    "get_balance",
    "Get wallet balance.",
    {},
    async () => {
      state.resolvePendingDeposits();

      const pendingDeposits = [...state.deposits.values()].filter(
        (d) => d.status === "pending"
      );

      let text = `Balance: ${formatUsd(state.balanceCents)} (${state.balanceCents} cents)`;

      if (pendingDeposits.length > 0) {
        text += `\n\nPending deposits: ${pendingDeposits.length}`;
        for (const d of pendingDeposits) {
          text += `\n  - $${d.amount.toFixed(2)} ${d.currency} (auto-confirms in ~5s)`;
        }
      }

      return textResponse(text);
    }
  );

  server.tool(
    "deposit",
    "Create a crypto deposit to add funds. Auto-confirms in ~5 seconds in sandbox.",
    {
      amount: z
        .number()
        .min(5)
        .max(10000)
        .describe("Amount in USD to deposit (min $5, max $10,000)"),
      currency: z
        .enum(["BTC", "ETH", "SOL", "LTC", "XMR", "TRX", "TON", "BNB", "USDT_TRX", "USDT_SOL", "USDC_SOL", "USDC_ETH"])
        .default("BTC")
        .describe("Cryptocurrency to pay with (default: BTC)"),
    },
    async ({ amount, currency }) => {
      const invoiceId = generateId("inv");
      const now = Date.now();
      const walletAddress = generateMockWalletAddress(currency);
      const qrCodeUrl = `https://sandbox.voidmob.com/pay/qr/${invoiceId}`;
      const cryptoAmount = generateMockCryptoAmount(amount, currency);
      const expiresAt = now + 30 * 60 * 1000;

      state.deposits.set(invoiceId, {
        invoiceId,
        amount,
        currency,
        walletAddress,
        qrCodeUrl,
        cryptoAmount,
        status: "pending",
        expiresAt,
        createdAt: now,
      });

      const text = [
        `Deposit created!`,
        ``,
        `  Deposit ID:     ${invoiceId}`,
        `  Amount:         $${amount.toFixed(2)} USD`,
        `  Crypto amount:  ${cryptoAmount} ${currency}`,
        `  Wallet address: ${walletAddress}`,
        `  QR code:        ${qrCodeUrl}`,
        `  Expires at:     ${new Date(expiresAt).toISOString()}`,
        ``,
        `This is a sandbox deposit. It will auto-confirm in ~5 seconds.`,
        `Call get_balance after a few seconds to see the updated balance.`,
      ].join("\n");

      return textResponse(text);
    }
  );
}
