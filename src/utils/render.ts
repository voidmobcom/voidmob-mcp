import { ZodError } from "zod";
import { HttpError, NetworkError } from "../client/http.js";
import { mapApiError } from "../client/errors.js";

export interface ToolResult {
  // SDK CallToolResult includes a string index signature; mirroring it here lets
  // factory handlers be passed straight to server.tool() without a cast.
  [x: string]: unknown;
  content: Array<
    | { type: "text"; text: string }
    | { type: "image"; mimeType: string; data: string }
  >;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export function structuredOk(text: string, structured: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: "text", text }],
    structuredContent: structured,
  };
}

export function structuredWithImage(
  text: string,
  structured: Record<string, unknown>,
  image: { mimeType: string; base64: string },
): ToolResult {
  return {
    content: [
      { type: "text", text },
      { type: "image", mimeType: image.mimeType, data: image.base64 },
    ],
    structuredContent: structured,
  };
}

export function toolError(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

// Shared "  Messages (N):" block for resources that carry RentalMessage-shaped
// SMS lists (rentals, dedicated numbers). Returns lines to spread into a render.
export function renderMessages(messages: Array<{ code?: string | null; text: string; received_at: string }>): string[] {
  const lines = [``, `  Messages (${messages.length}):`];
  for (const m of messages) {
    lines.push(`    [${m.received_at.slice(11, 19)}] ${m.text}`);
    if (m.code) lines.push(`      Code: ${m.code}`);
  }
  return lines;
}

/**
 * Wrap a tool handler so error surfaces become clean, white-labeled tool
 * results instead of opaque protocol crashes:
 *  - HttpError / NetworkError -> agent-readable text via mapApiError.
 *  - ZodError (response shape we can't parse) -> a generic message that leaks
 *    no schema internals. The detail is logged to stderr only. We deliberately
 *    do NOT tell the caller to blindly retry: a money operation may have
 *    succeeded server-side even though we couldn't parse its response, so the
 *    caller should verify before re-running.
 *  - Anything else still propagates.
 */
export function wrapToolErrors<A, R extends ToolResult>(
  fn: (args: A) => Promise<R>,
): (args: A) => Promise<R | ToolResult> {
  return async (args: A) => {
    try {
      return await fn(args);
    } catch (e) {
      if (e instanceof HttpError || e instanceof NetworkError) {
        return toolError(mapApiError(e));
      }
      if (e instanceof ZodError) {
        process.stderr.write(`[voidmob-mcp] response schema mismatch: ${e.message}\n`);
        return toolError(
          "The API returned an unexpected response the client could not parse. " +
          "The operation may have completed - check your account or use list_orders / a get_* tool to verify before retrying.",
        );
      }
      throw e;
    }
  };
}
