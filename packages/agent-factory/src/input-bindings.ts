import type { IntegrationToolBinding } from "./integration-binding";
import { analyzeExecutionPlanRequirement } from "./ontology-execution";
import type { OntologyAction, OntologyInputBindingKind } from "./ontology-types";
import type { GeneratedInputBinding, PlanStep } from "./spec-types";
import type { RealTool } from "./tool-catalog";

type Row = Record<string, unknown>;

const BINDING_KINDS = new Set<OntologyInputBindingKind>([
  "event",
  "object_lookup",
  "secret",
  "config",
  "human_input",
  "step_output",
]);
const SAFE_PATH = /^[A-Za-z_$][A-Za-z0-9_$-]*(?:(?:\??\.)[A-Za-z_$][A-Za-z0-9_$-]*|\[['"][^'"\]]+['"]\])*$/;
const SAFE_FIELD = /^[A-Za-z_$][A-Za-z0-9_$-]*$/;
const FORBIDDEN_FIELD_NAMES = new Set(["__proto__", "prototype", "constructor"]);

export interface InputBindingCompileIssue {
  code: string;
  field: string;
  message: string;
}

export interface InputBindingCompileResult {
  ok: boolean;
  bindings: GeneratedInputBinding[];
  errors: InputBindingCompileIssue[];
  warnings: InputBindingCompileIssue[];
}

export interface CompileInputBindingsOptions {
  plan?: PlanStep[];
  selectedTools?: string[];
  registeredTools?: RealTool[];
  integrationBindings?: IntegrationToolBinding[];
  /** Expanded, validated config from the selected human-confirmed profile. */
  toolConfigs?: Record<string, Record<string, unknown>>;
  /** toolName → confirmed profile id/key provenance. */
  toolProfileRefs?: Record<string, string>;
  env?: Record<string, string | undefined>;
  /** Authoring validates the symbolic tool/config contract but deliberately
   * does not require a credential value or confirmed environment profile.
   * Execution keeps the historical fail-closed checks. */
  mode?: "authoring" | "execution";
}

const rows = (value: unknown): Row[] =>
  Array.isArray(value)
    ? value.filter((item): item is Row => !!item && typeof item === "object" && !Array.isArray(item))
    : [];
const text = (value: unknown): string => typeof value === "string" ? value.trim() : "";
const normalized = (value: string): string => value.normalize("NFKC").toLocaleLowerCase().replace(/[\s_.:/()-]+/g, "");
const propertyRef = (value: string): string => value.includes(".") ? value.slice(value.indexOf(".") + 1).trim() : "";
const objectRef = (value: string): string => value.split(".")[0]?.trim() ?? "";

function canonicalRole(value: string): string {
  const role = normalized(value);
  if (["read", "reads", "fetch", "query", "lookup", "get"].includes(role)) return "read";
  if (["write", "writes", "persist", "upsert", "save"].includes(role)) return "write";
  return role;
}

function objectCovered(object: string, declared: string[]): boolean {
  const wanted = normalized(object);
  return declared.some((item) => normalized(item) === wanted || item.trim() === "*");
}

function readCapability(tool: RealTool, object: string): boolean {
  return (tool.capabilities ?? []).some((capability) =>
    capability.roles.some((role) => canonicalRole(role) === "read")
    && objectCovered(object, capability.objectTypes ?? []),
  );
}

function readIntegrationBinding(binding: IntegrationToolBinding, object: string): boolean {
  return binding.status === "resolved"
    && binding.bindingKind === "tool"
    && !!binding.toolName
    && canonicalRole(binding.requirement.role) === "read"
    && objectCovered(object, binding.requirement.objectTypes);
}

function issue(code: string, field: string, message: string): InputBindingCompileIssue {
  return { code, field, message };
}

function bindingKindOf(input: Row): string {
  return text(input.binding_kind ?? input.bindingKind);
}

function stringRefs(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : value == null || value === "" ? [] : [value];
  return raw.map(text).filter(Boolean);
}

type ConfigReference = { toolName: string; configKey: string; canonical: string };

function parseConfigReference(
  reference: string,
  toolConfigs: Record<string, Record<string, unknown>>,
): ConfigReference | null {
  const explicit = reference.match(/^tool:([^:]+):([A-Za-z_][A-Za-z0-9_-]*)$/);
  if (explicit) {
    const toolName = explicit[1]!;
    const configKey = explicit[2]!;
    return Object.prototype.hasOwnProperty.call(toolConfigs[toolName] ?? {}, configKey)
      ? { toolName, configKey, canonical: `tool:${toolName}:${configKey}` }
      : null;
  }
  const candidates = Object.keys(toolConfigs)
    .sort((left, right) => right.length - left.length)
    .flatMap((toolName) => {
      const prefix = `${toolName}.`;
      if (!reference.startsWith(prefix)) return [];
      const configKey = reference.slice(prefix.length);
      return configKey && Object.prototype.hasOwnProperty.call(toolConfigs[toolName] ?? {}, configKey)
        ? [{ toolName, configKey, canonical: `tool:${toolName}:${configKey}` }]
        : [];
    });
  return candidates.length === 1 ? candidates[0]! : null;
}

function parseAuthoringConfigReference(
  reference: string,
  tools: readonly RealTool[],
): ConfigReference | null {
  const declaredKeys = (tool: RealTool): Set<string> => new Set([
    ...(tool.configKeys ?? []),
    ...Object.keys(tool.catalogDefinition?.configSchema ?? {}),
  ]);
  const explicit = reference.match(/^tool:([^:]+):([A-Za-z_][A-Za-z0-9_-]*)$/);
  if (explicit) {
    const toolName = explicit[1]!;
    const configKey = explicit[2]!;
    const tool = tools.find((candidate) => candidate.name === toolName);
    return tool && declaredKeys(tool).has(configKey)
      ? { toolName, configKey, canonical: `tool:${toolName}:${configKey}` }
      : null;
  }
  const candidates = [...tools]
    .sort((left, right) => right.name.length - left.name.length)
    .flatMap((tool) => {
      const prefix = `${tool.name}.`;
      if (!reference.startsWith(prefix)) return [];
      const configKey = reference.slice(prefix.length);
      return configKey && declaredKeys(tool).has(configKey)
        ? [{ toolName: tool.name, configKey, canonical: `tool:${tool.name}:${configKey}` }]
        : [];
    });
  return candidates.length === 1 ? candidates[0]! : null;
}

function canonicalArgumentPath(value: string): string | null {
  if (!SAFE_PATH.test(value)) return null;
  if (value.startsWith("event.") || value.startsWith("bindings.")) return value;
  if (value.startsWith("input.")) return `bindings.${value.slice("input.".length)}`;
  // A bare Action-input lookup key is unambiguously an incoming Event path.
  return `event.${value}`;
}

function canonicalType(value: string): string {
  const raw = value.trim().toLocaleLowerCase().replace(/\s+/g, "");
  if (/\[\]$/.test(raw) || /^(array|list|set)(<.*>)?$/.test(raw)) return "array";
  if (["string", "str", "text", "uuid", "date", "datetime", "timestamp", "url", "email"].includes(raw)) return "string";
  if (["integer", "int", "int32", "int64", "long"].includes(raw)) return "integer";
  if (["number", "float", "double", "decimal", "numeric"].includes(raw)) return "number";
  if (["boolean", "bool"].includes(raw)) return "boolean";
  if (["object", "record", "map", "json", "jsonobject"].includes(raw)) return "object";
  if (["any", "unknown", "jsonvalue"].includes(raw)) return "any";
  return normalized(raw);
}

/** Conservative design-time compatibility for a step output feeding an Action
 * input. Numeric widening (integer → number) is allowed; other mismatches are
 * rejected instead of delegated to a prompt. */
export function inputBindingTypesCompatible(sourceType: string, targetType: string): boolean {
  const source = canonicalType(sourceType);
  const target = canonicalType(targetType);
  return source === target || target === "any" || source === "any" || (source === "integer" && target === "number");
}

function topologicallyOrderAcquisitions(
  bindings: GeneratedInputBinding[],
  errors: InputBindingCompileIssue[],
): GeneratedInputBinding[] {
  const acquisitions = bindings.filter((binding) => binding.kind === "human_input" || binding.kind === "object_lookup");
  const rest = bindings.filter((binding) => binding.kind !== "human_input" && binding.kind !== "object_lookup");
  const byField = new Map(bindings.map((binding) => [binding.field, binding]));
  const pending = new Map(acquisitions.map((binding, index) => [binding.field, { binding, index }]));
  const ordered: GeneratedInputBinding[] = [];

  for (const binding of acquisitions) {
    if (binding.kind !== "object_lookup") continue;
    for (const dependency of binding.dependsOn ?? []) {
      const source = byField.get(dependency);
      if (!source) {
        errors.push(issue("input_binding_dependency_unknown", binding.field, `object_lookup 参数引用了不存在的 input「${dependency}」`));
      } else if (source.kind === "secret" || source.kind === "config") {
        errors.push(issue("input_binding_dependency_reference_only", binding.field, `object_lookup 不能把 ${source.kind}「${dependency}」当业务参数；凭证/配置只能由已注册工具的 config 解析`));
      } else if (source.kind === "step_output") {
        errors.push(issue("input_binding_dependency_after_plan", binding.field, `object_lookup「${binding.field}」在 plan 前执行，不能依赖 plan 内的 step_output「${dependency}」`));
      }
    }
  }

  while (pending.size) {
    const ready = [...pending.values()]
      .filter(({ binding }) => binding.kind !== "object_lookup" || (binding.dependsOn ?? []).every((dep) => !pending.has(dep)))
      .sort((left, right) => left.index - right.index)[0];
    if (!ready) {
      const cycle = [...pending.keys()];
      for (const field of cycle) errors.push(issue("input_binding_dependency_cycle", field, `input acquisition 存在循环依赖：${cycle.join(" → ")}`));
      break;
    }
    ordered.push(ready.binding);
    pending.delete(ready.binding.field);
  }

  // Keep declarative bindings reviewable in ontology order, followed by the
  // executable acquisition order. Projection selects only acquisition rows.
  return [...rest, ...ordered];
}

/** Compile raw Ontology Action.inputs into an explicit runtime contract.  This
 * function never picks a tool by name similarity: object lookups must resolve
 * to one exact, selected, registered read tool with a resolved integration
 * receipt. */
export function compileInputBindings(
  action: OntologyAction,
  options: CompileInputBindingsOptions = {},
): InputBindingCompileResult {
  const bindings: GeneratedInputBinding[] = [];
  const errors: InputBindingCompileIssue[] = [];
  const warnings: InputBindingCompileIssue[] = [];
  const selected = new Set(options.selectedTools ?? []);
  const registered = new Map((options.registeredTools ?? []).map((tool) => [tool.name, tool]));
  const integrationBindings = options.integrationBindings ?? [];
  const authoring = options.mode === "authoring";
  const inputs = rows(action.inputs);
  const inputNames = new Set(inputs.map((input) => text(input.name)).filter(Boolean));
  const ontologySteps = analyzeExecutionPlanRequirement(action).ontologySteps;
  const actionSteps = rows(action.action_steps);
  const plan = options.plan ?? [];

  for (const input of inputs) {
    const field = text(input.name);
    const type = text(input.type);
    const required = input.required === true;
    if (!field || !type) {
      errors.push(issue("input_binding_schema_incomplete", field || "<unnamed>", "Action input 缺少 name/type，无法生成执行绑定"));
      continue;
    }
    if (!SAFE_FIELD.test(field) || FORBIDDEN_FIELD_NAMES.has(field)) {
      errors.push(issue("input_binding_field_invalid", field, `Action input 名「${field}」不能作为安全的运行时字段`));
      continue;
    }
    const rawKind = bindingKindOf(input);
    if (!BINDING_KINDS.has(rawKind as OntologyInputBindingKind)) {
      const entry = issue(
        rawKind ? "input_binding_kind_unknown" : "input_binding_kind_missing",
        field,
        rawKind ? `binding_kind「${rawKind}」不受支持` : "没有 binding_kind，工厂不会猜这个值来自 Event、对象库还是人工输入",
      );
      if (required) errors.push(entry);
      else warnings.push(entry);
      continue;
    }
    const kind = rawKind as OntologyInputBindingKind;

    if (kind === "event") {
      const rawPath = text(input.event_path ?? input.eventPath ?? input.event_field ?? input.eventField ?? input.source_field ?? input.sourceField) || field;
      if (!SAFE_PATH.test(rawPath)) {
        errors.push(issue("input_binding_event_path_invalid", field, `event path「${rawPath}」不是安全数据路径`));
        continue;
      }
      const sourceEvents = stringRefs(input.source_event ?? input.sourceEvent);
      const unknownSourceEvents = sourceEvents.filter(
        (sourceEvent) => !(action.trigger ?? []).some((trigger) => normalized(trigger) === normalized(sourceEvent)),
      );
      if (unknownSourceEvents.length) {
        errors.push(issue("input_binding_source_event_unknown", field, `source_event「${unknownSourceEvents.join("、")}」不在 Action.trigger 中`));
        continue;
      }
      bindings.push({
        field,
        type,
        required,
        kind,
        eventPath: rawPath,
        ...(sourceEvents.length ? { sourceEvents } : {}),
        ...(text(input.source_object ?? input.sourceObject) ? { sourceObject: text(input.source_object ?? input.sourceObject) } : {}),
      });
      continue;
    }

    if (kind === "secret" || kind === "config") {
      const reference = text(
        input.binding_ref
        ?? input.bindingRef
        ?? (kind === "secret" ? input.secret_ref ?? input.secretRef : input.config_ref ?? input.configRef),
      );
      if (!reference) {
        errors.push(issue("input_binding_reference_missing", field, `${kind} binding 缺少 binding_ref；真实值不能写进 Ontology`));
        continue;
      }
      const resolvedReference = authoring
        ? parseAuthoringConfigReference(reference, options.registeredTools ?? [])
        : parseConfigReference(reference, options.toolConfigs ?? {});
      if (!resolvedReference) {
        errors.push(issue("input_binding_reference_unresolved", field, `${kind} binding_ref「${reference}」没有解析到已选择工具的 profile config；请使用 toolName.configKey，不要填字面值/环境变量名`));
        continue;
      }
      if (!selected.has(resolvedReference.toolName)) {
        errors.push(issue(
          "input_binding_reference_tool_not_selected",
          field,
          `${kind} binding 指向工具「${resolvedReference.toolName}」，但该工具没有进入本 agent 的 tools；请显式选中它或修正 binding_ref`,
        ));
        continue;
      }
      const profileRef = text(options.toolProfileRefs?.[resolvedReference.toolName]);
      if (!authoring && !profileRef) {
        errors.push(issue("input_binding_profile_unconfirmed", field, `${kind} binding 指向 ${resolvedReference.toolName}.${resolvedReference.configKey}，但该工具没有用户确认的 integration profile`));
        continue;
      }
      const configValue = options.toolConfigs?.[resolvedReference.toolName]?.[resolvedReference.configKey];
      if (kind === "secret") {
        if (!/_env$/i.test(resolvedReference.configKey)) {
          errors.push(issue("input_binding_secret_not_env_ref", field, `secret binding 必须指向已确认 profile 的 *_env 字段；${resolvedReference.configKey} 不是 env reference`));
          continue;
        }
        const envName = text(configValue);
        if (!authoring && !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(envName)) {
          errors.push(issue("input_binding_secret_env_ref_invalid", field, `${resolvedReference.toolName}.${resolvedReference.configKey} 没有保存合法的环境变量名`));
          continue;
        }
        if (!authoring && !(options.env ?? process.env)[envName]?.trim()) {
          errors.push(issue("input_binding_secret_env_missing", field, `服务器没有配置 ${envName}；只检测是否存在，不读取或保存 secret 值`));
          continue;
        }
      } else {
        if (/_env$/i.test(resolvedReference.configKey)) {
          errors.push(issue("input_binding_config_points_to_secret", field, `config binding 不能指向 *_env 凭证字段 ${resolvedReference.configKey}；请声明为 secret`));
          continue;
        }
        if (!authoring && (configValue === undefined || configValue === null || (typeof configValue === "string" && !configValue.trim()))) {
          errors.push(issue("input_binding_config_value_missing", field, `已确认 profile 的 ${resolvedReference.toolName}.${resolvedReference.configKey} 没有配置值`));
          continue;
        }
      }
      bindings.push({ field, type, required, kind, reference: resolvedReference.canonical });
      continue;
    }

    if (kind === "human_input") {
      const prompt = text(input.prompt ?? input.description);
      if (!prompt) {
        errors.push(issue("input_binding_human_prompt_missing", field, "human_input 缺少给用户看的自然语言问题"));
        continue;
      }
      bindings.push({ field, type, required, kind, prompt });
      continue;
    }

    if (kind === "step_output") {
      const sourceStepRef = text(input.source_step ?? input.sourceStep ?? input.step_id ?? input.stepId);
      const sourceOutput = text(input.source_output ?? input.sourceOutput ?? input.output_name ?? input.outputName);
      const stepIndex = actionSteps.findIndex((step) => {
        const aliases = [text(step.id), text(step.step_id), text(step.stepId), text(step.name)].filter(Boolean).map(normalized);
        return aliases.includes(normalized(sourceStepRef));
      });
      if (!sourceStepRef || stepIndex < 0) {
        errors.push(issue("input_binding_step_unknown", field, `step_output 引用了不存在的 action_step「${sourceStepRef || "<missing>"}」`));
        continue;
      }
      if (!sourceOutput || !SAFE_PATH.test(sourceOutput)) {
        errors.push(issue("input_binding_step_output_invalid", field, `source_output「${sourceOutput || "<missing>"}」缺失或不是安全数据路径`));
        continue;
      }
      const step = actionSteps[stepIndex]!;
      const outputName = sourceOutput.split(".")[0]!;
      const output = rows(step.outputs).find((row) => normalized(text(row.name)) === normalized(outputName));
      if (!output) {
        errors.push(issue("input_binding_step_output_unknown", field, `action_step「${sourceStepRef}」没有声明 output「${outputName}」`));
        continue;
      }
      const sourceType = text(output.type);
      if (!sourceType) {
        errors.push(issue("input_binding_step_output_type_missing", field, `action_step「${sourceStepRef}」的 output「${outputName}」没有 type`));
        continue;
      }
      if (!inputBindingTypesCompatible(sourceType, type)) {
        errors.push(issue("input_binding_step_output_type_mismatch", field, `step output ${sourceStepRef}.${outputName} 是 ${sourceType}，不能绑定到 ${field}:${type}`));
        continue;
      }
      const sourceStep = ontologySteps[stepIndex]?.stepId ?? sourceStepRef;
      const planIndex = plan.findIndex((stepItem) => stepItem.stepId === sourceStep);
      if (planIndex < 0) {
        errors.push(issue("input_binding_step_not_in_plan", field, `step_output 的来源「${sourceStep}」没有进入结构化 plan`));
        continue;
      }
      bindings.push({ field, type, required, kind, sourceStep, sourceOutput });
      continue;
    }

    const sourceObject = text(input.source_object ?? input.sourceObject);
    const object = objectRef(sourceObject);
    if (!sourceObject || !object || !propertyRef(sourceObject)) {
      errors.push(issue("input_binding_lookup_source_invalid", field, "object_lookup 必须声明 source_object=Object.property"));
      continue;
    }
    const rawArgs = input.lookup_args ?? input.lookupArgs ?? input.arguments;
    if (!rawArgs || typeof rawArgs !== "object" || Array.isArray(rawArgs) || !Object.keys(rawArgs as Row).length) {
      errors.push(issue("input_binding_lookup_arguments_missing", field, "object_lookup 缺少 lookup_args（工具参数名 → event/input 安全路径）"));
      continue;
    }
    const args: Record<string, string> = {};
    const dependencies = new Set<string>();
    for (const [name, value] of Object.entries(rawArgs as Row)) {
      const source = text(value);
      const path = source ? canonicalArgumentPath(source) : null;
      if (!name.trim() || !path) {
        errors.push(issue("input_binding_lookup_argument_invalid", field, `lookup_args.${name || "<unnamed>"} 必须是安全路径字符串，不能内联常量或凭证`));
        continue;
      }
      args[name] = path;
      const dependency = path.match(/^bindings\.([A-Za-z_$][A-Za-z0-9_$-]*)/)?.[1];
      if (dependency) dependencies.add(dependency);
    }
    if (Object.keys(args).length !== Object.keys(rawArgs as Row).length) continue;
    const resultPath = text(input.result_path ?? input.resultPath ?? input.lookup_result_path ?? input.lookupResultPath);
    if (!resultPath || !SAFE_PATH.test(resultPath)) {
      errors.push(issue("input_binding_lookup_result_path_missing", field, "object_lookup 缺少安全的 result_path；工厂不会猜工具响应里的字段"));
      continue;
    }

    const explicitTool = text(input.lookup_tool ?? input.lookupTool ?? input.binding_tool ?? input.bindingTool ?? input.tool_name ?? input.toolName);
    const integrationRef = text(input.integration_ref ?? input.integrationRef);
    let candidates = integrationBindings.filter((binding) =>
      readIntegrationBinding(binding, object)
      || (authoring
        && binding.bindingKind === "tool"
        && !!binding.toolName
        && (binding.status === "needs_config" || binding.status === "needs_probe")
        && canonicalRole(binding.requirement.role) === "read"
        && objectCovered(object, binding.requirement.objectTypes)));
    if (integrationRef) {
      candidates = candidates.filter((binding) =>
        binding.requirement.id === integrationRef || binding.bindingId === integrationRef,
      );
    }
    if (explicitTool) candidates = candidates.filter((binding) => binding.toolName === explicitTool);
    const candidateTools = [...new Set(candidates.map((binding) => binding.toolName).filter((name): name is string => !!name))];
    if (candidateTools.length !== 1) {
      errors.push(issue(
        candidateTools.length ? "input_binding_lookup_tool_ambiguous" : "input_binding_lookup_tool_unresolved",
        field,
        candidateTools.length
          ? `object_lookup 同时匹配多个已就绪读工具：${candidateTools.join("、")}；请声明 lookup_tool 或 integration_ref`
          : `object_lookup 没有匹配到覆盖 ${object} 的已就绪 read integration；请先注册、配置并 probe 真实工具`,
      ));
      continue;
    }
    const toolName = candidateTools[0]!;
    const tool = registered.get(toolName);
    if (!tool || !readCapability(tool, object)) {
      errors.push(issue("input_binding_lookup_tool_not_registered", field, `集成回执指向的工具「${toolName}」未注册，或没有声明 ${object} 的 read capability`));
      continue;
    }
    if (!selected.has(toolName)) {
      errors.push(issue("input_binding_lookup_tool_not_selected", field, `object_lookup 需要工具「${toolName}」，但本 agent 没有选择它；请显式加入 tools 后重交`));
      continue;
    }
    for (const dependency of dependencies) {
      if (!inputNames.has(dependency)) {
        errors.push(issue("input_binding_dependency_unknown", field, `lookup_args 引用了不存在的 input「${dependency}」`));
      }
    }
    bindings.push({
      field,
      type,
      required,
      kind,
      sourceObject,
      tool: toolName,
      arguments: args,
      resultPath,
      ...(dependencies.size ? { dependsOn: [...dependencies] } : {}),
    });
  }

  const ordered = topologicallyOrderAcquisitions(bindings, errors);
  return { ok: errors.length === 0, bindings: ordered, errors, warnings };
}
