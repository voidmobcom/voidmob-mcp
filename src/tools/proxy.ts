import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { state } from "../sandbox/state.js";
import type { ProxyList } from "../sandbox/state.js";
import { validateCountry, ToolError, generateId } from "../utils/validation.js";
import {
  formatUsd,
  formatGb,
  formatTimeRemaining,
  generateDisplayId,
  generateProxyCredentials,
  generateIp,
  generateConnectionString,
  generateOpenvpnConfig,
  generateVlessUri,
} from "../utils/format.js";
import { errorResponse, textResponse } from "../utils/response.js";
import { searchProducts, getProduct } from "../mock-data/proxy.js";

export function registerProxyTools(server: McpServer) {
  server.tool(
    "search_proxies",
    "Search available mobile proxy products by country or type.",
    {
      country: z
        .string()
        .optional()
        .describe("ISO 3166-1 alpha-2 country code (e.g., US, GB, DE)"),
      type: z
        .enum(["shared", "dedicated_standard", "dedicated_premium"])
        .optional()
        .describe("Proxy type: shared (pay-per-GB), dedicated standard, or dedicated premium"),
    },
    async ({ country, type }) => {
      try {
        const validatedCountry = country ? validateCountry(country) : undefined;
        const results = searchProducts({ country: validatedCountry, type });

        if (results.length === 0) {
          return errorResponse(
            "No proxy products found matching your criteria. Try a different country or type."
          );
        }

        let text = `Found ${results.length} proxy product(s):\n\n`;
        for (const p of results) {
          text += `  ${p.name}\n`;
          text += `    ID:       ${p.id}\n`;
          text += `    Type:     ${p.type}\n`;
          text += `    Country:  ${p.country} (${p.countryName})\n`;
          text += `    Carrier:  ${p.carrier} (${p.carrierName})\n`;
          if (p.dataGb !== null) {
            text += `    Data:     ${formatGb(p.dataGb)}\n`;
          }
          text += `    Duration: ${p.durationDays} days (${p.period})\n`;
          text += `    Price:    ${formatUsd(p.priceCents)}\n`;
          if (p.features.length > 0) {
            text += `    Features: ${p.features.join(", ")}\n`;
          }
          text += `\n`;
        }

        return textResponse(text);
      } catch (e) {
        if (e instanceof ToolError) return errorResponse(e.message);
        throw e;
      }
    }
  );

  server.tool(
    "purchase_proxy",
    "Purchase a mobile proxy. Shared (pay-per-GB), dedicated standard, or dedicated premium.",
    {
      productId: z.string().describe("Product ID from search_proxies"),
    },
    async ({ productId }) => {
      try {
        const product = getProduct(productId);
        if (!product) {
          return errorResponse(
            `Product not found: ${productId}. Use search_proxies to find available products.`
          );
        }

        if (
          !state.deductBalance(
            product.priceCents,
            "proxy_purchase",
            `Proxy: ${product.name}`
          )
        ) {
          return errorResponse(
            `Insufficient balance. Need ${formatUsd(product.priceCents)} but have ${formatUsd(state.balanceCents)}. Use deposit to add funds.`
          );
        }

        const creds = generateProxyCredentials(product.country);
        const ip = generateIp();
        const now = Date.now();

        const protocol: "http" | "socks5" | "vless" =
          product.type === "shared"
            ? "http"
            : product.type === "dedicated_standard"
              ? "socks5"
              : "vless";

        const lists: ProxyList[] = [];
        if (product.type === "shared") {
          const r = () => Math.random().toString(36).substring(2, 8);
          lists.push({
            id: generateId("lst"),
            name: "Default",
            login: `vm_${r()}`,
            password: r() + r(),
            country: null,
            region: null,
            city: null,
            isp: null,
            locationPreset: "world_mix",
            countries: null,
            rotationPeriod: 0,
          });
        }

        const proxyId = generateId("prx");
        const entry = {
          id: proxyId,
          displayId: generateDisplayId("PRX"),
          type: product.type,
          status: "active" as const,
          proxyHost: creds.host,
          proxyPort: creds.port,
          socksPort:
            product.type === "dedicated_standard" || product.type === "dedicated_premium"
              ? creds.socksPort
              : null,
          proxyUsername: creds.username,
          proxyPassword: creds.password,
          protocol,
          country: product.country,
          countryName: product.countryName,
          carrier: product.carrier,
          carrierName: product.carrierName,
          currentIp: ip,
          isOnline: true,
          dataTotal: product.type === "shared" ? product.dataGb : null,
          dataUsed: product.type === "shared" ? 0 : null,
          rotationInterval: null,
          lastRotatedAt: null,
          autoRenew: false,
          expiresAt: now + product.durationDays * 24 * 60 * 60 * 1000,
          createdAt: now,
          priceCents: product.priceCents,
          features: product.features,
          lists,
        };

        state.proxies.set(proxyId, entry);

        const connectionString = generateConnectionString(
          creds.host,
          creds.port,
          creds.username,
          creds.password
        );

        const lines = [
          `Proxy purchased!`,
          ``,
          `  Order ID:    ${proxyId}`,
          `  Display ID:  ${entry.displayId}`,
          `  Product:     ${product.name}`,
          `  Type:        ${product.type}`,
          `  Protocol:    ${protocol}`,
          `  Country:     ${product.country} (${product.countryName})`,
          `  Carrier:     ${product.carrier} (${product.carrierName})`,
          `  Cost:        ${formatUsd(product.priceCents)}`,
          `  Expires:     ${formatTimeRemaining(entry.expiresAt)}`,
        ];

        if (product.type === "shared" && product.dataGb !== null) {
          lines.push(`  Data:        ${formatGb(product.dataGb)}`);
        }

        lines.push(
          ``,
          `  Connection:`,
          `    Host:       ${creds.host}`,
          `    Port:       ${creds.port}`
        );

        if (entry.socksPort !== null) {
          lines.push(`    SOCKS Port: ${entry.socksPort}`);
        }

        lines.push(
          `    Username:   ${creds.username}`,
          `    Password:   ${creds.password}`,
          `    String:     ${connectionString}`,
          `    Current IP: ${ip}`
        );

        if (lists.length > 0) {
          const list = lists[0];
          const listConn = generateConnectionString(creds.host, creds.port, list.login, list.password);
          lines.push(
            ``,
            `  Default Proxy List:`,
            `    List ID:    ${list.id}`,
            `    Login:      ${list.login}`,
            `    Password:   ${list.password}`,
            `    Preset:     ${list.locationPreset}`,
            `    Rotation:   per-request`,
            `    Connection: ${listConn}`
          );
        }

        lines.push(
          ``,
          `Use get_proxy_status to check status, rotate_proxy to rotate IP (dedicated only).`
        );

        return textResponse(lines.join("\n"));
      } catch (e) {
        if (e instanceof ToolError) return errorResponse(e.message);
        throw e;
      }
    }
  );

  server.tool(
    "get_proxy_status",
    "Check status, bandwidth, and connection details for a proxy.",
    {
      proxyId: z.string().describe("Proxy order ID returned from purchase_proxy"),
    },
    async ({ proxyId }) => {
      try {
        const proxy = state.proxies.get(proxyId);
        if (!proxy) {
          return errorResponse(`Proxy not found: ${proxyId}`);
        }

        const now = Date.now();

        if (proxy.type === "shared" && proxy.dataTotal !== null) {
          const hoursElapsed = (now - proxy.createdAt) / 3600000;
          const simulatedUsage = hoursElapsed * 0.05;
          const maxUsage = proxy.dataTotal * 0.9;
          proxy.dataUsed = Math.round(Math.min(simulatedUsage, maxUsage) * 100) / 100;
        }

        const lines = [
          `Proxy Status - ${proxy.carrierName} (${proxy.countryName})`,
          ``,
          `  Order ID:      ${proxy.id}`,
          `  Display ID:    ${proxy.displayId}`,
          `  Status:        ${proxy.status}`,
          `  Type:          ${proxy.type}`,
          `  Protocol:      ${proxy.protocol}`,
          `  Country:       ${proxy.country} (${proxy.countryName})`,
          `  Carrier:       ${proxy.carrier} (${proxy.carrierName})`,
          `  Online:        ${proxy.isOnline ? "yes" : "no"}`,
          `  Current IP:    ${proxy.currentIp}`,
          `  Expires:       ${formatTimeRemaining(proxy.expiresAt)}`,
          `  Auto-renew:    ${proxy.autoRenew ? "on" : "off"}`,
        ];

        if (proxy.type === "shared" && proxy.dataTotal !== null && proxy.dataUsed !== null) {
          const remaining = Math.max(0, proxy.dataTotal - proxy.dataUsed);
          lines.push(
            ``,
            `  Bandwidth:`,
            `    Used:        ${formatGb(proxy.dataUsed)}`,
            `    Remaining:   ${formatGb(remaining)}`,
            `    Total:       ${formatGb(proxy.dataTotal)}`
          );
        }

        if (proxy.type !== "shared") {
          lines.push(
            ``,
            `  Rotation:`,
            `    Interval:    ${proxy.rotationInterval !== null ? `${proxy.rotationInterval}s` : "manual"}`,
            `    Last rotated: ${proxy.lastRotatedAt ? new Date(proxy.lastRotatedAt).toISOString() : "never"}`
          );
        }

        lines.push(
          ``,
          `  Connection:`,
          `    Host:        ${proxy.proxyHost}`,
          `    Port:        ${proxy.proxyPort}`
        );

        if (proxy.socksPort !== null) {
          lines.push(`    SOCKS Port:  ${proxy.socksPort}`);
        }

        lines.push(
          `    Username:    ${proxy.proxyUsername}`,
          `    Password:    ${proxy.proxyPassword}`
        );

        if (proxy.features.length > 0) {
          lines.push(``, `  Features: ${proxy.features.join(", ")}`);
        }

        if (proxy.type === "shared" && proxy.lists.length > 0) {
          lines.push(``, `  Proxy Lists: ${proxy.lists.length}`);
          for (const list of proxy.lists) {
            lines.push(`    - ${list.name} (${list.id}) preset=${list.locationPreset}`);
          }
        }

        return textResponse(lines.join("\n"));
      } catch (e) {
        if (e instanceof ToolError) return errorResponse(e.message);
        throw e;
      }
    }
  );

  server.tool(
    "rotate_proxy",
    "Rotate a proxy to get a new IP address. Works on dedicated proxies only.",
    {
      proxyId: z.string().describe("Proxy order ID to rotate"),
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

        if (proxy.type === "shared") {
          return errorResponse(
            `Shared proxies rotate automatically per-request. Use proxy lists to control rotation. Only dedicated proxies support manual rotation.`
          );
        }

        const oldIp = proxy.currentIp;
        const newIp = generateIp();
        proxy.currentIp = newIp;
        proxy.lastRotatedAt = Date.now();

        const text = [
          `IP rotated!`,
          ``,
          `  Order ID:       ${proxy.id}`,
          `  Old IP:         ${oldIp}`,
          `  New IP:         ${newIp}`,
          `  Last rotated:   ${new Date(proxy.lastRotatedAt).toISOString()}`,
        ].join("\n");

        return textResponse(text);
      } catch (e) {
        if (e instanceof ToolError) return errorResponse(e.message);
        throw e;
      }
    }
  );

  server.tool(
    "get_proxy_lists",
    "Get proxy lists for a shared proxy order.",
    {
      orderId: z.string().describe("Shared proxy order ID"),
    },
    async ({ orderId }) => {
      try {
        const proxy = state.proxies.get(orderId);
        if (!proxy) {
          return errorResponse(`Proxy not found: ${orderId}`);
        }

        if (proxy.type !== "shared") {
          return errorResponse(
            `Proxy lists are only available for shared proxies. This is a ${proxy.type} proxy.`
          );
        }

        if (proxy.lists.length === 0) {
          return errorResponse(`No proxy lists found for order ${orderId}.`);
        }

        let text = `Proxy Lists for ${proxy.displayId} (${proxy.countryName}):\n\n`;
        for (const list of proxy.lists) {
          const connStr = generateConnectionString(
            proxy.proxyHost,
            proxy.proxyPort,
            list.login,
            list.password
          );
          text += `  ${list.name} (${list.id})\n`;
          text += `    Login:      ${list.login}\n`;
          text += `    Password:   ${list.password}\n`;
          text += `    Preset:     ${list.locationPreset}\n`;
          if (list.countries) {
            text += `    Countries:  ${list.countries.join(", ")}\n`;
          }
          text += `    Rotation:   ${list.rotationPeriod === 0 ? "per-request" : list.rotationPeriod === -1 ? "sticky" : `${list.rotationPeriod}s`}\n`;
          if (list.country) text += `    Country:    ${list.country}\n`;
          if (list.region) text += `    Region:     ${list.region}\n`;
          if (list.city) text += `    City:       ${list.city}\n`;
          if (list.isp) text += `    ISP:        ${list.isp}\n`;
          text += `    Connection: ${connStr}\n`;
          text += `\n`;
        }

        return textResponse(text);
      } catch (e) {
        if (e instanceof ToolError) return errorResponse(e.message);
        throw e;
      }
    }
  );

  server.tool(
    "create_proxy_list",
    "Create a new geo-targeted proxy list for a shared proxy order.",
    {
      orderId: z.string().describe("Shared proxy order ID"),
      name: z.string().describe("Name for the proxy list"),
      locationPreset: z
        .enum(["world_mix", "north_america", "europe", "asia", "latin_america", "custom"])
        .default("world_mix")
        .describe("Location preset for the list"),
      countries: z
        .array(z.string())
        .optional()
        .describe("Country codes (required when preset is 'custom')"),
      rotationPeriod: z
        .number()
        .default(0)
        .describe("Rotation period: 0=per-request, -1=sticky, N=seconds"),
    },
    async ({ orderId, name, locationPreset, countries, rotationPeriod }) => {
      try {
        const proxy = state.proxies.get(orderId);
        if (!proxy) {
          return errorResponse(`Proxy not found: ${orderId}`);
        }

        if (proxy.type !== "shared") {
          return errorResponse(
            `Proxy lists are only available for shared proxies. This is a ${proxy.type} proxy.`
          );
        }

        if (locationPreset === "custom" && (!countries || countries.length === 0)) {
          return errorResponse(
            `Countries must be provided when using the 'custom' location preset.`
          );
        }

        const validatedCountries = countries
          ? countries.map((c) => validateCountry(c))
          : null;

        const r = () => Math.random().toString(36).substring(2, 8);
        const list: ProxyList = {
          id: generateId("lst"),
          name,
          login: `vm_${r()}`,
          password: r() + r(),
          country: null,
          region: null,
          city: null,
          isp: null,
          locationPreset,
          countries: validatedCountries,
          rotationPeriod,
        };

        proxy.lists.push(list);

        const connStr = generateConnectionString(
          proxy.proxyHost,
          proxy.proxyPort,
          list.login,
          list.password
        );

        const rotationLabel =
          rotationPeriod === 0
            ? "per-request"
            : rotationPeriod === -1
              ? "sticky"
              : `${rotationPeriod}s`;

        const lines = [
          `Proxy list created!`,
          ``,
          `  List ID:      ${list.id}`,
          `  Name:         ${list.name}`,
          `  Login:        ${list.login}`,
          `  Password:     ${list.password}`,
          `  Preset:       ${locationPreset}`,
        ];

        if (validatedCountries) {
          lines.push(`  Countries:    ${validatedCountries.join(", ")}`);
        }

        lines.push(
          `  Rotation:     ${rotationLabel}`,
          `  Connection:   ${connStr}`,
          ``,
          `Total lists for this order: ${proxy.lists.length}`
        );

        return textResponse(lines.join("\n"));
      } catch (e) {
        if (e instanceof ToolError) return errorResponse(e.message);
        throw e;
      }
    }
  );

  server.tool(
    "get_openvpn_config",
    "Get OpenVPN configuration file for a dedicated proxy.",
    {
      orderId: z.string().describe("Dedicated proxy order ID"),
    },
    async ({ orderId }) => {
      try {
        const proxy = state.proxies.get(orderId);
        if (!proxy) {
          return errorResponse(`Proxy not found: ${orderId}`);
        }

        if (proxy.type === "shared") {
          return errorResponse(
            `OpenVPN config is only available for dedicated proxies. This is a shared proxy.`
          );
        }

        const { config, filename } = generateOpenvpnConfig(
          proxy.proxyHost,
          proxy.proxyUsername,
          proxy.proxyPassword,
          proxy.country,
          proxy.carrierName
        );

        const text = [
          `OpenVPN Configuration - ${proxy.displayId}`,
          ``,
          `  Filename: ${filename}`,
          ``,
          `--- ${filename} ---`,
          config,
          `--- end ---`,
        ].join("\n");

        return textResponse(text);
      } catch (e) {
        if (e instanceof ToolError) return errorResponse(e.message);
        throw e;
      }
    }
  );

  server.tool(
    "get_vless_config",
    "Get VLESS connection URI for a dedicated premium proxy.",
    {
      orderId: z.string().describe("Dedicated premium proxy order ID"),
    },
    async ({ orderId }) => {
      try {
        const proxy = state.proxies.get(orderId);
        if (!proxy) {
          return errorResponse(`Proxy not found: ${orderId}`);
        }

        if (proxy.type !== "dedicated_premium") {
          return errorResponse(
            `VLESS config is only available for dedicated premium proxies. This is a ${proxy.type} proxy.`
          );
        }

        const { uri, uuid } = generateVlessUri(
          proxy.proxyHost,
          proxy.proxyPort,
          proxy.country
        );

        const text = [
          `VLESS Configuration - ${proxy.displayId}`,
          ``,
          `  Host:  ${proxy.proxyHost}`,
          `  Port:  ${proxy.proxyPort}`,
          `  UUID:  ${uuid}`,
          ``,
          `  URI:   ${uri}`,
        ].join("\n");

        return textResponse(text);
      } catch (e) {
        if (e instanceof ToolError) return errorResponse(e.message);
        throw e;
      }
    }
  );
}
