import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { state } from "../sandbox/state.js";
import { generateId } from "../utils/validation.js";
import {
  formatUsd,
  generatePhoneNumber,
  generateVerificationCode,
  formatTimeRemaining,
} from "../utils/format.js";
import { searchServices, getServicePrice } from "../mock-data/sms.js";

function errorResponse(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
  };
}

export function registerSmsTools(server: McpServer) {
  server.tool(
    "search_sms_services",
    "Search available US non-VoIP SMS verification services. Filter by name or category.",
    {
      query: z
        .string()
        .optional()
        .describe("Search by service name or category (e.g., 'telegram', 'social')"),
    },
    async ({ query }) => {
      const results = searchServices(query);

      if (results.length === 0) {
        return errorResponse(
          "No services found matching your criteria. Try a different search term."
        );
      }

      let text = `Found ${results.length} US non-VoIP SMS service(s):\n\n`;
      for (const s of results) {
        text += `  ${s.name} (${s.id})\n`;
        text += `    Category: ${s.category}\n`;
        text += `    Country:  US (non-VoIP)\n`;
        text += `    Price:    ${formatUsd(s.price)}\n`;
        text += `    Delivery: ${s.estimatedDelivery}\n\n`;
      }

      return { content: [{ type: "text" as const, text }] };
    }
  );

  server.tool(
    "get_sms_price",
    "Get pricing for a US non-VoIP SMS verification service.",
    {
      service: z.string().describe("Service ID (e.g., 'whatsapp', 'telegram')"),
    },
    async ({ service }) => {
      const result = getServicePrice(service);

      if (!result) {
        return errorResponse(
          `Service "${service}" not found. Use search_sms_services to find available options.`
        );
      }

      const text = [
        `${result.service.name} — US (non-VoIP)`,
        ``,
        `  Price:    ${formatUsd(result.price)}`,
        `  Delivery: ${result.service.estimatedDelivery}`,
      ].join("\n");

      return { content: [{ type: "text" as const, text }] };
    }
  );

  server.tool(
    "rent_number",
    "Rent a US non-VoIP phone number to receive an SMS verification code. Deducts cost from wallet. Number expires in 5 minutes.",
    {
      service: z.string().describe("Service ID (e.g., 'whatsapp', 'telegram')"),
    },
    async ({ service }) => {
      const result = getServicePrice(service);

      if (!result) {
        return errorResponse(
          `Service "${service}" not found. Use search_sms_services to find available options.`
        );
      }

      const { price } = result;

      if (!state.deductBalance(price, "sms_rental", `SMS rental: ${result.service.name} (US)`)) {
        return errorResponse(
          `Insufficient balance. Need ${formatUsd(price)} but have ${formatUsd(state.balance)}. Use deposit to add funds.`
        );
      }

      const rentalId = generateId("sms");
      const number = generatePhoneNumber("US");
      const now = Date.now();

      state.smsRentals.set(rentalId, {
        rentalId,
        number,
        service,
        country: "US",
        status: "active",
        messages: [],
        expiry: now + 5 * 60 * 1000,
        createdAt: now,
        price,
      });

      const text = [
        `Number rented!`,
        ``,
        `  Rental ID: ${rentalId}`,
        `  Number:    ${number}`,
        `  Service:   ${result.service.name}`,
        `  Country:   US (non-VoIP)`,
        `  Cost:      ${formatUsd(price)}`,
        `  Expires:   ${formatTimeRemaining(now + 5 * 60 * 1000)}`,
        ``,
        `Use get_messages with the rental ID to check for incoming verification codes.`,
      ].join("\n");

      return { content: [{ type: "text" as const, text }] };
    }
  );

  server.tool(
    "get_messages",
    "Check for incoming SMS messages on a rented number. Messages typically arrive within a few seconds.",
    {
      rentalId: z.string().describe("Rental ID returned from rent_number"),
    },
    async ({ rentalId }) => {
      const rental = state.smsRentals.get(rentalId);

      if (!rental) {
        return errorResponse(`Rental not found: ${rentalId}`);
      }

      if (rental.status === "active" && Date.now() >= rental.expiry) {
        rental.status = "expired";
      }

      if (rental.status === "expired") {
        return errorResponse(`Rental ${rentalId} has expired.`);
      }

      if (rental.status === "cancelled") {
        return errorResponse(`Rental ${rentalId} has been cancelled.`);
      }

      // Lazy mock: generate a message after 5 seconds
      if (rental.messages.length === 0) {
        const elapsed = Date.now() - rental.createdAt;

        if (elapsed < 5000) {
          const text = [
            `No messages yet for ${rental.number} (${rental.service}).`,
            ``,
            `Waiting for verification code... try again shortly.`,
            `Time since rental: ${Math.floor(elapsed / 1000)}s`,
          ].join("\n");

          return { content: [{ type: "text" as const, text }] };
        }

        const code = generateVerificationCode();
        rental.messages.push({
          from: rental.service,
          text: `Your ${rental.service} verification code is: ${code}`,
          receivedAt: Date.now(),
        });
      }

      let text = `Messages for ${rental.number} (${rental.service}):\n\n`;
      for (const msg of rental.messages) {
        const time = new Date(msg.receivedAt).toISOString().slice(11, 19);
        text += `  [${time}] From: ${msg.from}\n`;
        text += `  ${msg.text}\n\n`;
      }

      return { content: [{ type: "text" as const, text }] };
    }
  );

  server.tool(
    "cancel_rental",
    "Cancel an SMS rental. Refunds the full price only if no messages were received.",
    {
      rentalId: z.string().describe("Rental ID to cancel"),
    },
    async ({ rentalId }) => {
      const rental = state.smsRentals.get(rentalId);

      if (!rental) {
        return errorResponse(`Rental not found: ${rentalId}`);
      }

      if (rental.status !== "active") {
        return errorResponse(`Rental ${rentalId} is ${rental.status} and cannot be cancelled.`);
      }

      rental.status = "cancelled";

      if (rental.messages.length === 0) {
        state.addBalance(rental.price, "refund", `Refund: ${rental.service} rental (US)`);

        const text = [
          `Rental ${rentalId} cancelled.`,
          ``,
          `  Refund: ${formatUsd(rental.price)} (no messages received)`,
          `  New balance: ${formatUsd(state.balance)}`,
        ].join("\n");

        return { content: [{ type: "text" as const, text }] };
      }

      const text = [
        `Rental ${rentalId} cancelled.`,
        ``,
        `  No refund — messages were already received.`,
      ].join("\n");

      return { content: [{ type: "text" as const, text }] };
    }
  );
}
