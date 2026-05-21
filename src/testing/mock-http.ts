import type { HttpClient, HttpResponse } from "../client/http.js";

interface Expectation {
  method: string;
  path: string;
  respond: HttpResponse;
}

export interface MockHttpClient extends HttpClient {
  expect(method: string, path: string, respond: HttpResponse): void;
  history: Array<{ method: string; path: string; body?: unknown; headers: Record<string, string> }>;
}

export function createMockHttpClient(): MockHttpClient {
  const queue: Expectation[] = [];
  const history: MockHttpClient["history"] = [];

  const client: MockHttpClient = {
    history,
    expect(method, path, respond) {
      queue.push({ method, path, respond });
    },
    async request(method, path, opts) {
      const recordedHeaders = (opts?.headers as Record<string, string>) ?? {};
      history.push({ method, path, body: opts?.body, headers: recordedHeaders });
      const exp = queue.shift();
      if (!exp) throw new Error(`No expectation for ${method} ${path}`);
      if (exp.method !== method || exp.path !== path) {
        throw new Error(`Expected ${exp.method} ${exp.path}, got ${method} ${path}`);
      }
      return exp.respond;
    },
  };
  return client;
}
