import type { ToolCapabilityDescriptor } from "./tool-catalog";

export type DeclarativeSideEffect = "read" | "write" | "dual";

export type DeclarativeToolPolicyResult =
  | { ok: true; sideEffect: DeclarativeSideEffect }
  | { ok: false; error: string };

export type CapabilityDescriptorParseResult =
  | { ok: true; capabilities: ToolCapabilityDescriptor[] }
  | { ok: false; error: string };

const SAFE_HTTP_METHODS = new Set(["GET", "HEAD"]);
const MUTATING_HTTP_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

const normalizeSignal = (value: string): string =>
  value.normalize("NFKC").toLocaleLowerCase().replace(/[\s_.:/()-]+/g, "");

const READ_SIGNALS = new Set([
  "read", "reads", "get", "gets", "fetch", "fetches", "query", "queries",
  "search", "searches", "list", "lists", "lookup", "lookups", "inspect",
  "check", "validate", "download", "parse", "match",
]);

const WRITE_SIGNALS = new Set([
  "write", "writes", "create", "creates", "update", "updates", "delete",
  "deletes", "save", "saves", "persist", "upsert", "insert", "remove",
  "upload", "send", "invite", "publish", "notify", "trigger", "mutate",
  "post", "put", "patch",
]);

function signalKinds(capabilities: readonly ToolCapabilityDescriptor[]): { read: boolean; write: boolean } {
  let read = false;
  let write = false;
  for (const capability of capabilities) {
    for (const raw of [...capability.roles, ...(capability.operations ?? [])]) {
      const signal = normalizeSignal(raw);
      if (READ_SIGNALS.has(signal)) read = true;
      if (WRITE_SIGNALS.has(signal)) write = true;
    }
  }
  return { read, write };
}

/** Strict runtime parser for the public HTTP API; TypeScript types alone do
 * not validate JSON request bodies. */
export function parseCapabilityDescriptors(value: unknown): CapabilityDescriptorParseResult {
  if (value === undefined) return { ok: true, capabilities: [] };
  if (!Array.isArray(value)) return { ok: false, error: "capabilities 必须是数组" };
  const capabilities: ToolCapabilityDescriptor[] = [];
  for (let index = 0; index < value.length; index++) {
    const raw = value[index];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return { ok: false, error: `capabilities[${index}] 必须是对象` };
    }
    const row = raw as Record<string, unknown>;
    const allowed = new Set(["systems", "kinds", "roles", "operations", "objectTypes", "probeRequired"]);
    const extra = Object.keys(row).find((key) => !allowed.has(key));
    if (extra) return { ok: false, error: `capabilities[${index}].${extra} 不是允许字段` };
    const strings = (field: string, required: boolean): string[] | null => {
      const item = row[field];
      if (item === undefined && !required) return [];
      if (!Array.isArray(item) || item.some((entry) => typeof entry !== "string" || !entry.trim())) return null;
      return [...new Set(item.map((entry) => String(entry).trim()))];
    };
    const systems = strings("systems", true);
    const kinds = strings("kinds", true);
    const roles = strings("roles", true);
    const operations = strings("operations", false);
    const objectTypes = strings("objectTypes", false);
    if (!systems?.length || !kinds?.length || !roles?.length || operations === null || objectTypes === null) {
      return { ok: false, error: `capabilities[${index}] 必须显式声明非空 systems/kinds/roles，其他列表也只能含非空字符串` };
    }
    if (row.probeRequired !== undefined && typeof row.probeRequired !== "boolean") {
      return { ok: false, error: `capabilities[${index}].probeRequired 必须是 boolean` };
    }
    capabilities.push({
      systems,
      kinds,
      roles,
      ...(operations.length ? { operations } : {}),
      ...(objectTypes.length ? { objectTypes } : {}),
      ...(row.probeRequired !== undefined ? { probeRequired: row.probeRequired } : {}),
    });
  }
  return { ok: true, capabilities };
}

/**
 * Compute the only acceptable side-effect class from execution-bearing HTTP
 * facts. A caller-provided label is checked, never trusted as the source of
 * truth. Unknown methods and contradictory method/contract/capability shapes
 * fail closed.
 */
export function validateDeclarativeToolPolicy(input: {
  method: string;
  declaredSideEffect: unknown;
  bodyTemplate?: string;
  requestSpec?: unknown;
  capabilities?: readonly ToolCapabilityDescriptor[];
}): DeclarativeToolPolicyResult {
  const method = input.method.trim().toUpperCase();
  if (!SAFE_HTTP_METHODS.has(method) && !MUTATING_HTTP_METHODS.has(method)) {
    return { ok: false, error: `未知 HTTP method ${method || "(empty)"}；无法证明只读，已拒绝` };
  }
  if (input.declaredSideEffect !== "read" && input.declaredSideEffect !== "write" && input.declaredSideEffect !== "dual") {
    return { ok: false, error: "side_effect 必须明确为 read、write 或 dual；缺失/未知值不能按只读处理" };
  }

  const capabilities = input.capabilities ?? [];
  const signals = signalKinds(capabilities);
  let expected: DeclarativeSideEffect;
  if (SAFE_HTTP_METHODS.has(method)) {
    if (input.bodyTemplate !== undefined || input.requestSpec !== undefined) {
      return { ok: false, error: `${method} 被声明为安全读取，但同时携带请求体契约；副作用边界不明确，已拒绝` };
    }
    if (signals.write) {
      return { ok: false, error: `${method} 与 capabilities 中的写入操作冲突；不能把可能写入的工具登记为只读` };
    }
    expected = "read";
  } else {
    // POST/PUT/PATCH/DELETE are potentially mutating even when an API happens
    // to use one as a query tunnel. Such an exception cannot be inferred from
    // model prose, so it remains guarded as write/dual.
    if (capabilities.length > 0 && signals.read && !signals.write) {
      return { ok: false, error: `${method} 可能写入，但 capabilities 只声明读取；请修正契约，不能降级为 read` };
    }
    expected = signals.read && signals.write ? "dual" : "write";
  }

  if (input.declaredSideEffect !== expected) {
    return {
      ok: false,
      error: `side_effect=${String(input.declaredSideEffect)} 与 HTTP/contract/capabilities 推导结果 ${expected} 不一致`,
    };
  }
  return { ok: true, sideEffect: expected };
}
