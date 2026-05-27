import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHttpClient, HttpError, NetworkError } from "../../src/client/http.js";

describe("createHttpClient", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });
  afterEach(() => vi.restoreAllMocks());

  function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
    return {
      status,
      headers: new Headers({ "Content-Type": "application/json", ...headers }),
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  }

  it("attaches Authorization, User-Agent, JSON Content-Type", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { success: true, data: { ok: true } }));
    const c = createHttpClient({ apiKey: "vmk_live_test", baseUrl: "https://x", debug: false, userAgent: "voidmob-mcp/test" });
    await c.request("GET", "/v1/me");
    const [_url, init] = fetchMock.mock.calls[0];
    expect(init.headers.get("Authorization")).toBe("Bearer vmk_live_test");
    expect(init.headers.get("User-Agent")).toBe("voidmob-mcp/test");
    expect(init.headers.get("Content-Type")).toBe("application/json");
  });

  it("adds Idempotency-Key when opts.idempotencyKey is set", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(201, { success: true, data: {} }));
    const c = createHttpClient({ apiKey: "k", baseUrl: "https://x", debug: false, userAgent: "ua" });
    await c.request("POST", "/v1/verifications", { body: { a: 1 }, idempotencyKey: "abc-123" });
    const [_url, init] = fetchMock.mock.calls[0];
    expect(init.headers.get("Idempotency-Key")).toBe("abc-123");
  });

  it("returns parsed body on 2xx", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { success: true, data: { id: 42 } }));
    const c = createHttpClient({ apiKey: "k", baseUrl: "https://x", debug: false, userAgent: "ua" });
    const res = await c.request("GET", "/v1/me");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: { id: 42 } });
  });

  it("throws HttpError with code on 4xx envelope", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(401, {
      success: false,
      error: { code: "UNAUTHENTICATED", message: "Authentication required.", request_id: "req_x", docs_url: "https://docs/x" },
    }));
    const c = createHttpClient({ apiKey: "k", baseUrl: "https://x", debug: false, userAgent: "ua" });
    await expect(c.request("GET", "/v1/me")).rejects.toMatchObject({
      name: "HttpError",
      status: 401,
      code: "UNAUTHENTICATED",
      requestId: "req_x",
    });
  });

  it("retries GET 2x on 5xx then surfaces last error", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(500, { success: false, error: { code: "INTERNAL_ERROR", message: "", request_id: "r", docs_url: "" } }))
      .mockResolvedValueOnce(jsonResponse(500, { success: false, error: { code: "INTERNAL_ERROR", message: "", request_id: "r", docs_url: "" } }))
      .mockResolvedValueOnce(jsonResponse(500, { success: false, error: { code: "INTERNAL_ERROR", message: "", request_id: "r", docs_url: "" } }));
    const c = createHttpClient({ apiKey: "k", baseUrl: "https://x", debug: false, userAgent: "ua" });
    await expect(c.request("GET", "/v1/me")).rejects.toMatchObject({ status: 500 });
    expect(fetchMock).toHaveBeenCalledTimes(3); // 1 + 2 retries
  });

  it("does NOT retry POST", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(500, { success: false, error: { code: "INTERNAL_ERROR", message: "", request_id: "r", docs_url: "" } }));
    const c = createHttpClient({ apiKey: "k", baseUrl: "https://x", debug: false, userAgent: "ua" });
    await expect(c.request("POST", "/v1/x", { body: {} })).rejects.toMatchObject({ status: 500 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry 429", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(429, { success: false, error: { code: "RATE_LIMITED", message: "", request_id: "r", docs_url: "" } }, { "Retry-After": "30" }));
    const c = createHttpClient({ apiKey: "k", baseUrl: "https://x", debug: false, userAgent: "ua" });
    await expect(c.request("GET", "/v1/me")).rejects.toMatchObject({ code: "RATE_LIMITED" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws NetworkError on fetch failure", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    const c = createHttpClient({ apiKey: "k", baseUrl: "https://x", debug: false, userAgent: "ua" });
    await expect(c.request("POST", "/v1/x", { body: {} })).rejects.toBeInstanceOf(NetworkError);
  });

  it("returns binary body when expectBinary=true", async () => {
    const buf = new Uint8Array([1, 2, 3]);
    fetchMock.mockResolvedValueOnce({
      status: 200,
      headers: new Headers({ "Content-Type": "image/png" }),
      arrayBuffer: async () => buf.buffer,
    });
    const c = createHttpClient({ apiKey: "k", baseUrl: "https://x", debug: false, userAgent: "ua" });
    const res = await c.request("GET", "/v1/esims/x/qr.png", { expectBinary: true });
    expect(res.binary).toBeInstanceOf(Buffer);
    expect((res.binary as Buffer).length).toBe(3);
  });

  it("wraps arrayBuffer errors as NetworkError on binary path", async () => {
    const brokenBinaryResponse = () => ({
      status: 200,
      headers: new Headers({ "Content-Type": "image/png" }),
      arrayBuffer: async () => { throw new TypeError("stream broken"); },
    });
    // GET retries NetworkError up to 3 attempts total - mock all of them
    fetchMock
      .mockResolvedValueOnce(brokenBinaryResponse())
      .mockResolvedValueOnce(brokenBinaryResponse())
      .mockResolvedValueOnce(brokenBinaryResponse());
    const c = createHttpClient({ apiKey: "k", baseUrl: "https://x", debug: false, userAgent: "ua" });
    await expect(c.request("GET", "/v1/esims/x/qr.png", { expectBinary: true })).rejects.toBeInstanceOf(NetworkError);
  });

  it("debug log does not crash on malformed error envelope shapes", async () => {
    // {error: null} shape
    fetchMock.mockResolvedValueOnce({
      status: 500,
      headers: new Headers({ "Content-Type": "application/json" }),
      json: async () => ({ success: false, error: null }),
    });
    const c = createHttpClient({ apiKey: "k", baseUrl: "https://x", debug: true, userAgent: "ua" });
    // Should throw HttpError, not blow up trying to read .code
    await expect(c.request("POST", "/v1/x", { body: {} })).rejects.toBeInstanceOf(Error);
  });
});
