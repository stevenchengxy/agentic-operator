// #P6-1 — runGeneratedModuleProcess: the STRONGER-isolation sibling of runGeneratedModule (worker
// version). The fusion blueprint's P6 first step, backed by the research finding that a worker_thread
// is NOT a security boundary — it shares the host's `process.env` (every real credential) and the same
// filesystem view. The moment generated code runs with REAL creds in scope, the isolate must first
// STRIP the secrets. A worker can't: it inherits process.env wholesale. A child process can be handed
// a freshly-scrubbed environment, so this path runs the generated module in a separate OS process with:
//
//   1. SCRUBBED ENV      — the child receives only a minimal whitelist (PATH/HOME/NODE_ENV/locale/temp);
//                          every secret-shaped var (KEY/TOKEN/SECRET/PASSWORD/CREDENTIAL/_API_/CUSTOM_LLM/
//                          ROBOHIRE/AUTH/DATABASE) is dropped — see the pure, unit-tested `scrubEnv`.
//   2. THROWAWAY CWD     — cwd is a fresh os.tmpdir() directory, never the project root, torn down after.
//   3. HARD WALL-CLOCK   — a runaway (sync OR async) is SIGKILL'd at the deadline → { timedOut:true }.
//   4. MEMORY CAP        — `--max-old-space-size=<mb>` bounds the child heap (OOM → child dies, host lives).
//   5. NO STRING CODE-GEN— `--disallow-code-generation-from-strings` denies the child's OWN code eval/
//                          new Function. Trade-off: this ALSO blocks `new Function`, which the worker
//                          version uses to run the transpiled module — so here we compile the module with
//                          `vm.compileFunction` instead (the vm module's compile API is NOT gated by the
//                          flag; verified on Node 26). Net effect: OUR loader works, but LLM code trying
//                          to `eval`/`new Function` at runtime is refused. Opt out via allowCodeGeneration.
//
// Shares runGeneratedModule's `ModuleRunResult` shape, the FACTORY_EXEC_GENERATED kill switch, and the
// factory-issued ephemeral-sandbox invariant. Never throws — every failure resolves a structured { ok:false, … }.

import { fork, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModuleRunResult } from "./module-runner";
import { isSandboxTenant } from "./sandbox-mode";

export type { ModuleRunResult } from "./module-runner";

// ── Env scrubbing (pure, unit-tested) ───────────────────────────────────────────────────────────────
// Strategy: WHITELIST-primary + BLACKLIST-override. A var is passed through iff it is on the minimal
// allowlist AND does not look like a secret. The whitelist alone already drops every non-essential var
// (so a brand-new secret with an unfamiliar name never leaks); the deny pattern is defence-in-depth that
// ALWAYS wins — even if a caller widens the allowlist, a KEY/TOKEN/SECRET/… var is still stripped.

/** Minimal env the child needs to be a functioning node process, cross-platform. Intentionally excludes
 *  NODE_OPTIONS — a parent `--require`/loader flag there could re-inject a secret or undo the
 *  --disallow-code-generation guard. Add it explicitly via `allowExtra` only if a caller truly needs it. */
export const DEFAULT_ENV_ALLOWLIST: readonly string[] = [
  "PATH",
  "HOME",
  "NODE_ENV",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  // Windows startup essentials (harmless no-ops on POSIX):
  "SYSTEMROOT",
  "SYSTEMDRIVE",
  "WINDIR",
  "PATHEXT",
  "COMSPEC",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
];

/** Any env var whose NAME matches this is treated as a secret and never passed to the child. */
export const SECRET_ENV_PATTERN =
  /(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|_API_|CUSTOM_LLM|ROBOHIRE|AUTH|DATABASE)/i;

export interface ScrubEnvOpts {
  /** exact key names (case-insensitive) that survive the whitelist. REPLACES DEFAULT_ENV_ALLOWLIST. */
  allow?: Iterable<string>;
  /** extra key names allowed ON TOP of the effective allowlist (a secret-shaped name is STILL dropped). */
  allowExtra?: Iterable<string>;
  /** override the secret-name detector (defaults to SECRET_ENV_PATTERN). */
  denyPattern?: RegExp;
}

/** Pure: return a NEW env object containing only whitelisted, non-secret, defined vars. Never mutates
 *  its input. This is the load-bearing safety primitive — the child literally cannot read a credential
 *  that scrubEnv drops. Unit-tested in module-runner-proc.test.ts. */
export function scrubEnv(
  env: Record<string, string | undefined> = {},
  opts: ScrubEnvOpts = {},
): Record<string, string> {
  const deny = opts.denyPattern ?? SECRET_ENV_PATTERN;
  const allow = new Set<string>();
  for (const k of opts.allow ?? DEFAULT_ENV_ALLOWLIST) allow.add(String(k).toLowerCase());
  for (const k of opts.allowExtra ?? []) allow.add(String(k).toLowerCase());

  const out: Record<string, string> = {};
  for (const [key, val] of Object.entries(env)) {
    if (val == null) continue; // never forward an unset var
    if (deny.test(key)) continue; // blacklist ALWAYS wins (defence in depth)
    if (allow.has(key.toLowerCase())) out[key] = val; // whitelist gate
  }
  return out;
}

// ── The child bootstrap ──────────────────────────────────────────────────────────────────────────────
// Written fresh into the throwaway temp dir each run and `fork`ed, so there is no dev(tsx)/prod(dist)
// entry-file resolution problem (the worker version dodges this with an eval string; we dodge it by
// generating the file). It receives one IPC message { code, tsPath, … }, transpiles TS→CJS with the
// resolved `typescript` (absolute path passed by the parent — the child's cwd is an empty temp dir with
// no node_modules), compiles the module with `vm.compileFunction` (NOT new Function — blocked by
// --disallow-code-generation-from-strings), picks an entry export, optionally invokes it, and posts a
// JSON-serializable result. Non-allowlisted requires are rejected (no host module access by default).
const BOOTSTRAP_SRC = `'use strict';
const vm = require('node:vm');
const serialize = (v) => {
  try {
    const json = JSON.stringify(v === undefined ? null : v);
    if (json === undefined) throw new TypeError('result has no JSON representation');
    return { ok: true, value: JSON.parse(json) };
  } catch (e) {
    return { ok: false, error: 'entry result is not JSON-serializable: ' + String(e && e.message || e).slice(0, 500) };
  }
};
const done = (m) => { try { process.send(m, () => process.exit(0)); } catch { try { process.exit(0); } catch {} } };
process.once('message', async (msg) => {
  try {
    const { code, tsPath, entryName, call, input, args, allowlist } = msg || {};
    if (!tsPath) throw new Error('TypeScript compiler path is required');
    const ts = require(tsPath);
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
    // vm.compileFunction: build fn(require, exports, module, defineAgent){ <js> } WITHOUT eval/new Function.
    const factory = vm.compileFunction(js, ['require', 'exports', 'module', 'defineAgent'], { filename: '__generated__.js' });
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
      if (typeof entry !== 'function') { done({ ok: false, error: 'no callable entry export found', exportNames }); return; }
      const out = Array.isArray(args) ? await entry.apply(null, args) : await entry(input);
      const encoded = serialize(out);
      if (!encoded.ok) { done({ ok: false, called: true, exportName: name, exportNames, error: encoded.error }); return; }
      done({ ok: true, called: true, exportName: name, exportNames, result: encoded.value });
    } else {
      done({ ok: true, called: false, exportName: name, exportNames });
    }
  } catch (e) {
    done({ ok: false, error: String(e && e.message || e).slice(0, 800) });
  }
});
`;

export interface RunModuleProcOpts {
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
  /** wall-clock ceiling in ms (default 5000). Exceed → child SIGKILL'd, { timedOut:true }. */
  timeoutMs?: number;
  /** child heap cap in MB → --max-old-space-size (default 128). */
  memoryMb?: number;
  /** isolation invariant: if set, MUST be a recognized Agent Factory sandbox tenant. */
  tenantSlug?: string;
  /** extra env var names to pass through the scrub (still dropped if secret-shaped). */
  envAllowExtra?: string[];
  /** escape hatch: drop --disallow-code-generation-from-strings (re-permits eval/new Function in the
   *  child). Off by default — the flag is a load-bearing containment for LLM-written code. */
  allowCodeGeneration?: boolean;
}

// Resolve the `typescript` compiler entry from THIS module's location (packages/runtime has it as a
// devDep). Passed to the child as an absolute path because the child's cwd is an empty temp dir with no
// node_modules to walk. Missing compiler resolution fails the run before the child is started.
function resolveTypescriptPath(): string | undefined {
  try {
    return createRequire(import.meta.url).resolve("typescript");
  } catch {
    return undefined;
  }
}

/** Run an arbitrary generated module in a SEPARATE OS process with a scrubbed env, throwaway cwd, hard
 *  wall-clock timeout, memory cap, and string-code-gen denied. Never throws; always resolves a structured
 *  ModuleRunResult. The stronger-isolation sibling of runGeneratedModule (worker version). */
export function runGeneratedModuleProcess(
  code: string,
  opts: RunModuleProcOpts = {},
): Promise<ModuleRunResult> {
  const started = Date.now();
  const done = (r: Omit<ModuleRunResult, "durationMs">): ModuleRunResult => ({
    isolationTier: "process",
    ...r,
    durationMs: Date.now() - started,
  });

  if (process.env.FACTORY_EXEC_GENERATED === "0") {
    return Promise.resolve(done({ ok: false, error: "FACTORY_EXEC_GENERATED=0（生成代码执行已禁用）" }));
  }
  // Isolation invariant (mirrors codeact / worker runner): a real-tenant slug is refused up front, so this
  // runner can never be wired onto a non-sandbox tenant by accident.
  if (opts.tenantSlug && !isSandboxTenant(opts.tenantSlug)) {
    return Promise.resolve(
      done({ ok: false, error: "隔离不变量：runGeneratedModuleProcess 仅允许 Agent Factory 临时沙箱租户" }),
    );
  }
  if (!code || code.trim().length < 1) {
    return Promise.resolve(done({ ok: false, error: "空代码" }));
  }

  const timeoutMs = opts.timeoutMs ?? 5000;
  const memoryMb = opts.memoryMb ?? 128;
  const tsPath = resolveTypescriptPath();
  if (!tsPath) {
    return Promise.resolve(
      done({ ok: false, error: "TypeScript compiler is unavailable; generated module was not executed" }),
    );
  }

  let tmpDir: string;
  let bootstrapPath: string;
  try {
    tmpDir = mkdtempSync(join(tmpdir(), "agx-proc-"));
    bootstrapPath = join(tmpDir, "bootstrap.cjs");
    writeFileSync(bootstrapPath, BOOTSTRAP_SRC, "utf8");
  } catch (e) {
    return Promise.resolve(
      done({ ok: false, error: `子进程临时目录准备失败：${String((e as Error)?.message ?? e).slice(0, 300)}` }),
    );
  }

  const execArgv = [`--max-old-space-size=${memoryMb}`];
  if (!opts.allowCodeGeneration) execArgv.push("--disallow-code-generation-from-strings");

  return new Promise<ModuleRunResult>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let child: ChildProcess | null = null;
    let stderrTail = "";

    const cleanup = () => {
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        /* best-effort — the temp dir is disposable */
      }
    };
    const finish = (r: Omit<ModuleRunResult, "durationMs">) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try {
        child?.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      cleanup();
      resolve(done(r));
    };

    try {
      child = fork(bootstrapPath, [], {
        // Replace execArgv entirely (do NOT inherit the parent's tsx loader flags) — the bootstrap is
        // plain .cjs and requires the typescript compiler by absolute path.
        execArgv,
        // THE point of this runner: the child gets a scrubbed env, not process.env. fork adds its own
        // NODE_CHANNEL_FD for IPC on top of whatever we pass, so IPC still works.
        env: scrubEnv(process.env, { allowExtra: opts.envAllowExtra }),
        cwd: tmpDir,
        // Pipe (don't inherit) the child's stdio so user console output can't corrupt our streams; keep a
        // bounded tail of stderr for crash diagnostics. IPC is a separate channel, unaffected.
        silent: true,
      });
    } catch (e) {
      finish({ ok: false, error: `子进程启动失败：${String((e as Error)?.message ?? e).slice(0, 300)}` });
      return;
    }

    child.stderr?.on("data", (d: Buffer) => {
      if (stderrTail.length < 2000) stderrTail += d.toString();
    });
    // Drain stdout so a chatty child can't backpressure/hang; contents are irrelevant (result is via IPC).
    child.stdout?.on("data", () => {});

    // Wall-clock ceiling — the definitive backstop for a SYNC infinite loop (nothing in-process can
    // preempt it): SIGKILL the child and report timedOut.
    timer = setTimeout(
      () => finish({ ok: false, timedOut: true, error: `执行超时（>${timeoutMs}ms）——子进程已被 SIGKILL` }),
      timeoutMs,
    );
    timer.unref?.();

    child.once("message", (m: Record<string, unknown>) => {
      finish({
        ok: m.ok === true,
        called: m.called as boolean | undefined,
        exportName: m.exportName as string | undefined,
        exportNames: m.exportNames as string[] | undefined,
        result: m.result,
        error: m.ok === true ? undefined : ((m.error as string | undefined) ?? "子进程报告失败"),
      });
    });
    child.once("error", (err: Error) => {
      finish({ ok: false, crashed: true, error: `子进程错误：${String(err?.message ?? err).slice(0, 300)}` });
    });
    child.once("exit", (codeExit: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      // Exit BEFORE a result message. A non-zero code / kill signal = crash (commonly the
      // --max-old-space-size OOM, which aborts the process). A clean exit(0) with no message = the module
      // loaded but never posted a result (e.g. an async entry that suspended then drained the loop).
      const tail = stderrTail ? `：${stderrTail.slice(-200).trim()}` : "";
      if (codeExit === 0 && !signal) {
        finish({ ok: false, error: "子进程干净退出但未产出结果（可能异步挂起后事件循环空转退出）" });
      } else {
        finish({
          ok: false,
          crashed: true,
          error: `子进程非正常退出（code=${codeExit ?? "null"} signal=${signal ?? "null"}）——可能超内存或崩溃${tail}`,
        });
      }
    });

    // Hand the child its work. IPC buffers this until the child registers its 'message' listener.
    try {
      child.send({
        code,
        tsPath,
        entryName: opts.entryName,
        call: !!opts.call,
        input: opts.input,
        args: opts.args,
        allowlist: opts.allowlist ?? [],
      });
    } catch (e) {
      finish({ ok: false, error: `子进程消息投递失败：${String((e as Error)?.message ?? e).slice(0, 300)}` });
    }
  });
}
