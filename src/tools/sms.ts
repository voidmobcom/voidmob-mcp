import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { state, SmsRental } from "../sandbox/state.js";
import { generateId } from "../utils/validation.js";
import {
  formatUsd,
  generatePhoneNumber,
  generateVerificationCode,
  generateDisplayId,
  formatTimeRemaining,
} from "../utils/format.js";
import { errorResponse, textResponse } from "../utils/response.js";
import { searchServices, getService, smsServices } from "../mock-data/sms.js";

const DURATION_DAYS: Record<string, number> = {
  "3D": 3,
  "7D": 7,
  "14D": 14,
  "30D": 30,
};

const REUSE_COST_CENTS = 50;

export function registerSmsTools(server: McpServer) {
  server.tool(
    "search_sms_services",
    "Search available US non-VoIP SMS services with pricing for verification, long-term rental, and dedicated numbers.",
    {
      query: z
        .string()
        .optional()
        .describe("Search by service name (e.g., 'telegram', 'whatsapp')"),
    },
    async ({ query }) => {
      const results = searchServices(query);

      if (results.length === 0) {
        return errorResponse(
          "No services found matching your query. Try a different search term or omit the query to see all services."
        );
      }

      let text = `Found ${results.length} US non-VoIP SMS service(s):\n\n`;
      text += `${"Service".padEnd(22)} ${"ID".padEnd(6)} ${"Verify".padStart(8)} ${"3-Day".padStart(8)} ${"7-Day".padStart(8)} ${"14-Day".padStart(8)} ${"30-Day".padStart(8)} ${"Dedicated".padStart(10)} Icon\n`;
      text += `${"─".repeat(22)} ${"─".repeat(6)} ${"─".repeat(8)} ${"─".repeat(8)} ${"─".repeat(8)} ${"─".repeat(8)} ${"─".repeat(8)} ${"─".repeat(10)} ${"─".repeat(4)}\n`;

      for (const s of results) {
        text += `${s.serviceName.padEnd(22)} ${s.id.padEnd(6)} ${formatUsd(s.priceUsdCents).padStart(8)} ${formatUsd(s.ltr3PriceCents).padStart(8)} ${formatUsd(s.ltr7PriceCents).padStart(8)} ${formatUsd(s.ltr14PriceCents).padStart(8)} ${formatUsd(s.ltr30PriceCents).padStart(8)} ${formatUsd(s.dedicatedPriceCents).padStart(10)} ${s.hasIcon ? "Yes" : "No"}\n`;
      }

      return textResponse(text);
    }
  );

  server.tool(
    "get_sms_price",
    "Get all pricing tiers for a specific US non-VoIP SMS service.",
    {
      service: z.string().describe("Service ID (e.g., 'wa', 'tg', 'go')"),
    },
    async ({ service }) => {
      const svc = getService(service);

      if (!svc) {
        return errorResponse(
          `Service "${service}" not found. Use search_sms_services to find available options.`
        );
      }

      const text = [
        `${svc.serviceName} (${svc.id}) - US Non-VoIP`,
        ``,
        `  Verification (20min):  ${formatUsd(svc.priceUsdCents)}`,
        `  Long-Term Rental:`,
        `    3-day:               ${formatUsd(svc.ltr3PriceCents)}`,
        `    7-day:               ${formatUsd(svc.ltr7PriceCents)}`,
        `    14-day:              ${formatUsd(svc.ltr14PriceCents)}`,
        `    30-day:              ${formatUsd(svc.ltr30PriceCents)}`,
        `  Dedicated (28 days):   ${formatUsd(svc.dedicatedPriceCents)}`,
        ``,
        `  Has icon: ${svc.hasIcon ? "Yes" : "No"}`,
      ].join("\n");

      return textResponse(text);
    }
  );

  server.tool(
    "rent_number",
    "Rent a US non-VoIP phone number. Supports verification (20min), long-term rental (3-30 days), and dedicated numbers (28 days, all services).",
    {
      service: z.string().describe("Service ID (e.g., 'wa', 'tg', 'go')"),
      rentalType: z
        .enum(["verification", "rental", "dedicated"])
        .default("verification")
        .describe("Type of rental (default: verification)"),
      duration: z
        .enum(["3D", "7D", "14D", "30D"])
        .optional()
        .describe("Duration for long-term rentals (required when rentalType is 'rental')"),
      autoRenew: z
        .boolean()
        .default(false)
        .describe("Enable auto-renewal (only for rental/dedicated)"),
    },
    async ({ service, rentalType, duration, autoRenew }) => {
      const svc = getService(service);

      if (!svc) {
        return errorResponse(
          `Service "${service}" not found. Use search_sms_services to find available options.`
        );
      }

      if (rentalType === "rental" && !duration) {
        return errorResponse(
          `Duration is required for long-term rentals. Choose one of: 3D, 7D, 14D, 30D.`
        );
      }

      let priceCents: number;
      let txType: "sms_verification" | "sms_rental" | "sms_dedicated";
      let expiryMs: number;

      const now = Date.now();

      if (rentalType === "verification") {
        priceCents = svc.priceUsdCents;
        txType = "sms_verification";
        expiryMs = 20 * 60 * 1000;
      } else if (rentalType === "rental") {
        const durationKey = duration!;
        const priceMap: Record<string, number> = {
          "3D": svc.ltr3PriceCents,
          "7D": svc.ltr7PriceCents,
          "14D": svc.ltr14PriceCents,
          "30D": svc.ltr30PriceCents,
        };
        priceCents = priceMap[durationKey];
        txType = "sms_rental";
        expiryMs = DURATION_DAYS[durationKey] * 86400000;
      } else {
        // dedicated
        priceCents = svc.dedicatedPriceCents;
        txType = "sms_dedicated";
        expiryMs = 28 * 86400000;
      }

      const desc = rentalType === "verification"
        ? `SMS verification: ${svc.serviceName}`
        : rentalType === "rental"
          ? `SMS ${duration} rental: ${svc.serviceName}`
          : `SMS dedicated: ${svc.serviceName}`;

      if (!state.deductBalance(priceCents, txType, desc)) {
        return errorResponse(
          `Insufficient balance. Need ${formatUsd(priceCents)} but have ${formatUsd(state.balanceCents)}. Use deposit to add funds.`
        );
      }

      const rentalId = generateId("sms");
      const phoneNumber = generatePhoneNumber();
      const displayId = generateDisplayId("SMS");

      const rental: SmsRental = {
        id: rentalId,
        displayId,
        phoneNumber,
        service: svc.id,
        serviceName: svc.serviceName,
        rentalType,
        duration: rentalType === "rental" ? duration! : null,
        autoRenew: rentalType === "verification" ? false : autoRenew,
        paidUntil: rentalType === "verification" ? null : now + expiryMs,
        status: "active",
        messages: [],
        expiresAt: now + expiryMs,
        createdAt: now,
        priceCents,
        reuseCounter: 0,
      };

      state.smsRentals.set(rentalId, rental);

      const lines = [
        `Number rented!`,
        ``,
        `  Rental ID:  ${rentalId}`,
        `  Display ID: ${displayId}`,
        `  Number:     ${phoneNumber}`,
        `  Service:    ${svc.serviceName}`,
        `  Type:       ${rentalType}${rentalType === "rental" ? ` (${duration})` : ""}`,
        `  Cost:       ${formatUsd(priceCents)}`,
        `  Expires:    ${formatTimeRemaining(now + expiryMs)}`,
      ];

      if (rentalType !== "verification") {
        lines.push(`  Auto-renew: ${autoRenew ? "On" : "Off"}`);
        lines.push(`  Paid until: ${new Date(now + expiryMs).toISOString().slice(0, 16)}`);
      }

      lines.push(``);
      lines.push(`  Balance:    ${formatUsd(state.balanceCents)}`);
      lines.push(``);
      lines.push(`Use get_messages with the rental ID to check for incoming SMS.`);

      return textResponse(lines.join("\n"));
    }
  );

  server.tool(
    "get_messages",
    "Check for incoming SMS messages on a rented number.",
    {
      rentalId: z.string().describe("Rental ID returned from rent_number"),
    },
    async ({ rentalId }) => {
      const rental = state.smsRentals.get(rentalId);

      if (!rental) {
        return errorResponse(`Rental not found: ${rentalId}`);
      }

      if (rental.status === "active" && Date.now() >= rental.expiresAt) {
        rental.status = "expired";
      }

      if (rental.status === "expired") {
        return errorResponse(
          `Rental ${rentalId} has expired. Use reuse_number to reactivate a verification rental.`
        );
      }

      if (rental.status === "cancelled") {
        return errorResponse(`Rental ${rentalId} has been cancelled.`);
      }

      // Lazy mock: generate a message after 5 seconds
      if (rental.messages.length === 0) {
        const elapsed = Date.now() - rental.createdAt;

        if (elapsed < 5000) {
          const text = [
            `No messages yet for ${rental.phoneNumber} (${rental.serviceName}).`,
            ``,
            `  Waiting for SMS... try again shortly.`,
            `  Time since rental: ${Math.floor(elapsed / 1000)}s`,
          ].join("\n");

          return textResponse(text);
        }

        // For dedicated numbers, the message comes from a random service
        let msgService = rental.serviceName;
        if (rental.rentalType === "dedicated") {
          const randomSvc = smsServices[Math.floor(Math.random() * smsServices.length)];
          msgService = randomSvc.serviceName;
        }

        const code = generateVerificationCode();
        rental.messages.push({
          id: generateId("msg"),
          message_text: `Your ${msgService} verification code is: ${code}`,
          code,
          received_at: Date.now(),
          read_at: null,
        });

        if (rental.rentalType === "verification") {
          rental.status = "completed";
        }
      }

      let text = `Messages for ${rental.phoneNumber} (${rental.serviceName}):\n\n`;

      for (const msg of rental.messages) {
        const time = new Date(msg.received_at).toISOString().slice(11, 19);
        const readStatus = msg.read_at ? "read" : "new";
        text += `  [${time}] (${readStatus})\n`;
        text += `  ${msg.message_text}\n`;
        if (msg.code) {
          text += `  Code: ${msg.code}\n`;
        }
        text += `\n`;

        if (!msg.read_at) {
          msg.read_at = Date.now();
        }
      }

      text += `Total messages: ${rental.messages.length}`;
      if (rental.status === "completed") {
        text += `\nStatus: completed - use reuse_number to receive another SMS.`;
      }

      return textResponse(text);
    }
  );

  server.tool(
    "cancel_rental",
    "Cancel an SMS rental. Full refund for verification with no messages, no refund for LTR/dedicated.",
    {
      rentalId: z.string().describe("Rental ID to cancel"),
    },
    async ({ rentalId }) => {
      const rental = state.smsRentals.get(rentalId);

      if (!rental) {
        return errorResponse(`Rental not found: ${rentalId}`);
      }

      if (rental.status === "cancelled") {
        return errorResponse(`Rental ${rentalId} is already cancelled.`);
      }

      if (rental.status === "expired") {
        return errorResponse(`Rental ${rentalId} has expired and cannot be cancelled.`);
      }

      rental.status = "cancelled";

      if (rental.rentalType === "verification" && rental.messages.length === 0) {
        state.addBalance(rental.priceCents, "refund", `Refund: ${rental.serviceName} verification`);

        const text = [
          `Rental ${rentalId} cancelled.`,
          ``,
          `  Refund:      ${formatUsd(rental.priceCents)} (no messages received)`,
          `  New balance: ${formatUsd(state.balanceCents)}`,
        ].join("\n");

        return textResponse(text);
      }

      const reason = rental.rentalType === "verification"
        ? "messages were already received"
        : `${rental.rentalType} rentals are non-refundable`;

      const text = [
        `Rental ${rentalId} cancelled.`,
        ``,
        `  No refund - ${reason}.`,
      ].join("\n");

      return textResponse(text);
    }
  );

  server.tool(
    "reuse_number",
    "Reuse a completed or expired verification number to receive another SMS.",
    {
      rentalId: z.string().describe("Rental ID of a verification rental to reuse"),
      paid: z
        .boolean()
        .default(false)
        .describe("Use paid reuse ($0.50) for expired numbers"),
    },
    async ({ rentalId, paid }) => {
      const rental = state.smsRentals.get(rentalId);

      if (!rental) {
        return errorResponse(`Rental not found: ${rentalId}`);
      }

      if (rental.rentalType !== "verification") {
        return errorResponse(
          `Only verification rentals can be reused. This is a ${rental.rentalType} rental.`
        );
      }

      if (rental.status === "active") {
        return errorResponse(
          `Rental ${rentalId} is still active. Wait for it to complete or expire before reusing.`
        );
      }

      if (rental.status === "cancelled") {
        return errorResponse(`Rental ${rentalId} has been cancelled and cannot be reused.`);
      }

      if (!paid && rental.status === "expired") {
        return errorResponse(
          `Rental ${rentalId} has expired. Use paid reuse (paid: true) for ${formatUsd(REUSE_COST_CENTS)} to reactivate.`
        );
      }

      if (paid) {
        if (!state.deductBalance(REUSE_COST_CENTS, "sms_reuse", `SMS reuse: ${rental.serviceName}`)) {
          return errorResponse(
            `Insufficient balance. Need ${formatUsd(REUSE_COST_CENTS)} but have ${formatUsd(state.balanceCents)}. Use deposit to add funds.`
          );
        }
      }

      const now = Date.now();
      rental.status = "active";
      rental.expiresAt = now + 20 * 60 * 1000;
      rental.messages = [];
      rental.reuseCounter += 1;

      const lines = [
        `Number reused!`,
        ``,
        `  Rental ID:   ${rentalId}`,
        `  Number:      ${rental.phoneNumber}`,
        `  Service:     ${rental.serviceName}`,
        `  Reuse count: ${rental.reuseCounter}`,
        `  Cost:        ${paid ? formatUsd(REUSE_COST_CENTS) : "Free"}`,
        `  Expires:     ${formatTimeRemaining(rental.expiresAt)}`,
        `  Balance:     ${formatUsd(state.balanceCents)}`,
        ``,
        `Use get_messages to check for incoming SMS.`,
      ];

      return textResponse(lines.join("\n"));
    }
  );

  server.tool(
    "toggle_auto_renew",
    "Toggle auto-renewal for a long-term rental or dedicated number.",
    {
      rentalId: z.string().describe("Rental ID of a long-term or dedicated rental"),
    },
    async ({ rentalId }) => {
      const rental = state.smsRentals.get(rentalId);

      if (!rental) {
        return errorResponse(`Rental not found: ${rentalId}`);
      }

      if (rental.rentalType === "verification") {
        return errorResponse(
          `Auto-renewal is not available for verification rentals. Only long-term and dedicated rentals support auto-renewal.`
        );
      }

      rental.autoRenew = !rental.autoRenew;

      const lines = [
        `Auto-renewal ${rental.autoRenew ? "enabled" : "disabled"}.`,
        ``,
        `  Rental ID:     ${rentalId}`,
        `  Service:       ${rental.serviceName}`,
        `  Type:          ${rental.rentalType}${rental.duration ? ` (${rental.duration})` : ""}`,
        `  Auto-renew:    ${rental.autoRenew ? "On" : "Off"}`,
        `  Paid until:    ${rental.paidUntil ? new Date(rental.paidUntil).toISOString().slice(0, 16) : "N/A"}`,
        `  Renewal cost:  ${formatUsd(rental.priceCents)}`,
      ];

      if (rental.autoRenew && state.balanceCents < rental.priceCents) {
        lines.push(``);
        lines.push(`  WARNING: Balance (${formatUsd(state.balanceCents)}) is less than renewal cost (${formatUsd(rental.priceCents)}). Add funds before renewal date.`);
      }

      return textResponse(lines.join("\n"));
    }
  );
}
