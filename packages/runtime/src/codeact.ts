// #G — TRUE CodeAct: execute the AI-WRITTEN agent handler in the sandbox (not a re-interpretation
// of the spec). The Agent Factory's codegen_agent makes the brain hand-write each agent as
// `export const xAgent = defineAgent({ ..., async handler(input, ctx) { ... } })`, TS-compiler
// validated. Historically that code was NEVER run — the sandbox ran the declarative spec. This
// closes that gap (ported from the old AO's load-generated.ts): transpile the code, supply
// `defineAgent` + a controlled `ctx`, and run the real handler so "跑通" means the deployable code
// ran.
//
// SAFETY (this executes LLM-written code):
//   · OFF when FACTORY_EXEC_GENERATED=0 (kill switch).
//   · ONLY runs for the isolated `-sb` SANDBOX tenant (opts.tenantSlug must end in "-sb") — so a
//     promoted-to-production agent NEVER executes LLM code on a real tenant (it falls back to the
//     declarative path). This is the load-bearing isolation invariant.
//   · `require("@agentic/runtime")` resolves to the capturing `defineAgent`; every other import
//     resolves to {} (harmless). `ctx.tool(s)` run DRY-RUN (mock) — no real external side effects.
//   · any compile/load/run failure → returns null → the caller falls back to the default generated
//     prompt path, so a bad codegen can never brick the sandbox.

import { getRuntimeGateway } from "./llm-host";
import { globalToolRegistry } from "@agentic/tools";
import { sandboxToolMode, sandboxToolStub, cassetteLookup } from "./sandbox-mode";

type Emit = { event: string; payload: Record<string, unknown> };
interface AgentDef { handler: (input: unknown, ctx: unknown) => unknown; systemPrompt?: string }

// T3 — tool dispatch for the CodeAct path, mode-aware (FACTORY_SANDBOX_TOOL_MODE):
//   mock (default) → representative stub (no real external side effect)
//   replay         → recorded cassette for (tenant, tool, args); miss → stub
//   live           → call the REAL global tool handler against sandbox-scoped creds
async function runSandboxTool(name: string, tenantSlug: string | undefined, args: unknown): Promise<unknown> {
  const mode = sandboxToolMode();
  if (mode === "live") {
    const t = globalToolRegistry.get(name);
    if (t) {
      try {
        const r = await t.handler({ agentName: "codeact", actionName: name, correlationId: "sandbox", tenantSlug: tenantSlug ?? "", event: { name: "codeact", data: (args ?? {}) as Record<string, unknown> } } as never);
        return (r as { data?: unknown })?.data ?? r;
      } catch (e) {
        return { __error: (e as Error).message };
      }
    }
  }
  if (mode === "replay" && tenantSlug) {
    const hit = await cassetteLookup(tenantSlug, name, args);
    if (hit !== undefined) return hit;
  }
  return sandboxToolStub(name);
}

/** Execute a generated agent's AI-written handler. Returns its result data (+ chosen emit event) and
 *  the emitted events, or null on any failure (caller falls back). Never throws. */
export async function runGeneratedCode(
  code: string,
  input: Record<string, unknown>,
  opts: { systemPrompt?: string; tenantSlug?: string } = {},
): Promise<{ data: Record<string, unknown>; emitted: Emit[] } | null> {
  if (process.env.FACTORY_EXEC_GENERATED === "0") return null;
  // ISOLATION INVARIANT: LLM-written code runs ONLY in the `-sb` sandbox tenant. A promoted agent
  // on a real tenant has a non-sandbox slug → returns null → falls back to the declarative path.
  if (opts.tenantSlug && !opts.tenantSlug.endsWith("-sb")) return null;
  if (!code || code.trim().length < 60) return null;
  try {
    const ts = await import("typescript");
    const js = ts.transpileModule(code, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText;

    let captured: AgentDef | null = null;
    const defineAgent = (cfg: AgentDef) => { captured = cfg; return cfg; };
    // codegen_agent instructs the LLM to write a full .ts (import → export), so the transpiled
    // CommonJS does `require("@agentic/runtime").defineAgent` — resolve THAT to the capturing fn;
    // import-less code uses the scope-injected `defineAgent` directly. Any other import → {}.
    const requireShim = (id: string): unknown => (id === "@agentic/runtime" ? { defineAgent } : {});
    const moduleObj = { exports: {} as Record<string, unknown> };
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
    const factory = new Function("require", "exports", "module", "defineAgent", js) as (
      r: (id: string) => unknown, e: Record<string, unknown>, m: { exports: Record<string, unknown> }, d: (c: AgentDef) => AgentDef,
    ) => void;
    factory(requireShim, moduleObj.exports, moduleObj, defineAgent);

    const def: AgentDef | null =
      captured ?? (Object.values(moduleObj.exports).find((v) => v && typeof v === "object" && typeof (v as AgentDef).handler === "function") as AgentDef | undefined) ?? null;
    if (!def || typeof def.handler !== "function") return null;

    const emitted: Emit[] = [];
    const gateway = getRuntimeGateway();
    const agentCtx = {
      // the agent's decision core — its own system prompt over the event input.
      reason: async (sp: string, inp: unknown) => {
        if (!gateway) return { ok: true };
        const r = await gateway
          .chat({ messages: [{ role: "system", content: sp || opts.systemPrompt || "" }, { role: "user", content: JSON.stringify(inp ?? {}) }], tenantSlug: opts.tenantSlug })
          .catch(() => null);
        if (!r) return { ok: true };
        try { return JSON.parse(r.text); } catch { return { text: r.text, ok: true }; }
      },
      emit: (event: string, payload: Record<string, unknown> = {}) => { emitted.push({ event, payload }); },
      tools: { run: (name: string, toolArgs?: unknown) => runSandboxTool(name, opts.tenantSlug, toolArgs ?? input) },
      tool: (name: string, toolArgs?: unknown) => runSandboxTool(name, opts.tenantSlug, toolArgs ?? input),
    };

    const result = await Promise.resolve(def.handler(input, agentCtx));
    const base = result && typeof result === "object" ? (result as Record<string, unknown>) : { result };
    // `_emit` lets register.ts's branch-emit (selectEmittedEvent) honor the handler's chosen event.
    const data = emitted[0] ? { ...base, _emit: emitted[0].event } : base;
    return { data, emitted };
  } catch {
    return null; // fall back to the default generated path
  }
}
