import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHttpClient, HttpError, NetworkError } from "../../src/client/http.js";

describe("createHttpClient", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

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
  // ── writes: one same-key retry on a network error, nothing else ──────────

  const client = () => createHttpClient({ apiKey: "k", baseUrl: "https://x", debug: false, userAgent: "ua" });
  const envelopeErr = (status: number, code: string, headers: Record<string, string> = {}) =>
    jsonResponse(status, { success: false, error: { code, message: code, request_id: "req_w" } }, headers);

  it("retries a write with an Idempotency-Key once on a network error, reusing the SAME key and body", async () => {
    vi.useFakeTimers();
    fetchMock
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(jsonResponse(201, { success: true, data: { verification: { id: "ver_1" } } }));
    const p = client().request("POST", "/v1/verifications", { body: { service_id: "svc_tg", max_price_cents: 35 }, idempotencyKey: "key-123" });
    await vi.advanceTimersByTimeAsync(2_000);
    const res = await p;
    expect(res.status).toBe(201);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, first] = fetchMock.mock.calls[0];
    const [, second] = fetchMock.mock.calls[1];
    expect(first.headers.get("Idempotency-Key")).toBe("key-123");
    expect(second.headers.get("Idempotency-Key")).toBe("key-123");
    expect(second.body).toBe(first.body);
  });

  it("never retries a write a second time: two network errors surface as a write NetworkError", async () => {
    vi.useFakeTimers();
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    const p = client().request("POST", "/v1/esims", { body: {}, idempotencyKey: "key-2" });
    const assertion = expect(p).rejects.toMatchObject({ name: "NetworkError", method: "POST" });
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry a write on 4xx", async () => {
    fetchMock.mockResolvedValueOnce(envelopeErr(402, "INSUFFICIENT_BALANCE"));
    await expect(client().request("POST", "/v1/esims", { body: {}, idempotencyKey: "key-3" })).rejects.toMatchObject({ code: "INSUFFICIENT_BALANCE" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry a write on 5xx (the API stores it as the key's outcome)", async () => {
    fetchMock.mockResolvedValueOnce(envelopeErr(500, "INTERNAL_ERROR"));
    await expect(client().request("POST", "/v1/esims", { body: {}, idempotencyKey: "key-4" })).rejects.toMatchObject({ status: 500, meta: { method: "POST" } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry a write that carries no Idempotency-Key", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    await expect(client().request("POST", "/v1/proxies/prx_1/rotate_ip")).rejects.toBeInstanceOf(NetworkError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("surfaces IDEMPOTENCY_REPLAY_IN_FLIGHT from the retry with its Retry-After, without retrying again", async () => {
    vi.useFakeTimers();
    fetchMock
      .mockRejectedValueOnce(new TypeError("socket hang up"))
      .mockResolvedValueOnce(envelopeErr(409, "IDEMPOTENCY_REPLAY_IN_FLIGHT", { "Retry-After": "5" }));
    const p = client().request("POST", "/v1/proxies", { body: {}, idempotencyKey: "key-5" });
    const assertion = expect(p).rejects.toMatchObject({ code: "IDEMPOTENCY_REPLAY_IN_FLIGHT", meta: { method: "POST", retryAfterSeconds: 5 } });
    await vi.advanceTimersByTimeAsync(2_000);
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("the timeout also covers the body read: a stalled body aborts, then the same-key retry gets the stored response", async () => {
    vi.useFakeTimers();
    const stalledBody = (_url: string, init: RequestInit) =>
      Promise.resolve({
        status: 201,
        headers: new Headers({ "Content-Type": "application/json" }),
        json: () =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")));
          }),
      });
    fetchMock
      .mockImplementationOnce(stalledBody)
      .mockResolvedValueOnce(jsonResponse(201, { success: true, data: { esim: { id: "esim_1" } } }));
    const p = client().request("POST", "/v1/esims", { body: { product_id: "prod_1" }, idempotencyKey: "key-6" });
    await vi.advanceTimersByTimeAsync(29_000);
    expect(fetchMock).toHaveBeenCalledTimes(1); // still waiting on the body
    await vi.advanceTimersByTimeAsync(3_000); // write timeout (30s) fires, then the retry delay
    const res = await p;
    expect(res.body).toEqual({ success: true, data: { esim: { id: "esim_1" } } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][1].headers.get("Idempotency-Key")).toBe("key-6");
  });

  it("a stalled GET body times out as a NetworkError", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation((_url: string, init: RequestInit) =>
      Promise.resolve({
        status: 200,
        headers: new Headers(),
        json: () =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")));
          }),
      }),
    );
    const p = client().request("GET", "/v1/me");
    const assertion = expect(p).rejects.toMatchObject({ name: "NetworkError", method: "GET" });
    await vi.advanceTimersByTimeAsync(35_000);
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(3); // 1 + 2 GET retries
  });

  it("an empty or non-JSON body is still judged by its status, not treated as a network error", async () => {
    fetchMock.mockResolvedValueOnce({
      status: 502,
      headers: new Headers({ "Content-Type": "text/html" }),
      json: async () => { throw new SyntaxError("Unexpected token <"); },
    });
    await expect(client().request("POST", "/v1/esims", { body: {}, idempotencyKey: "key-7" })).rejects.toMatchObject({ name: "HttpError", status: 502, code: "UNKNOWN_ERROR" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("parses Retry-After into the error", async () => {
    fetchMock.mockResolvedValueOnce(envelopeErr(429, "RATE_LIMITED", { "Retry-After": "30" }));
    await expect(client().request("GET", "/v1/me")).rejects.toMatchObject({ code: "RATE_LIMITED", meta: { retryAfterSeconds: 30 } });
  });
});
