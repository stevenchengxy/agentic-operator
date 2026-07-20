import type { FactoryInputBinding } from "./manifest";

const FORBIDDEN_PATH_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);
const SAFE_BINDING_FIELD = /^[A-Za-z_$][A-Za-z0-9_$-]*$/;

export interface RuntimeInputBindingIssue {
  code: string;
  field: string;
  message: string;
}

export interface RuntimeInputBindingState {
  /** Original trigger data. Object lookups cannot mutate what `event.*` means. */
  readonly eventData: Record<string, unknown>;
  /** Business input visible to subsequent tools/code/LLM steps. */
  readonly data: Record<string, unknown>;
  /** Reference receipts only. Values are intentionally absent. */
  readonly references: Record<string, { kind: "secret" | "config"; reference: string }>;
  readonly resolved: Set<string>;
  /** Event-scoped inputs that do not apply to the current trigger. */
  readonly inactive: Set<string>;
}

export interface RuntimeInputReferenceContext {
  toolConfigs: Record<string, Record<string, unknown>>;
  toolProfileRefs: Record<string, string>;
  env?: Record<string, string | undefined>;
  /** Actual wire event name. Tenant-qualified names are matched by their bare
   * suffix against manifest source_events. */
  eventName?: string;
}

function eventBindingApplies(binding: FactoryInputBinding, eventName: string | undefined): boolean {
  if (binding.kind !== "event" || !binding.source_events?.length) return true;
  if (!eventName?.trim()) return false;
  const raw = eventName.trim();
  const bare = raw.includes("/") ? raw.slice(raw.lastIndexOf("/") + 1) : raw;
  return binding.source_events.some((source) => source === raw || source === bare);
}

export class InputBindingResolutionError extends Error {
  readonly issues: RuntimeInputBindingIssue[];

  constructor(issues: RuntimeInputBindingIssue[]) {
    super(issues.map((entry) => `${entry.field}: ${entry.message}`).join("; "));
    this.name = "InputBindingResolutionError";
    this.issues = issues;
  }
}

type PathResult = { found: true; value: unknown } | { found: false; value?: undefined };

function pathSegments(path: string): string[] | null {
  if (path === "$" || path === "") return [];
  const normalized = path.replace(/\?\./g, ".");
  const segments: string[] = [];
  let cursor = 0;
  const token = /(?:^|\.)([A-Za-z_$][A-Za-z0-9_$-]*)|\[['"]([^'"\]]+)['"]\]/g;
  for (const match of normalized.matchAll(token)) {
    if (match.index !== cursor) return null;
    const segment = match[1] ?? match[2];
    if (!segment || FORBIDDEN_PATH_SEGMENTS.has(segment)) return null;
    segments.push(segment);
    cursor = match.index + match[0].length;
  }
  return cursor === normalized.length ? segments : null;
}

export function readInputBindingPath(root: unknown, path: string): PathResult {
  const segments = pathSegments(path);
  if (!segments) return { found: false };
  let current = root;
  for (const segment of segments) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return { found: false };
    if (!Object.prototype.hasOwnProperty.call(current, segment)) return { found: false };
    current = (current as Record<string, unknown>)[segment];
  }
  return { found: current !== undefined, ...(current !== undefined ? { value: current } : {}) } as PathResult;
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
  // Custom ontology types are compared at design time. Their runtime JSON
  // representation is domain-defined, so coercing them to object/string here
  // would manufacture a contract the ontology never declared.
  return "any";
}

export function inputBindingValueMatchesType(value: unknown, declaredType: string): boolean {
  switch (canonicalType(declaredType)) {
    case "any": return true;
    case "string": return typeof value === "string";
    case "integer": return typeof value === "number" && Number.isSafeInteger(value);
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "boolean": return typeof value === "boolean";
    case "array": return Array.isArray(value);
    case "object": return !!value && typeof value === "object" && !Array.isArray(value);
    default: return false;
  }
}

function missingValue(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === "string" && value.trim() === "");
}

function valueIssue(binding: FactoryInputBinding, value: unknown, found: boolean): RuntimeInputBindingIssue | null {
  if (!found || missingValue(value)) {
    return binding.required
      ? { code: "required_input_missing", field: binding.field, message: `必填输入没有值（来源：${binding.kind}）` }
      : null;
  }
  if (!inputBindingValueMatchesType(value, binding.type)) {
    return { code: "input_type_mismatch", field: binding.field, message: `收到的值不是声明的 ${binding.type}` };
  }
  return null;
}

function setValue(state: RuntimeInputBindingState, binding: FactoryInputBinding, result: PathResult): RuntimeInputBindingIssue | null {
  if (!SAFE_BINDING_FIELD.test(binding.field) || FORBIDDEN_PATH_SEGMENTS.has(binding.field)) {
    return { code: "input_binding_field_invalid", field: binding.field, message: "绑定字段名不安全" };
  }
  const problem = valueIssue(binding, result.value, result.found);
  if (problem) return problem;
  if (result.found && !missingValue(result.value)) {
    state.data[binding.field] = result.value;
    state.resolved.add(binding.field);
  }
  return null;
}

/** Resolve synchronous bindings. Secret/config refs are acknowledged without
 * dereferencing: registered tools already receive their reviewed config on a
 * separate channel, preventing credentials from entering business payloads. */
export function initializeInputBindings(
  bindings: FactoryInputBinding[],
  eventData: Record<string, unknown>,
  referenceContext: RuntimeInputReferenceContext = { toolConfigs: {}, toolProfileRefs: {} },
): { state: RuntimeInputBindingState; issues: RuntimeInputBindingIssue[] } {
  // Once a factory manifest declares an input contract, only fields acquired
  // through that contract may enter tool/logic business data. Keeping the
  // historical whole-event view for manifests with no bindings preserves
  // hand-written tenants while preventing an undeclared event field (PII or a
  // credential accidentally sent by a caller) from bypassing factory review.
  const state: RuntimeInputBindingState = {
    eventData: { ...eventData },
    data: bindings.length ? Object.create(null) as Record<string, unknown> : { ...eventData },
    references: Object.create(null) as Record<string, { kind: "secret" | "config"; reference: string }>,
    resolved: new Set<string>(),
    inactive: new Set<string>(),
  };
  const issues: RuntimeInputBindingIssue[] = [];
  for (const binding of bindings) {
    if (!SAFE_BINDING_FIELD.test(binding.field) || FORBIDDEN_PATH_SEGMENTS.has(binding.field)) {
      issues.push({ code: "input_binding_field_invalid", field: binding.field, message: "绑定字段名不安全" });
      continue;
    }
    if (binding.kind === "event") {
      if (!eventBindingApplies(binding, referenceContext.eventName)) {
        state.inactive.add(binding.field);
        continue;
      }
      const path = binding.event_path.startsWith("event.") ? binding.event_path.slice("event.".length) : binding.event_path;
      const problem = setValue(state, binding, readInputBindingPath(state.eventData, path));
      if (problem) issues.push(problem);
    } else if (binding.kind === "secret" || binding.kind === "config") {
      const match = binding.reference.match(/^tool:([^:]+):([A-Za-z_][A-Za-z0-9_-]*)$/);
      const toolName = match?.[1];
      const configKey = match?.[2];
      const config = toolName && Object.prototype.hasOwnProperty.call(referenceContext.toolConfigs, toolName)
        ? referenceContext.toolConfigs[toolName]
        : undefined;
      const profileRef = toolName && Object.prototype.hasOwnProperty.call(referenceContext.toolProfileRefs, toolName)
        ? referenceContext.toolProfileRefs[toolName]
        : undefined;
      const hasConfig = !!configKey && !!config && Object.prototype.hasOwnProperty.call(config, configKey);
      const configValue = hasConfig ? config![configKey!] : undefined;
      let problem: RuntimeInputBindingIssue | null = null;
      if (!toolName || !configKey || !hasConfig) {
        problem = { code: "input_reference_unresolved", field: binding.field, message: `${binding.kind} 引用没有解析到已注册工具配置` };
      } else if (!profileRef?.trim()) {
        problem = { code: "input_reference_profile_unconfirmed", field: binding.field, message: `${toolName} 没有确认过的 integration profile` };
      } else if (binding.kind === "secret") {
        const envName = typeof configValue === "string" ? configValue : "";
        if (!/_env$/i.test(configKey) || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(envName)) {
          problem = { code: "input_secret_reference_invalid", field: binding.field, message: "secret 必须指向 profile 中保存环境变量名的 *_env 字段" };
        } else if (!(referenceContext.env ?? process.env)[envName]?.trim()) {
          problem = { code: "input_secret_env_missing", field: binding.field, message: `服务器没有配置 ${envName}` };
        }
      } else if (/_env$/i.test(configKey) || missingValue(configValue)) {
        problem = { code: "input_config_reference_invalid", field: binding.field, message: "config 必须指向 profile 中已确认的非 secret 配置字段" };
      }
      if (problem) {
        issues.push(problem);
      } else {
        state.references[binding.field] = { kind: binding.kind, reference: binding.reference };
        state.resolved.add(binding.field);
      }
    }
  }
  return { state, issues };
}

function resolveArgumentSource(state: RuntimeInputBindingState, path: string): PathResult {
  if (path.startsWith("event.")) return readInputBindingPath(state.eventData, path.slice("event.".length));
  if (path.startsWith("bindings.")) return readInputBindingPath(state.data, path.slice("bindings.".length));
  if (path.startsWith("input.")) return readInputBindingPath(state.data, path.slice("input.".length));
  return { found: false };
}

export function prepareObjectLookupArguments(
  state: RuntimeInputBindingState,
  binding: Extract<FactoryInputBinding, { kind: "object_lookup" }>,
): { ok: true; arguments: Record<string, unknown> } | { ok: false; issues: RuntimeInputBindingIssue[] } {
  const values = Object.create(null) as Record<string, unknown>;
  const issues: RuntimeInputBindingIssue[] = [];
  for (const [argument, path] of Object.entries(binding.arguments)) {
    const result = resolveArgumentSource(state, path);
    if (!result.found || missingValue(result.value)) {
      issues.push({ code: "lookup_argument_missing", field: binding.field, message: `查询参数「${argument}」无法从 ${path} 取得` });
    } else {
      values[argument] = result.value;
    }
  }
  return issues.length ? { ok: false, issues } : { ok: true, arguments: values };
}

export function applyObjectLookupResult(
  state: RuntimeInputBindingState,
  binding: Extract<FactoryInputBinding, { kind: "object_lookup" }>,
  result: unknown,
): RuntimeInputBindingIssue[] {
  const problem = setValue(state, binding, readInputBindingPath(result, binding.result_path));
  return problem ? [problem] : [];
}

export function applyHumanInputResult(
  state: RuntimeInputBindingState,
  binding: Extract<FactoryInputBinding, { kind: "human_input" }>,
  payload: unknown,
): RuntimeInputBindingIssue[] {
  let result: PathResult;
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const record = payload as Record<string, unknown>;
    result = Object.prototype.hasOwnProperty.call(record, binding.field)
      ? { found: record[binding.field] !== undefined, value: record[binding.field] } as PathResult
      : { found: record.value !== undefined, value: record.value } as PathResult;
  } else {
    result = { found: payload !== undefined, value: payload } as PathResult;
  }
  const problem = setValue(state, binding, result);
  return problem ? [problem] : [];
}

/** Resolve every step_output whose source action has completed. A missing or
 * mistyped required output fails before the next step can observe bad input. */
export function resolveAvailableStepOutputBindings(
  state: RuntimeInputBindingState,
  bindings: FactoryInputBinding[],
  stepResults: Record<string, unknown>,
): RuntimeInputBindingIssue[] {
  const issues: RuntimeInputBindingIssue[] = [];
  for (const binding of bindings) {
    if (binding.kind !== "step_output" || state.resolved.has(binding.field)) continue;
    if (!Object.prototype.hasOwnProperty.call(stepResults, binding.source_step)) continue;
    const problem = setValue(state, binding, readInputBindingPath(stepResults[binding.source_step], binding.source_output));
    if (problem) issues.push(problem);
  }
  return issues;
}

export function unresolvedRequiredInputBindings(
  state: RuntimeInputBindingState,
  bindings: FactoryInputBinding[],
): RuntimeInputBindingIssue[] {
  return bindings
    .filter((binding) => binding.required && !state.resolved.has(binding.field) && !state.inactive.has(binding.field))
    .map((binding) => ({
      code: "required_input_unresolved",
      field: binding.field,
      message: `运行结束前仍未取得必填输入（来源：${binding.kind}）`,
    }));
}

export function throwForInputBindingIssues(issues: RuntimeInputBindingIssue[]): void {
  if (issues.length) throw new InputBindingResolutionError(issues);
}
