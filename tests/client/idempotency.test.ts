import { describe, it, expect } from "vitest";
import { newIdempotencyKey } from "../../src/client/idempotency.js";

describe("newIdempotencyKey", () => {
  it("returns a UUIDv4-shaped string", () => {
    const k = newIdempotencyKey();
    expect(k).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("returns a different value each call", () => {
    expect(newIdempotencyKey()).not.toBe(newIdempotencyKey());
  });
});
