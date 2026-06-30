// Agent code generator — render a generated SPEC into a readable agent module the
// user can SEE + own + edit, and validate AI-written agent code.
//
// Adapted for the new arch: the OLD repo rendered an Inngest createFunction wired to
// a tool-registry's per-client `impl` metadata. The new monorepo has no such registry
// (agents deploy via the workflow manifest), so this renders a clean, self-documenting
// agent module — IO interfaces from the ontology-grounded schema, the LLM-authored
// SYSTEM_PROMPT verbatim, the bound tools, the per-branch decision logic, and a handler
// sketch. It's a faithful, readable scaffold (the deployed path is the manifest), not a
// guaranteed-runnable drop-in. Ported from OLD lib/agent-factory-v3/codegen.ts.

import type { GeneratedAgentSpec, IoField } from "./spec-types";

function camel(s: string): string {
  return s ? s[0]!.toLowerCase() + s.slice(1) : "agent";
}

function tsType(t: string): string {
  const x = (t || "").toLowerCase();
  if (x.startsWith("str")) return "string";
  if (x.startsWith("num") || x === "int" || x === "integer" || x === "float" || x === "double") return "number";
  if (x.startsWith("bool")) return "boolean";
  if (x.startsWith("arr") || x.endsWith("[]")) return "unknown[]";
  if (x.startsWith("obj") || x.startsWith("map") || x.startsWith("json")) return "Record<string, unknown>";
  return "unknown";
}

function ioInterface(name: string, fields: IoField[] | undefined): string {
  if (!fields?.length) return "";
  const lines = fields.map((f) => {
    const key = /^[a-zA-Z_$][\w$]*$/.test(f.field) ? f.field : JSON.stringify(f.field);
    const note = f.description ? ` // ${f.description.replace(/\s+/g, " ").trim()}${f.source ? ` (源: ${f.source})` : ""}` : f.source ? ` // 源: ${f.source}` : "";
    return `  ${key}: ${tsType(f.type)};${note}`;
  });
  return `interface ${name} {\n${lines.join("\n")}\n}`;
}

/** Validate AI-written agent code. Uses the real TS compiler when available;
 *  falls back to structural checks. Returns concrete errors for the codegen retry loop. */
export async function validateAgentCode(code: string): Promise<{ ok: boolean; errors: string[] }> {
  try {
    const ts = await import("typescript");
    const out = ts.transpileModule(code, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, isolatedModules: true },
      reportDiagnostics: true,
    });
    const errors = (out.diagnostics ?? [])
      .filter((d) => d.category === ts.DiagnosticCategory.Error)
      .map((d) => ts.flattenDiagnosticMessageText(d.messageText, " "));
    return { ok: errors.length === 0, errors };
  } catch {
    const errors: string[] = [];
    const count = (s: string) => code.split(s).length - 1;
    if (count("{") !== count("}")) errors.push("花括号 { } 不配对");
    if (count("(") !== count(")")) errors.push("圆括号 ( ) 不配对");
    if (count("`") % 2 !== 0) errors.push("反引号 ` 不配对");
    if (!/export\s+(const|default|function)/.test(code)) errors.push("缺少 export const / default / function");
    return { ok: errors.length === 0, errors };
  }
}

function escapeTemplate(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
}

/**
 * Render a readable agent module from a generated spec (new-arch flavor).
 */
export function specToAgentCode(spec: GeneratedAgentSpec): string {
  const exportName = camel(spec.short || "agent") + (/(agent)$/i.test(spec.short || "") ? "" : "Agent");
  const tools = spec.tools ?? [];
  const emits = spec.emit ?? [];
  const triggers = spec.trigger ?? [];

  const inName = `${spec.short || "Agent"}Input`;
  const outName = `${spec.short || "Agent"}Output`;
  const ifaces = [ioInterface(inName, spec.inputSchema), ioInterface(outName, spec.outputSchema)].filter(Boolean);

  const toolCalls = tools.length
    ? tools.map((t) => `      // 调用工具 ${t}\n      // const ${camel(t.split(".").pop() || "r")}Result = await ctx.tools.run(${JSON.stringify(t)}, input);`).join("\n")
    : "      // (此 agent 不依赖外部工具)";

  const emitBlock =
    emits.length <= 1
      ? `      await ctx.emit(${JSON.stringify(emits[0] ?? "DONE")}, { ...input, ...decision });`
      : [
          `      // 决策分支（条件见 SYSTEM_PROMPT / decisionLogic）`,
          `      if (decision.pass) {`,
          `        await ctx.emit(${JSON.stringify(emits[0])}, { ...input, ...decision });`,
          `      } else {`,
          `        await ctx.emit(${JSON.stringify(emits[emits.length - 1])}, { ...input, ...decision });`,
          `      }`,
          emits.length > 2 ? `      // 其它分支: ${emits.slice(1, -1).join(", ")} — 按 SYSTEM_PROMPT 条件补充` : "",
        ]
          .filter(Boolean)
          .join("\n");

  return [
    `// ${spec.nameZh} — 由 Agent 工厂从本体动作 \`${spec.actionName}\`(${spec.domainId})生成。`,
    `// trigger: ${triggers.join(" / ") || "(entry)"} → emit: ${emits.join(" | ") || "(terminal)"}`,
    `// 参考脚手架：运行时按 workflow manifest 的 action[] 声明式调度执行（systemPrompt + 工具），`,
    `// 【不直接运行这段 .ts 代码】——它是可读/可改的 agent 定义参考。真·CodeAct 执行路径用 codeExecuted 开关（默认关）。`,
    "",
    ...(ifaces.length ? [`/** Input/Output schema — 依据本体 DataObjects 定义。 */`, ifaces.join("\n\n"), ""] : []),
    `/** System prompt — 工厂为【这一个】agent 亲自推理出来的。 */`,
    "const SYSTEM_PROMPT = `" + escapeTemplate(spec.systemPrompt ?? "") + "`;",
    "",
    `export const ${exportName} = defineAgent({`,
    `  id: ${JSON.stringify(spec.slug)},`,
    `  name: ${JSON.stringify(spec.short || spec.nameZh)},`,
    `  actor: ${JSON.stringify(spec.hitl ? ["Human"] : ["Agent"])},`,
    `  trigger: ${JSON.stringify(triggers)},`,
    `  emit: ${JSON.stringify(emits)},`,
    `  tools: ${JSON.stringify(tools)},`,
    `  systemPrompt: SYSTEM_PROMPT,`,
    `  async handler(input, ctx) {`,
    toolCalls,
    `      // 用本 agent 专属 system prompt 推理(决策核心)`,
    `      const decision = await ctx.reason(SYSTEM_PROMPT, input);`,
    emitBlock,
    `      return { ok: true };`,
    `  },`,
    `});`,
    "",
  ].join("\n");
}
