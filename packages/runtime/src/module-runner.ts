// #P0a — runGeneratedModule: execute an ARBITRARY generated module in a REAL worker_thread isolate,
// off the main event loop, with a hard wall-clock timeout + memory cap. This is the load-bearing
// safety rebuild the fusion blueprint (§08) calls for: today's runGeneratedCode (codeact.ts) runs an
// LLM-written handler in-process via `new Function` with no wall-clock bound — a synchronous infinite
// loop locks the whole api. This runner moves execution into a worker so a runaway (sync OR async) is
// abandoned via Worker.terminate() and can NEVER hang the host.
//
// Scope vs codeact.ts:
//   · codeact.runGeneratedCode  = the defineAgent(.handler + rich ctx) sandbox path (in-process, now
//     with an async-timeout floor). Kept for the manifest/agent decision loop.
//   · runGeneratedModule (here)  = the GENERIC deliverable path (the future ts_function_module): any
//     export — function/class/module — bounded and isolated. The worker IS the isolation boundary.
//
// SAFETY:
//   · OFF when FACTORY_EXEC_GENERATED=0 (kill switch, same as codeact).
//   · If a tenantSlug is supplied it MUST be a factory-issued ephemeral sandbox tenant (mirrors codeact's isolation
//     invariant) — so this can never be wired onto a real tenant by accident. Tests omit it.
//   · Dependencies are DENIED by default; only an explicit `allowlist` passes through to the
//     real `require` (the deploy/test-profile split of §07/§08 lives above this). Network egress
//     guarding is a later phase (P6); this phase delivers time+memory containment + arbitrary exports.
//   · Never throws — every failure returns a structured { ok:false, ... } result.

import { Worker } from "node:worker_threads";
import { isSandboxTenant } from "./sandbox-mode";

/**
 * Curated dependency allowlist for GENERATED code execution (the factory Tester's
 * real run). Only safe, side-effect-free stdlib modules — pure computation /
 * parsing, zero I/O reach. Anything that can touch the host (fs, net, http/https,
 * child_process, os, …) is rejected by the require-shim. Both the
 * `node:`-prefixed and bare specifier spellings are listed because the shim
 * matches the literal id the generated code used. Shared by all three isolation
 * tiers (worker / process / container) via `allowlist` opts; the AST security
 * lint (packages/agent-factory/src/code-lint.ts) does not ban these modules.
 */
export const GENERATED_CODE_ALLOWLIST: readonly string[] = Object.freeze([
  "node:crypto", "crypto",
  "node:url", "url",
  "node:querystring", "querystring",
]);

export interface ModuleRunResult {
  ok: boolean;
  /** Isolation boundary that actually executed the module. */
  isolationTier?: "worker" | "process" | "container";
  /** Stronger tier requested by the caller when the runner explicitly degraded. */
  requestedIsolationTier?: "worker" | "process" | "container";
  /** true when the worker was killed by the wall-clock timeout (sync or async hang). */
  timedOut?: boolean;
  /** true when the worker died from an out-of-memory / non-zero exit (e.g. resourceLimits breach). */
  crashed?: boolean;
  error?: string;
  /** whether the entry export was actually invoked (opts.call). */
  called?: boolean;
  /** which export was chosen as the entry. */
  exportName?: string;
  /** all top-level export names the module produced. */
  exportNames?: string[];
  /** the (JSON-serializable) return value, when called. */
  result?: unknown;
  durationMs: number;
}

export interface RunModuleOpts {
  /** which export to treat as the entry (else: defineAgent handler → first fn export → default). */
  entryName?: string;
  /** actually invoke the entry (default false = load-probe only). */
  call?: boolean;
  /** single argument passed to the entry when called. */
  input?: unknown;
  /** multi-arg call (overrides `input` when present). */
  args?: unknown[];
  /** module ids the require-shim resolves to the REAL module (everything else is rejected). */
  allowlist?: string[];
  /** wall-clock ceiling in ms (default 5000). */
  timeoutMs?: number;
  /** worker heap cap in MB → resourceLimits.maxOldGenerationSizeMb (default 128). */
  memoryMb?: number;
  /** isolation invariant: if set, MUST be a recognized Agent Factory sandbox tenant. */
  tenantSlug?: string;
}

// The worker program (eval:true). Receives { code, ... } via workerData; transpiles TS→CJS with the
// `typescript` package already in the workspace, runs the module behind a deny-by-default require-shim, picks
// an entry export, optionally invokes it, and posts a serializable result. Any throw is reported, not
// leaked. Kept as a string so no separate compiled worker-entry file must resolve at both dev(tsx) and
// prod(dist) paths.
const WORKER_SRC = `
const { parentPort, workerData } = require('node:worker_threads');
(async () => {
  const post = (m) => { try { parentPort.postMessage(m); } catch (e) { parentPort.postMessage({ ok:false, error:'postMessage failed: '+String(e && e.message || e) }); } };
  const serialize = (v) => {
    try {
      const json = JSON.stringify(v === undefined ? null : v);
      if (json === undefined) throw new TypeError('result has no JSON representation');
      return { ok:true, value:JSON.parse(json) };
    } catch (e) {
      return { ok:false, error:'entry result is not JSON-serializable: '+String(e && e.message || e).slice(0,500) };
    }
  };
  try {
    const { code, entryName, call, input, args, allowlist } = workerData;
    const ts = require('typescript');
    const js = ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
    const allow = new Set(allowlist || []);
    let captured = null;
    const defineAgent = (cfg) => { captured = cfg; return cfg; };
    const requireShim = (id) => {
      if (id === '@agentic/runtime') return { defineAgent };
      if (allow.has(id)) return require(id);
      throw new Error("module '" + id + "' is not allowlisted");
    };
    const moduleObj = { exports: {} };
    // eslint-disable-next-line no-new-func
    const factory = new Function('require','exports','module','defineAgent', js);
    factory(requireShim, moduleObj.exports, moduleObj, defineAgent);
    const exp = moduleObj.exports || {};
    const exportNames = Object.keys(exp);
    let entry = null, name = '';
    if (entryName && exp[entryName] !== undefined) { entry = exp[entryName]; name = entryName; }
    else if (captured && typeof captured.handler === 'function') { entry = captured.handler; name = 'handler'; }
    else {
      for (const k of exportNames) { if (typeof exp[k] === 'function') { entry = exp[k]; name = k; break; } }
      if (!entry && exp.default !== undefined) { entry = exp.default; name = 'default'; }
    }
    if (call) {
      if (typeof entry !== 'function') { post({ ok:false, error:'no callable entry export found', exportNames }); return; }
      const out = Array.isArray(args) ? await entry.apply(null, args) : await entry(input);
      const encoded = serialize(out);
      if (!encoded.ok) { post({ ok:false, called:true, exportName:name, exportNames, error:encoded.error }); return; }
      post({ ok:true, called:true, exportName:name, exportNames, result: encoded.value });
    } else {
      post({ ok:true, called:false, exportName:name, exportNames, hasEntry: entry != null, entryType: typeof entry });
    }
  } catch (e) {
    post({ ok:false, error: String(e && e.message || e).slice(0, 800) });
  }
})();
`;

/** Run an arbitrary generated module in an isolated worker with a hard time + memory bound.
 *  Never throws; always resolves a structured result. */
export function runGeneratedModule(code: string, opts: RunModuleOpts = {}): Promise<ModuleRunResult> {
  const started = Date.now();
  const done = (r: Omit<ModuleRunResult, "durationMs">): ModuleRunResult => ({ isolationTier: "worker", ...r, durationMs: Date.now() - started });

  if (process.env.FACTORY_EXEC_GENERATED === "0") {
    return Promise.resolve(done({ ok: false, error: "FACTORY_EXEC_GENERATED=0（生成代码执行已禁用）" }));
  }
  // Isolation invariant (mirrors codeact): a real-tenant slug is refused; the worker is the boundary,
  // but this stops the runner from ever being wired onto a non-sandbox tenant by accident.
  if (opts.tenantSlug && !isSandboxTenant(opts.tenantSlug)) {
    return Promise.resolve(done({ ok: false, error: "隔离不变量：runGeneratedModule 仅允许 Agent Factory 临时沙箱租户" }));
  }
  if (!code || code.trim().length < 1) {
    return Promise.resolve(done({ ok: false, error: "空代码" }));
  }

  const timeoutMs = opts.timeoutMs ?? 5000;
  const memoryMb = opts.memoryMb ?? 128;

  return new Promise<ModuleRunResult>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let worker: Worker | null = null;

    const finish = (r: Omit<ModuleRunResult, "durationMs">) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      // Best-effort teardown; terminate() is safe to call after natural exit too.
      try { worker?.terminate(); } catch { /* already gone */ }
      resolve(done(r));
    };

    try {
      worker = new Worker(WORKER_SRC, {
        eval: true,
        workerData: {
          code,
          entryName: opts.entryName,
          call: !!opts.call,
          input: opts.input,
          args: opts.args,
          allowlist: opts.allowlist ?? [],
        },
        // Hard memory containment: a heap breach crashes the worker (→ 'error'/'exit'), not the host.
        resourceLimits: {
          maxOldGenerationSizeMb: memoryMb,
          maxYoungGenerationSizeMb: Math.max(16, Math.floor(memoryMb / 4)),
          codeRangeSizeMb: 64,
          stackSizeMb: 4,
        },
      });
    } catch (e) {
      finish({ ok: false, error: `worker 启动失败：${String((e as Error)?.message ?? e).slice(0, 300)}` });
      return;
    }

    // Wall-clock ceiling — the definitive backstop for a SYNC infinite loop (which no in-process race
    // can preempt): terminate the worker and report timedOut.
    timer = setTimeout(() => finish({ ok: false, timedOut: true, error: `执行超时（>${timeoutMs}ms）——worker 已终止` }), timeoutMs);
    timer.unref?.();

    worker.once("message", (m: Record<string, unknown>) => {
      finish({
        ok: m.ok === true,
        called: m.called as boolean | undefined,
        exportName: m.exportName as string | undefined,
        exportNames: m.exportNames as string[] | undefined,
        result: m.result,
        error: m.ok === true ? undefined : (m.error as string | undefined) ?? "worker 报告失败",
      });
    });
    worker.once("error", (err: Error) => {
      const msg = String(err?.message ?? err);
      const oom = /out of memory|heap|ERR_WORKER_OUT_OF_MEMORY/i.test(msg);
      finish({ ok: false, crashed: true, error: `worker 崩溃：${msg.slice(0, 300)}`, ...(oom ? {} : {}) });
    });
    worker.once("exit", (codeExit: number) => {
      if (settled) return;
      // A NON-ZERO exit with no prior message = crash (commonly the OOM resourceLimits breach).
      // A CLEAN exit (code 0) with no message = the module loaded/ran but the worker went idle without
      // posting a result — e.g. an async entry that suspended on a promise with no backing handle. That
      // is a failure-to-produce, not a crash.
      if (codeExit === 0) finish({ ok: false, error: "worker 干净退出但未产出结果（可能异步挂起后事件循环空转退出）" });
      else finish({ ok: false, crashed: true, error: `worker 非正常退出（code=${codeExit}）——可能超内存或崩溃` });
    });
  });
}
