// #P2.5-Tester — 把一个 ts_function_module(inngest.createFunction 形态,renderTsFunctionModule 产出)
// 转成【自包含可跑】的测试模块:注入 mock inngest/step/logger,调用它的 handler,回收 emits。
// 目的:生成→【真跑 handler 逻辑】→验收,而不是只看它编不编译过。研究证据(AgentCoder/Self-Collab):
// 代码生成的增益主要来自"加一个真执行的验证角色",而非多派 leader。
//
// 这一层是【纯代码变换】(不依赖 runtime,不真执行)——它产出一个可以喂给 runGeneratedModule(P0a worker
// 隔离)的字符串。真执行发生在调用点(apps/api,同时依赖 agent-factory + runtime)。

/** 把 ts_function_module 源码变换成一个自包含、可在隔离里执行的测试模块。
 *  - 剥掉真实 import(inngest client 等——隔离里本就 stub;这里换成 mock);
 *  - `inngest.createFunction(...)` 捕获 {cfg,trig,handler} 到 __fn;
 *  - 追加 `export async function __run(event)`:mock step(run=执行 fn、sendEvent=收 emit、invoke=空)、
 *    mock logger,调用 handler,回收 emits + emitNames,结构化返回(never throw)。 */
export function harnessTsModuleForTest(moduleCode: string): string {
  // 去掉真实的 import 语句(带引号的模块说明符),保留以 // 开头的注释 import(它们只是文档)。
  const bodyNoImports = moduleCode
    .split("\n")
    .filter((ln) => !/^\s*import\s.+from\s+['"][^'"]+['"]\s*;?\s*$/.test(ln))
    .join("\n")
    // 把对 inngest 的调用改指向 mock(渲染器只用 inngest.createFunction 一处)。
    .replace(/\binngest\.createFunction\b/g, "__inngest.createFunction");

  return [
    "// [test-harness] 自包含可跑版:mock inngest/step/logger,调用 handler 回收 emits。由 harnessTsModuleForTest 生成。",
    "let __fn = null;",
    "const __inngest = { createFunction: (cfg, trig, handler) => { __fn = { cfg, trig, handler }; return __fn; } };",
    "",
    bodyNoImports,
    "",
    "export async function __run(event) {",
    "  const __emits = [];",
    "  const step = {",
    "    run: async (_id, fn) => await fn(),",
    "    sendEvent: async (_id, ev) => { __emits.push(ev); },",
    "    invoke: async () => ({}),",
    "  };",
    "  const logger = { info: () => {}, warn: () => {}, error: () => {} };",
    "  if (!__fn || typeof __fn.handler !== 'function') return { ran: false, error: '未捕获到 createFunction/handler' };",
    "  try {",
    "    const result = await __fn.handler({ event: event ?? {}, step, logger });",
    "    return { ran: true, result, emits: __emits, emitNames: __emits.map((e) => e && e.name).filter(Boolean) };",
    "  } catch (e) {",
    "    return { ran: false, error: String((e && e.message) || e), emits: __emits, emitNames: __emits.map((e) => e && e.name).filter(Boolean) };",
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
}

/** 从一次隔离执行的原始结果 + 期望 emit 集,算出 Tester 判据。runResult 形如 runGeneratedModule 的
 *  result 字段(= __run 的返回:{ran, result?, emits?, emitNames?, error?})。 */
export function gradeFunctionTest(
  runResult: { ok?: boolean; result?: unknown; error?: string; timedOut?: boolean; crashed?: boolean } | null,
  opts: { expectEmits?: string[] } = {},
): FunctionTestVerdict {
  const reasons: string[] = [];
  if (!runResult || runResult.ok === false) {
    const why = runResult?.timedOut ? "隔离执行超时" : runResult?.crashed ? "隔离执行崩溃" : runResult?.error ?? "隔离未产出结果";
    return { ran: false, emittedExpected: false, emitNames: [], error: why, pass: false, reasons: [`未跑通:${why}`] };
  }
  const r = (runResult.result ?? {}) as { ran?: boolean; error?: string; emitNames?: string[] };
  const ran = r.ran === true;
  const emitNames = Array.isArray(r.emitNames) ? r.emitNames : [];
  if (!ran) reasons.push(`handler 抛错/未跑通:${r.error ?? "未知"}`);
  else reasons.push(`handler 真跑通,发出事件:${emitNames.join("、") || "(无)"}`);
  const expect = opts.expectEmits ?? [];
  const emittedExpected = expect.length === 0 ? ran : expect.some((e) => emitNames.includes(e));
  if (expect.length && !emittedExpected) reasons.push(`期望 emit 之一 [${expect.join("、")}] 未出现`);
  return { ran, emittedExpected, emitNames, error: r.error, pass: ran && emittedExpected, reasons };
}
