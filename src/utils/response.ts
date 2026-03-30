export function errorResponse(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
  };
}

export function textResponse(text: string) {
  return {
    content: [{ type: "text" as const, text }],
  };
}
