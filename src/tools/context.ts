import type { McpServer, ToolAnnotations } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { HttpClient } from "../client/http.js";
import { DEFAULT_CONTROLS, type OwnerControls, type Toolset } from "../config.js";
import { SpendGuard } from "../controls/spend-guard.js";
import type { ToolExtra, ToolResult } from "../utils/render.js";

/**
 * What an action needs on the API key: view (reads), manage (changes that do
 * not spend) or buy (every charge). The API enforces the same levels.
 */
export type PermissionLevel = "view" | "manage" | "buy";

const RANK: Record<PermissionLevel, number> = { view: 0, manage: 1, buy: 2 };

/** Whether a server at level `have` may do something that needs `need`. */
export function levelAllows(have: PermissionLevel, need: PermissionLevel): boolean {
  return RANK[have] >= RANK[need];
}

/** Everything a tool needs: the API client plus the owner's controls. */
export interface ToolContext {
  http: HttpClient;
  guard: SpendGuard;
  /** The highest level this server acts at; VOIDMOB_READ_ONLY=1 means view. */
  level: PermissionLevel;
  toolsets: ReadonlySet<Toolset>;
}

export function createToolContext(http: HttpClient, controls: OwnerControls = DEFAULT_CONTROLS): ToolContext {
  return {
    http,
    guard: new SpendGuard({ maxOrderCents: controls.maxOrderCents, budgetCents: controls.budgetCents }),
    level: controls.readOnly ? "view" : "buy",
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
  /**
   * The highest level any API call the tool can make needs. A tool is not
   * registered on a server whose level is lower.
   */
  level: PermissionLevel;
  title: string;
  description: string;
  inputSchema: z.ZodRawShape;
  outputSchema: z.ZodType;
  annotations: ToolAnnotations;
}

type Handler = (args: never, extra: ToolExtra) => Promise<ToolResult>;

/**
 * Register a tool unless the owner's controls leave it out: tools above the
 * server's level, and tools outside the selected toolsets. Returns whether it
 * was registered.
 */
export function defineTool(server: McpServer, ctx: ToolContext, name: string, spec: ToolSpec, handler: Handler): boolean {
  if (!levelAllows(ctx.level, spec.level)) return false;
  const groups = Array.isArray(spec.group) ? spec.group : [spec.group];
  if (!groups.some((g) => g === "core" || ctx.toolsets.has(g))) return false;
  server.registerTool(
    name,
    {
      title: spec.title,
      description: spec.description,
      inputSchema: z.object(spec.inputSchema),
      // The SDK types outputSchema as an object schema; every VoidMob output
      // schema is a loose zod object (see utils/output.ts).
      outputSchema: spec.outputSchema as never,
      annotations: spec.annotations,
    },
    handler as never,
  );
  return true;
}
