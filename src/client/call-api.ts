// src/client/call-api.ts
import { HttpClient, HttpError } from "./http.js";

interface SuccessEnvelope<T> { success: true; data: T }
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

export async function callApi<T>(
  http: HttpClient,
  method: string,
  path: string,
  opts?: { body?: unknown; idempotencyKey?: string },
): Promise<T> {
  const res = await http.request(method, path, opts);
  const env = res.body as ApiEnvelope<T>;
  if (env && env.success === true) return env.data;
  // The real http client already throws HttpError on non-2xx. This branch
  // covers (a) mock-http test clients that return error envelopes directly
  // and (b) any 2xx response that nonetheless carries success:false.
  if (env && env.success === false) {
    throw new HttpError(
      res.status,
      env.error.code,
      env.error.request_id,
      env.error.details,
      env.error.message,
    );
  }
  throw new HttpError(res.status, "UNKNOWN_ERROR", "", undefined, "Unexpected response shape");
}
