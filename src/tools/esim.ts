import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { state, EsimOrder } from "../sandbox/state.js";
import { ToolError, generateId } from "../utils/validation.js";
import {
  formatUsd,
  formatMb,
  formatData,
  formatTimeRemaining,
  generateDisplayId,
  generateIccid,
  generateActivationCode,
} from "../utils/format.js";
import { errorResponse, textResponse } from "../utils/response.js";
import {
  searchPlans,
  getPlan,
  getTopupProducts,
  getTopupProduct,
} from "../mock-data/esim.js";

function featureBadges(has5g: boolean, hasHotspot: boolean): string {
  const badges: string[] = [];
  if (has5g) badges.push("5G");
  if (hasHotspot) badges.push("Hotspot");
  return badges.length > 0 ? badges.join(", ") : "None";
}

export function registerEsimTools(server: McpServer) {
  server.tool(
    "search_esim_plans",
    "Search available eSIM data plans by country, data, duration, or features.",
    {
      country: z
        .string()
        .optional()
        .describe("ISO 3166-1 alpha-2 country code (e.g., JP, US, GB)"),
      duration: z
        .number()
        .min(1)
        .optional()
        .describe("Minimum plan validity in days"),
      dataAmount: z
        .number()
        .min(1)
        .optional()
        .describe("Minimum data amount in GB"),
      has5g: z.boolean().optional().describe("Filter for 5G-capable plans"),
      hasHotspot: z
        .boolean()
        .optional()
        .describe("Filter for plans with hotspot/tethering"),
      search: z
        .string()
        .optional()
        .describe("Text search in plan title (e.g., 'Japan', 'Europe')"),
      limit: z
        .number()
        .min(1)
        .max(50)
        .default(20)
        .describe("Maximum results to return (default: 20)"),
    },
    async ({ country, duration, dataAmount, has5g, hasHotspot, search, limit }) => {
      try {
        const results = searchPlans({
          country,
          duration,
          dataAmount,
          has5g,
          hasHotspot,
          search,
          limit,
        });

        if (results.length === 0) {
          return errorResponse(
            "No eSIM plans found matching your criteria. Try different filters or omit them to browse all plans."
          );
        }

        let text = `Found ${results.length} eSIM plan(s):\n\n`;

        for (const plan of results) {
          text += `  ${plan.title} (${plan.id})\n`;
          text += `    Countries:  ${plan.countries.join(", ")}\n`;
          text += `    Data:       ${formatData(plan.dataLimitGb, plan.dataUnlimited)}\n`;
          text += `    Duration:   ${plan.validityDays} days\n`;
          text += `    Price:      $${plan.retailPriceUsd.toFixed(2)}\n`;
          text += `    Features:   ${featureBadges(plan.has5g, plan.hasHotspot)}\n`;
          text += `    Routing:    ${plan.routingLocation}\n`;
          text += `    Top-up:     ${plan.supportsTopup ? "Yes" : "No"}\n\n`;
        }

        return textResponse(text);
      } catch (e) {
        if (e instanceof ToolError) return errorResponse(e.message);
        throw e;
      }
    }
  );

  server.tool(
    "get_esim_plan_details",
    "Get full details for a specific eSIM plan.",
    {
      planId: z.string().describe("Plan ID (e.g., 'esim_jp_3g_7d')"),
    },
    async ({ planId }) => {
      const plan = getPlan(planId);

      if (!plan) {
        return errorResponse(
          `Plan not found: ${planId}. Use search_esim_plans to browse available plans.`
        );
      }

      const text = [
        `${plan.title}`,
        ``,
        `  Plan ID:          ${plan.id}`,
        `  Countries:        ${plan.countries.join(", ")}`,
        `  Data:             ${formatData(plan.dataLimitGb, plan.dataUnlimited)}`,
        `  Duration:         ${plan.validityDays} days`,
        `  Price:            $${plan.retailPriceUsd.toFixed(2)}`,
        `  Network:          ${plan.networkType}`,
        `  Speed:            ${plan.speed}`,
        `  5G:               ${plan.has5g ? "Yes" : "No"}`,
        `  Hotspot:          ${plan.hasHotspot ? "Yes" : "No"}`,
        `  Activation:       ${plan.activationPolicy}`,
        `  Routing:          ${plan.routingLocation}`,
        `  Supports top-up:  ${plan.supportsTopup ? "Yes" : "No"}`,
        `  Tags:             ${plan.tags.length > 0 ? plan.tags.join(", ") : "None"}`,
      ].join("\n");

      return textResponse(text);
    }
  );

  server.tool(
    "purchase_esim",
    "Purchase an eSIM plan. Returns QR code and activation details.",
    {
      planId: z.string().describe("Plan ID to purchase (e.g., 'esim_jp_3g_7d')"),
    },
    async ({ planId }) => {
      const plan = getPlan(planId);

      if (!plan) {
        return errorResponse(
          `Plan not found: ${planId}. Use search_esim_plans to browse available plans.`
        );
      }

      const costCents = Math.round(plan.retailPriceUsd * 100);

      if (!state.deductBalance(costCents, "esim_purchase", `eSIM: ${plan.title}`)) {
        return errorResponse(
          `Insufficient balance. Need ${formatUsd(costCents)} but have ${formatUsd(state.balanceCents)}. Use deposit to add funds.`
        );
      }

      const now = Date.now();
      const orderId = generateId("esm");
      const displayId = generateDisplayId("ESM");

      const order: EsimOrder = {
        id: orderId,
        displayId,
        planId: plan.id,
        planTitle: plan.title,
        countries: plan.countries,
        dataLimitGb: plan.dataLimitGb,
        dataUnlimited: plan.dataUnlimited,
        validityDays: plan.validityDays,
        dataUsedMb: 0,
        status: "active",
        retailPriceUsd: plan.retailPriceUsd,
        qrCodeData: `https://sandbox.voidmob.com/esim/qr/${orderId}`,
        activationCode: generateActivationCode(),
        iccid: generateIccid(),
        isTopup: false,
        parentOrderId: null,
        supportsTopup: plan.supportsTopup,
        expiresAt: now + plan.validityDays * 86400000,
        createdAt: now,
      };

      state.esimOrders.set(orderId, order);

      const lines = [
        `eSIM purchased!`,
        ``,
        `  Order ID:         ${orderId}`,
        `  Display ID:       ${displayId}`,
        `  Plan:             ${plan.title}`,
        `  Countries:        ${plan.countries.join(", ")}`,
        `  Data:             ${formatData(plan.dataLimitGb, plan.dataUnlimited)}`,
        `  Duration:         ${plan.validityDays} days`,
        `  Cost:             $${plan.retailPriceUsd.toFixed(2)}`,
        `  Balance:          ${formatUsd(state.balanceCents)}`,
        ``,
        `  QR Code:          ${order.qrCodeData}`,
        `  Activation Code:  ${order.activationCode}`,
        `  ICCID:            ${order.iccid}`,
        ``,
        `Setup steps:`,
        `  1. Scan the QR code or enter the activation code in your device settings`,
        `  2. Select the eSIM line and enable data roaming`,
        `  3. The plan activates on first data usage`,
        ``,
        `Use get_esim_usage with order ID "${orderId}" to check data consumption.`,
      ];

      return textResponse(lines.join("\n"));
    }
  );

  server.tool(
    "get_esim_usage",
    "Check data usage and status for an eSIM order.",
    {
      orderId: z.string().describe("Order ID returned from purchase_esim"),
    },
    async ({ orderId }) => {
      const order = state.esimOrders.get(orderId);

      if (!order) {
        return errorResponse(`Order not found: ${orderId}`);
      }

      const now = Date.now();

      if (order.status === "active" && now >= order.expiresAt) {
        order.status = "expired";
      }

      // Simulate usage: ~0.1 GB/hour = ~102.4 MB/hour, cap at 95% of total
      const hoursElapsed = (now - order.createdAt) / 3600000;
      const simulatedUsageMb = hoursElapsed * 102.4;

      if (order.dataUnlimited || order.dataLimitGb === null) {
        order.dataUsedMb = Math.round(simulatedUsageMb * 100) / 100;
      } else {
        const totalMb = order.dataLimitGb * 1024;
        const maxUsageMb = totalMb * 0.95;
        order.dataUsedMb = Math.round(Math.min(simulatedUsageMb, maxUsageMb) * 100) / 100;
      }

      const esimStatus = order.status === "active" ? "active" : "expired";

      const lines = [
        `eSIM Usage`,
        ``,
        `  esimStatus: ${esimStatus}`,
        ``,
        `  Package: ${order.planTitle}`,
        `    Used: ${formatMb(order.dataUsedMb)}`,
      ];

      if (!order.dataUnlimited && order.dataLimitGb !== null) {
        const totalMb = order.dataLimitGb * 1024;
        const remainingMb = Math.max(0, totalMb - order.dataUsedMb);
        const pct = Math.min(100, (order.dataUsedMb / totalMb) * 100);

        lines[lines.length - 1] = `    Used: ${formatMb(order.dataUsedMb)} / ${formatMb(totalMb)} (${pct.toFixed(1)}%)`;
        lines.push(`    Remaining: ${formatMb(remainingMb)}`);
      }

      lines.push(
        `    Expires: ${order.status === "expired" ? "Expired" : new Date(order.expiresAt).toISOString().slice(0, 16)}`,
      );

      if (order.status === "active") {
        lines.push(`    Time left: ${formatTimeRemaining(order.expiresAt)}`);
      }

      return textResponse(lines.join("\n"));
    }
  );

  server.tool(
    "topup_esim",
    "Browse available top-up products or purchase a top-up for an active eSIM.",
    {
      orderId: z.string().describe("Order ID of the eSIM to top up"),
      topupProductId: z
        .string()
        .optional()
        .describe("Top-up product ID to purchase. Omit to browse available top-ups."),
    },
    async ({ orderId, topupProductId }) => {
      const order = state.esimOrders.get(orderId);

      if (!order) {
        return errorResponse(`Order not found: ${orderId}`);
      }

      if (order.status !== "active") {
        return errorResponse(
          `Order ${orderId} is ${order.status}. Only active orders can be topped up.`
        );
      }

      if (!order.supportsTopup) {
        return errorResponse(
          `Order ${orderId} (${order.planTitle}) does not support top-ups.`
        );
      }

      if (!topupProductId) {
        const products = getTopupProducts(order.planId);

        if (products.length === 0) {
          return errorResponse(
            `No top-up products available for plan ${order.planTitle}.`
          );
        }

        let text = `Available top-ups for ${order.planTitle} (order ${orderId}):\n\n`;

        for (const p of products) {
          text += `  ${p.title} (${p.id})\n`;
          text += `    Data:     ${p.dataLimitGb} GB\n`;
          text += `    Duration: ${p.validityDays} days\n`;
          text += `    Price:    $${p.retailPriceUsd.toFixed(2)}\n\n`;
        }

        text += `Use topup_esim with orderId and topupProductId to purchase.`;

        return textResponse(text);
      }

      const product = getTopupProduct(topupProductId);

      if (!product) {
        return errorResponse(
          `Top-up product not found: ${topupProductId}. Use topup_esim without topupProductId to browse available options.`
        );
      }

      const costCents = Math.round(product.retailPriceUsd * 100);

      if (!state.deductBalance(costCents, "esim_topup", `eSIM top-up: ${product.title} on ${orderId}`)) {
        return errorResponse(
          `Insufficient balance. Need ${formatUsd(costCents)} but have ${formatUsd(state.balanceCents)}. Use deposit to add funds.`
        );
      }

      const now = Date.now();
      const newOrderId = generateId("esm");
      const displayId = generateDisplayId("ESM");

      const topupOrder: EsimOrder = {
        id: newOrderId,
        displayId,
        planId: order.planId,
        planTitle: product.title,
        countries: order.countries,
        dataLimitGb: product.dataLimitGb,
        dataUnlimited: false,
        validityDays: product.validityDays,
        dataUsedMb: 0,
        status: "active",
        retailPriceUsd: product.retailPriceUsd,
        qrCodeData: `https://sandbox.voidmob.com/esim/qr/${newOrderId}`,
        activationCode: generateActivationCode(),
        iccid: order.iccid,
        isTopup: true,
        parentOrderId: orderId,
        supportsTopup: false,
        expiresAt: now + product.validityDays * 86400000,
        createdAt: now,
      };

      state.esimOrders.set(newOrderId, topupOrder);

      const text = [
        `Top-up purchased!`,
        ``,
        `  Top-up order:  ${newOrderId}`,
        `  Display ID:    ${displayId}`,
        `  Product:       ${product.title}`,
        `  Data:          ${product.dataLimitGb} GB`,
        `  Duration:      ${product.validityDays} days`,
        `  Cost:          $${product.retailPriceUsd.toFixed(2)}`,
        `  Parent order:  ${orderId}`,
        `  Balance:       ${formatUsd(state.balanceCents)}`,
        ``,
        `The top-up data has been added to your eSIM.`,
      ].join("\n");

      return textResponse(text);
    }
  );
}
