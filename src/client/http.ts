import { makeDebugLogger } from "./debug.js";

const TIMEOUT_MS = 30_000;
const GET_RETRIES = 2;
const RETRY_DELAY_MS = 250;

export interface HttpResponse {
  status: number;
  body?: unknown;
  binary?: Buffer;
  headers: Headers;
}

export interface HttpRequestOpts {
  body?: unknown;
  idempotencyKey?: string;
  headers?: Record<string, string>;
  expectBinary?: boolean;
}

export interface HttpClient {
  request(
    method: string,
    path: string,
    opts?: HttpRequestOpts,
  ): Promise<HttpResponse>;
}

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    public requestId: string,
    public details?: Record<string, unknown>,
    message?: string,
  ) {
    super(message ?? `${code} (status ${status})`);
    this.name = "HttpError";
  }
}

export class NetworkError extends Error {
  constructor(public cause: unknown) {
    super("Network error reaching the VoidMob API");
    this.name = "NetworkError";
  }
}

interface ClientOpts {
  apiKey: string;
  baseUrl: string;
  debug: boolean;
  userAgent: string;
}

function jitter(): number {
  return Math.random() * 100;
}

export function createHttpClient(opts: ClientOpts): HttpClient {
  const dbg = makeDebugLogger(opts.debug);

  async function doOnce(method: string, path: string, ropts: HttpRequestOpts): Promise<HttpResponse> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
    const headers = new Headers({
      Authorization: `Bearer ${opts.apiKey}`,
      "User-Agent": opts.userAgent,
      "Content-Type": "application/json",
      ...(ropts.headers ?? {}),
    });
    if (ropts.idempotencyKey) headers.set("Idempotency-Key", ropts.idempotencyKey);

    const startMs = Date.now();
    let res: Response;
    try {
      res = (await fetch(`${opts.baseUrl}${path}`, {
        method,
        headers,
        body: ropts.body !== undefined ? JSON.stringify(ropts.body) : undefined,
        signal: ac.signal,
      })) as Response;
    } catch (e) {
      clearTimeout(timer);
      throw new NetworkError(e);
    }
    clearTimeout(timer);

    const elapsed = Date.now() - startMs;

    if (ropts.expectBinary && res.status >= 200 && res.status < 300) {
      const ab = await res.arrayBuffer();
      dbg(`${method} ${path} ${res.status} (${elapsed}ms) [binary ${ab.byteLength}b]`);
      return { status: res.status, binary: Buffer.from(ab), headers: res.headers };
    }

    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = undefined;
    }

    const idem = ropts.idempotencyKey ? ` idem=${ropts.idempotencyKey.slice(0, 8)}...` : "";
    const codeOrEmpty =
      body && typeof body === "object" && "error" in body
        ? ` ${(body as { error: { code: string } }).error.code}`
        : "";
    dbg(`${method} ${path}${idem} ${res.status}${codeOrEmpty} (${elapsed}ms)`);

    if (res.status >= 200 && res.status < 300) {
      return { status: res.status, body, headers: res.headers };
    }

    const errBody = (body as {
      error?: { code: string; message: string; request_id: string; details?: Record<string, unknown> };
    } | undefined)?.error;
    throw new HttpError(
      res.status,
      errBody?.code ?? "UNKNOWN_ERROR",
      errBody?.request_id ?? "",
      errBody?.details,
      errBody?.message,
    );
  }

  return {
    async request(method, path, ropts = {}) {
      const isGet = method.toUpperCase() === "GET";
      const maxAttempts = isGet ? 1 + GET_RETRIES : 1;
      let lastErr: unknown;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          return await doOnce(method, path, ropts);
        } catch (e) {
          lastErr = e;
          if (!isGet) throw e;
          if (e instanceof HttpError) {
            // Retry only on 5xx; never on 429 or 4xx
            if (e.status < 500) throw e;
          } else if (!(e instanceof NetworkError)) {
            throw e;
          }
          if (attempt < maxAttempts) {
            await new Promise((r) => setTimeout(r, RETRY_DELAY_MS + jitter()));
          }
        }
      }
      throw lastErr;
    },
  };
}
