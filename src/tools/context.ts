import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";
import type { HttpClient } from "../client/http.js";
import { DEFAULT_CONTROLS, type OwnerControls, type Toolset } from "../config.js";
import { SpendGuard } from "../controls/spend-guard.js";
import type { ToolExtra, ToolResult } from "../utils/render.js";

/** Everything a tool needs: the API client plus the owner's controls. */
export interface ToolContext {
  http: HttpClient;
  guard: SpendGuard;
  readOnly: boolean;
  toolsets: ReadonlySet<Toolset>;
}

export function createToolContext(http: HttpClient, controls: OwnerControls = DEFAULT_CONTROLS): ToolContext {
  return {
    http,
    guard: new SpendGuard({ maxOrderCents: controls.maxOrderCents, budgetCents: controls.budgetCents }),
    readOnly: controls.readOnly,
    toolsets: controls.toolsets,
  };
}

/** A context with no limits, for handler-level tests and callers that do not need controls. */
export function toolContext(http: HttpClient, controls: Partial<OwnerControls> = {}): ToolContext {
  return createToolContext(http, { ...DEFAULT_CONTROLS, ...controls });
}

export interface ToolSpec {
  /** "core" tools (account, orders, geo) are always registered. */
  group: Toolset | "core" | Toolset[];
  /** Spends money or changes anything: never registered in read-only mode. */
  writes: boolean;
  title: string;
  description: string;
  inputSchema: z.ZodRawShape;
  outputSchema: z.ZodType;
  annotations: ToolAnnotations;
}

type Handler = (args: never, extra: ToolExtra) => Promise<ToolResult>;

/**
 * Register a tool unless the owner's controls leave it out: write tools in
 * read-only mode, and tools outside the selected toolsets. Returns whether it
 * was registered.
 */
export function defineTool(server: McpServer, ctx: ToolContext, name: string, spec: ToolSpec, handler: Handler): boolean {
  if (spec.writes && ctx.readOnly) return false;
  const groups = Array.isArray(spec.group) ? spec.group : [spec.group];
  if (!groups.some((g) => g === "core" || ctx.toolsets.has(g))) return false;
  server.registerTool(
    name,
    {
      title: spec.title,
      description: spec.description,
      inputSchema: spec.inputSchema,
      // The SDK types outputSchema as an object schema; every VoidMob output
      // schema is a loose zod object (see utils/output.ts).
      outputSchema: spec.outputSchema as never,
      annotations: spec.annotations,
    },
    handler as never,
  );
  return true;
}
