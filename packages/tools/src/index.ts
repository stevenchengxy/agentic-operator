/**
 * @agentic/tools — first-party tool implementations + global registry.
 *
 * Two surfaces:
 *
 *  1. **Global tool registry** (the canonical, configuration-driven surface) —
 *     `globalToolRegistry: Map<string, ToolDescriptor>` and
 *     `listGlobalTools(): ToolCatalogEntry[]` from `./registry`.
 *     Any agent in any tenant can reference these tools by name in its
 *     manifest's `tool_use[]`; no code change needed per tenant. Per-tenant
 *     configuration (API keys, paths) flows through `tool_use[].config`
 *     into `ctx.config`.
 *
 *  2. **Legacy `runTool` fallback** (kept for back-compat) — the original
 *     mock dispatcher used by `type: "tool"` manifest actions that don't
 *     have an explicit tool binding. Returns canned responses so legacy
 *     workflows still execute even without real implementations. New work
 *     should use the global registry; this section will be removed once
 *     all `type: "tool"` actions migrate to named tools.
 */

// ─── (1) global registry — canonical surface ───────────────────────────────

export {
  globalToolRegistry,
  listGlobalTools,
  type ToolCatalogEntry,
} from "./registry";

// ─── declarative HTTP tools (Phase 2 Tier A) — make brain-authored tools runtime-invocable ──
export {
  makeDeclarativeTool,
  buildDeclarativeOverlay,
  type DeclarativeToolDef,
  type MakeDeclarativeToolOpts,
} from "./declarative/http-tool";
export { isPrivateHost, assertPublicUrl, safeFetch } from "./declarative/ssrf";

// Re-export the category sub-packages so external consumers can import
// the descriptors directly when they want (e.g. for tests).
export * as robohire from "./robohire";
export * as fs from "./fs";
export * as http from "./http";
export * as meta from "./meta";
export * as ontology from "./ontology";
export * as records from "./records";
export * as viz from "./viz";
export * as report from "./report";

// Named exports for server-side (non-tool) reuse — the report pipeline in
// apps/api renders charts + prints PDFs through these directly.
export { renderSvgChart, type SvgChartSpec, type ChartDatum } from "./viz";
export { htmlToPdf, htmlFileToPdf, findChrome, reportArchiveDir } from "./report";

// ─── (2) legacy runTool fallback — used by step-engine's type:"tool" path ──

export interface ToolContext {
  agentName: string;
  actionName: string;
  subject?: string;
  correlationId: string;
}

export interface ToolResult<T = unknown> {
  ok: boolean;
  data: T;
  meta?: Record<string, unknown>;
}

export type ToolName = "http.fetch" | "channel.publish";

/**
 * Mock dispatcher kept for back-compat with `type: "tool"` actions that
 * don't have an explicit tool binding. See module-level docs above.
 */
export async function runTool(
  ctx: ToolContext,
  hintFromName?: string,
): Promise<ToolResult> {
  const tool = guessTool(hintFromName ?? ctx.actionName);
  switch (tool) {
    case "http.fetch":
      return httpFetch(ctx, { url: `https://mock.invalid/${ctx.actionName}` });
    case "channel.publish":
      return channelPublish(ctx, {
        channel: "mock",
        payload: { actionName: ctx.actionName },
      });
  }
}

export async function httpFetch(
  _ctx: ToolContext,
  args: { url: string; method?: string; body?: unknown },
): Promise<ToolResult<{ status: number; body: unknown }>> {
  await delay(120 + jitter(80));
  return {
    ok: true,
    data: { status: 200, body: { mock: true, echoed: args } },
    meta: { tool: "http.fetch" },
  };
}

export async function channelPublish(
  _ctx: ToolContext,
  args: { channel: string; payload: unknown },
): Promise<ToolResult<{ delivered: boolean; channel: string }>> {
  await delay(180 + jitter(120));
  return {
    ok: true,
    data: { delivered: true, channel: args.channel },
    meta: { tool: "channel.publish" },
  };
}

function guessTool(name: string): ToolName {
  const low = name.toLowerCase();
  if (low.includes("publish") || low.includes("notify") || low.includes("alert"))
    return "channel.publish";
  return "http.fetch";
}

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
function jitter(max: number) {
  return Math.floor(Math.random() * max);
}
