import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { state } from "../sandbox/state.js";
import { validateCountry, ToolError, generateId } from "../utils/validation.js";
import {
  formatUsd,
  formatGb,
  formatTimeRemaining,
  generateProxyCredentials,
  generateIp,
} from "../utils/format.js";
import { searchProxyOptions, getProxyPricing } from "../mock-data/proxy.js";

function errorResponse(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
  };
}

export function registerProxyTools(server: McpServer) {
  server.tool(
    "search_proxies",
    "Search available mobile proxy options. Filter by country or proxy type (gb = pay-per-GB, dedicated = fixed monthly).",
    {
      country: z
        .string()
        .optional()
        .describe("ISO 3166-1 alpha-2 country code (e.g., US, GB, DE)"),
      type: z
        .enum(["gb", "dedicated"])
        .optional()
        .describe("Proxy type: 'gb' for pay-per-GB or 'dedicated' for fixed monthly"),
    },
    async ({ country, type }) => {
      try {
        const validatedCountry = country ? validateCountry(country) : undefined;
        const results = searchProxyOptions(validatedCountry, type);

        if (results.length === 0) {
          return errorResponse(
            "No proxy options found matching your criteria. Try a different country or type."
          );
        }

        let text = `Found ${results.length} proxy option(s):\n\n`;
        for (const p of results) {
          text += `  ${p.carrier} — ${p.country} (${p.type})\n`;
          text += `    Network: ${p.network}\n`;
          if (p.type === "gb") {
            text += `    Price:   ${formatUsd(p.pricePerGb)}/GB\n`;
          } else {
            text += `    Price:   ${formatUsd(p.pricePerMonth)}/month\n`;
            text += `    Included bandwidth: ${formatGb(p.bandwidth)}\n`;
          }
          text += `\n`;
        }

        return { content: [{ type: "text" as const, text }] };
      } catch (e) {
        if (e instanceof ToolError) return errorResponse(e.message);
        throw e;
      }
    }
  );

  server.tool(
    "get_proxy_pricing",
    "Get detailed pricing for a specific proxy type and country combination.",
    {
      type: z
        .enum(["gb", "dedicated"])
        .describe("Proxy type: 'gb' for pay-per-GB or 'dedicated' for fixed monthly"),
      country: z.string().describe("ISO 3166-1 alpha-2 country code (e.g., US, GB)"),
    },
    async ({ type, country }) => {
      try {
        const validatedCountry = validateCountry(country);
        const options = getProxyPricing(type, validatedCountry);

        if (options.length === 0) {
          return errorResponse(
            `No ${type} proxies available in ${validatedCountry}. Use search_proxies to find available options.`
          );
        }

        let text = `${type === "gb" ? "Pay-per-GB" : "Dedicated"} proxy pricing — ${validatedCountry}:\n\n`;
        for (const opt of options) {
          text += `  ${opt.carrier} (${opt.network})\n`;
          if (opt.type === "gb") {
            text += `    Rate: ${formatUsd(opt.pricePerGb)}/GB\n`;
          } else {
            text += `    Rate:      ${formatUsd(opt.pricePerMonth)}/month\n`;
            text += `    Bandwidth: ${formatGb(opt.bandwidth)} included\n`;
          }
          text += `\n`;
        }

        return { content: [{ type: "text" as const, text }] };
      } catch (e) {
        if (e instanceof ToolError) return errorResponse(e.message);
        throw e;
      }
    }
  );

  server.tool(
    "purchase_proxy",
    "Purchase a mobile proxy. For GB type, quantity = GB to buy. For dedicated, quantity = months. Deducts cost from wallet.",
    {
      type: z
        .enum(["gb", "dedicated"])
        .describe("Proxy type: 'gb' for pay-per-GB or 'dedicated' for fixed monthly"),
      country: z.string().describe("ISO 3166-1 alpha-2 country code (e.g., US, GB)"),
      quantity: z
        .number()
        .positive()
        .optional()
        .describe("GB for 'gb' type, months for 'dedicated' type (default: 1)"),
    },
    async ({ type, country, quantity }) => {
      try {
        const validatedCountry = validateCountry(country);
        const qty = quantity ?? 1;
        const options = getProxyPricing(type, validatedCountry);

        if (options.length === 0) {
          return errorResponse(
            `No ${type} proxies available in ${validatedCountry}. Use search_proxies to find available options.`
          );
        }

        // Pick the first carrier option
        const option = options[0];

        let totalCost: number;
        let bandwidthTotal: number;
        let expiryMs: number;
        const now = Date.now();

        if (option.type === "gb") {
          totalCost = Math.round(qty * option.pricePerGb * 100) / 100;
          bandwidthTotal = qty;
          expiryMs = now + 30 * 24 * 60 * 60 * 1000; // 30 days
        } else {
          totalCost = Math.round(qty * option.pricePerMonth * 100) / 100;
          bandwidthTotal = option.bandwidth;
          expiryMs = now + qty * 30 * 24 * 60 * 60 * 1000; // quantity * 30 days
        }

        if (!state.deductBalance(totalCost, "proxy_purchase", `Proxy: ${type} ${option.carrier} (${validatedCountry})`)) {
          return errorResponse(
            `Insufficient balance. Need ${formatUsd(totalCost)} but have ${formatUsd(state.balance)}. Use deposit to add funds.`
          );
        }

        const proxyId = generateId("prx");
        const credentials = generateProxyCredentials(validatedCountry);
        const ip = generateIp();

        state.proxies.set(proxyId, {
          proxyId,
          type,
          country: validatedCountry,
          carrier: option.carrier,
          credentials,
          bandwidthUsed: 0,
          bandwidthTotal,
          status: "active",
          ip,
          createdAt: now,
          price: totalCost,
        });

        const connectionString = `${credentials.host}:${credentials.port}:${credentials.username}:${credentials.password}`;

        const text = [
          `Proxy purchased!`,
          ``,
          `  Proxy ID:    ${proxyId}`,
          `  Type:        ${type === "gb" ? "Pay-per-GB" : "Dedicated"}`,
          `  Carrier:     ${option.carrier} (${option.network})`,
          `  Country:     ${validatedCountry}`,
          `  Cost:        ${formatUsd(totalCost)}`,
          `  Bandwidth:   ${formatGb(bandwidthTotal)}`,
          `  Expires:     ${formatTimeRemaining(expiryMs)}`,
          ``,
          `  Connection:`,
          `    Host:      ${credentials.host}`,
          `    Port:      ${credentials.port}`,
          `    Username:  ${credentials.username}`,
          `    Password:  ${credentials.password}`,
          `    String:    ${connectionString}`,
          `    Current IP: ${ip}`,
          ``,
          `Use get_proxy_status to check bandwidth usage, or rotate_proxy to get a new IP.`,
        ].join("\n");

        return { content: [{ type: "text" as const, text }] };
      } catch (e) {
        if (e instanceof ToolError) return errorResponse(e.message);
        throw e;
      }
    }
  );

  server.tool(
    "get_proxy_status",
    "Check status, bandwidth usage, and connection details for a proxy.",
    {
      proxyId: z.string().describe("Proxy ID returned from purchase_proxy"),
    },
    async ({ proxyId }) => {
      try {
        const proxy = state.proxies.get(proxyId);

        if (!proxy) {
          return errorResponse(`Proxy not found: ${proxyId}`);
        }

        const now = Date.now();

        // Simulate bandwidth usage: ~0.05 GB/hour elapsed, cap at 90% of total
        const hoursElapsed = (now - proxy.createdAt) / 3600000;
        const simulatedUsage = hoursElapsed * 0.05;
        const maxUsage = proxy.bandwidthTotal * 0.9;
        proxy.bandwidthUsed = Math.round(Math.min(simulatedUsage, maxUsage) * 100) / 100;

        const bandwidthRemaining = Math.max(0, proxy.bandwidthTotal - proxy.bandwidthUsed);
        const uptimeHours = Math.floor(hoursElapsed);
        const uptimeMinutes = Math.floor((hoursElapsed - uptimeHours) * 60);

        const text = [
          `Proxy Status — ${proxy.carrier} (${proxy.country})`,
          ``,
          `  Proxy ID:           ${proxy.proxyId}`,
          `  Status:             ${proxy.status}`,
          `  Type:               ${proxy.type === "gb" ? "Pay-per-GB" : "Dedicated"}`,
          `  Location:           ${proxy.country}`,
          `  Current IP:         ${proxy.ip}`,
          `  Bandwidth used:     ${formatGb(proxy.bandwidthUsed)}`,
          `  Bandwidth remaining: ${formatGb(bandwidthRemaining)}`,
          `  Bandwidth total:    ${formatGb(proxy.bandwidthTotal)}`,
          `  Uptime:             ${uptimeHours}h ${uptimeMinutes}m`,
        ].join("\n");

        return { content: [{ type: "text" as const, text }] };
      } catch (e) {
        if (e instanceof ToolError) return errorResponse(e.message);
        throw e;
      }
    }
  );

  server.tool(
    "rotate_proxy",
    "Rotate a proxy to get a new IP address. Only works on active proxies.",
    {
      proxyId: z.string().describe("Proxy ID to rotate"),
    },
    async ({ proxyId }) => {
      try {
        const proxy = state.proxies.get(proxyId);

        if (!proxy) {
          return errorResponse(`Proxy not found: ${proxyId}`);
        }

        if (proxy.status !== "active") {
          return errorResponse(
            `Proxy ${proxyId} is ${proxy.status}. Only active proxies can be rotated.`
          );
        }

        const oldIp = proxy.ip;
        const newIp = generateIp();
        proxy.ip = newIp;

        const text = [
          `IP rotated!`,
          ``,
          `  Proxy ID: ${proxy.proxyId}`,
          `  Old IP:   ${oldIp}`,
          `  New IP:   ${newIp}`,
        ].join("\n");

        return { content: [{ type: "text" as const, text }] };
      } catch (e) {
        if (e instanceof ToolError) return errorResponse(e.message);
        throw e;
      }
    }
  );
}
