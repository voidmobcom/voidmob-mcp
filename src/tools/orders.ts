import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { state } from "../sandbox/state.js";
import { formatUsd } from "../utils/format.js";
import { errorResponse, textResponse } from "../utils/response.js";

interface OrderDetails {
  id: string;
  displayId: string;
  type: "sms" | "esim" | "proxy";
  status: string;
  priceCents: number;
  createdAt: number;
  details: Record<string, unknown>;
}

export function registerOrdersTools(server: McpServer) {
  server.tool(
    "list_orders",
    "List all orders across SMS, eSIM, and proxy services.",
    {
      type: z
        .enum(["sms", "esim", "proxy"])
        .optional()
        .describe("Filter by service type"),
      status: z
        .enum(["active", "completed", "cancelled", "expired"])
        .optional()
        .describe("Filter by status"),
      limit: z
        .number()
        .min(1)
        .max(50)
        .default(20)
        .describe("Maximum number of orders to return (default: 20)"),
    },
    async ({ type, status, limit }) => {
      const now = Date.now();
      const orders: OrderDetails[] = [];

      if (!type || type === "sms") {
        for (const rental of state.smsRentals.values()) {
          if (rental.status === "active" && rental.expiresAt < now) {
            rental.status = "expired";
          }
          if (status && rental.status !== status) continue;
          orders.push({
            id: rental.id,
            displayId: rental.displayId,
            type: "sms",
            status: rental.status,
            priceCents: rental.priceCents,
            createdAt: rental.createdAt,
            details: {
              phoneNumber: rental.phoneNumber,
              service: rental.service,
              serviceName: rental.serviceName,
              rentalType: rental.rentalType,
              duration: rental.duration,
              messageCount: rental.messages.length,
            },
          });
        }
      }

      if (!type || type === "esim") {
        for (const order of state.esimOrders.values()) {
          if (order.status === "active" && order.expiresAt < now) {
            order.status = "expired";
          }
          if (status && order.status !== status) continue;
          orders.push({
            id: order.id,
            displayId: order.displayId,
            type: "esim",
            status: order.status,
            priceCents: Math.round(order.retailPriceUsd * 100),
            createdAt: order.createdAt,
            details: {
              planTitle: order.planTitle,
              dataLimitGb: order.dataLimitGb,
              validityDays: order.validityDays,
              countries: order.countries.join(", "),
            },
          });
        }
      }

      if (!type || type === "proxy") {
        for (const proxy of state.proxies.values()) {
          if (proxy.status === "active" && proxy.expiresAt < now) {
            proxy.status = "expired";
          }
          if (status && proxy.status !== status) continue;
          orders.push({
            id: proxy.id,
            displayId: proxy.displayId,
            type: "proxy",
            status: proxy.status,
            priceCents: proxy.priceCents,
            createdAt: proxy.createdAt,
            details: {
              type: proxy.type,
              country: proxy.country,
              countryName: proxy.countryName,
              carrier: proxy.carrier,
              carrierName: proxy.carrierName,
              protocol: proxy.protocol,
            },
          });
        }
      }

      if (orders.length === 0) {
        return errorResponse("No orders found.");
      }

      orders.sort((a, b) => b.createdAt - a.createdAt);
      const limited = orders.slice(0, limit);

      const typeBadge: Record<string, string> = {
        sms: "[SMS]",
        esim: "[eSIM]",
        proxy: "[Proxy]",
      };

      let text = `${orders.length} order(s)${orders.length > limit ? ` (showing ${limit})` : ""}:\n`;

      for (const o of limited) {
        const date = new Date(o.createdAt).toISOString().slice(0, 16).replace("T", " ");
        const badge = typeBadge[o.type];

        text += `\n  ${badge} ${o.displayId}`;
        text += `\n    ID: ${o.id}`;
        text += `\n    Status: ${o.status}  |  Price: ${formatUsd(o.priceCents)}`;

        if (o.type === "sms") {
          const d = o.details as {
            phoneNumber: string;
            service: string;
            serviceName: string;
            rentalType: string;
            duration: string | null;
            messageCount: number;
          };
          text += `\n    Service: ${d.serviceName} (${d.service})`;
          text += `\n    Phone: ${d.phoneNumber}  |  Type: ${d.rentalType}`;
          if (d.duration) text += `  |  Duration: ${d.duration}`;
          text += `\n    Messages: ${d.messageCount}`;
        } else if (o.type === "esim") {
          const d = o.details as {
            planTitle: string;
            dataLimitGb: number | null;
            validityDays: number;
            countries: string;
          };
          text += `\n    Plan: ${d.planTitle}`;
          text += `\n    Data: ${d.dataLimitGb !== null ? `${d.dataLimitGb} GB` : "Unlimited"}  |  Validity: ${d.validityDays} days`;
          text += `\n    Countries: ${d.countries}`;
        } else if (o.type === "proxy") {
          const d = o.details as {
            type: string;
            country: string;
            countryName: string;
            carrier: string;
            carrierName: string;
            protocol: string;
          };
          text += `\n    Type: ${d.type}  |  Protocol: ${d.protocol}`;
          text += `\n    Location: ${d.countryName} (${d.country})  |  Carrier: ${d.carrierName}`;
        }

        text += `\n    Created: ${date}\n`;
      }

      return textResponse(text);
    }
  );
}
