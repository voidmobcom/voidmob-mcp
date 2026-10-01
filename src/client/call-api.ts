import { HttpClient, HttpError, HttpResponse, parseRetryAfter } from "./http.js";

interface SuccessEnvelope<T> { success: true; data: T; next_cursor?: unknown }
interface ErrorEnvelope {
  success: false;
  error: {
    code: string;
    message: string;
    request_id: string;
    details?: Record<string, unknown>;
  };
}
type ApiEnvelope<T> = SuccessEnvelope<T> | ErrorEnvelope;

/** The success envelope of a response, or the HttpError it carries. */
function unwrap<T>(res: HttpResponse, method: string): SuccessEnvelope<T> {
  const env = res.body as ApiEnvelope<T> | undefined;
  if (env && env.success === true) return env;
  const meta = { method, retryAfterSeconds: parseRetryAfter(res.headers?.get("Retry-After")) };
  // Handles mock test clients and 2xx responses carrying success:false.
  if (env && env.success === false) {
    throw new HttpError(
      res.status,
      env.error.code,
      env.error.request_id,
      env.error.details,
      env.error.message ?? env.error.code,
      meta,
    );
  }
  throw new HttpError(res.status, "UNKNOWN_ERROR", "", undefined, "Unexpected response shape", meta);
}

export async function callApi<T>(
  http: HttpClient,
  method: string,
  path: string,
  opts?: { body?: unknown; idempotencyKey?: string },
): Promise<T> {
  const res = await http.request(method, path, opts);
  // 204 No Content (e.g. DELETE proxy list) is a success with no body.
  if (res.status === 204) return undefined as T;
  return unwrap<T>(res, method).data;
}

/**
 * GET a list endpoint whose pagination fields sit next to `data` in the
 * envelope (`{ success, data: [...], has_more, next_cursor }`): verifications,
 * rentals and dedicated numbers.
 */
export async function callApiPage<T>(http: HttpClient, path: string): Promise<{ data: T; nextCursor: string | null }> {
  const env = unwrap<T>(await http.request("GET", path), "GET");
  return { data: env.data, nextCursor: typeof env.next_cursor === "string" && env.next_cursor ? env.next_cursor : null };
}
