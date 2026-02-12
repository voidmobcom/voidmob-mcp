import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { state } from "../sandbox/state.js";
import { generateId, ToolError } from "../utils/validation.js";
import { formatUsd } from "../utils/format.js";

export function registerWalletTools(server: McpServer) {
  server.tool(
    "get_balance",
    "Get wallet balance and recent transactions. Resolves any pending deposits first.",
    {},
    async () => {
      state.resolvePendingDeposits();

      const recent = state.transactions
        .slice()
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, 10);

      const pendingDeposits = [...state.deposits.values()].filter(
        (d) => d.status === "pending"
      );

      let text = `Balance: ${formatUsd(state.balance)}\n`;

      if (pendingDeposits.length > 0) {
        text += `\nPending deposits: ${pendingDeposits.length}\n`;
        for (const d of pendingDeposits) {
          text += `  - ${formatUsd(d.amount)} ${d.currency} (auto-confirms in ~5s)\n`;
        }
      }

      if (recent.length > 0) {
        text += `\nLast ${recent.length} transactions:\n`;
        for (const tx of recent) {
          const sign = tx.amount >= 0 ? "+" : "";
          const date = new Date(tx.createdAt).toISOString().slice(0, 16);
          text += `  ${date}  ${sign}${formatUsd(Math.abs(tx.amount))}  ${tx.description}\n`;
        }
      } else {
        text += "\nNo transactions yet.\n";
      }

      return {
        content: [{ type: "text" as const, text }],
      };
    }
  );

  server.tool(
    "deposit",
    "Create a crypto deposit to add funds to the wallet. Returns a mock payment link that auto-confirms in ~5 seconds.",
    {
      amount: z.number().positive().describe("Amount in USD to deposit"),
      currency: z
        .enum(["BTC", "ETH", "SOL"])
        .default("BTC")
        .describe("Cryptocurrency to pay with (default: BTC)"),
    },
    async ({ amount, currency }) => {
      const invoiceId = generateId("inv");

      state.deposits.set(invoiceId, {
        invoiceId,
        amount,
        currency,
        status: "pending",
        createdAt: Date.now(),
      });

      const payUrl = `https://sandbox.voidmob.com/pay/${invoiceId}`;

      const text = [
        `Deposit created!`,
        ``,
        `  Amount:   ${formatUsd(amount)}`,
        `  Currency: ${currency}`,
        `  Invoice:  ${invoiceId}`,
        `  Pay URL:  ${payUrl}`,
        ``,
        `This is a sandbox deposit. It will auto-confirm in ~5 seconds.`,
        `Call get_balance after a few seconds to see the updated balance.`,
      ].join("\n");

      return {
        content: [{ type: "text" as const, text }],
      };
    }
  );
}
