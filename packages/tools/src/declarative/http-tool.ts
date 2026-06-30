// Phase 2 Tier A — the EXECUTOR for brain-authored declarative HTTP tools. The factory's
// create_tool persists a factory_tools row (name / method / urlTemplate / headers / bodyTemplate /
// returnsSchema); DrizzleToolStore loads it; this turns each row into a runtime-invocable,
// SSRF-guarded ToolDescriptor. Folding the result into the runtime resolution chain (per-tenant
// overlay) is what finally lets a deployed agent CALL a tool the brain declared — closing the
// "can declare but never invoke" gap. No eval: only string-template interpolation + guarded fetch.

import { defineTool } from "@agentic/agent-kit";
import type { ToolContext, ToolDescriptor } from "@agentic/agent-kit";
import { safeFetch } from "./ssrf";

/** Structural shape of a persisted declarative tool (matches agent-factory's DeclarativeTool /
 *  the factory_tools row — kept local so packages/tools needs no cross-package type import). */
export interface DeclarativeToolDef {
  name: string;
  description?: string;
  method: string;
  urlTemplate: string;
  headers?: Record<string, string>;
  bodyTemplate?: string;
  sideEffect?: string;
  paramsSchema?: Record<string, unknown>;
  returnsSchema?: Record<string, unknown>;
}

function readPath(obj: unknown, path: string): unknown {
  if (obj == null || !path) return undefined;
  let cur: unknown = obj;
  for (const part of path.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/** Replace {dotted.path} tokens from a scope. URL substitutions are URL-encoded; header/body are not. */
function fillTemplate(tpl: string, scope: Record<string, unknown>, encode: boolean): string {
  return tpl.replace(/\{([\w.]+)\}/g, (_m, key: string) => {
    const v = readPath(scope, key);
    if (v == null) return "";
    const s = typeof v === "object" ? JSON.stringify(v) : String(v);
    return encode ? encodeURIComponent(s) : s;
  });
}

/** When returnsSchema declares `required: string[]` (JSON-schema style), assert those top-level
 *  keys are present in the response. Lenient otherwise (field-map schemas aren't enforced). */
function missingRequired(parsed: unknown, returnsSchema?: Record<string, unknown>): string[] {
  const required = returnsSchema?.required;
  if (!Array.isArray(required) || !required.length) return [];
  if (parsed == null || typeof parsed !== "object") return required.map(String);
  const obj = parsed as Record<string, unknown>;
  return required.map(String).filter((k) => !(k in obj) || obj[k] === undefined);
}

export interface MakeDeclarativeToolOpts {
  /** Inject a fetch implementation (tests / cassette replay). Defaults to global fetch via safeFetch. */
  fetchFn?: typeof fetch;
}

/** Build a runtime ToolDescriptor from a declarative tool definition. The handler reads the
 *  LLM-supplied args from ctx.event.data (the runtime overrides `event` with the tool-call input
 *  at dispatch), merges ctx.config (per-tenant creds/paths), fills the templates, calls the
 *  SSRF-guarded fetch, and validates required return fields. Throws on failure so the runtime
 *  surfaces tool_result:is_error and the LLM can self-correct. */
export function makeDeclarativeTool(def: DeclarativeToolDef, opts?: MakeDeclarativeToolOpts): ToolDescriptor {
  const fetchFn = opts?.fetchFn ?? fetch;
  return defineTool({
    name: def.name,
    description: def.description ?? `declarative HTTP tool ${def.method} ${def.urlTemplate}`,
    async handler(ctx: ToolContext) {
      const args = (ctx.event?.data ?? {}) as Record<string, unknown>;
      // config supplies creds/paths; LLM args win on key collision.
      const scope = { ...(ctx.config ?? {}), ...args };
      const method = (def.method || "GET").toUpperCase();
      const url = fillTemplate(def.urlTemplate, scope, true);
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(def.headers ?? {})) headers[k] = fillTemplate(v, scope, false);
      const init: RequestInit = { method, headers };
      if (def.bodyTemplate && method !== "GET" && method !== "HEAD") {
        init.body = fillTemplate(def.bodyTemplate, scope, false);
        if (!headers["content-type"] && !headers["Content-Type"]) headers["content-type"] = "application/json";
      }
      const res = await safeFetch(url, init, fetchFn);
      const text = await res.text();
      let parsed: unknown = text;
      try {
        parsed = JSON.parse(text);
      } catch {
        /* non-JSON response — keep raw text */
      }
      if (!res.ok) {
        throw new Error(`declarative tool ${def.name} HTTP ${res.status}: ${String(text).slice(0, 200)}`);
      }
      const missing = missingRequired(parsed, def.returnsSchema);
      if (missing.length) {
        throw new Error(`declarative tool ${def.name} response missing required field(s): ${missing.join(", ")}`);
      }
      return { data: parsed, meta: { declarative: true, tool: def.name, status: res.status } };
    },
  });
}

/** Turn a set of declarative tool rows into a name→descriptor overlay map. The runtime merges
 *  this into the per-tenant tool registry so resolution finds them BEFORE the global registry. */
export function buildDeclarativeOverlay(
  defs: DeclarativeToolDef[],
  opts?: MakeDeclarativeToolOpts,
): Record<string, ToolDescriptor> {
  const overlay: Record<string, ToolDescriptor> = {};
  for (const def of defs) {
    if (!def?.name) continue;
    overlay[def.name] = makeDeclarativeTool(def, opts);
  }
  return overlay;
}
