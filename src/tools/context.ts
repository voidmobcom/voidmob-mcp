import type { McpServer, ToolAnnotations } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { HttpClient } from "../client/http.js";
import { DEFAULT_CONTROLS, type OwnerControls, type Toolset } from "../config.js";
import { depositUrlFor, settingsUrlFor, type Connection, type PermissionLevel } from "../connection.js";
import { SpendGuard } from "../controls/spend-guard.js";
import type { ToolExtra, ToolResult } from "../utils/render.js";

export type { PermissionLevel } from "../connection.js";

const RANK: Record<PermissionLevel, number> = { view: 0, manage: 1, buy: 2 };

/** Whether a server at level `have` may do something that needs `need`. */
export function levelAllows(have: PermissionLevel, need: PermissionLevel): boolean {
  return RANK[have] >= RANK[need];
}

/** Everything a tool needs: the API client, the owner's controls and the key's settings. */
export interface ToolContext {
  http: HttpClient;
  guard: SpendGuard;
  /**
   * The highest level this server acts at: the lower of the API key's or app
   * connection's permission and the local controls (VOIDMOB_READ_ONLY=1 means view).
   */
  level: PermissionLevel;
  toolsets: ReadonlySet<Toolset>;
  /** The key's or app connection's settings from /v1/me, or null when unknown. */
  connection: Connection | null;
  /** VOIDMOB_READ_ONLY=1: the owner lowered this server to View in its configuration. */
  localReadOnly: boolean;
  /** VOIDMOB_AUTONOMOUS=1, accepted because a limit is set (session budget or the key's daily limit). */
  localAutoMode: boolean;
  /** Auto-mode in force (the key's or connection's, or the local flag): only the instructions change. */
  autoMode: boolean;
  /** Where the user adds funds. */
  depositUrl: string;
  /** Where the account owner changes the key's or connection's permission and limits. */
  settingsUrl: string;
  /** Served over HTTP at mcp.voidmob.com rather than run locally over stdio. */
  hosted: boolean;
}

/** How the server is run. */
export interface ServeOptions {
  /** Served over HTTP at mcp.voidmob.com: shorter SMS waits, and error texts that speak of the app's connection. */
  hosted?: boolean;
}

export function createToolContext(
  http: HttpClient,
  controls: OwnerControls = DEFAULT_CONTROLS,
  connection: Connection | null = null,
  options: ServeOptions = {},
): ToolContext {
  const keyDailyLimit = connection?.dailyLimitCents ?? null;
  const localAutoMode = controls.autonomous && (controls.budgetCents !== null || keyDailyLimit !== null);
  return {
    http,
    guard: new SpendGuard({ maxOrderCents: controls.maxOrderCents, budgetCents: controls.budgetCents }),
    // VOIDMOB_READ_ONLY is View, the lowest level, so it always wins.
    level: controls.readOnly ? "view" : connection?.permission ?? "buy",
    toolsets: controls.toolsets,
    connection,
    localReadOnly: controls.readOnly,
    localAutoMode,
    autoMode: connection?.autoMode === true || localAutoMode,
    depositUrl: depositUrlFor(connection),
    settingsUrl: settingsUrlFor(connection),
    hosted: options.hosted === true,
  };
}

/** A context with no limits, for handler-level tests and callers that do not need controls. */
export function toolContext(http: HttpClient, controls: Partial<OwnerControls> = {}, connection: Connection | null = null): ToolContext {
  return createToolContext(http, { ...DEFAULT_CONTROLS, ...controls }, connection);
}

/** Where the server's level is set: this server's configuration, or the key's settings page. */
export function levelSetAt(ctx: ToolContext): string {
  return ctx.localReadOnly
    ? "in this MCP server's configuration (VOIDMOB_READ_ONLY)"
    : `at ${ctx.settingsUrl}`;
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
