/**
 * Machine-readable safety contract for a live probe that can write external
 * state.  Tool names are deliberately absent: every decision is derived from
 * the declared side-effect class and this contract.
 */
export type WriteCapableSideEffect = "write" | "dual";

export interface ProbeArgumentValueContract {
  kind: "argument";
  /** Safe dotted path in the tool argument object. */
  path: string;
  /** Non-secret prefix used to identify disposable probe data. */
  valuePrefix: string;
}

export type ProbeIdempotencyContract =
  | ProbeArgumentValueContract
  | {
      kind: "handler";
      /** Dotted path in create result containing the effective key/receipt. */
      receiptPath: string;
    };

export type ProbeCleanupContract =
  | { kind: "handler"; handler: string }
  | { kind: "operation"; operation: string };

export type ProbeAbsenceProofContract =
  | { kind: "handler"; handler: string }
  | { kind: "operation"; operation: string };

export interface WriteProbeSafetyContract {
  testDataContract: {
    kind: "synthetic_canary";
    marker: ProbeArgumentValueContract;
  };
  idempotency: ProbeIdempotencyContract;
  isolation: {
    namespace: ProbeArgumentValueContract;
    target: ProbeArgumentValueContract;
  };
  cleanup: ProbeCleanupContract;
  absenceProof: ProbeAbsenceProofContract;
}

export type WriteProbeSafetyMissingField =
  | "test_data_contract"
  | "idempotency_key"
  | "canary_namespace"
  | "canary_target"
  | "cleanup"
  | "absence_readback";

export type WriteProbeSafetyPreflight =
  | {
      status: "ready";
      next: "execute";
      required: true;
      contract: WriteProbeSafetyContract;
    }
  | {
      status: "not_required";
      next: "execute";
      required: false;
    }
  | {
      status: "needs_config";
      next: "ask_user";
      required: true;
      missing: WriteProbeSafetyMissingField[];
      question: string;
    };

const SAFE_PATH_SEGMENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const BLOCKED_PATH_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/;

export function isWriteCapableSideEffect(sideEffect: unknown): sideEffect is WriteCapableSideEffect {
  return sideEffect === "write" || sideEffect === "dual";
}

export function safeProbePath(path: unknown): path is string {
  if (typeof path !== "string") return false;
  const segments = path.split(".");
  return segments.length > 0
    && segments.every((segment) => SAFE_PATH_SEGMENT.test(segment) && !BLOCKED_PATH_SEGMENTS.has(segment));
}

function validPrefix(value: unknown): value is string {
  return typeof value === "string"
    && value.length >= 3
    && value.length <= 80
    && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
}

function validArgumentContract(value: unknown): value is ProbeArgumentValueContract {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return row.kind === "argument" && safeProbePath(row.path) && validPrefix(row.valuePrefix);
}

function validLifecycleContract(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return row.kind === "handler"
    ? typeof row.handler === "string" && SAFE_IDENTIFIER.test(row.handler)
    : row.kind === "operation"
      ? typeof row.operation === "string" && SAFE_IDENTIFIER.test(row.operation)
      : false;
}

/**
 * Fail-closed metadata inspection used by design-time binding and both live
 * probe boundaries. It intentionally reports configuration work rather than
 * guessing a cleanup operation from a tool name.
 */
export function inspectWriteProbeSafety(
  sideEffect: unknown,
  value: unknown,
): WriteProbeSafetyPreflight {
  if (!isWriteCapableSideEffect(sideEffect)) {
    return { status: "not_required", next: "execute", required: false };
  }

  const row = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const testData = row.testDataContract && typeof row.testDataContract === "object"
    ? row.testDataContract as Record<string, unknown>
    : {};
  const isolation = row.isolation && typeof row.isolation === "object"
    ? row.isolation as Record<string, unknown>
    : {};
  const idempotency = row.idempotency && typeof row.idempotency === "object"
    ? row.idempotency as Record<string, unknown>
    : {};
  const missing: WriteProbeSafetyMissingField[] = [];

  if (testData.kind !== "synthetic_canary" || !validArgumentContract(testData.marker)) {
    missing.push("test_data_contract");
  }
  if (!(
    validArgumentContract(idempotency)
    || (idempotency.kind === "handler" && safeProbePath(idempotency.receiptPath))
  )) missing.push("idempotency_key");
  if (!validArgumentContract(isolation.namespace)) missing.push("canary_namespace");
  if (!validArgumentContract(isolation.target)) missing.push("canary_target");
  if (!validLifecycleContract(row.cleanup)) missing.push("cleanup");
  if (!validLifecycleContract(row.absenceProof)) missing.push("absence_readback");

  if (missing.length) {
    return {
      status: "needs_config",
      next: "ask_user",
      required: true,
      missing,
      question: `这个写工具还不能安全做真实探针。请补充 canary 测试数据、幂等键、隔离 namespace/target、cleanup，以及 cleanup 后的 absence/readback 证明（缺少：${missing.join(", ")}）。`,
    };
  }
  return {
    status: "ready",
    next: "execute",
    required: true,
    contract: value as WriteProbeSafetyContract,
  };
}

function setArgumentAtPath(
  args: Record<string, unknown>,
  path: string,
  value: string,
): Record<string, unknown> | null {
  if (!safeProbePath(path)) return null;
  const output = structuredClone(args);
  const segments = path.split(".");
  let cursor: Record<string, unknown> = output;
  for (const segment of segments.slice(0, -1)) {
    const current = cursor[segment];
    if (current == null) cursor[segment] = {};
    if (!cursor[segment] || typeof cursor[segment] !== "object" || Array.isArray(cursor[segment])) return null;
    cursor = cursor[segment] as Record<string, unknown>;
  }
  const leaf = segments.at(-1)!;
  const current = cursor[leaf];
  // A caller may retry the exact prepared request, but cannot choose a
  // different namespace/target/idempotency value.
  if (current !== undefined && current !== null && current !== "" && current !== value) return null;
  cursor[leaf] = value;
  return output;
}

export interface PreparedWriteProbeCanary {
  args: Record<string, unknown>;
  marker: string;
  namespace: string;
  target: string;
  idempotencyKey?: string;
}

export function prepareWriteProbeCanary(input: {
  args: Record<string, unknown>;
  contract: WriteProbeSafetyContract;
  /** Stable, non-secret lower-case hex seed bound to definition + execution. */
  seed: string;
}): { ok: true; canary: PreparedWriteProbeCanary } | { ok: false; reason: string } {
  if (!/^[a-f0-9]{32,128}$/.test(input.seed)) {
    return { ok: false, reason: "canary seed is missing or invalid" };
  }
  const suffix = input.seed.slice(0, 24);
  const marker = `${input.contract.testDataContract.marker.valuePrefix}${suffix}`;
  const namespace = `${input.contract.isolation.namespace.valuePrefix}${suffix}`;
  const target = `${input.contract.isolation.target.valuePrefix}${suffix}`;
  const idempotencyKey = input.contract.idempotency.kind === "argument"
    ? `${input.contract.idempotency.valuePrefix}${input.seed}`
    : undefined;
  const writes: Array<[ProbeArgumentValueContract, string]> = [
    [input.contract.testDataContract.marker, marker],
    [input.contract.isolation.namespace, namespace],
    [input.contract.isolation.target, target],
    ...(input.contract.idempotency.kind === "argument"
      ? [[input.contract.idempotency, idempotencyKey!] as [ProbeArgumentValueContract, string]]
      : []),
  ];
  let args = input.args;
  for (const [contract, value] of writes) {
    const next = setArgumentAtPath(args, contract.path, value);
    if (!next) return { ok: false, reason: `probe argument path ${contract.path} conflicts with the isolated canary value` };
    args = next;
  }
  return { ok: true, canary: { args, marker, namespace, target, ...(idempotencyKey ? { idempotencyKey } : {}) } };
}

export function readProbeResultPath(value: unknown, path: string): unknown {
  if (!safeProbePath(path)) return undefined;
  return path.split(".").reduce<unknown>((cursor, segment) => {
    if (!cursor || typeof cursor !== "object" || Array.isArray(cursor)) return undefined;
    return (cursor as Record<string, unknown>)[segment];
  }, value);
}
