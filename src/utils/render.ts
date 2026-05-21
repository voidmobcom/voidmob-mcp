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

export function textBlock(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
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

/**
 * Wrap a tool handler so HttpError + NetworkError surfaces are translated to
 * agent-readable text via mapApiError. Unknown throws still propagate.
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
      throw e;
    }
  };
}
