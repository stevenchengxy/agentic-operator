// Phase 2 Tier B — security lint for AI-authored code tools. Gates the clear-cut dangerous APIs an
// untrusted generated tool must never use. This is ONE of three gates a code tool must pass before
// it becomes a runtime-invocable capability:
//   1. validateAgentCode  — it compiles (real tsc)        [codegen.ts]
//   2. lintGeneratedToolCode — no dangerous APIs           [here]
//   3. mandatory human review + execution isolation        [promotion — see ports/promote]
// A lint is NOT isolation: an infinite loop / memory bomb is the isolate's job to bound. It also is
// NOT a substitute for human review. It only blocks the obvious escapes.
//
// #REDESIGN FU2 — AST-based, not a raw-text regex scan. The old regex deny-list was evadable
// (`require`, `globalThis["ch"+"ild_process"]`, a module name split across concatenation) AND
// false-positive-prone (a local variable named `vm`, the substring "http" inside `httpClientLabel`).
// We now parse with the TypeScript compiler and inspect IMPORT / REQUIRE / CALL / NEW nodes
// structurally — a forbidden module only trips the gate when it is an actual import/require target,
// and `eval`/`new Function`/`process.exit` only when they are actual call/new expressions. The regex
// RULES remain purely as a FALLBACK for the (rare) environment where `typescript` can't be resolved
// or the snippet fails to parse — never as the primary path.

import { createRequire } from "node:module";

interface Rule {
  re: RegExp;
  label: string;
}

// FALLBACK ONLY — used when the TypeScript compiler can't be loaded / the code won't parse.
const RULES: Rule[] = [
  { re: /child_process/, label: "child_process (shell/process spawn) is forbidden" },
  { re: /\beval\s*\(/, label: "eval() is forbidden" },
  { re: /\bnew\s+Function\s*\(/, label: "new Function() is forbidden" },
  { re: /\bvm\b|node:vm|["']vm["']/, label: "vm module is forbidden" },
  { re: /worker_threads/, label: "worker_threads is forbidden" },
  { re: /process\s*\.\s*(exit|kill|abort)\s*\(/, label: "process.exit/kill/abort is forbidden" },
  { re: /node:fs|["']fs["']|["']fs\/promises["']/, label: "raw filesystem (fs) is forbidden — use the provided fs.* tools (data-root scoped)" },
  { re: /node:net|["']net["']|node:dgram|["']dgram["']/, label: "raw sockets (net/dgram) are forbidden" },
  { re: /node:http\b|["']http["']|node:https|["']https["']/, label: "raw http/https modules are forbidden — use a declarative HTTP tool / safeFetch" },
  { re: /\brequire\s*\(\s*[^'"]/, label: "dynamic require() with a non-literal is forbidden" },
];

// A forbidden node builtin → the human-readable violation it raises. Keyed on the *base* specifier
// (after stripping a `node:` prefix and any `/subpath`). Kept a touch broader than the old regex —
// dns/tls/http2/cluster/inspector/v8/repl/module are just as dangerous as the originals and the AST
// path makes them safe to block without false positives.
const FORBIDDEN_MODULES: Record<string, string> = {
  child_process: "child_process (shell/process spawn) is forbidden",
  fs: "raw filesystem (fs) is forbidden — use the provided fs.* tools (data-root scoped)",
  net: "raw sockets (net) are forbidden",
  dgram: "raw sockets (dgram) are forbidden",
  tls: "raw TLS sockets are forbidden",
  http: "raw http module is forbidden — use a declarative HTTP tool / safeFetch",
  https: "raw https module is forbidden — use a declarative HTTP tool / safeFetch",
  http2: "raw http2 module is forbidden — use a declarative HTTP tool / safeFetch",
  dns: "raw DNS resolution (dns) is forbidden",
  vm: "vm module is forbidden",
  worker_threads: "worker_threads is forbidden",
  cluster: "cluster is forbidden",
  os: "os module is forbidden (host info leak)",
  inspector: "inspector module is forbidden",
  v8: "v8 module is forbidden",
  repl: "repl module is forbidden",
  module: "module (require internals) is forbidden",
  process: "importing the process module is forbidden",
};

function normalizeModule(spec: string): string {
  let s = spec.trim();
  if (s.startsWith("node:")) s = s.slice(5);
  return s;
}

function moduleViolation(spec: string): string | null {
  const base = normalizeModule(spec);
  if (FORBIDDEN_MODULES[base]) return FORBIDDEN_MODULES[base];
  const head = base.split("/")[0] ?? base; // dns/promises → dns, fs/promises → fs
  if (head !== base && FORBIDDEN_MODULES[head]) return FORBIDDEN_MODULES[head];
  return null;
}

// Cache the resolved compiler (or a null sentinel if it can't be loaded) across calls.
let _ts: typeof import("typescript") | null | undefined;
function loadTs(): typeof import("typescript") | null {
  if (_ts !== undefined) return _ts;
  try {
    // Synchronous resolve so the public API stays sync (callers + tests depend on it). typescript is
    // hoisted to the workspace root and already loaded at runtime by codegen.ts's transpile step.
    _ts = createRequire(import.meta.url)("typescript") as typeof import("typescript");
  } catch {
    _ts = null;
  }
  return _ts;
}

/** AST pass. Returns the violation labels, or null if the snippet couldn't be parsed (→ regex fallback). */
function astLint(code: string, ts: typeof import("typescript")): string[] | null {
  let sf: import("typescript").SourceFile;
  try {
    sf = ts.createSourceFile("__generated__.ts", code, ts.ScriptTarget.ES2022, /*setParentNodes*/ true, ts.ScriptKind.TS);
  } catch {
    return null;
  }
  const violations = new Set<string>();
  const addModule = (spec: string) => {
    const v = moduleViolation(spec);
    if (v) violations.add(v);
  };

  const visit = (node: import("typescript").Node): void => {
    // import x from "child_process"  /  export … from "fs"
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      addModule(node.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      addModule(node.moduleSpecifier.text);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
      // import cp = require("child_process")
      addModule(node.moduleReference.expression.text);
    } else if (ts.isCallExpression(node)) {
      const ex = node.expression;
      const arg0 = node.arguments[0];
      if (ts.isIdentifier(ex) && ex.text === "require") {
        if (arg0 && ts.isStringLiteral(arg0)) addModule(arg0.text);
        else violations.add("dynamic require() with a non-literal is forbidden");
      } else if (ex.kind === ts.SyntaxKind.ImportKeyword) {
        // dynamic import("child_process")
        if (arg0 && ts.isStringLiteral(arg0)) addModule(arg0.text);
        else violations.add("dynamic import() with a non-literal is forbidden");
      } else if (ts.isIdentifier(ex) && ex.text === "eval") {
        violations.add("eval() is forbidden");
      } else if (ts.isIdentifier(ex) && ex.text === "Function") {
        violations.add("new Function() is forbidden"); // Function("…")() called without new
      } else if (
        ts.isPropertyAccessExpression(ex) &&
        ts.isIdentifier(ex.expression) &&
        ex.expression.text === "process" &&
        ["exit", "kill", "abort", "binding", "dlopen"].includes(ex.name.text)
      ) {
        violations.add("process.exit/kill/abort is forbidden");
      }
    } else if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Function") {
      violations.add("new Function() is forbidden");
    } else if (
      ts.isPropertyAccessExpression(node)
      && (node.name.text === "__proto__" || node.name.text === "constructor")
    ) {
      violations.add(`${node.name.text} access is forbidden (prototype/host escape)`);
    } else if (
      ts.isElementAccessExpression(node) &&
      ts.isStringLiteral(node.argumentExpression) &&
      (node.argumentExpression.text === "__proto__" || node.argumentExpression.text === "constructor")
    ) {
      violations.add("computed __proto__/constructor access is forbidden (prototype pollution)");
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return [...violations];
}

/** Static view of the runtime tool capabilities referenced by generated CodeAct code. */
export interface GeneratedToolCallInspection {
  /** Unique literal tool names used by `ctx.tool("...")` / `ctx.tools.run("...")`. */
  calledTools: string[];
  /** Dynamic/aliased/computed calls which cannot be bound to an immutable reviewed tool name. */
  violations: string[];
}

function propertyNameText(
  name: import("typescript").PropertyName | undefined,
  ts: typeof import("typescript"),
): string | null {
  if (!name) return null;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return null;
}

/**
 * Extract the exact tool set reachable from a generated handler.
 *
 * This deliberately accepts only direct literal calls. `ctx.tool(name)`,
 * `ctx["tool"](...)`, destructuring/aliasing the tool function, and computed
 * expressions are rejected: promotion must be able to bind every possible
 * capability to the immutable reviewed spec without executing the code first.
 * The deterministic renderer currently emits the back-compatible
 * `ctx.tools.run("...")` spelling, so it is governed by the same rule.
 */
export function inspectGeneratedToolCalls(code: string): GeneratedToolCallInspection {
  const ts = loadTs();
  if (!ts) {
    return {
      calledTools: [],
      violations: ["无法加载 TypeScript 解析器，不能安全确认生成代码的工具 allowlist"],
    };
  }

  const source = ts.createSourceFile(
    "__generated_tool_allowlist__.ts",
    code ?? "",
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TS,
  );
  const called = new Set<string>();
  const violations = new Set<string>();
  // `ctx` is the public AgentRuntime convention. Handler discovery below also
  // supports a renamed second argument such as `handler(input, runtime)`.
  const contextNames = new Set<string>(["ctx"]);

  const location = (node: import("typescript").Node): string => {
    const pos = source.getLineAndCharacterOfPosition(node.getStart(source));
    return `${pos.line + 1}:${pos.character + 1}`;
  };
  const addHandlerContext = (
    parameters: import("typescript").NodeArray<import("typescript").ParameterDeclaration>,
    node: import("typescript").Node,
  ): void => {
    const context = parameters[1]?.name;
    if (!context) return;
    if (ts.isIdentifier(context)) {
      contextNames.add(context.text);
      return;
    }
    violations.add(
      `生成 handler 在 ${location(node)} 解构了运行时上下文；请使用命名参数 ctx 并直接调用 ctx.tool("工具名", args)`,
    );
  };

  // First discover the runtime-context parameter used by defineAgent handlers.
  const discoverHandlers = (node: import("typescript").Node): void => {
    if (
      ts.isMethodDeclaration(node) &&
      propertyNameText(node.name, ts) === "handler"
    ) {
      addHandlerContext(node.parameters, node);
    } else if (
      ts.isPropertyAssignment(node) &&
      propertyNameText(node.name, ts) === "handler" &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    ) {
      addHandlerContext(node.initializer.parameters, node.initializer);
    } else if (ts.isFunctionDeclaration(node) && node.name?.text === "handler") {
      addHandlerContext(node.parameters, node);
    }
    ts.forEachChild(node, discoverHandlers);
  };
  discoverHandlers(source);

  const unwrap = (expression: import("typescript").Expression): import("typescript").Expression => {
    let current = expression;
    while (
      ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isTypeAssertionExpression(current) ||
      ts.isNonNullExpression(current)
    ) {
      current = current.expression;
    }
    return current;
  };
  const isContextIdentifier = (expression: import("typescript").Expression): boolean => {
    const value = unwrap(expression);
    return ts.isIdentifier(value) && contextNames.has(value.text);
  };
  const isContextTools = (expression: import("typescript").Expression): boolean => {
    const value = unwrap(expression);
    return (
      ts.isPropertyAccessExpression(value) &&
      value.name.text === "tools" &&
      isContextIdentifier(value.expression)
    );
  };
  const isContextMemory = (expression: import("typescript").Expression): boolean => {
    const value = unwrap(expression);
    return (
      ts.isPropertyAccessExpression(value) &&
      value.name.text === "memory" &&
      isContextIdentifier(value.expression)
    );
  };
  // These are the runtime surface actually exposed by the CodeAct worker.
  // Keep this explicit: an unknown ctx property must not become an accidental
  // capability merely because generated TypeScript can spell it.
  const directContextMethods = new Set(["reason", "emit", "invoke", "spawn", "log"]);
  const directContextValues = new Set(["agentName", "tenantSlug", "correlationId", "subject"]);
  const memoryMethods = new Set(["get", "put", "delete", "search"]);

  // Track simple `const runtime = ctx` aliases so renaming the object cannot
  // evade inspection. Aliasing the function itself remains forbidden below.
  let changed = true;
  while (changed) {
    changed = false;
    const discoverAliases = (node: import("typescript").Node): void => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        isContextIdentifier(node.initializer) &&
        !contextNames.has(node.name.text)
      ) {
        contextNames.add(node.name.text);
        changed = true;
      }
      ts.forEachChild(node, discoverAliases);
    };
    discoverAliases(source);
  }

  const directCapability = (
    expression: import("typescript").Expression,
  ): "ctx.tool" | "ctx.tools.run" | null => {
    const value = unwrap(expression);
    if (
      ts.isPropertyAccessExpression(value) &&
      value.name.text === "tool" &&
      isContextIdentifier(value.expression)
    ) {
      return "ctx.tool";
    }
    if (
      ts.isPropertyAccessExpression(value) &&
      value.name.text === "run" &&
      isContextTools(value.expression)
    ) {
      return "ctx.tools.run";
    }
    return null;
  };

  const visit = (node: import("typescript").Node): void => {
    if (ts.isCallExpression(node)) {
      const capability = directCapability(node.expression);
      if (capability) {
        const name = node.arguments[0];
        const literal =
          name && (ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name))
            ? name.text.trim()
            : "";
        if (!literal) {
          violations.add(
            `生成代码在 ${location(node)} 使用了动态工具名；${capability} 的第一个参数必须是非空字符串字面量`,
          );
        } else {
          called.add(literal);
        }
      }
    }

    // Taking the method as a value (`const call = ctx.tool`) or routing it
    // through `.call/.apply` defeats exact static extraction, so fail closed.
    if (ts.isPropertyAccessExpression(node) && directCapability(node)) {
      const parent = node.parent;
      if (!(ts.isCallExpression(parent) && unwrap(parent.expression) === node)) {
        violations.add(
          `生成代码在 ${location(node)} 对工具能力做了别名/间接调用；请直接写 ctx.tool("工具名", args)`,
        );
      }
    }

    // The tools namespace is itself a capability. Taking or destructuring it
    // would hide later calls from exact extraction (`const tools = ctx.tools`,
    // `const { run } = ctx.tools`). Only the direct `.run("literal", ...)`
    // chain is accepted.
    if (ts.isPropertyAccessExpression(node) && isContextTools(node)) {
      const parent = node.parent;
      const directRun =
        ts.isPropertyAccessExpression(parent) &&
        parent.expression === node &&
        parent.name.text === "run" &&
        ts.isCallExpression(parent.parent) &&
        unwrap(parent.parent.expression) === parent;
      if (!directRun) {
        violations.add(
          `生成代码在 ${location(node)} 对 ctx.tools 能力做了别名/解构/间接传递；请直接写 ctx.tools.run("工具名", args)`,
        );
      }
    }

    // Non-tool runtime methods are legitimate, but they must stay as direct
    // calls. This lets normal generated handlers use ctx.emit()/ctx.reason()
    // without permitting `const emit = ctx.emit` or handing that capability to
    // a helper. Identity fields are plain immutable values and may be read.
    if (ts.isPropertyAccessExpression(node) && isContextIdentifier(node.expression)) {
      const name = node.name.text;
      if (directContextMethods.has(name)) {
        const parent = node.parent;
        if (!(ts.isCallExpression(parent) && unwrap(parent.expression) === node)) {
          violations.add(
            `生成代码在 ${location(node)} 对 ctx.${name} 做了别名/间接传递；请直接调用 ctx.${name}(...)`,
          );
        }
      } else if (
        name !== "tool" &&
        name !== "tools" &&
        name !== "memory" &&
        !directContextValues.has(name)
      ) {
        violations.add(`生成代码在 ${location(node)} 访问了未声明的运行时上下文能力 ctx.${name}`);
      }
    }

    // The memory namespace follows the same confinement rule as ctx.tools:
    // only a direct call to one of the worker's four declared methods is valid.
    if (ts.isPropertyAccessExpression(node) && isContextMemory(node)) {
      const parent = node.parent;
      const directMemoryCall =
        ts.isPropertyAccessExpression(parent) &&
        parent.expression === node &&
        memoryMethods.has(parent.name.text) &&
        ts.isCallExpression(parent.parent) &&
        unwrap(parent.parent.expression) === parent;
      if (!directMemoryCall) {
        violations.add(
          `生成代码在 ${location(node)} 对 ctx.memory 能力做了别名/解构/间接传递；请直接调用 ctx.memory.get/put/delete/search`,
        );
      }
    }
    if (
      ts.isPropertyAccessExpression(node) &&
      isContextMemory(node.expression)
    ) {
      const parent = node.parent;
      if (
        !memoryMethods.has(node.name.text) ||
        !(ts.isCallExpression(parent) && unwrap(parent.expression) === node)
      ) {
        violations.add(`生成代码在 ${location(node)} 使用了未声明或间接的 ctx.memory 能力`);
      }
    }

    // The whole context may only be the direct receiver of `.tool/.tools` or
    // a simple `const alias = ctx`. Assignment, arrays, objects, spreads,
    // returns and helper arguments all transfer capabilities beyond exact
    // extraction and are rejected.
    if (ts.isIdentifier(node) && contextNames.has(node.text)) {
      const parent = node.parent;
      const isDeclarationName =
        (ts.isParameter(parent) || ts.isVariableDeclaration(parent)) && parent.name === node;
      const isDirectReceiver =
        ts.isPropertyAccessExpression(parent) &&
        parent.expression === node &&
        (
          parent.name.text === "tool" ||
          parent.name.text === "tools" ||
          parent.name.text === "memory" ||
          directContextMethods.has(parent.name.text) ||
          directContextValues.has(parent.name.text)
        );
      const isSimpleAliasInitializer =
        ts.isVariableDeclaration(parent) &&
        parent.initializer === node &&
        ts.isIdentifier(parent.name);
      if (!isDeclarationName && !isDirectReceiver && !isSimpleAliasInitializer) {
        violations.add(
          `生成代码在 ${location(node)} 间接转交/保存了运行时上下文；工具能力只能直接字面量调用`,
        );
      }
    }

    // Computed access is never accepted, even when the property text happens
    // to be a literal, because it is the common bridge to dynamic invocation.
    if (ts.isElementAccessExpression(node)) {
      const target = unwrap(node.expression);
      const argument = node.argumentExpression;
      const key =
        argument && (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument))
          ? argument.text
          : null;
      if (
        (isContextIdentifier(target) && (key === "tool" || key === "tools" || key === null)) ||
        (isContextTools(target) && (key === "run" || key === null))
      ) {
        violations.add(
          `生成代码在 ${location(node)} 使用了计算属性访问工具能力；请改为直接的字符串字面量调用`,
        );
      }
    }

    // Destructuring the runtime context hides subsequent tool calls from the
    // syntax-level capability set and is therefore rejected.
    if (
      ts.isVariableDeclaration(node) &&
      !ts.isIdentifier(node.name) &&
      node.initializer &&
      isContextIdentifier(node.initializer)
    ) {
      violations.add(
        `生成代码在 ${location(node)} 解构了运行时上下文；工具调用必须保持为 ctx.tool("工具名", args)`,
      );
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  return {
    calledTools: [...called].sort(),
    violations: [...violations],
  };
}

/** Promotion-oriented exact subset check against the immutable reviewed spec. */
export function validateGeneratedToolAllowlist(
  code: string,
  reviewedTools: readonly string[],
): GeneratedToolCallInspection & { ok: boolean; undeclaredTools: string[] } {
  const inspected = inspectGeneratedToolCalls(code);
  const allowed = new Set(reviewedTools.map((name) => name.trim()).filter(Boolean));
  const undeclaredTools = inspected.calledTools.filter((name) => !allowed.has(name));
  const violations = [
    ...inspected.violations,
    ...undeclaredTools.map(
      (name) => `生成代码调用了未在不可变 spec.tools 中审查并绑定的工具「${name}」`,
    ),
  ];
  return {
    calledTools: inspected.calledTools,
    undeclaredTools,
    violations,
    ok: violations.length === 0,
  };
}

/** Exact CodeAct coverage check. A CodeAct handler owns the Agent's complete
 * authored execution path, so every reviewed tool must appear in at least one
 * direct literal call. Otherwise a function can declare real integrations,
 * leave every call in comments, and still obtain a misleading green replay. */
export function validateGeneratedToolCoverage(
  code: string,
  reviewedTools: readonly string[],
): ReturnType<typeof validateGeneratedToolAllowlist> & { missingReviewedTools: string[] } {
  const allowlist = validateGeneratedToolAllowlist(code, reviewedTools);
  const called = new Set(allowlist.calledTools);
  const missingReviewedTools = [...new Set(reviewedTools.map((name) => name.trim()).filter(Boolean))]
    .filter((name) => !called.has(name))
    .sort();
  const violations = [
    ...allowlist.violations,
    ...missingReviewedTools.map(
      (name) => `生成代码声明了已审查工具「${name}」，但 handler 没有直接字面量调用它`,
    ),
  ];
  return {
    ...allowlist,
    missingReviewedTools,
    violations,
    ok: violations.length === 0,
  };
}

export interface GeneratedContextMethodInspection {
  calls: number;
  issues: string[];
}

/** Count direct runtime-context method calls from executable AST nodes. Unlike
 * regex matching, comments and string literals never count as execution
 * evidence. Parser absence/syntax damage is explicit so callers can fail
 * closed with a useful reason. */
export function inspectGeneratedContextMethodCalls(
  code: string,
  method: "reason",
): GeneratedContextMethodInspection {
  const ts = loadTs();
  if (!ts) return { calls: 0, issues: ["无法加载 TypeScript 解析器，不能确认 ctx.reason 是否真实执行"] };
  let source: import("typescript").SourceFile;
  try {
    source = ts.createSourceFile(
      "__generated_context_calls__.ts",
      code ?? "",
      ts.ScriptTarget.ES2022,
      true,
      ts.ScriptKind.TS,
    );
  } catch {
    return { calls: 0, issues: ["生成代码无法解析，不能确认 ctx.reason 是否真实执行"] };
  }
  const parseDiagnostics = (source as import("typescript").SourceFile & {
    parseDiagnostics?: readonly import("typescript").Diagnostic[];
  }).parseDiagnostics ?? [];
  if (parseDiagnostics.length) {
    const first = ts.flattenDiagnosticMessageText(parseDiagnostics[0]!.messageText, " ").slice(0, 180);
    return { calls: 0, issues: [`生成代码存在语法错误，不能确认 ctx.reason：${first}`] };
  }
  const contextNames = new Set(["ctx"]);
  const discoverHandlers = (node: import("typescript").Node): void => {
    const parameters = ts.isMethodDeclaration(node) && propertyNameText(node.name, ts) === "handler"
      ? node.parameters
      : ts.isPropertyAssignment(node)
        && propertyNameText(node.name, ts) === "handler"
        && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
        ? node.initializer.parameters
        : ts.isFunctionDeclaration(node) && node.name?.text === "handler"
          ? node.parameters
          : undefined;
    const context = parameters?.[1]?.name;
    if (context && ts.isIdentifier(context)) contextNames.add(context.text);
    ts.forEachChild(node, discoverHandlers);
  };
  discoverHandlers(source);
  let changed = true;
  while (changed) {
    changed = false;
    const discoverAliases = (node: import("typescript").Node): void => {
      if (
        ts.isVariableDeclaration(node)
        && ts.isIdentifier(node.name)
        && node.initializer
        && ts.isIdentifier(node.initializer)
        && contextNames.has(node.initializer.text)
        && !contextNames.has(node.name.text)
      ) {
        contextNames.add(node.name.text);
        changed = true;
      }
      ts.forEachChild(node, discoverAliases);
    };
    discoverAliases(source);
  }
  let calls = 0;
  const issues = new Set<string>();
  const isContext = (expression: import("typescript").Expression): boolean =>
    ts.isIdentifier(expression) && contextNames.has(expression.text);
  const isDirectCallTarget = (node: import("typescript").Node): boolean =>
    ts.isCallExpression(node.parent) && node.parent.expression === node;
  const visit = (node: import("typescript").Node): void => {
    if (ts.isCallExpression(node)) {
      const target = node.expression;
      if (
        ts.isPropertyAccessExpression(target)
        && target.name.text === method
        && isContext(target.expression)
      ) calls += 1;
      else if (
        ts.isElementAccessExpression(target)
        && isContext(target.expression)
        && ts.isStringLiteral(target.argumentExpression)
        && target.argumentExpression.text === method
      ) calls += 1;
    } else if (
      ts.isPropertyAccessExpression(node)
      && node.name.text === method
      && isContext(node.expression)
      && !isDirectCallTarget(node)
    ) {
      issues.add("生成代码把 ctx.reason 当作值传递或改名；请直接调用 ctx.reason(...)，否则不能证明模型路径");
    } else if (
      ts.isElementAccessExpression(node)
      && isContext(node.expression)
      && ts.isStringLiteral(node.argumentExpression)
      && node.argumentExpression.text === method
      && !isDirectCallTarget(node)
    ) {
      issues.add("生成代码把 ctx[\"reason\"] 当作值传递或改名；请直接调用 ctx.reason(...)，否则不能证明模型路径");
    } else if (
      ts.isVariableDeclaration(node)
      && ts.isObjectBindingPattern(node.name)
      && node.initializer
      && isContext(node.initializer)
      && node.name.elements.some((element) => {
        const name = element.propertyName ?? element.name;
        return (ts.isIdentifier(name) || ts.isStringLiteral(name))
          && name.text === method;
      })
    ) {
      issues.add("生成代码解构了 ctx.reason；请直接调用 ctx.reason(...)，否则不能证明模型路径");
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { calls, issues: [...issues] };
}

// #IAL — unbounded-loop rules, applied on EVERY path (AST and fallback alike; they're textual
// patterns with negligible false-positive surface in generated Inngest handler code). A deployed
// function that spins `while(true)` / `for(;;)` or arms `setInterval` has no stopping bound the
// runtime can enforce — the exact "missing strong bound" root cause present in 100% of the 68
// confirmed infinite agentic loops in arXiv 2607.01641. Bounded loops (`for (const x of items)`,
// counters with limits) pass untouched.
const UNBOUNDED_RULES: Rule[] = [
  { re: /while\s*\(\s*(true|1)\s*\)/, label: "无界循环 while(true) is forbidden in deployable functions — write a bounded loop (explicit max iterations)" },
  { re: /for\s*\(\s*;\s*;\s*\)/, label: "无界循环 for(;;) is forbidden in deployable functions — write a bounded loop (explicit max iterations)" },
  { re: /\bsetInterval\s*\(/, label: "setInterval is forbidden in deployable functions — scheduling belongs to Inngest (cron/throttle config), not in-handler timers" },
];

/** Static security lint. Returns the concrete violations so a promotion gate can block + explain. */
export function lintGeneratedToolCode(code: string): { ok: boolean; violations: string[] } {
  const src = code ?? "";
  const universal = UNBOUNDED_RULES.filter((r) => r.re.test(src)).map((r) => r.label);
  const ts = loadTs();
  if (ts) {
    const astViolations = astLint(src, ts);
    if (astViolations !== null) {
      const all = [...astViolations, ...universal];
      return { ok: all.length === 0, violations: all };
    }
    // parse failed → fall through to the regex floor
  }
  // FALLBACK — typescript unavailable or unparseable: coarse regex deny-list.
  const violations: string[] = [...universal];
  for (const rule of RULES) {
    if (rule.re.test(src)) violations.push(rule.label);
  }
  return { ok: violations.length === 0, violations };
}
