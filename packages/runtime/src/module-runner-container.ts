// #P6 (full) — runGeneratedModuleContainer: the STRONGEST isolation tier for executing generated code,
// a real OS-level container boundary (Docker). The fusion blueprint's §08 硬伤 conclusion: a worker_thread
// isn't a security boundary and a child process still shares the host kernel + filesystem + network; the
// only honest boundary for running LLM-written code with real side-effects is infrastructure-level. This
// runs the module inside a locked-down container:
//
//   --network none                 no network at all (egress impossible)
//   --read-only + --tmpfs /tmp     immutable root fs; only a small exec tmpfs for /tmp
//   --memory / --memory-swap       hard memory cap (OOM kills the container, host lives)
//   --cpus / --pids-limit          CPU + fork-bomb caps
//   --cap-drop ALL                 drop every Linux capability
//   --security-opt no-new-privileges   no privilege escalation
//   --user 1000:1000               non-root
//   -v <tmp>:/work:ro              the code + payload mounted READ-ONLY; container env is EMPTY of secrets
//   node --disallow-code-generation-from-strings   deny the LLM code's own eval/new Function
//
// TS is transpiled on the HOST (which has the compiler); the container only runs the compiled JS via
// vm.compileFunction, so no toolchain is needed inside. Shares ModuleRunResult, the FACTORY_EXEC_GENERATED
// kill switch, and the -sb invariant. Never throws. A caller may explicitly opt into the weaker child-
// process tier with fallback:true; the default fails when Docker is unavailable.

import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import type { ModuleRunResult } from "./module-runner";
import { runGeneratedModuleProcess, type RunModuleProcOpts } from "./module-runner-proc";
import { isSandboxTenant } from "./sandbox-mode";

export type { ModuleRunResult } from "./module-runner";

const RESULT_SENTINEL = "__AGX_RESULT__";
const DEFAULT_IMAGE = process.env.FACTORY_CONTAINER_IMAGE?.trim() || "node:22-alpine";

let _dockerOk: boolean | null = null;
/** Probe whether Docker is usable (daemon reachable). Cached for the process. */
export function dockerAvailable(): boolean {
  if (_dockerOk !== null) return _dockerOk;
  try {
    const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
    const r = spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], { timeout: 5000, stdio: ["ignore", "ignore", "ignore"] });
    _dockerOk = r.status === 0;
  } catch {
    _dockerOk = false;
  }
  return _dockerOk;
}
/** test hook — reset the cached probe. */
export function _resetDockerProbe(): void { _dockerOk = null; }

// The in-container bootstrap: reads /work/payload.json (compiled JS + params), runs it behind a deny-by-default
// require-shim via vm.compileFunction (NOT new Function — denied by the node flag), picks an entry export,
// optionally invokes it, and prints the result on a SENTINEL line to stdout (the only channel out of the
// container). Non-allowlisted requires are rejected.
const CONTAINER_BOOTSTRAP = `'use strict';
const vm = require('node:vm');
const fs = require('node:fs');
const emit = (m) => { try { process.stdout.write("\\n" + ${JSON.stringify(RESULT_SENTINEL)} + JSON.stringify(m) + "\\n"); } catch (e) {} };
const serialize = (v) => {
  try {
    const json = JSON.stringify(v === undefined ? null : v);
    if (json === undefined) throw new TypeError('result has no JSON representation');
    return { ok: true, value: JSON.parse(json) };
  } catch (e) {
    return { ok: false, error: 'entry result is not JSON-serializable: ' + String(e && e.message || e).slice(0, 500) };
  }
};
(async () => {
  try {
    const p = JSON.parse(fs.readFileSync('/work/payload.json', 'utf8'));
    const allow = new Set(p.allowlist || []);
    let captured = null;
    const defineAgent = (cfg) => { captured = cfg; return cfg; };
    const requireShim = (id) => { if (id === '@agentic/runtime') return { defineAgent }; if (allow.has(id)) return require(id); throw new Error("module '" + id + "' is not allowlisted"); };
    const moduleObj = { exports: {} };
    const factory = vm.compileFunction(p.js, ['require','exports','module','defineAgent'], { filename: '__generated__.js' });
    factory(requireShim, moduleObj.exports, moduleObj, defineAgent);
    const exp = moduleObj.exports || {};
    const exportNames = Object.keys(exp);
    let entry = null, name = '';
    if (p.entryName && exp[p.entryName] !== undefined) { entry = exp[p.entryName]; name = p.entryName; }
    else if (captured && typeof captured.handler === 'function') { entry = captured.handler; name = 'handler'; }
    else { for (const k of exportNames) { if (typeof exp[k] === 'function') { entry = exp[k]; name = k; break; } } if (!entry && exp.default !== undefined) { entry = exp.default; name = 'default'; } }
    if (p.call) {
      if (typeof entry !== 'function') { emit({ ok:false, error:'no callable entry export found', exportNames }); return; }
      const out = Array.isArray(p.args) ? await entry.apply(null, p.args) : await entry(p.input);
      const encoded = serialize(out);
      if (!encoded.ok) { emit({ ok:false, called:true, exportName:name, exportNames, error:encoded.error }); return; }
      emit({ ok:true, called:true, exportName:name, exportNames, result: encoded.value });
    } else { emit({ ok:true, called:false, exportName:name, exportNames }); }
  } catch (e) { emit({ ok:false, error: String(e && e.message || e).slice(0, 800) }); }
})();
`;

export interface RunModuleContainerOpts extends RunModuleProcOpts {
  /** container image (default node:22-alpine or FACTORY_CONTAINER_IMAGE). */
  image?: string;
  /** CPU cap (default 1). */
  cpus?: number;
  /** explicitly allow a weaker child-process tier when Docker is unavailable (default false). */
  fallback?: boolean;
}

function transpileOnHost(code: string): string {
  const ts = createRequire(import.meta.url)("typescript") as typeof import("typescript");
  return ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
}

/** Run an arbitrary generated module inside a locked-down Docker container. Never throws. A weaker
 *  child-process fallback is used only when the caller explicitly sets fallback:true. */
export function runGeneratedModuleContainer(code: string, opts: RunModuleContainerOpts = {}): Promise<ModuleRunResult> {
  const started = Date.now();
  const done = (r: Omit<ModuleRunResult, "durationMs">): ModuleRunResult => ({ isolationTier: "container", ...r, durationMs: Date.now() - started });

  if (process.env.FACTORY_EXEC_GENERATED === "0") return Promise.resolve(done({ ok: false, error: "FACTORY_EXEC_GENERATED=0（生成代码执行已禁用）" }));
  if (opts.tenantSlug && !isSandboxTenant(opts.tenantSlug)) return Promise.resolve(done({ ok: false, error: "隔离不变量：runGeneratedModuleContainer 仅允许 Agent Factory 临时沙箱租户" }));
  if (!code || code.trim().length < 1) return Promise.resolve(done({ ok: false, error: "空代码" }));

  if (!dockerAvailable()) {
    if (opts.fallback !== true) return Promise.resolve(done({ ok: false, error: "Docker 不可用(daemon 未运行/未安装)；未执行容器任务" }));
    // Degrade to the next-strongest tier (child process + scrubbed env).
    return runGeneratedModuleProcess(code, opts).then((r) => ({
      ...r,
      requestedIsolationTier: "container",
      error: r.ok ? r.error : `[docker 不可用→回退子进程] ${r.error ?? ""}`.trim(),
    }));
  }

  const timeoutMs = opts.timeoutMs ?? 15000; // container startup is slower — a larger default than the worker/proc runners
  const memoryMb = opts.memoryMb ?? 128;
  const cpus = opts.cpus ?? 1;
  const image = opts.image ?? DEFAULT_IMAGE;
  const name = `agx-sb-${Date.now().toString(36)}-${Math.floor(process.hrtime()[1] % 1e6).toString(36)}`;

  let tmpDir: string;
  try {
    tmpDir = mkdtempSync(join(tmpdir(), "agx-cnt-"));
    writeFileSync(join(tmpDir, "bootstrap.cjs"), CONTAINER_BOOTSTRAP, { mode: 0o644 });
    writeFileSync(
      join(tmpDir, "payload.json"),
      JSON.stringify({ js: transpileOnHost(code), entryName: opts.entryName, call: !!opts.call, input: opts.input, args: opts.args, allowlist: opts.allowlist ?? [] }),
      { mode: 0o644 },
    );
  } catch (e) {
    return Promise.resolve(done({ ok: false, error: `容器临时目录准备失败：${String((e as Error)?.message ?? e).slice(0, 300)}` }));
  }

  const args = [
    "run", "--rm", "--name", name,
    "--network", "none",
    "--read-only",
    "--tmpfs", "/tmp:exec,size=16m",
    "--memory", `${memoryMb}m`, "--memory-swap", `${memoryMb}m`,
    "--cpus", String(cpus),
    "--pids-limit", "128",
    "--security-opt", "no-new-privileges",
    "--cap-drop", "ALL",
    "--user", "1000:1000",
    "-v", `${tmpDir}:/work:ro`,
    "-e", "NODE_ENV=production",
    image,
    "node", `--max-old-space-size=${memoryMb}`, "--disallow-code-generation-from-strings", "/work/bootstrap.cjs",
  ];

  return new Promise<ModuleRunResult>((resolve) => {
    let settled = false;
    let out = "";
    let errTail = "";
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => { try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* disposable */ } };
    const killContainer = () => { try { spawn("docker", ["kill", name], { stdio: "ignore" }).on("error", () => {}); } catch { /* best-effort */ } };
    const parseResult = (): Record<string, unknown> | null => {
      const i = out.lastIndexOf(RESULT_SENTINEL);
      if (i < 0) return null;
      const line = out.slice(i + RESULT_SENTINEL.length).split("\n")[0]!.trim();
      try { return JSON.parse(line) as Record<string, unknown>; } catch { return null; }
    };
    const finish = (r: Omit<ModuleRunResult, "durationMs">) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      cleanup();
      resolve(done(r));
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      finish({ ok: false, error: `docker 启动失败：${String((e as Error)?.message ?? e).slice(0, 300)}` });
      return;
    }
    child.stdout?.on("data", (d: Buffer) => { out += d.toString(); if (out.length > 1_000_000) out = out.slice(-500_000); });
    child.stderr?.on("data", (d: Buffer) => { if (errTail.length < 2000) errTail += d.toString(); });

    timer = setTimeout(() => { killContainer(); finish({ ok: false, timedOut: true, error: `容器执行超时（>${timeoutMs}ms）——已 docker kill` }); }, timeoutMs);
    timer.unref?.();

    child.once("error", (err: Error) => { killContainer(); finish({ ok: false, error: `docker 进程错误：${String(err?.message ?? err).slice(0, 300)}` }); });
    child.once("exit", (codeExit: number | null) => {
      if (settled) return;
      const m = parseResult();
      if (m) {
        finish({ ok: m.ok === true, called: m.called as boolean | undefined, exportName: m.exportName as string | undefined, exportNames: m.exportNames as string[] | undefined, result: m.result, error: m.ok === true ? undefined : ((m.error as string | undefined) ?? "容器内报告失败") });
        return;
      }
      // No sentinel result — the container crashed / was OOM-killed / image missing / failed to start.
      const tail = errTail ? `：${errTail.slice(-240).trim()}` : "";
      const oom = /oom|out of memory|killed/i.test(errTail);
      finish({ ok: false, crashed: true, error: `容器无结果退出（code=${codeExit ?? "null"}）${oom ? "·疑似超内存被杀" : ""}${tail}` });
    });
  });
}
