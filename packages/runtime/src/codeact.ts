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
import type { AgentRuntime, MemoryHandle } from "@agentic/agent-sdk";
import { sandboxToolMode, sandboxToolStub, cassetteLookup, toolDispatchDecision, gatedWriteMarker } from "./sandbox-mode";

type Emit = { event: string; payload: Record<string, unknown> };
interface AgentDef { handler: (input: unknown, ctx: unknown) => unknown; systemPrompt?: string }

// T3 — tool dispatch for the CodeAct path, mode-aware (FACTORY_SANDBOX_TOOL_MODE):
//   mock (default) → representative stub (no real external side effect)
//   replay         → recorded cassette for (tenant, tool, args); miss → stub
//   live           → call the REAL global tool handler against sandbox-scoped creds
async function runSandboxTool(name: string, tenantSlug: string | undefined, args: unknown): Promise<unknown> {
  const decision = toolDispatchDecision(name, sandboxToolMode());
  if (decision === "gate") return gatedWriteMarker(name, args); // external write gated (real payload recorded, not fired)
  if (decision === "live") {
    const t = globalToolRegistry.get(name);
    if (t) {
      try {
        const r = await t.handler({ agentName: "codeact", actionName: name, correlationId: "sandbox", tenantSlug: tenantSlug ?? "", event: { name: "codeact", data: (args ?? {}) as Record<string, unknown> } } as never);
        return (r as { data?: unknown })?.data ?? r;
      } catch (e) {
        return { __error: (e as Error).message };
      }
    }
    return sandboxToolStub(name); // no such tool registered → representative stub
  }
  if (decision === "replay" && tenantSlug) {
    const hit = await cassetteLookup(tenantSlug, name, args);
    if (hit !== undefined) return hit;
  }
  return sandboxToolStub(name);
}

// #NEST — recursive harness: a RUNNING agent can spawn a SUB-AGENT by generating its handler code
// on the fly and running it (recursively through runGeneratedCode). Depth-capped so a runaway
// self-spawn can't blow the stack; inherits the same `-sb` sandbox isolation as its parent (the
// generated sub-agent code only executes in the sandbox tenant). This is the "agents have their own
// harness + can generate sub-agents" layer — for PRODUCTION-deployable sub-agents the factory
// promotes a discovered decomposition into real functions wired via `type:"invoke"` (register.ts).
const MAX_SUBAGENT_DEPTH = Number(process.env.FACTORY_SUBAGENT_MAX_DEPTH) || 2;
// #REDESIGN P3 — review budget: how many generate→lint→run attempts a spawned sub-agent gets.
const SPAWN_REVIEW_TRIES = Number(process.env.FACTORY_SPAWN_REVIEW_TRIES) || 2;

// #REDESIGN P3 + FU2 — SECURITY LINT for a spawned sub-agent's code (runtime-local; mirrors the
// factory's lintGeneratedToolCode, which lives in agent-factory and can't be imported here without a
// cycle). AST-based: parse with the TS compiler and inspect import/require/call/new nodes, so a
// dangerous host API can't slip past behind concatenation or a shadowed identifier the way a raw-text
// scan could. The regex below is a FALLBACK for when typescript can't load / the snippet won't parse.
// The `-sb` isolation invariant is the load-bearing guard; this is defence-in-depth + a review signal.
const DANGEROUS_API = /\b(child_process|require\(['"]fs['"]\)|require\(['"]net['"]\)|require\(['"]http['"]\)|require\(['"]https['"]\)|require\(['"]dns['"]\)|require\(['"]os['"]\)|import\s+[^;]*['"](?:fs|net|http|https|dns|os|child_process)['"]|process\.(exit|kill|binding)|eval\(|new\s+Function\(|globalThis\.|__proto__|constructor\s*\[)/;
const FORBIDDEN_SPAWN_MODULES = new Set(["child_process", "fs", "net", "dgram", "tls", "http", "https", "http2", "dns", "vm", "worker_threads", "cluster", "os", "inspector", "v8", "repl", "module", "process"]);
function normSpawnModule(spec: string): string {
  let s = spec.trim();
  if (s.startsWith("node:")) s = s.slice(5);
  return s.split("/")[0] ?? s; // fs/promises → fs
}
async function lintSpawnCode(code: string): Promise<{ ok: boolean; violations: string[] }> {
  const violations: string[] = [];
  let ast: string[] | null = null;
  try {
    // #W1-10 — a hung typescript import (module-resolution stall) must not hang the whole spawn:
    // race it against a 5s timeout; on timeout fall through to the regex floor.
    const ts = await Promise.race([
      import("typescript"),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("ts import timeout")), 5000).unref?.()),
    ]);
    const sf = ts.createSourceFile("__spawn__.ts", code, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
    const found = new Set<string>();
    const chk = (spec: string) => { const b = normSpawnModule(spec); if (FORBIDDEN_SPAWN_MODULES.has(b)) found.add(`危险模块 ${b}`); };
    const visit = (n: import("typescript").Node): void => {
      if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) chk(n.moduleSpecifier.text);
      else if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference) && n.moduleReference.expression && ts.isStringLiteral(n.moduleReference.expression)) chk(n.moduleReference.expression.text);
      else if (ts.isCallExpression(n)) {
        const ex = n.expression; const a0 = n.arguments[0];
        if (ts.isIdentifier(ex) && ex.text === "require") { if (a0 && ts.isStringLiteral(a0)) chk(a0.text); else found.add("动态 require()"); }
        else if (ex.kind === ts.SyntaxKind.ImportKeyword) { if (a0 && ts.isStringLiteral(a0)) chk(a0.text); else found.add("动态 import()"); }
        else if (ts.isIdentifier(ex) && ex.text === "eval") found.add("eval()");
        else if (ts.isIdentifier(ex) && ex.text === "Function") found.add("Function()");
        else if (ts.isPropertyAccessExpression(ex) && ts.isIdentifier(ex.expression) && ex.expression.text === "process" && ["exit", "kill", "abort", "binding", "dlopen"].includes(ex.name.text)) found.add(`process.${ex.name.text}`);
      }
      else if (ts.isNewExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "Function") found.add("new Function()");
      else if (ts.isPropertyAccessExpression(n) && n.name.text === "__proto__") found.add("__proto__ 访问");
      ts.forEachChild(n, visit);
    };
    visit(sf);
    ast = [...found];
  } catch { ast = null; }
  if (ast !== null) { for (const v of ast) violations.push(`危险 API：${v}`); }
  else { const m = code.match(DANGEROUS_API); if (m) violations.push(`危险 API：${m[0].slice(0, 40)}`); }
  if (!/defineAgent|handler\s*\(/.test(code)) violations.push("没有 defineAgent/handler 结构");
  return { ok: violations.length === 0, violations };
}

async function generateSubAgentCode(
  task: string,
  gateway: ReturnType<typeof getRuntimeGateway>,
  opts: { tools?: string[]; tenantSlug?: string },
): Promise<string | null> {
  if (!gateway || !task.trim()) return null;
  const sys =
    "你为一个【正在运行的 agent】生成一个【子 agent】的 TypeScript 处理器，帮它完成一个子任务。只输出一个完整的 defineAgent 代码块：\n" +
    'export const subAgent = defineAgent({ name: "sub", async handler(input, ctx) { /* 用 ctx.reason(systemPrompt, input) 做判断；ctx.tool(name, args) 调工具；ctx.emit(event, payload) 产出；return 一个结果对象 */ return { ok: true }; } });\n' +
    "只输出代码，不要解释、不要 markdown 围栏之外的任何文字。";
  const user = `子任务：${task}\n可用工具：${(opts.tools ?? []).join("、") || "（以 ctx.reason 推理为主）"}`;
  const r = await gateway
    .chat({ messages: [{ role: "system", content: sys }, { role: "user", content: user }], tenantSlug: opts.tenantSlug })
    .catch(() => null);
  if (!r) return null;
  const fenced = r.text.match(/```(?:ts|typescript)?\s*\n([\s\S]*?)```/);
  const code = (fenced ? fenced[1] : r.text) ?? "";
  return code.includes("defineAgent") ? code : null;
}

/** Execute a generated agent's AI-written handler. Returns its result data (+ chosen emit event) and
 *  the emitted events, or null on any failure (caller falls back). Never throws. */
export async function runGeneratedCode(
  code: string,
  input: Record<string, unknown>,
  opts: { systemPrompt?: string; tenantSlug?: string; _depth?: number; memory?: MemoryHandle; runId?: string } = {},
): Promise<{ data: Record<string, unknown>; emitted: Emit[]; spawnedSubAgents?: Array<{ task: string; code: string }> } | null> {
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
    // #NEST promotion capture — every sub-agent this run spawns (its task + generated code) so the
    // factory can PROMOTE a useful one into a deployable spec via design_subagent({ code }).
    const spawnedSubAgents: Array<{ task: string; code: string }> = [];
    const gateway = getRuntimeGateway();
    // #REDESIGN P2/FU1 — memory. The DELIVERED adapter (register.ts) injects the REAL durable
    // MemoryHandle (createMemoryHandle) via opts.memory, so generated code running under Inngest gets
    // persistent get/put/delete + vector search — this is the one durable capability that's legal
    // inside a `step.run` body (a plain DB op, not a `step.*` primitive). When none is injected (pure
    // runtime tier / tests) we fall back to an ephemeral in-process handle: get/put/delete for the run,
    // vector search returns [] (that scope isn't vector-indexed — honest empty, not a stub).
    const _sbMem = new Map<string, unknown>();
    const sandboxMemory: MemoryHandle = opts.memory ?? {
      async get<T = unknown>(key: string): Promise<T | null> { return (_sbMem.has(key) ? (_sbMem.get(key) as T) : null); },
      async put<T = unknown>(key: string, value: T): Promise<void> { _sbMem.set(key, value); },
      async delete(key: string): Promise<void> { _sbMem.delete(key); },
      async search(): Promise<never[]> { return []; },
    };
    // #REDESIGN P2 — the CodeAct ctx conforms to the UNIFIED AgentRuntime socket (same shape the
    // delivered Inngest adapter provides), so a generated agent's handler is tier-agnostic.
    const agentCtx: AgentRuntime = {
      agentName: "codeact",
      tenantSlug: opts.tenantSlug ?? "",
      correlationId: "sandbox",
      subject: typeof (input as { _subject?: unknown })?._subject === "string" ? (input as { _subject?: string })._subject : undefined,
      memory: sandboxMemory,
      log: (level, msg, data) => { try { (console[level] ?? console.log)(`[codeact] ${msg}`, data ?? ""); } catch { /* best-effort */ } },
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
      // #NEST — the running agent's own harness: spawn a SUB-AGENT for a subtask by generating its
      // handler code and running it recursively. Depth-capped; sub-agent's emits bubble up to the
      // parent's emitted[]. Returns { ok, data?, emitted?, error? } — never throws.
      spawn: async (task: string, subInput?: unknown, subOpts?: { tools?: string[] }) => {
        const depth = opts._depth ?? 0;
        if (depth >= MAX_SUBAGENT_DEPTH) return { ok: false, error: `达到子 agent 最大嵌套深度(${MAX_SUBAGENT_DEPTH})` };
        // #REDESIGN P3 — REVIEW LOOP: generate → security-lint → (run = dynamic probe). Retry with the
        // lint feedback if the code is unsafe, up to a budget, before the parent relies on the sub-agent.
        let subCode: string | null = null;
        let lastIssue = "";
        let lastGen = "";
        for (let attempt = 0; attempt < SPAWN_REVIEW_TRIES; attempt++) {
          // Feed BACK the rejected code + the reason so the retry actually IMPROVES it (not an
          // identical stateless re-roll).
          const feedback = lastIssue ? `\n\n【上一次生成（已驳回）】：\n${lastGen.slice(0, 1500)}\n【驳回原因】：${lastIssue}\n请针对性修正后重写。` : "";
          const gen = await generateSubAgentCode(String(task ?? "") + feedback, gateway, { tools: subOpts?.tools, tenantSlug: opts.tenantSlug }).catch(() => null);
          if (!gen) { lastIssue = "代码生成失败"; continue; }
          lastGen = gen;
          const lint = await lintSpawnCode(gen);
          if (!lint.ok) { lastIssue = lint.violations.join("；"); continue; }
          subCode = gen;
          break;
        }
        if (!subCode) return { ok: false, error: `子 agent 未通过审查（${lastIssue}）` };
        // G5 独立观测（lite）：spawn 的任务/深度/时长/结果随 spawnedSubAgents 链上浮（工厂
        // inspect 与晋升路径都读它）+ 一条进程日志——不再是父 transcript 里的黑盒。
        const spawnStarted = Date.now();
        const entry: { task: string; code: string; ok?: boolean; durationMs?: number; depth?: number } = { task: String(task ?? ""), code: subCode, depth: depth + 1 };
        spawnedSubAgents.push(entry); // captured for promotion
        const r = await runGeneratedCode(subCode, (subInput ?? input) as Record<string, unknown>, { ...opts, _depth: depth + 1 });
        entry.ok = !!r;
        entry.durationMs = Date.now() - spawnStarted;
        try {
          console.info(`[codeact-spawn] tenant=${opts.tenantSlug ?? "?"} depth=${depth + 1} ok=${entry.ok} ms=${entry.durationMs} task=${entry.task.slice(0, 80)}`);
        } catch { /* logging best-effort */ }
        // G5 独立观测（完整版）：spawn 落一条父运行的 steps 行（type=subflow, name=spawn:…）——
        // 运行详情页直接可见每次派生的任务/时长/结果，不再只活在父 transcript 里。best-effort。
        if (opts.runId) {
          try {
            const { getDb, steps } = await import("@agentic/db");
            const { makeId } = await import("@agentic/shared");
            getDb()
              .insert(steps)
              .values({
                id: makeId("stp"),
                runId: opts.runId,
                ord: 900 + spawnedSubAgents.length,
                name: `spawn:${entry.task.slice(0, 60)}`,
                type: "subflow",
                status: entry.ok ? "ok" : "failed",
                startedAt: new Date(spawnStarted),
                endedAt: new Date(),
                durationMs: entry.durationMs,
              })
              .run();
          } catch { /* observability best-effort — never break the spawn */ }
        }
        if (!r) return { ok: false, error: "子 agent 运行失败（已回退）" };
        for (const e of r.emitted) emitted.push(e); // sub-agent emits bubble up to the parent chain
        for (const s of r.spawnedSubAgents ?? []) spawnedSubAgents.push(s); // nested spawns bubble up too
        return { ok: true, data: r.data, emitted: r.emitted, code: subCode };
      },
      // #REDESIGN P2 — on the RUNTIME tier, invoking another agent maps to a spawn (there's no durable
      // Inngest step.invoke in the ephemeral sandbox); returns the sub-agent's data (or null on fail).
      invoke: async (agentRef: string, inp?: unknown) => {
        const r = await agentCtx.spawn(`执行 ${agentRef}`, inp ?? input);
        return r.ok ? r.data : null;
      },
    };

    const result = await Promise.resolve(def.handler(input, agentCtx));
    const base = result && typeof result === "object" ? (result as Record<string, unknown>) : { result };
    // `_emit` lets register.ts's branch-emit (selectEmittedEvent) honor the handler's chosen event.
    const data = emitted[0] ? { ...base, _emit: emitted[0].event } : base;
    return spawnedSubAgents.length ? { data, emitted, spawnedSubAgents } : { data, emitted };
  } catch {
    return null; // fall back to the default generated path
  }
}
