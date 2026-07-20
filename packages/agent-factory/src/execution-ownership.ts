import ts from "typescript";

import type { GeneratedAgentSpec, PlanStep } from "./spec-types";

export type GeneratedExecutionOwner = "codeact-container" | "declarative-plan";

export interface GeneratedExecutionOwnership {
  owner: GeneratedExecutionOwner;
  codeActEligible: boolean;
  blockers: Array<{
    code:
      | "step_output_binding"
      | "decision_table"
      | "tool_capability"
      | "invoke_capability"
      | "foreach_durability"
      | "error_policy"
      | "code_rpc_capability"
      | "code_nondeterminism";
    reason: string;
  }>;
  reason?: string;
}

function allPlanSteps(plan: readonly PlanStep[]): PlanStep[] {
  return plan.flatMap((step) => [step, ...(step.body ? allPlanSteps(step.body) : [])]);
}

function staticRpcCapabilities(code: string | undefined): string[] {
  if (!code?.trim()) return [];
  const source = ts.createSourceFile(
    "generated-agent.ts",
    code,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const found = new Set<string>();
  const contextNames = new Set<string>(["ctx"]);
  const propertyName = (name: ts.PropertyName | undefined): string | null => {
    if (!name) return null;
    return ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)
      ? name.text
      : null;
  };
  const discoverHandlers = (node: ts.Node): void => {
    let parameters: ts.NodeArray<ts.ParameterDeclaration> | undefined;
    if (ts.isMethodDeclaration(node) && propertyName(node.name) === "handler") {
      parameters = node.parameters;
    } else if (
      ts.isPropertyAssignment(node)
      && propertyName(node.name) === "handler"
      && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    ) {
      parameters = node.initializer.parameters;
    } else if (ts.isFunctionDeclaration(node) && node.name?.text === "handler") {
      parameters = node.parameters;
    }
    const context = parameters?.[1]?.name;
    if (context) {
      if (ts.isIdentifier(context)) contextNames.add(context.text);
      else found.add("context-destructure");
    }
    ts.forEachChild(node, discoverHandlers);
  };
  discoverHandlers(source);
  const unwrap = (expression: ts.Expression): ts.Expression => {
    let current = expression;
    while (
      ts.isParenthesizedExpression(current)
      || ts.isAsExpression(current)
      || ts.isTypeAssertionExpression(current)
      || ts.isNonNullExpression(current)
    ) current = current.expression;
    return current;
  };
  const isContext = (expression: ts.Expression): boolean => {
    const value = unwrap(expression);
    return ts.isIdentifier(value) && contextNames.has(value.text);
  };
  let changed = true;
  while (changed) {
    changed = false;
    const discoverAliases = (node: ts.Node): void => {
      if (
        ts.isVariableDeclaration(node)
        && ts.isIdentifier(node.name)
        && node.initializer
        && isContext(node.initializer)
        && !contextNames.has(node.name.text)
      ) {
        contextNames.add(node.name.text);
        changed = true;
      }
      ts.forEachChild(node, discoverAliases);
    };
    discoverAliases(source);
  }
  const isNamespace = (expression: ts.Expression, name: "tools" | "memory"): boolean => {
    const value = unwrap(expression);
    return ts.isPropertyAccessExpression(value)
      && value.name.text === name
      && isContext(value.expression);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node)) {
      const member = node.name.text;
      if (isContext(node.expression) && ["reason", "tool", "invoke", "spawn"].includes(member)) {
        found.add(member);
      }
      if (isContext(node.expression) && member === "memory") found.add("memory");
      if (member === "run" && isNamespace(node.expression, "tools")) found.add("tools.run");
      if (isNamespace(node.expression, "memory")) found.add(`memory.${member}`);
    }
    if (
      ts.isElementAccessExpression(node)
      && (ts.isStringLiteral(node.argumentExpression)
        || ts.isNoSubstitutionTemplateLiteral(node.argumentExpression))
    ) {
      const member = node.argumentExpression.text;
      if (isContext(node.expression) && ["reason", "tool", "invoke", "spawn", "memory", "tools"].includes(member)) {
        found.add(`context[${member}]`);
      }
    } else if (ts.isElementAccessExpression(node) && isContext(node.expression)) {
      found.add("context[dynamic]");
    }
    if (
      ts.isVariableDeclaration(node)
      && !ts.isIdentifier(node.name)
      && node.initializer
      && isContext(node.initializer)
    ) {
      found.add("context-destructure");
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return [...found].sort();
}

/** Find wall-clock and entropy reads that make a supposedly pure CodeAct
 * handler produce different bytes when the same durable action is replayed.
 * Time/IDs must be captured by the host and passed in through reviewed input.
 * Deterministic APIs such as Date.parse(input.ts), new Date(input.ts) and
 * Math.round remain allowed. */
function staticNondeterministicCapabilities(code: string | undefined): string[] {
  if (!code?.trim()) return [];
  const source = ts.createSourceFile(
    "generated-agent.ts",
    code,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const found = new Set<string>();
  const entropyImports = new Set<string>();
  const cryptoNamespaces = new Set<string>(["crypto"]);
  const entropyMembers = new Set([
    "getRandomValues",
    "randomBytes",
    "randomFill",
    "randomFillSync",
    "randomInt",
    "randomUUID",
  ]);
  const unwrap = (expression: ts.Expression): ts.Expression => {
    let current = expression;
    while (
      ts.isParenthesizedExpression(current)
      || ts.isAsExpression(current)
      || ts.isTypeAssertionExpression(current)
      || ts.isNonNullExpression(current)
    ) current = current.expression;
    return current;
  };
  const memberPath = (expression: ts.Expression): string[] | null => {
    const value = unwrap(expression);
    if (ts.isIdentifier(value)) return [value.text];
    if (ts.isPropertyAccessExpression(value)) {
      const base = memberPath(value.expression);
      return base ? [...base, value.name.text] : null;
    }
    if (
      ts.isElementAccessExpression(value)
      && (ts.isStringLiteral(value.argumentExpression)
        || ts.isNoSubstitutionTemplateLiteral(value.argumentExpression))
    ) {
      const base = memberPath(value.expression);
      return base ? [...base, value.argumentExpression.text] : null;
    }
    return null;
  };
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (!["crypto", "node:crypto"].includes(statement.moduleSpecifier.text)) continue;
    const clause = statement.importClause;
    if (clause?.name) cryptoNamespaces.add(clause.name.text);
    if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
      cryptoNamespaces.add(clause.namedBindings.name.text);
    } else if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const element of clause.namedBindings.elements) {
        const imported = element.propertyName?.text ?? element.name.text;
        if (entropyMembers.has(imported)) entropyImports.add(element.name.text);
      }
    }
  }
  const nondeterministicPath = (path: readonly string[]): string | null => {
    const normalized = path[0] === "globalThis" ? path.slice(1) : path;
    const joined = normalized.join(".");
    if (joined === "Math.random") return joined;
    if (joined === "Date.now") return joined;
    if (joined === "performance.now" || joined === "performance.timeOrigin") return joined;
    if (joined === "process.hrtime" || joined === "process.hrtime.bigint") return joined;
    if (normalized.length === 2 && cryptoNamespaces.has(normalized[0]!) && entropyMembers.has(normalized[1]!)) {
      return `crypto.${normalized[1]}`;
    }
    return null;
  };
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const path = memberPath(node as ts.Expression);
      const capability = path && nondeterministicPath(path);
      if (capability) found.add(capability);
    }
    if (ts.isCallExpression(node)) {
      const expression = unwrap(node.expression);
      if (ts.isIdentifier(expression)) {
        if (expression.text === "Date" && node.arguments.length === 0) found.add("Date()");
        if (entropyImports.has(expression.text)) found.add(`crypto.${expression.text}()`);
      }
    }
    if (ts.isNewExpression(node)) {
      const path = memberPath(node.expression);
      const normalized = path?.[0] === "globalThis" ? path.slice(1) : path;
      if (normalized?.length === 1 && normalized[0] === "Date" && (node.arguments?.length ?? 0) === 0) {
        found.add("new Date()");
      }
    }
    if (
      ts.isVariableDeclaration(node)
      && ts.isObjectBindingPattern(node.name)
      && node.initializer
    ) {
      const owner = memberPath(node.initializer);
      const normalized = owner?.[0] === "globalThis" ? owner.slice(1) : owner;
      for (const element of node.name.elements) {
        const member = element.propertyName && (ts.isIdentifier(element.propertyName) || ts.isStringLiteral(element.propertyName))
          ? element.propertyName.text
          : ts.isIdentifier(element.name) ? element.name.text : "";
        if (normalized?.join(".") === "Math" && member === "random") found.add("Math.random");
        if (normalized?.join(".") === "Date" && member === "now") found.add("Date.now");
        if (normalized?.join(".") === "performance" && ["now", "timeOrigin"].includes(member)) found.add(`performance.${member}`);
        if (normalized?.length === 1 && cryptoNamespaces.has(normalized[0]!) && entropyMembers.has(member)) {
          found.add(`crypto.${member}`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return [...found].sort();
}

/**
 * Select exactly one execution owner for a generated spec.
 *
 * Until the CodeAct protocol can checkpoint typed child commands as stable
 * Inngest steps, tool/invoke/foreach/error-policy semantics must remain owned
 * by the declarative plan. Generated TypeScript is still reviewable reference
 * material, but it cannot become the production execution owner and duplicate
 * a side effect when the outer action retries.
 */
export function generatedSpecExecutionOwnership(
  spec: GeneratedAgentSpec,
  code: string | undefined = spec.generatedCode,
): GeneratedExecutionOwnership {
  const flat = allPlanSteps(spec.plan ?? []);
  const blockers: GeneratedExecutionOwnership["blockers"] = [];
  const add = (entry: GeneratedExecutionOwnership["blockers"][number]): void => {
    if (!blockers.some((existing) => existing.code === entry.code)) blockers.push(entry);
  };

  if (spec.inputBindings?.some((binding) => binding.kind === "step_output")) {
    add({
      code: "step_output_binding",
      reason: "step_output 依赖声明式 runtime 的命名步骤与重放结果",
    });
  }
  if (spec.decisionTables?.length) {
    add({
      code: "decision_table",
      reason: "decision table 已由确定性 manifest action 执行，不能再由 CodeAct 重复执行",
    });
  }
  if (spec.tools.length || flat.some((step) => step.kind === "tool")) {
    add({
      code: "tool_capability",
      reason: "工具调用需要独立 durable step、幂等键与 typed failure policy",
    });
  }
  if (flat.some((step) => step.kind === "invoke")) {
    add({
      code: "invoke_capability",
      reason: "invoke 需要宿主创建可重放的 durable child step",
    });
  }
  if (flat.some((step) => step.kind === "foreach")) {
    add({
      code: "foreach_durability",
      reason: "foreach 需要逐项稳定业务键、游标和 durable replay identity",
    });
  }
  if (flat.some((step) => step.onError || step.errorPolicy?.length)) {
    add({
      code: "error_policy",
      reason: "错误策略需要宿主的 typed retry/park/terminal 控制流",
    });
  }
  const codeCapabilities = staticRpcCapabilities(code);
  if (codeCapabilities.length) {
    add({
      code: "code_rpc_capability",
      reason: `代码直接访问 ${codeCapabilities.join("、")}；当前协议不能把这些调用恢复为独立 durable step`,
    });
  }
  const nondeterministicCapabilities = staticNondeterministicCapabilities(code);
  if (nondeterministicCapabilities.length) {
    add({
      code: "code_nondeterminism",
      reason: `代码读取 ${nondeterministicCapabilities.join("、")}；相同 durable input 重放会漂移，时间和随机值必须由宿主步骤捕获后通过 input 传入`,
    });
  }

  if (blockers.length) {
    return {
      owner: "declarative-plan",
      codeActEligible: false,
      blockers,
      reason: blockers.map((entry) => entry.reason).join("；"),
    };
  }
  return { owner: "codeact-container", codeActEligible: true, blockers: [] };
}

/** Defense-in-depth assertion for persistence/promotion boundaries. */
export function assertGeneratedSpecExecutionOwner(spec: GeneratedAgentSpec): void {
  const ownership = generatedSpecExecutionOwnership(spec);
  if (spec.codeExecuted === true && !ownership.codeActEligible) {
    throw new Error(
      `codeExecuted agent "${spec.slug}" requires ${ownership.owner}: ${ownership.reason}`,
    );
  }
}
