import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

// Explicit hint booleans on every tool so hosts can auto-approve reads and ask
// for confirmation on anything that spends or releases something.
// openWorldHint marks calls that move money or allocate real-world resources
// (numbers, eSIM profiles, modems); reads and edits of the account's own
// VoidMob data are closed-world.

/** Side-effect-free read. */
export const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

/** Debits the balance for a new resource or period. Irreversible spend - confirm first. */
export const SPENDS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};
