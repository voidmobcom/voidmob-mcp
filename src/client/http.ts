import { makeDebugLogger } from "./debug.js";

const GET_TIMEOUT_MS = 10_000;
const WRITE_TIMEOUT_MS = 30_000;
const GET_RETRIES = 2;
const RETRY_DELAY_MS = 250;
const WRITE_RETRY_DELAY_MS = 1_000;

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

export const isWriteMethod = (method: string | undefined): boolean =>
  method !== undefined && method.toUpperCase() !== "GET";

export interface HttpErrorMeta {
  /** Request method, so error copy can tell a failed write from a failed read. */
  method?: string;
  /** Parsed `Retry-After` response header, in seconds. */
  retryAfterSeconds?: number;
}

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    public requestId: string,
    public details?: Record<string, unknown>,
    message?: string,
    public meta: HttpErrorMeta = {},
  ) {
    super(message ?? `${code} (status ${status})`);
    this.name = "HttpError";
  }
}

/** No verdict came back from the API (connection failure, timeout, broken body). */
export class NetworkError extends Error {
  constructor(public cause: unknown, public method = "GET") {
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

export function parseRetryAfter(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds) : undefined;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function createHttpClient(opts: ClientOpts): HttpClient {
  const dbg = makeDebugLogger(opts.debug);

  async function doOnce(method: string, path: string, ropts: HttpRequestOpts): Promise<HttpResponse> {
    const ac = new AbortController();
    const timeoutMs = method.toUpperCase() === "GET" ? GET_TIMEOUT_MS : WRITE_TIMEOUT_MS;
    // The timer stays armed until the body has been read: a response whose
    // headers arrive but whose body stalls is aborted too.
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
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
        throw new NetworkError(e, method);
      }

      if (ropts.expectBinary && res.status >= 200 && res.status < 300) {
        let ab: ArrayBuffer;
        try {
          ab = await res.arrayBuffer();
        } catch (e) {
          throw new NetworkError(e, method);
        }
        dbg(`${method} ${path} ${res.status} (${Date.now() - startMs}ms) [binary ${ab.byteLength}b]`);
        return { status: res.status, binary: Buffer.from(ab), headers: res.headers };
      }

      let body: unknown;
      try {
        body = await res.json();
      } catch (e) {
        // An empty or non-JSON body is a response we can still judge by its
        // status. Anything else (abort, broken stream) means no verdict.
        if (!(e instanceof SyntaxError)) throw new NetworkError(e, method);
        body = undefined;
      }
      const elapsed = Date.now() - startMs;

      const idem = ropts.idempotencyKey ? ` idem=${ropts.idempotencyKey.slice(0, 8)}...` : "";
      const errObj =
        body && typeof body === "object" && "error" in body
          ? (body as Record<string, unknown>).error
          : undefined;
      const codeOrEmpty =
        errObj && typeof errObj === "object" && "code" in errObj &&
        typeof (errObj as Record<string, unknown>).code === "string"
          ? ` ${(errObj as { code: string }).code}`
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
        { method, retryAfterSeconds: parseRetryAfter(res.headers.get("Retry-After")) },
      );
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async request(method, path, ropts = {}) {
      const isGet = method.toUpperCase() === "GET";
      // GETs: up to 2 retries on a network error or 5xx (reads are safe to repeat).
      //
      // Writes: only a write that carries an Idempotency-Key is retried, only on
      // a NetworkError (no verdict reached us), and only once - with the SAME
      // key and body (`ropts` is reused as-is). The API then either replays the
      // stored outcome of the first attempt (charged at most once), answers
      // IDEMPOTENCY_REPLAY_IN_FLIGHT when that attempt is still running or was
      // abandoned mid-way (surfaced as "check before buying again"), or runs
      // the request for the first time if the first attempt never arrived.
      //
      // An HTTP status is a verdict and is never retried for writes: 4xx is
      // final, and an API 5xx is stored as the key's completed outcome, so a
      // same-key replay returns the identical 5xx (no gain) while a fresh key
      // could charge twice.
      const maxAttempts = isGet ? 1 + GET_RETRIES : ropts.idempotencyKey ? 2 : 1;
      let lastErr: unknown;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          return await doOnce(method, path, ropts);
        } catch (e) {
          lastErr = e;
          const retryable = isGet
            ? e instanceof NetworkError || (e instanceof HttpError && e.status >= 500)
            : e instanceof NetworkError;
          if (!retryable || attempt === maxAttempts) throw e;
          await sleep(isGet ? RETRY_DELAY_MS + jitter() : WRITE_RETRY_DELAY_MS + Math.random() * 500);
        }
      }
      throw lastErr;
    },
  };
}
