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
