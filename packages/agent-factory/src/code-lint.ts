// Phase 2 Tier B — security lint for AI-authored code tools. A cheap, static deny-list of the
// clear-cut dangerous APIs an untrusted generated tool must never use. This is ONE of three gates
// a code tool must pass before it becomes a runtime-invocable capability:
//   1. validateAgentCode  — it compiles (real tsc)        [codegen.ts]
//   2. lintGeneratedToolCode — no dangerous APIs           [here]
//   3. mandatory human review + execution isolation        [promotion — see ports/promote]
// A lint is NOT isolation: an infinite loop / memory bomb is the isolate's job to bound. It also
// is NOT a substitute for human review. It only blocks the obvious escapes.

interface Rule {
  re: RegExp;
  label: string;
}

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

/** Static deny-list lint. Returns the concrete violations so a promotion gate can block + explain. */
export function lintGeneratedToolCode(code: string): { ok: boolean; violations: string[] } {
  const src = code ?? "";
  const violations: string[] = [];
  for (const rule of RULES) {
    if (rule.re.test(src)) violations.push(rule.label);
  }
  return { ok: violations.length === 0, violations };
}
