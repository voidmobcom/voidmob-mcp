import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { state } from "../sandbox/state.js";
import { validateCountry, ToolError, generateId } from "../utils/validation.js";
import { formatUsd, formatGb, formatTimeRemaining } from "../utils/format.js";
import { searchPlans, getPlan } from "../mock-data/esim.js";

function errorResponse(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
  };
}

function formatData(gb: number): string {
  return gb >= 999 ? "Unlimited" : formatGb(gb);
}

export function registerEsimTools(server: McpServer) {
  server.tool(
    "search_esim_plans",
    "Search available eSIM data plans. Filter by country, minimum duration, or minimum data amount.",
    {
      country: z.string().describe("ISO 3166-1 alpha-2 country code (e.g., JP, US, GB)"),
      duration: z
        .number()
        .min(1)
        .optional()
        .describe("Minimum plan duration in days"),
      dataAmount: z
        .number()
        .min(1)
        .optional()
        .describe("Minimum data amount in GB"),
    },
    async ({ country, duration, dataAmount }) => {
      try {
        const validatedCountry = validateCountry(country);
        const results = searchPlans(validatedCountry, duration, dataAmount);

        if (results.length === 0) {
          return errorResponse(
            "No eSIM plans found matching your criteria. Try a different country or adjust filters."
          );
        }

        let text = `Found ${results.length} eSIM plan(s) for ${validatedCountry}:\n\n`;
        for (const plan of results) {
          text += `  ${plan.name} (${plan.planId})\n`;
          text += `    Data:     ${formatData(plan.data)}\n`;
          text += `    Duration: ${plan.duration} days\n`;
          text += `    Price:    ${formatUsd(plan.price)}\n`;
          text += `    Carrier:  ${plan.carrier}\n`;
          text += `    Routing:  ${plan.routing}\n`;
          text += `    Top-up:   ${plan.topupAvailable ? `Yes (${formatUsd(plan.topupPrice)}/GB)` : "No"}\n\n`;
        }

        return { content: [{ type: "text" as const, text }] };
      } catch (e) {
        if (e instanceof ToolError) return errorResponse(e.message);
        throw e;
      }
    }
  );

  server.tool(
    "get_esim_plan_details",
    "Get full details for a specific eSIM plan including APN settings and top-up availability.",
    {
      planId: z.string().describe("Plan ID (e.g., 'esim_jp_3g_7d')"),
    },
    async ({ planId }) => {
      try {
        const plan = getPlan(planId);

        if (!plan) {
          return errorResponse(
            `Plan not found: ${planId}. Use search_esim_plans to browse available plans.`
          );
        }

        const text = [
          `${plan.name}`,
          ``,
          `  Plan ID:   ${plan.planId}`,
          `  Country:   ${plan.country}`,
          `  Region:    ${plan.region}`,
          `  Data:      ${formatData(plan.data)}`,
          `  Duration:  ${plan.duration} days`,
          `  Price:     ${formatUsd(plan.price)}`,
          `  Carrier:   ${plan.carrier}`,
          `  APN:       ${plan.apn}`,
          `  Routing:   ${plan.routing}`,
          `  Top-up:    ${plan.topupAvailable ? `Available at ${formatUsd(plan.topupPrice)}/GB` : "Not available"}`,
        ].join("\n");

        return { content: [{ type: "text" as const, text }] };
      } catch (e) {
        if (e instanceof ToolError) return errorResponse(e.message);
        throw e;
      }
    }
  );

  server.tool(
    "purchase_esim",
    "Purchase an eSIM plan. Deducts cost from wallet and provides QR code for installation.",
    {
      planId: z.string().describe("Plan ID to purchase (e.g., 'esim_jp_3g_7d')"),
    },
    async ({ planId }) => {
      try {
        const plan = getPlan(planId);

        if (!plan) {
          return errorResponse(
            `Plan not found: ${planId}. Use search_esim_plans to browse available plans.`
          );
        }

        if (!state.deductBalance(plan.price, "esim_purchase", `eSIM: ${plan.name}`)) {
          return errorResponse(
            `Insufficient balance. Need ${formatUsd(plan.price)} but have ${formatUsd(state.balance)}. Use deposit to add funds.`
          );
        }

        const orderId = generateId("ord");
        const now = Date.now();

        state.esimOrders.set(orderId, {
          orderId,
          planId: plan.planId,
          planName: plan.name,
          country: plan.country,
          dataTotal: plan.data,
          dataUsed: 0,
          status: "active",
          qrUrl: `https://sandbox.voidmob.com/esim/qr/${orderId}`,
          apn: plan.apn,
          expiry: now + plan.duration * 24 * 60 * 60 * 1000,
          createdAt: now,
          price: plan.price,
        });

        const text = [
          `eSIM purchased!`,
          ``,
          `  Order ID:  ${orderId}`,
          `  Plan:      ${plan.name}`,
          `  Data:      ${formatData(plan.data)}`,
          `  Duration:  ${plan.duration} days`,
          `  Cost:      ${formatUsd(plan.price)}`,
          `  Carrier:   ${plan.carrier}`,
          `  Routing:   ${plan.routing}`,
          ``,
          `  QR Code:   https://sandbox.voidmob.com/esim/qr/${orderId}`,
          `  APN:       ${plan.apn}`,
          ``,
          `Setup steps:`,
          `  1. Scan the QR code with your device camera`,
          `  2. Set APN to "${plan.apn}"`,
          `  3. Enable the eSIM line in Settings`,
          ``,
          `Use get_esim_usage with the order ID to check data consumption.`,
        ].join("\n");

        return { content: [{ type: "text" as const, text }] };
      } catch (e) {
        if (e instanceof ToolError) return errorResponse(e.message);
        throw e;
      }
    }
  );

  server.tool(
    "get_esim_usage",
    "Check data usage and status for an eSIM order. Shows data consumed, remaining, and time left.",
    {
      orderId: z.string().describe("Order ID returned from purchase_esim"),
    },
    async ({ orderId }) => {
      try {
        const order = state.esimOrders.get(orderId);

        if (!order) {
          return errorResponse(`Order not found: ${orderId}`);
        }

        const now = Date.now();
        if (order.status === "active" && now >= order.expiry) {
          order.status = "expired";
        }

        // Simulate usage growth: ~0.1 GB/hour, capped at 95% of total
        const hoursElapsed = (now - order.createdAt) / 3600000;
        const simulatedUsage = hoursElapsed * 0.1;
        const maxUsage = order.dataTotal * 0.95;
        order.dataUsed = Math.round(Math.min(simulatedUsage, maxUsage) * 100) / 100;

        const daysLeft = Math.max(0, Math.ceil((order.expiry - now) / 86400000));
        const isUnlimited = order.dataTotal >= 999;

        const dataRemaining = isUnlimited
          ? "Unlimited"
          : formatGb(Math.max(0, order.dataTotal - order.dataUsed));

        const text = [
          `eSIM Usage — ${order.planName}`,
          ``,
          `  Order ID:       ${order.orderId}`,
          `  Status:         ${order.status}`,
          `  Data used:      ${formatGb(order.dataUsed)}`,
          `  Data remaining: ${dataRemaining}`,
          `  Data total:     ${formatData(order.dataTotal)}`,
          `  Days left:      ${order.status === "expired" ? "Expired" : `${daysLeft} day(s)`}`,
          `  Expires:        ${order.status === "expired" ? "Expired" : formatTimeRemaining(order.expiry)}`,
        ].join("\n");

        return { content: [{ type: "text" as const, text }] };
      } catch (e) {
        if (e instanceof ToolError) return errorResponse(e.message);
        throw e;
      }
    }
  );

  server.tool(
    "topup_esim",
    "Add more data to an active eSIM order. Only available for plans that support top-ups.",
    {
      orderId: z.string().describe("Order ID to top up"),
      dataAmount: z.number().positive().describe("Amount of data to add in GB"),
    },
    async ({ orderId, dataAmount }) => {
      try {
        const order = state.esimOrders.get(orderId);

        if (!order) {
          return errorResponse(`Order not found: ${orderId}`);
        }

        if (order.status !== "active") {
          return errorResponse(
            `Order ${orderId} is ${order.status}. Only active orders can be topped up.`
          );
        }

        const plan = getPlan(order.planId);

        if (!plan || !plan.topupAvailable) {
          return errorResponse(
            `Top-up is not available for this plan (${order.planName}).`
          );
        }

        const cost = Math.round(dataAmount * plan.topupPrice * 100) / 100;

        if (!state.deductBalance(cost, "topup", `eSIM top-up: +${formatGb(dataAmount)} for ${order.planName}`)) {
          return errorResponse(
            `Insufficient balance. Need ${formatUsd(cost)} but have ${formatUsd(state.balance)}. Use deposit to add funds.`
          );
        }

        order.dataTotal = Math.round((order.dataTotal + dataAmount) * 100) / 100;

        const text = [
          `Top-up successful!`,
          ``,
          `  Order:     ${order.orderId}`,
          `  Added:     ${formatGb(dataAmount)}`,
          `  Cost:      ${formatUsd(cost)}`,
          `  New total: ${formatData(order.dataTotal)}`,
          `  Balance:   ${formatUsd(state.balance)}`,
        ].join("\n");

        return { content: [{ type: "text" as const, text }] };
      } catch (e) {
        if (e instanceof ToolError) return errorResponse(e.message);
        throw e;
      }
    }
  );
}
