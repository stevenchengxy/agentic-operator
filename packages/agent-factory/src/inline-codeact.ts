/**
 * Inline CodeAct — 系统 A 的即席代码执行（G4，附录 B / 架构书 §1.5 内部 CodeAct）。
 *
 * 生成系统的角色在"消化不动"时除了派认知专家（LLM 分治），还可以【写一小段分析代码
 * 真跑】：对本体/规格做确定性统计、交叉核对、图计算——LLM 数不清 262 条规则的分布，
 * 代码一趟循环就数清了。这是把「代码做骨架、模型做关节」贯彻到系统 A 自身。
 *
 * 安全模型（与 codegen/spawn 同一信任级：大脑亲笔的代码，AST 审后跑）：
 *   1. AST 级危险 API 审查（lintInlineAnalysis：禁 import/require/eval/Function/process/fetch…）；
 *   2. 执行时全局遮蔽（new Function 形参把 require/process/fetch/globalThis… 全部遮成 undefined）；
 *   3. 超时竞速（默认 3s）+ 结果必须 JSON 可序列化 + 输出封顶。
 *   纯计算沙盒：不给 I/O、不给网络、不给模块系统——只给 input 和标准 JS 内建。
 */

export interface InlineAnalysisResult {
  ok: boolean;
  /** JSON-serializable result returned by the code (capped). */
  result?: unknown;
  error?: string;
  durationMs: number;
}

const FORBIDDEN_SOURCE = /\b(require|process|globalThis|fetch|XMLHttpRequest|WebSocket|Deno|Bun|child_process|fs|net|http|https|eval|Function|constructor\s*\[|import\s*\(|__proto__)\b|\bimport\s+/;

/** AST lint via typescript when available; regex floor otherwise. Same posture as lintSpawnCode. */
export async function lintInlineAnalysis(code: string): Promise<{ ok: boolean; violations: string[] }> {
  const violations: string[] = [];
  if (!code || code.trim().length < 10) return { ok: false, violations: ["代码为空或过短"] };
  if (code.length > 12_000) return { ok: false, violations: ["代码过长（>12k 字符）"] };
  let astChecked = false;
  try {
    const ts = await Promise.race([
      import("typescript"),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("ts import timeout")), 5000).unref?.()),
    ]);
    const sf = ts.createSourceFile("__inline__.ts", code, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
    const bad = new Set<string>();
    const visit = (n: import("typescript").Node): void => {
      if (ts.isImportDeclaration(n) || ts.isImportEqualsDeclaration(n)) bad.add("import");
      else if (ts.isCallExpression(n)) {
        const ex = n.expression;
        if (ts.isIdentifier(ex) && ["require", "eval", "Function", "fetch"].includes(ex.text)) bad.add(`${ex.text}()`);
        else if (ex.kind === ts.SyntaxKind.ImportKeyword) bad.add("import()");
      } else if (ts.isNewExpression(n) && ts.isIdentifier(n.expression) && ["Function", "WebSocket", "XMLHttpRequest"].includes(n.expression.text)) bad.add(`new ${n.expression.text}()`);
      else if (ts.isIdentifier(n) && ["process", "globalThis", "Deno", "Bun"].includes(n.text)) bad.add(n.text);
      else if (ts.isPropertyAccessExpression(n) && n.name.text === "__proto__") bad.add("__proto__");
      ts.forEachChild(n, visit);
    };
    visit(sf);
    astChecked = true;
    for (const b of bad) violations.push(`危险 API：${b}`);
  } catch {
    /* fall through to regex floor */
  }
  if (!astChecked) {
    const m = code.match(FORBIDDEN_SOURCE);
    if (m) violations.push(`危险 API：${m[0].slice(0, 30)}`);
  }
  // 同步死循环无法被进程内超时抢占（事件循环被锁死）——启发式直接驳回。
  if (/while\s*\(\s*(true|1)\s*\)|for\s*\(\s*;\s*;\s*\)/.test(code)) violations.push("疑似无界同步循环（while(true)/for(;;)）——请写有界循环");
  return { ok: violations.length === 0, violations };
}

/** Execute brain-authored analysis code against a JSON input. Never throws. */
export async function runInlineAnalysis(code: string, input: unknown, opts?: { timeoutMs?: number }): Promise<InlineAnalysisResult> {
  const started = Date.now();
  const lint = await lintInlineAnalysis(code);
  if (!lint.ok) return { ok: false, error: `安审驳回：${lint.violations.join("；")}`, durationMs: Date.now() - started };
  try {
    // 形参遮蔽：即使 lint 漏网，运行时这些名字也是 undefined。
    // 注意：strict mode 禁止 `eval`/`arguments` 作形参名——eval 由 AST lint 层拦截（且 strict
    // 下间接 eval 也拿不到本地作用域），这里遮蔽其余全局。
    const SHADOWED = ["require", "module", "exports", "process", "global", "globalThis", "fetch", "XMLHttpRequest", "WebSocket", "setTimeout", "setInterval", "setImmediate", "queueMicrotask", "Deno", "Bun"];
    // 代码契约：形如 `return <expr>` 或定义并调用——统一包成函数体，input 只读副本。
    // async 包装：异步挂起（永不 resolve 的 await）可被下面的超时竞速抢占；同步死循环由 lint 拦。
    const fn = new Function("input", ...SHADOWED, `"use strict";\nreturn (async () => {\n${code}\n})();`) as (input: unknown, ...rest: undefined[]) => Promise<unknown>;
    const frozenInput = JSON.parse(JSON.stringify(input ?? null)) as unknown;
    const exec = Promise.resolve().then(() => fn(frozenInput, ...(new Array(SHADOWED.length).fill(undefined) as undefined[])));
    const timeoutMs = opts?.timeoutMs ?? 3000;
    const result = await Promise.race([
      exec,
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`执行超时（>${timeoutMs}ms）`)), timeoutMs).unref?.()),
    ]);
    const json = JSON.stringify(result);
    if (json === undefined) return { ok: false, error: "代码没有 return 一个可 JSON 序列化的结果", durationMs: Date.now() - started };
    return { ok: true, result: json.length > 20_000 ? { truncated: true, preview: json.slice(0, 20_000) } : result, durationMs: Date.now() - started };
  } catch (e) {
    return { ok: false, error: (e as Error).message?.slice(0, 300) ?? String(e), durationMs: Date.now() - started };
  }
}
