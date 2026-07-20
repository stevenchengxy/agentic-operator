/**
 * Worker-thread execution boundary for generated `defineAgent` handlers.
 *
 * Generated code never executes on the host event loop. The worker receives no
 * credentials and can import only the runtime capture shim plus the curated,
 * side-effect-free generated-code allowlist. Every capability that can touch
 * host state crosses the explicit RPC bridge below.
 */

import { Worker } from "node:worker_threads";
import { GENERATED_CODE_ALLOWLIST } from "./module-runner";

/**
 * An actual execution tier, set by the implementation that creates the
 * operating-system boundary.  Environment variables and caller supplied
 * labels are deliberately not part of this type: `FACTORY_EXEC_TIER=container`
 * cannot turn a worker thread into a container.
 */
export type CodeActExecutorIsolation =
  | "worker_thread"
  | "isolated_subprocess"
  | "isolated_container";

export type CodeActExecutionGate =
  | { allowed: true; isolation: "isolated_subprocess" | "isolated_container" }
  | {
      allowed: false;
      isolation: CodeActExecutorIsolation;
      failure: "execution_disabled" | "isolation_not_allowed";
      reason: string;
    };

/**
 * Fail-closed generated-code switch. Enabling the feature is two-factor:
 * an explicit operator opt-in AND an executor implementation that reports its
 * hard-coded, real subprocess/container boundary. A VM/worker implementation
 * always fails, even when an environment variable calls it a container.
 */
export function codeActExecutionGate(
  actualIsolation: CodeActExecutorIsolation,
  enabled = process.env.FACTORY_EXEC_GENERATED,
): CodeActExecutionGate {
  if (enabled !== "1") {
    return {
      allowed: false,
      isolation: actualIsolation,
      failure: "execution_disabled",
      reason:
        "generated CodeAct is disabled by default; set FACTORY_EXEC_GENERATED=1 only on a trusted isolated subprocess/container executor",
    };
  }
  if (
    actualIsolation !== "isolated_subprocess" &&
    actualIsolation !== "isolated_container"
  ) {
    return {
      allowed: false,
      isolation: actualIsolation,
      failure: "isolation_not_allowed",
      reason:
        "worker_thread/vm is not a generated-code security boundary; an actual isolated subprocess or one-shot container executor is required",
    };
  }
  return { allowed: true, isolation: actualIsolation };
}

/** Build-bound facts used by the remote sandbox workload. The worker result is
 * not resolved until `Worker.terminate()` has completed, but worker/vm is not a
 * privilege or credential boundary and therefore is never promotable. */
export const CODEACT_WORKER_ISOLATION_CONTRACT = Object.freeze({
  isolation: "worker_thread" as const,
  candidateEnvironment: "empty" as const,
  ambientProcessAccess: "unproven" as const,
  ambientNetworkAccess: "unproven" as const,
  terminationAwaited: true as const,
  promotable: false as const,
});

export type CodeActRpcMethod =
  | "reason"
  | "tool"
  | "memory.get"
  | "memory.put"
  | "memory.delete"
  | "memory.search"
  | "invoke"
  | "spawn";

export interface CodeActWorkerIdentity {
  agentName: string;
  tenantSlug: string;
  correlationId: string;
  subject?: string;
}

export interface CodeActWorkerOptions {
  timeoutMs: number;
  memoryMb: number;
  identity: CodeActWorkerIdentity;
  onRpc(method: CodeActRpcMethod, args: unknown[]): Promise<unknown>;
  onLog?(level: "info" | "warn" | "error", message: string, data?: unknown): void;
}

export type CodeActWorkerFailure =
  | "worker_start_failed"
  | "worker_timeout"
  | "worker_crashed"
  | "worker_no_result"
  | "load_failed"
  | "handler_failed"
  | "rpc_failed"
  | "result_unserializable"
  | "worker_termination_failed"
  | "kill_switch"
  | "isolation_not_allowed";

export type CodeActWorkerResult =
  | {
      ok: true;
      isolation: "worker_thread";
      result: Record<string, unknown>;
      emitted: Array<{ event: string; payload: Record<string, unknown> }>;
      durationMs: number;
      workerTerminated: true;
      candidateEnvironment: "empty";
    }
  | {
      ok: false;
      isolation: "worker_thread";
      failure: CodeActWorkerFailure;
      error: string;
      timedOut?: boolean;
      crashed?: boolean;
      durationMs: number;
      workerTerminated: true;
      candidateEnvironment: "empty";
    };

type CodeActWorkerCompletion =
  | {
      ok: true;
      result: Record<string, unknown>;
      emitted: Array<{ event: string; payload: Record<string, unknown> }>;
    }
  | {
      ok: false;
      failure: CodeActWorkerFailure;
      error: string;
      timedOut?: boolean;
      crashed?: boolean;
    };

interface WorkerMessage {
  kind?: string;
  id?: number;
  method?: CodeActRpcMethod;
  args?: unknown[];
  level?: "info" | "warn" | "error";
  message?: string;
  data?: unknown;
  ok?: boolean;
  result?: Record<string, unknown>;
  emitted?: Array<{ event: string; payload: Record<string, unknown> }>;
  stage?: "load" | "handler" | "serialize";
  error?: string;
}

function jsonWireValue(value: unknown): unknown {
  const encoded = JSON.stringify(value === undefined ? null : value);
  if (encoded === undefined) throw new TypeError("value has no JSON representation");
  return JSON.parse(encoded) as unknown;
}

// Kept as an inline CommonJS worker so this package runs identically from tsx
// source and from a compiled distribution without resolving a second entry
// file. `vm.compileFunction` loads the generated CommonJS module; generated
// code itself never receives `vm`, `typescript`, or the worker APIs.
const CODEACT_WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require("node:worker_threads");
const vm = require("node:vm");

// Never hand a host-realm object or callable directly to generated code. A
// host Function constructor is an escape hatch even when vm string code
// generation is disabled. Facades have null prototypes, bind methods to the
// hidden host value, and recursively facade every result.
const facadeCache = new WeakMap();
function safeFacade(value, boundThis, depth = 0) {
  if (value === null || value === undefined) return value;
  const kind = typeof value;
  if (kind !== "object" && kind !== "function") return value;
  const cacheable = kind === "object" || boundThis === undefined;
  if (cacheable && facadeCache.has(value)) return facadeCache.get(value);
  if (depth > 6) return undefined;
  if (kind === "function") {
    const wrapped = function(...args) {
      let output;
      try { output = Reflect.apply(value, boundThis, args); }
      catch (error) {
        if (!/class constructor/i.test(String(error && error.message || error))) throw error;
        output = Reflect.construct(value, args);
      }
      return safeFacade(output, undefined, depth + 1);
    };
    Object.setPrototypeOf(wrapped, null);
    if (cacheable) facadeCache.set(value, wrapped);
    return wrapped;
  }
  const facade = Object.create(null);
  facadeCache.set(value, facade);
  const names = new Set(Object.getOwnPropertyNames(value));
  const proto = Object.getPrototypeOf(value);
  if (proto && proto !== Object.prototype) {
    for (const name of Object.getOwnPropertyNames(proto)) names.add(name);
  }
  names.delete("constructor");
  names.delete("__proto__");
  for (const name of names) {
    try {
      // Never invoke a host accessor while constructing the membrane. Apart
      // from side effects, module getters may expose process-wide state that
      // was not part of the reviewed dependency surface.
      const ownDescriptor = Object.getOwnPropertyDescriptor(value, name);
      const prototypeDescriptor = ownDescriptor
        ? undefined
        : proto && Object.getOwnPropertyDescriptor(proto, name);
      const descriptor = ownDescriptor || prototypeDescriptor;
      if (!descriptor || !("value" in descriptor)) continue;
      const member = descriptor.value;
      if (typeof member === "function") facade[name] = safeFacade(member, value, depth + 1);
      else facade[name] = safeFacade(member, undefined, depth + 1);
    } catch { /* omit privileged/throwing accessors */ }
  }
  return Object.freeze(facade);
}

const pending = new Map();
let rpcSeq = 0;
parentPort.on("message", (message) => {
  if (!message || message.kind !== "rpc_result") return;
  const waiter = pending.get(message.id);
  if (!waiter) return;
  pending.delete(message.id);
  if (message.ok) waiter.resolve(message.value);
  else waiter.reject(new Error(message.error || "host RPC failed"));
});

function post(message) {
  parentPort.postMessage(message);
}

function jsonClone(value, label) {
  try {
    const encoded = JSON.stringify(value === undefined ? null : value);
    if (encoded === undefined) throw new TypeError("no JSON representation");
    return JSON.parse(encoded);
  } catch (error) {
    throw new TypeError(label + " is not JSON-serializable: " + String(error && error.message || error).slice(0, 400));
  }
}

function rpc(method, args) {
  const id = ++rpcSeq;
  const wireArgs = jsonClone(args, "RPC arguments");
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    post({ kind: "rpc", id, method, args: wireArgs });
  });
}

(async () => {
  try {
    const ts = require("typescript");
    const transpiled = ts.transpileModule(workerData.code, {
      reportDiagnostics: true,
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        esModuleInterop: true,
      },
    });
    const errors = (transpiled.diagnostics || []).filter((d) => d.category === ts.DiagnosticCategory.Error);
    if (errors.length) {
      const message = errors.slice(0, 5).map((d) => ts.flattenDiagnosticMessageText(d.messageText, " ")).join("; ");
      post({ kind: "result", ok: false, stage: "load", error: "TypeScript transpile failed: " + message });
      return;
    }

    let captured = null;
    const defineAgent = safeFacade((definition) => {
      if (!definition || typeof definition !== "object") throw new TypeError("defineAgent requires an object");
      captured = definition;
      return definition;
    });
    const allowed = new Set(workerData.allowlist);
    const runtimeFacade = Object.create(null);
    runtimeFacade.defineAgent = defineAgent;
    Object.freeze(runtimeFacade);
    const requireGenerated = safeFacade((id) => {
      if (id === "@agentic/runtime") return runtimeFacade;
      if (allowed.has(id)) return safeFacade(require(id));
      throw new Error("CodeAct import '" + id + "' is not allowed");
    });
    const moduleObject = Object.create(null);
    moduleObject.exports = Object.create(null);
    // Minimal global surface for authored handlers. There is deliberately no
    // process, fetch, Buffer, host console, or ambient require in this context.
    const context = vm.createContext({
      setTimeout: safeFacade(setTimeout),
      clearTimeout: safeFacade(clearTimeout),
      setInterval: safeFacade(setInterval),
      clearInterval: safeFacade(clearInterval),
      TextEncoder: safeFacade(globalThis.TextEncoder),
      TextDecoder: safeFacade(globalThis.TextDecoder),
      URL: safeFacade(globalThis.URL),
      URLSearchParams: safeFacade(globalThis.URLSearchParams),
    }, {
      // module, requireGenerated and timer callbacks necessarily cross the
      // realm boundary. Without this flag, constructor.constructor(...) can
      // compile a host-realm Function and recover the worker process.
      // The worker already has env:{}, but filesystem/network access would still
      // violate the candidate capability boundary.
      codeGeneration: { strings: false, wasm: false },
    });
    const load = vm.compileFunction(
      transpiled.outputText,
      ["require", "exports", "module", "defineAgent"],
      { filename: "__generated_agent__.js", parsingContext: context },
    );
    load(requireGenerated, moduleObject.exports, moduleObject, defineAgent);
    const exported = moduleObject.exports && typeof moduleObject.exports === "object"
      ? Object.values(moduleObject.exports)
      : [];
    const definition = captured || exported.find((value) => value && typeof value === "object" && typeof value.handler === "function");
    if (!definition || typeof definition.handler !== "function") {
      post({ kind: "result", ok: false, stage: "load", error: "generated module exposes no defineAgent handler" });
      return;
    }

    const emitted = [];
    const identity = workerData.identity;
    const ctx = {
      agentName: identity.agentName,
      tenantSlug: identity.tenantSlug,
      correlationId: identity.correlationId,
      subject: identity.subject,
      reason: (systemPrompt, input) => rpc("reason", [systemPrompt, input]),
      tool: (name, args) => rpc("tool", [name, args]),
      tools: { run: (name, args) => rpc("tool", [name, args]) },
      emit(event, payload = {}) {
        if (typeof event !== "string" || !event.trim()) throw new TypeError("emit event must be a non-empty string");
        const wire = jsonClone({ event, payload }, "emit payload");
        emitted.push(wire);
      },
      memory: {
        get: (key, scope) => rpc("memory.get", [key, scope]),
        put: (key, value, scope) => rpc("memory.put", [key, value, scope]),
        delete: (key, scope) => rpc("memory.delete", [key, scope]),
        search: (query, k) => rpc("memory.search", [query, k]),
      },
      invoke: (agentRef, input, options) => rpc("invoke", [agentRef, input, options]),
      spawn: (task, input, options) => rpc("spawn", [task, input, options]),
      log(level, message, data) {
        try { post({ kind: "log", level, message: String(message), data: jsonClone(data, "log data") }); }
        catch (_) { /* logging is non-authoritative */ }
      },
    };

    let value;
    try {
      value = await definition.handler(workerData.input, ctx);
    } catch (error) {
      post({ kind: "result", ok: false, stage: "handler", error: String(error && error.message || error).slice(0, 800) });
      return;
    }
    let result;
    try {
      const normalized = value && typeof value === "object" && !Array.isArray(value) ? value : { result: value };
      result = jsonClone(normalized, "handler result");
    } catch (error) {
      post({ kind: "result", ok: false, stage: "serialize", error: String(error && error.message || error).slice(0, 800) });
      return;
    }
    post({ kind: "result", ok: true, result, emitted });
  } catch (error) {
    post({ kind: "result", ok: false, stage: "load", error: String(error && error.message || error).slice(0, 800) });
  }
})();
`;

/** Execute one generated handler behind a worker + RPC boundary. Never throws. */
export function executeCodeActWorker(
  code: string,
  input: Record<string, unknown>,
  options: CodeActWorkerOptions,
): Promise<CodeActWorkerResult> {
  const started = Date.now();
  const duration = () => Date.now() - started;
  const gate = codeActExecutionGate("worker_thread");
  if (!gate.allowed) {
    return Promise.resolve({
      ok: false,
      isolation: "worker_thread",
      failure:
        gate.failure === "execution_disabled"
          ? "kill_switch"
          : "isolation_not_allowed",
      error: gate.reason,
      durationMs: duration(),
      workerTerminated: true,
      candidateEnvironment: "empty",
    });
  }

  return new Promise<CodeActWorkerResult>((resolve) => {
    let settled = false;
    let worker: Worker | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let killSwitchPoll: ReturnType<typeof setInterval> | undefined;

    const finish = (result: CodeActWorkerCompletion) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (killSwitchPoll) clearInterval(killSwitchPoll);
      const complete = (completion: CodeActWorkerCompletion) => resolve({
        ...completion,
        isolation: "worker_thread",
        durationMs: duration(),
        workerTerminated: true,
        candidateEnvironment: "empty",
      } as CodeActWorkerResult);
      if (!worker) {
        complete(result);
        return;
      }
      void worker.terminate().then(
        () => complete(result),
        (error) => complete({
          ok: false,
          failure: "worker_termination_failed",
          error: `worker termination failed: ${String((error as Error)?.message ?? error).slice(0, 500)}`,
        }),
      );
    };

    try {
      worker = new Worker(CODEACT_WORKER_SOURCE, {
        eval: true,
        env: {},
        workerData: {
          code,
          input: jsonWireValue(input),
          identity: jsonWireValue(options.identity),
          allowlist: [...GENERATED_CODE_ALLOWLIST],
        },
        resourceLimits: {
          maxOldGenerationSizeMb: options.memoryMb,
          maxYoungGenerationSizeMb: Math.max(16, Math.floor(options.memoryMb / 4)),
          codeRangeSizeMb: 64,
          stackSizeMb: 4,
        },
      });
    } catch (error) {
      finish({
        ok: false,
        failure: "worker_start_failed",
        error: `worker start failed: ${String((error as Error)?.message ?? error).slice(0, 500)}`,
      });
      return;
    }

    timeout = setTimeout(() => {
      finish({
        ok: false,
        failure: "worker_timeout",
        error: `generated handler exceeded ${options.timeoutMs}ms; worker terminated`,
        timedOut: true,
      });
    }, options.timeoutMs);
    timeout.unref?.();

    // A future safe executor must retain the live-switch behaviour. This branch
    // is currently unreachable for the worker implementation because the gate
    // above permanently classifies worker_thread as non-promotable.
    killSwitchPoll = setInterval(() => {
      if (process.env.FACTORY_EXEC_GENERATED !== "1") {
        finish({
          ok: false,
          failure: "kill_switch",
          error: "FACTORY_EXEC_GENERATED is no longer exactly 1; generated handler terminated",
        });
      }
    }, 100);
    killSwitchPoll.unref?.();

    worker.on("message", (message: WorkerMessage) => {
      if (settled || !message || typeof message !== "object") return;
      if (message.kind === "log") {
        try {
          options.onLog?.(
            message.level === "warn" || message.level === "error" ? message.level : "info",
            message.message ?? "",
            message.data,
          );
        } catch { /* logging must not alter execution */ }
        return;
      }
      if (message.kind === "rpc") {
        const id = message.id;
        const method = message.method;
        if (typeof id !== "number" || !method) {
          finish({ ok: false, failure: "rpc_failed", error: "worker sent a malformed RPC request" });
          return;
        }
        void options
          .onRpc(method, Array.isArray(message.args) ? message.args : [])
          .then((value) => {
            if (settled) return;
            let wire: unknown;
            try { wire = jsonWireValue(value); }
            catch (error) {
              finish({
                ok: false,
                failure: "rpc_failed",
                error: `RPC ${method} returned a non-JSON value: ${String((error as Error)?.message ?? error).slice(0, 400)}`,
              });
              return;
            }
            try { worker?.postMessage({ kind: "rpc_result", id, ok: true, value: wire }); }
            catch (error) {
              finish({
                ok: false,
                failure: "rpc_failed",
                error: `RPC ${method} response could not be delivered: ${String((error as Error)?.message ?? error).slice(0, 400)}`,
              });
            }
          })
          .catch((error) => {
            if (settled) return;
            const detail = String((error as Error)?.message ?? error).slice(0, 600);
            // A generated handler is not allowed to catch-and-hide a failed
            // host capability. The host terminates the isolate immediately.
            finish({ ok: false, failure: "rpc_failed", error: `RPC ${method} failed: ${detail}` });
          });
        return;
      }
      if (message.kind !== "result") return;
      if (message.ok === true && message.result && typeof message.result === "object") {
        finish({
          ok: true,
          result: message.result,
          emitted: Array.isArray(message.emitted) ? message.emitted : [],
        });
        return;
      }
      const failure: CodeActWorkerFailure =
        message.stage === "handler"
          ? "handler_failed"
          : message.stage === "serialize"
            ? "result_unserializable"
            : "load_failed";
      finish({ ok: false, failure, error: message.error ?? "worker reported generated-code failure" });
    });

    worker.on("error", (error: Error) => {
      finish({
        ok: false,
        failure: "worker_crashed",
        error: `worker crashed: ${String(error?.message ?? error).slice(0, 500)}`,
        crashed: true,
      });
    });
    worker.on("exit", (exitCode) => {
      if (settled) return;
      if (exitCode === 0) {
        finish({
          ok: false,
          failure: "worker_no_result",
          error: "worker exited cleanly without an execution result",
        });
      } else {
        finish({
          ok: false,
          failure: "worker_crashed",
          error: `worker exited abnormally (code=${exitCode}); possible memory-limit breach`,
          crashed: true,
        });
      }
    });
  });
}
