import { randomUUID } from "node:crypto";

export function newIdempotencyKey(): string {
  return randomUUID();
}
