import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { state } from "../sandbox/state.js";
import { formatUsd, formatGb, formatTimeRemaining } from "../utils/format.js";

interface UnifiedOrder {
  type: "SMS" | "eSIM" | "Proxy";
  name: string;
  id: string;
  status: string;
  price: number;
  details: string;
  createdAt: number;
}

export function registerOrdersTools(server: McpServer) {
  server.tool(
    "list_orders",
    "List all orders across SMS, eSIM, and proxy services. Filter by service type or status.",
    {
      type: z
        .enum(["sms", "esim", "proxy"])
        .optional()
        .describe("Filter by service type"),
      status: z
        .enum(["active", "completed", "cancelled", "expired", "all"])
        .optional()
        .describe("Filter by status (default: all)"),
    },
    async ({ type, status }) => {
      const statusFilter = status ?? "all";
      const orders: UnifiedOrder[] = [];

      if (!type || type === "sms") {
        for (const rental of state.smsRentals.values()) {
          if (statusFilter !== "all" && rental.status !== statusFilter) continue;
          orders.push({
            type: "SMS",
            name: `${rental.service} (${rental.country}) — ${rental.number}`,
            id: rental.rentalId,
            status: rental.status,
            price: rental.price,
            details: `Messages: ${rental.messages.length}`,
            createdAt: rental.createdAt,
          });
        }
      }

      if (!type || type === "esim") {
        for (const order of state.esimOrders.values()) {
          if (statusFilter !== "all" && order.status !== statusFilter) continue;
          const dataRemaining = formatGb(Math.max(0, order.dataTotal - order.dataUsed));
          const timeLeft = formatTimeRemaining(order.expiry);
          orders.push({
            type: "eSIM",
            name: `${order.planName} (${order.country})`,
            id: order.orderId,
            status: order.status,
            price: order.price,
            details: `Data remaining: ${dataRemaining} | ${timeLeft}`,
            createdAt: order.createdAt,
          });
        }
      }

      if (!type || type === "proxy") {
        for (const proxy of state.proxies.values()) {
          if (statusFilter !== "all" && proxy.status !== statusFilter) continue;
          orders.push({
            type: "Proxy",
            name: `${proxy.type.toUpperCase()} proxy — ${proxy.country} (${proxy.carrier})`,
            id: proxy.proxyId,
            status: proxy.status,
            price: proxy.price,
            details: `Bandwidth: ${formatGb(proxy.bandwidthUsed)} / ${formatGb(proxy.bandwidthTotal)}`,
            createdAt: proxy.createdAt,
          });
        }
      }

      if (orders.length === 0) {
        return {
          content: [{ type: "text" as const, text: "No orders found." }],
        };
      }

      orders.sort((a, b) => b.createdAt - a.createdAt);

      let text = `${orders.length} order(s):\n`;
      for (const o of orders) {
        const date = new Date(o.createdAt).toISOString().slice(0, 16).replace("T", " ");
        text += `\n  [${o.type}] ${o.name}`;
        text += `\n    ID: ${o.id}`;
        text += `\n    Status: ${o.status}  |  Price: ${formatUsd(o.price)}`;
        text += `\n    ${o.details}`;
        text += `\n    Created: ${date}\n`;
      }

      return { content: [{ type: "text" as const, text }] };
    }
  );
}
