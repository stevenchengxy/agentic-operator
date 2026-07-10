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
    } else if (ts.isPropertyAccessExpression(node) && node.name.text === "__proto__") {
      violations.add("__proto__ access is forbidden (prototype pollution)");
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

/** Static security lint. Returns the concrete violations so a promotion gate can block + explain. */
export function lintGeneratedToolCode(code: string): { ok: boolean; violations: string[] } {
  const src = code ?? "";
  const ts = loadTs();
  if (ts) {
    const astViolations = astLint(src, ts);
    if (astViolations !== null) return { ok: astViolations.length === 0, violations: astViolations };
    // parse failed → fall through to the regex floor
  }
  // FALLBACK — typescript unavailable or unparseable: coarse regex deny-list.
  const violations: string[] = [];
  for (const rule of RULES) {
    if (rule.re.test(src)) violations.push(rule.label);
  }
  return { ok: violations.length === 0, violations };
}
