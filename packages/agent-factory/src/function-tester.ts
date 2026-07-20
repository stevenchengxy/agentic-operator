// #P2.5-Tester — 把一个 ts_function_module(inngest.createFunction 形态,renderTsFunctionModule 产出)
// 转成【自包含可跑】的测试模块:注入 mock inngest/step/logger,调用它的 handler,回收 emits。
// 目的:生成→【真跑 handler 逻辑】→验收,而不是只看它编不编译过。研究证据(AgentCoder/Self-Collab):
// 代码生成的增益主要来自"加一个真执行的验证角色",而非多派 leader。
//
// 这一层是【纯代码变换】(不依赖 runtime,不真执行)——它产出一个可以喂给 runGeneratedModule(P0a worker
// 隔离)的字符串。真执行发生在调用点(apps/api,同时依赖 agent-factory + runtime)。

import type {
  FunctionJsonType,
  FunctionTestAssertions,
  FunctionValueAssertion,
} from "./function-test-contract";

/** 把 ts_function_module 源码变换成一个自包含、可在隔离里执行的测试模块。
 *  - 剥掉真实 import(inngest client 等——隔离里本就 stub;这里换成 mock);
 *  - `inngest.createFunction(...)` 捕获 {cfg,trig,handler} 到 __fn;
 *  - 追加 `export async function __run(event)`:mock step(run=执行 fn、sendEvent=收 emit、invoke=空)、
 *    mock logger,调用 handler,回收 emits + emitNames,结构化返回(never throw)。 */
export function harnessTsModuleForTest(moduleCode: string): string {
  // Keep terminal-vs-retry behavior observable after stripping real imports.
  // Production uses Inngest's class; the harness only needs the same name and
  // throwable shape so generated catch blocks do not turn terminal into a
  // successful/failure-event return.
  const withNonRetriableShim = moduleCode.replace(
    /^\s*import\s+\{\s*NonRetriableError\s*\}\s+from\s+['"]inngest['"]\s*;?\s*$/m,
    `class NonRetriableError extends Error { constructor(message, options) { super(message, options); this.name = "NonRetriableError"; } }`,
  );
  // 去掉真实的 import 语句(带引号的模块说明符),保留以 // 开头的注释 import(它们只是文档)。
  const bodyNoImports = withNonRetriableShim
    .split("\n")
    .filter((ln) => !/^\s*import\s.+from\s+['"][^'"]+['"]\s*;?\s*$/.test(ln))
    .join("\n")
    // 把对 inngest 的调用改指向 mock(渲染器只用 inngest.createFunction 一处)。
    .replace(/\binngest\.createFunction\b/g, "__inngest.createFunction");

  return [
    "// [test-harness] 自包含可跑版:mock inngest/step/logger + 注入缝测试替身,调用 handler 回收 emits。由 harnessTsModuleForTest 生成。",
    "let __fn = null;",
    "const __inngest = { createFunction: (cfg, trig, handler) => { __fn = { cfg, trig, handler }; return __fn; } };",
    "",
    bodyNoImports,
    "",
    "export async function __run(event, opts) {",
    "  const __emits = [];",
    "  const __toolCalls = [];",
    "  const __runStepIds = [];",
    "  const __runSteps = [];",
    "  const __fixtureErrors = [];",
    "  const __stable = (value) => { if (value === undefined) return 'null'; if (value === null || typeof value !== 'object') return JSON.stringify(value); if (Array.isArray(value)) return '[' + value.map(__stable).join(',') + ']'; return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + __stable(value[key])).join(',') + '}'; };",
    "  const __hash = (value) => { let hash = 2166136261 >>> 0; for (let i = 0; i < value.length; i++) { hash ^= value.charCodeAt(i); hash = Math.imul(hash, 16777619) >>> 0; } return hash.toString(16).padStart(8, '0'); };",
    "  const step = {",
    "    run: async (_id, fn) => { __runStepIds.push(_id); const value = await fn(); __runSteps.push({ id: _id, result: value }); return value; },",
    "    sendEvent: async (_id, ev) => { __emits.push(ev); },",
    "    invoke: async (_id, input) => {",
    "      __runStepIds.push(_id);",
    "      const ref = input && input.function && input.function.__agentRef ? String(input.function.__agentRef) : '';",
    "      if (!ref) { const msg = 'invoke target was not resolved for durable step: ' + String(_id ?? ''); __fixtureErrors.push(msg); throw new Error('[park] ' + msg); }",
    "      const name = 'invoke:' + ref; const args = input && input.data; __toolCalls.push({ name, args, timeout: input && input.timeout, stepId: _id });",
    "      if (opts && typeof opts.invoke === 'function') { const value = await opts.invoke(ref, args, { timeout: input && input.timeout, stepId: _id }); __runSteps.push({ id: _id, result: value }); return value; }",
    "      if (opts && opts.invokeResults && Object.prototype.hasOwnProperty.call(opts.invokeResults, ref)) { const value = opts.invokeResults[ref]; __runSteps.push({ id: _id, result: value }); return value; }",
    "      if (opts && opts.invokeResults && Object.prototype.hasOwnProperty.call(opts.invokeResults, String(_id ?? ''))) { const value = opts.invokeResults[String(_id ?? '')]; __runSteps.push({ id: _id, result: value }); return value; }",
    "      const msg = 'missing explicit invoke fixture: ' + ref; __fixtureErrors.push(msg); throw new Error('[park] ' + msg);",
    "    },",
    "  };",
    "  const logger = { info: () => {}, warn: () => {}, error: () => {} };",
    "  if (!__fn || typeof __fn.handler !== 'function') return { ran: false, error: '未捕获到 createFunction/handler' };",
    "  // 注入缝测试替身(#TRUE-CODE):生成模块的 callTool/reasonCore fail-close 依赖这两个全局——",
    "  // harness 不再内置 pass:true / 工具成功。生产函数测试里，外部工具只能由",
    "  // definition-bound probe/record cassette 回放；静态 toolResults 不是工具证据。",
    "  // 缺证据或实际 argsHash 不匹配即 fail-close，并在 fixtureErrors 中留下原因。跑完恢复原值。",
    "  const __g = globalThis;",
    "  const __prevTool = __g.__agentTool; const __prevReason = __g.__agentReason; const __prevInvokeTarget = __g.__agentInvokeTarget;",
    "  const __has = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);",
    "  __g.__agentTool = async (name, args) => {",
    "    __toolCalls.push({ name, args });",
    "    // opts.tool 只是包内测试的函数注入缝；testGeneratedFunction 的可序列化边界无法传入它。",
    "    if (opts && typeof opts.tool === 'function') return opts.tool(name, args);",
    "    if (__has(opts && opts.toolCassettes, name)) {",
    "      const document = opts.toolCassettes[name];",
    "      const evidenceMode = document && document.evidence && document.evidence.mode;",
    "      const evidenceOk = document && document.version === 1 && document.tool && document.tool.name === name && typeof document.tool.definitionHash === 'string' && document.tool.definitionHash.length > 0 && document.evidence && typeof document.evidence.recordedAt === 'string' && document.evidence.recordedAt.length > 0 && ['live-probe', 'signed-fixture', 'runtime-record'].includes(evidenceMode) && Array.isArray(document.entries);",
    "      if (!evidenceOk) { const msg = '工具「' + name + '」的 cassette 没有通过 definition/probe/record 证据校验，本次函数测试已阻断 (cassette is not approved evidence)'; __fixtureErrors.push(msg); throw new Error('[park] ' + msg); }",
    "      const argsHash = __hash(__stable(args ?? {}));",
    "      const entry = document && Array.isArray(document.entries) ? document.entries.find((candidate) => candidate && candidate.request && candidate.request.kind === 'tool' && candidate.request.toolName === name && candidate.request.argsHash === argsHash) : undefined;",
    "      if (entry && entry.response && Object.prototype.hasOwnProperty.call(entry.response, 'body')) {",
    "        const status = Number(entry.response.status);",
    "        if (Number.isFinite(status) && status >= 200 && status < 300) return entry.response.body;",
    "        const msg = '工具「' + name + '」的证据 cassette 返回 HTTP ' + String(entry.response.status) + ' (evidence cassette returned HTTP ' + String(entry.response.status) + ' for ' + name + ')';",
    "        if (!(opts && opts.allowEvidenceFailures === true)) __fixtureErrors.push(msg);",
    "        throw new Error('[fixture] ' + msg);",
    "      }",
    "      const msg = '工具「' + name + '」确实有证据，但没有一条与这次实际参数完全匹配，本次函数测试已阻断 (no evidence cassette matches tool arguments: ' + name + ', argsHash=' + argsHash + ')'; __fixtureErrors.push(msg); throw new Error('[park] ' + msg);",
    "    }",
    "    if (__has(opts && opts.blockedToolReasons, name)) { const msg = String(opts.blockedToolReasons[name]); __fixtureErrors.push(msg); throw new Error('[park] ' + msg); }",
    "    const msg = '工具「' + name + '」没有已批准的 cassette/probe/record 证据，不会伪造成功，也不会调用真实外部系统 (missing approved cassette/probe/record evidence)'; __fixtureErrors.push(msg); throw new Error('[park] ' + msg);",
    "  };",
    "  __g.__agentReason = (opts && typeof opts.reason === 'function') ? opts.reason : async () => {",
    "    if (opts && opts.reasonResult && typeof opts.reasonResult === 'object') return opts.reasonResult;",
    "    const msg = 'missing explicit reason fixture'; __fixtureErrors.push(msg); return { _reasonFailed: true, error: msg };",
    "  };",
    "  __g.__agentInvokeTarget = (ref) => ({ __agentRef: String(ref) });",
    "  try {",
    "    const result = await __fn.handler({ event: event ?? {}, step, logger });",
    "    return { ran: __fixtureErrors.length === 0, result, emits: __emits, emitNames: __emits.map((e) => e && e.name).filter(Boolean), toolCalls: __toolCalls, runStepIds: __runStepIds, runSteps: __runSteps, fixtureErrors: __fixtureErrors };",
    "  } catch (e) {",
    "    return { ran: false, error: String((e && e.message) || e), emits: __emits, emitNames: __emits.map((e) => e && e.name).filter(Boolean), toolCalls: __toolCalls, runStepIds: __runStepIds, runSteps: __runSteps, fixtureErrors: __fixtureErrors };",
    "  } finally {",
    "    __g.__agentTool = __prevTool; __g.__agentReason = __prevReason; __g.__agentInvokeTarget = __prevInvokeTarget;",
    "  }",
    "}",
    "",
  ].join("\n");
}

/** Tester 验收判据(纯):一次 handler 执行结果 → 通过/失败 + 原因。 */
export interface FunctionTestVerdict {
  ran: boolean;
  /** handler 是否发出了【期望的】事件(若给了 expectEmits)。 */
  emittedExpected: boolean;
  emitNames: string[];
  error?: string;
  pass: boolean;
  reasons: string[];
  /** Missing scripted dependencies make a structural test invalid, never green. */
  fixtureErrors: string[];
  /** Assertion failures are kept separate from fixture/infrastructure errors
   * so a reviewer can see whether code or evidence is missing. */
  assertionFailures: string[];
  unexpectedEmits: string[];
  forbiddenEmitsObserved: string[];
}

interface FunctionHarnessObservation {
  ran?: boolean;
  error?: string;
  result?: unknown;
  state?: unknown;
  emits?: Array<{ name?: unknown; data?: unknown }>;
  emitNames?: string[];
  toolCalls?: Array<{ name?: unknown; args?: unknown }>;
  runSteps?: Array<{ id?: unknown; result?: unknown }>;
  fixtureErrors?: string[];
}

function hasOwn(object: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function readPath(value: unknown, path: string): { found: boolean; value: unknown } {
  if (!path.trim()) return { found: true, value };
  let current = value;
  for (const part of path.split(".")) {
    if (!current || typeof current !== "object" || Array.isArray(current) || !hasOwn(current, part)) {
      return { found: false, value: undefined };
    }
    current = (current as Record<string, unknown>)[part];
  }
  return { found: true, value: current };
}

function jsonEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((item, index) => jsonEqual(item, right[index]));
  }
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index] && jsonEqual(leftRecord[key], rightRecord[key]));
}

function jsonPartial(actual: unknown, expected: unknown): boolean {
  if (!expected || typeof expected !== "object") return Object.is(actual, expected);
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && actual.length >= expected.length && expected.every((item, index) => jsonPartial(actual[index], item));
  }
  if (!actual || typeof actual !== "object" || Array.isArray(actual)) return false;
  const actualRecord = actual as Record<string, unknown>;
  return Object.entries(expected as Record<string, unknown>).every(([key, value]) => hasOwn(actualRecord, key) && jsonPartial(actualRecord[key], value));
}

function isJsonType(value: unknown, expected: FunctionJsonType): boolean {
  if (expected === "null") return value === null;
  if (expected === "array") return Array.isArray(value);
  if (expected === "object") return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  if (expected === "integer") return typeof value === "number" && Number.isInteger(value);
  return typeof value === expected;
}

function valueAssertionFailures(label: string, value: unknown, contract: FunctionValueAssertion | undefined): string[] {
  if (!contract) return [];
  const failures: string[] = [];
  for (const path of contract.requiredPaths ?? []) {
    if (!readPath(value, path).found) failures.push(`${label} 缺少字段 ${path}`);
  }
  for (const [path, expectedType] of Object.entries(contract.types ?? {})) {
    const observed = readPath(value, path);
    if (!observed.found) failures.push(`${label} 缺少需校验类型的字段 ${path}`);
    else if (!isJsonType(observed.value, expectedType)) failures.push(`${label}.${path || "(root)"} 类型应为 ${expectedType}`);
  }
  if (hasOwn(contract, "partial") && !jsonPartial(value, contract.partial)) failures.push(`${label} 未包含约定的关键字段/值`);
  if (hasOwn(contract, "equals") && !jsonEqual(value, contract.equals)) failures.push(`${label} 与约定的完整值不一致`);
  return failures;
}

/** Pure contract grader shared by the rendered-module and exact CodeAct
 * regression paths. `expectEmits` keeps its legacy one-of meaning. When it
 * identifies one deterministic event, exact-set checking defaults on. */
export function assertionFailuresForObservation(
  observation: FunctionHarnessObservation,
  opts: { expectEmits?: string[]; assertions?: FunctionTestAssertions; exactEmits?: boolean } = {},
): { failures: string[]; unexpectedEmits: string[]; forbiddenEmitsObserved: string[] } {
  const failures: string[] = [];
  const assertions = opts.assertions ?? {};
  const emitNames = Array.isArray(observation.emitNames) ? observation.emitNames : [];
  const expected = [...new Set(opts.expectEmits ?? [])];
  const assertedEvents = (assertions.emits ?? []).map((entry) => entry.event).filter(Boolean);
  const allowed = new Set([...expected, ...assertedEvents]);
  const exact = opts.exactEmits ?? assertions.exactEmits ?? expected.length === 1;
  const unexpectedEmits = exact ? [...new Set(emitNames.filter((event) => !allowed.has(event)))] : [];
  if (unexpectedEmits.length) failures.push(`发出了未约定的额外事件: ${unexpectedEmits.join("、")}`);

  const forbiddenSet = new Set((assertions.forbiddenEmits ?? []).filter(Boolean));
  const forbiddenEmitsObserved = [...new Set(emitNames.filter((event) => forbiddenSet.has(event)))];
  if (forbiddenEmitsObserved.length) failures.push(`发出了禁用事件: ${forbiddenEmitsObserved.join("、")}`);

  const emits = Array.isArray(observation.emits) ? observation.emits : [];
  for (const contract of assertions.emits ?? []) {
    const matching = emits.filter((entry) => entry?.name === contract.event);
    if (contract.count === undefined && matching.length === 0) failures.push(`事件 ${contract.event} 没有发出`);
    if (contract.count !== undefined && matching.length !== contract.count) failures.push(`事件 ${contract.event} 应发出 ${contract.count} 次，实际 ${matching.length} 次`);
    matching.forEach((entry, index) => failures.push(...valueAssertionFailures(`事件 ${contract.event} 第 ${index + 1} 次 payload`, entry.data, contract.payload)));
  }

  const toolCalls = Array.isArray(observation.toolCalls) ? observation.toolCalls : [];
  for (const contract of assertions.toolCalls ?? []) {
    const matching = toolCalls.filter((entry) => entry?.name === contract.tool);
    if (contract.count === undefined && matching.length === 0) failures.push(`工具 ${contract.tool} 没有被调用`);
    if (contract.count !== undefined && matching.length !== contract.count) failures.push(`工具 ${contract.tool} 应调用 ${contract.count} 次，实际 ${matching.length} 次`);
    matching.forEach((entry, index) => failures.push(...valueAssertionFailures(`工具 ${contract.tool} 第 ${index + 1} 次参数`, entry.args, contract.args)));
  }

  const runSteps = Array.isArray(observation.runSteps) ? observation.runSteps : [];
  for (const contract of assertions.stepResults ?? []) {
    const matching = runSteps.filter((entry) => entry?.id === contract.stepId);
    if (contract.count === undefined && matching.length === 0) failures.push(`步骤 ${contract.stepId} 没有执行`);
    if (contract.count !== undefined && matching.length !== contract.count) failures.push(`步骤 ${contract.stepId} 应执行 ${contract.count} 次，实际 ${matching.length} 次`);
    matching.forEach((entry, index) => failures.push(...valueAssertionFailures(`步骤 ${contract.stepId} 第 ${index + 1} 次结果`, entry.result, contract.result)));
  }
  failures.push(...valueAssertionFailures("handler 返回值", observation.result, assertions.result));
  failures.push(...valueAssertionFailures("执行状态", observation.state, assertions.state));
  return { failures, unexpectedEmits, forbiddenEmitsObserved };
}

/** 从一次隔离执行的原始结果 + 期望 emit 集,算出 Tester 判据。runResult 形如 runGeneratedModule 的
 *  result 字段(= __run 的返回:{ran, result?, emits?, emitNames?, error?})。 */
export function gradeFunctionTest(
  runResult: { ok?: boolean; result?: unknown; error?: string; timedOut?: boolean; crashed?: boolean } | null,
  opts: { expectEmits?: string[]; assertions?: FunctionTestAssertions; exactEmits?: boolean } = {},
): FunctionTestVerdict {
  const reasons: string[] = [];
  if (!runResult || runResult.ok === false) {
    const why = runResult?.timedOut ? "隔离执行超时" : runResult?.crashed ? "隔离执行崩溃" : runResult?.error ?? "隔离未产出结果";
    return { ran: false, emittedExpected: false, emitNames: [], error: why, pass: false, reasons: [`未跑通:${why}`], fixtureErrors: [], assertionFailures: [], unexpectedEmits: [], forbiddenEmitsObserved: [] };
  }
  const r = (runResult.result ?? {}) as FunctionHarnessObservation;
  const ran = r.ran === true;
  const emitNames = Array.isArray(r.emitNames) ? r.emitNames : [];
  const fixtureErrors = Array.isArray(r.fixtureErrors) ? r.fixtureErrors : [];
  if (!ran) reasons.push(`handler 抛错/未跑通:${r.error ?? "未知"}`);
  else reasons.push(`handler 真跑通,发出事件:${emitNames.join("、") || "(无)"}`);
  const expect = opts.expectEmits ?? [];
  const emittedExpected = expect.length === 0 ? ran : expect.some((e) => emitNames.includes(e));
  if (expect.length && !emittedExpected) reasons.push(`期望 emit 之一 [${expect.join("、")}] 未出现`);
  if (fixtureErrors.length) reasons.push(`测试 fixture 不完整:${fixtureErrors.join("；")}`);
  const assertionResult = assertionFailuresForObservation(r, opts);
  reasons.push(...assertionResult.failures);
  return {
    ran,
    emittedExpected,
    emitNames,
    error: r.error,
    pass: ran && emittedExpected && fixtureErrors.length === 0 && assertionResult.failures.length === 0,
    reasons,
    fixtureErrors,
    assertionFailures: assertionResult.failures,
    unexpectedEmits: assertionResult.unexpectedEmits,
    forbiddenEmitsObserved: assertionResult.forbiddenEmitsObserved,
  };
}
