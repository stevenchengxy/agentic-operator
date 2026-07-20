export type DraftEditorValueType =
  | "string"
  | "multiline"
  | "code"
  | "integer"
  | "number"
  | "boolean"
  | "enum"
  | "string_array"
  | "json";

export interface DraftEditorFieldContract {
  key: string;
  label: string;
  help: string;
  valueType: DraftEditorValueType;
  editable: boolean;
  readonlyReason?: string;
  unsettable: boolean;
  enumValues?: string[];
  present: boolean;
  valueStatus: "available" | "withheld_sensitive";
  value?: unknown;
}

export interface DraftEditorContract {
  schema: "agent-factory-draft-editor/v1";
  scope: {
    tenantId: string;
    tenantSlug: string;
    domain: string;
    slug: string;
    versionId: string;
  };
  fields: DraftEditorFieldContract[];
  evidenceEffect: DraftEditEvidenceEffect;
}

export interface StructuredDraftPatch {
  set?: Record<string, unknown>;
  unset?: string[];
}

export interface DraftEditEvidenceEffect {
  carriedForward: false;
  invalidatedForNewVersion: string[];
  requiredNext: string[];
}

export interface DraftFieldEditPreview {
  field: DraftEditorFieldContract;
  patch: StructuredDraftPatch;
  before: unknown;
  after: unknown;
  beforeWithheld: boolean;
}

export type DraftEditorValidation<T> =
  | { ok: true; data: T }
  | { ok: false; message: string };

export interface PatchedDraftVersionReceipt {
  domain: string;
  versionId: string;
  baseVersionId: string;
  changedSlug: string;
  regressionReady: false;
  evidenceEffect: DraftEditEvidenceEffect;
  scope: {
    tenantId: string;
    tenantSlug: string;
    domain: string;
    slug: string;
    baseVersionId: string;
  };
}

const VALUE_TYPES = new Set<DraftEditorValueType>([
  "string", "multiline", "code", "integer", "number", "boolean", "enum", "string_array", "json",
]);
const REQUIRED_INVALIDATIONS = ["human_review", "sandbox", "regression", "promotion_preview"];
const REQUIRED_NEXT = ["human_review", "sandbox_replay", "promotion_preview"];
const ENV_REFERENCE = /^[A-Z][A-Z0-9_]{1,127}$/;
const FIXTURE_ASSET_REFERENCE = /\bffa-[0-9a-f]{32}\b/i;
const DATA_URL_BYTES = /data:[^;,\s]+;base64,[a-z0-9+/=_-]+/i;
const PRIVATE_KEY = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i;
const JWT_LIKE = /\beyJ[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}\b/i;
const PROVIDER_KEY_LIKE = /\b(?:sk|rk|pk|api)[-_][a-z0-9_-]{8,}\b/i;
const AUTH_HEADER_LIKE = /\b(?:Bearer|Basic)\s+(?!\{)[A-Za-z0-9+/_=.:-]{4,}\b/i;
const AWS_ACCESS_KEY = /\bAKIA[0-9A-Z]{16}\b/;
const CREDENTIAL_URL = /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s/:@]+:[^\s/@]+@/i;
const ASSIGNED_SECRET = /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|authorization|password|passwd|secret|credential|cookie|session)\s*[:=]\s*(?!\{|\[REDACTED)[^\s,;"'}]{3,}/i;
const LONG_BASE64 = /^(?:[A-Za-z0-9+/]{4}){64,}(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const PADDED_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string");

function exactEvidenceEffect(value: unknown): value is DraftEditEvidenceEffect {
  if (!isRecord(value) || value.carriedForward !== false) return false;
  const invalidated = value.invalidatedForNewVersion;
  const requiredNext = value.requiredNext;
  if (!isStringArray(invalidated) || !isStringArray(requiredNext)) return false;
  return REQUIRED_INVALIDATIONS.every((item) => invalidated.includes(item))
    && REQUIRED_NEXT.every((item) => requiredNext.includes(item));
}

function valueMatchesType(field: DraftEditorFieldContract): boolean {
  if (!field.present || field.valueStatus === "withheld_sensitive") return field.value === undefined;
  if (draftEditContainsSensitiveData(field.value)) return false;
  switch (field.valueType) {
    case "string":
    case "multiline":
    case "code":
      return typeof field.value === "string";
    case "integer":
      return typeof field.value === "number" && Number.isSafeInteger(field.value);
    case "number":
      return typeof field.value === "number" && Number.isFinite(field.value);
    case "boolean":
      return typeof field.value === "boolean";
    case "enum":
      return typeof field.value === "string" && Boolean(field.enumValues?.includes(field.value));
    case "string_array":
      return isStringArray(field.value);
    case "json":
      return field.value !== undefined;
  }
}

function parseField(value: unknown): DraftEditorFieldContract | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.key !== "string" || !value.key
    || typeof value.label !== "string" || !value.label
    || typeof value.help !== "string"
    || typeof value.valueType !== "string" || !VALUE_TYPES.has(value.valueType as DraftEditorValueType)
    || typeof value.editable !== "boolean"
    || typeof value.unsettable !== "boolean"
    || typeof value.present !== "boolean"
    || (value.valueStatus !== "available" && value.valueStatus !== "withheld_sensitive")
    || (value.enumValues !== undefined && !isStringArray(value.enumValues))
  ) return null;
  if (
    (value.editable === false && (typeof value.readonlyReason !== "string" || !value.readonlyReason.trim() || value.unsettable !== false))
    || (value.editable === true && value.readonlyReason !== undefined)
  ) return null;
  if (value.valueStatus === "withheld_sensitive" && (value.present !== true || "value" in value)) return null;
  const field: DraftEditorFieldContract = {
    key: value.key,
    label: value.label,
    help: value.help,
    valueType: value.valueType as DraftEditorValueType,
    editable: value.editable,
    ...(value.editable === false ? { readonlyReason: value.readonlyReason as string } : {}),
    unsettable: value.unsettable,
    present: value.present,
    valueStatus: value.valueStatus,
    ...(value.enumValues !== undefined ? { enumValues: [...value.enumValues as string[]] } : {}),
    ...(value.present === true && value.valueStatus === "available" ? { value: value.value } : {}),
  };
  if (field.valueType === "enum" && (!field.enumValues || field.enumValues.length === 0)) return null;
  if (!valueMatchesType(field)) return null;
  return field;
}

/** Validate both response shape and the exact browser scope that initiated the
 * read. A late response from another tenant/domain/version is discarded. */
export function readDraftEditorContract(
  value: unknown,
  expected: { tenantSlug: string; domain: string; slug: string; versionId: string },
): DraftEditorValidation<DraftEditorContract> {
  if (!isRecord(value) || value.schema !== "agent-factory-draft-editor/v1" || !isRecord(value.scope)) {
    return { ok: false, message: "服务端没有返回可识别的草稿编辑契约。" };
  }
  const scope = value.scope;
  if (
    typeof scope.tenantId !== "string" || !scope.tenantId
    || scope.tenantSlug !== expected.tenantSlug
    || scope.domain !== expected.domain
    || scope.slug !== expected.slug
    || scope.versionId !== expected.versionId
  ) {
    return { ok: false, message: "草稿编辑范围已经变化，请刷新后重新打开。" };
  }
  if (!Array.isArray(value.fields) || !exactEvidenceEffect(value.evidenceEffect)) {
    return { ok: false, message: "草稿编辑契约不完整，已停止编辑。" };
  }
  const fields = value.fields.map(parseField);
  if (fields.length === 0 || fields.some((field) => !field)) {
    return { ok: false, message: "服务端返回了无法编辑的字段定义。" };
  }
  const keys = fields.map((field) => field!.key);
  if (new Set(keys).size !== keys.length) {
    return { ok: false, message: "草稿字段定义重复，已停止编辑。" };
  }
  return {
    ok: true,
    data: {
      schema: "agent-factory-draft-editor/v1",
      scope: {
        tenantId: scope.tenantId,
        tenantSlug: expected.tenantSlug,
        domain: expected.domain,
        slug: expected.slug,
        versionId: expected.versionId,
      },
      fields: fields as DraftEditorFieldContract[],
      evidenceEffect: {
        carriedForward: false,
        invalidatedForNewVersion: [...(value.evidenceEffect as DraftEditEvidenceEffect).invalidatedForNewVersion],
        requiredNext: [...(value.evidenceEffect as DraftEditEvidenceEffect).requiredNext],
      },
    },
  };
}

function canonicalEditorKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

function isEnvReferenceField(key: string, value: unknown): boolean {
  const canonical = canonicalEditorKey(key);
  return canonical.length > 4
    && canonical.endsWith("_env")
    && typeof value === "string"
    && ENV_REFERENCE.test(value);
}

const SENSITIVE_EDITOR_KEYS = new Set([
  "asset_id", "assetid", "base64",
  "auth", "auth_header", "authorization", "authorization_header",
  "bearer", "bearer_token", "cookie", "session", "session_id",
  "password", "passwd", "secret", "secret_key", "private_key",
  "token", "access_token", "refresh_token",
  "credential", "credentials", "client_secret",
  "api_key", "access_key", "client_key", "key",
]);

function sensitiveKey(key: string, value: unknown): boolean {
  if (/^~(?:[01])?key$/i.test(key)) return false;
  const canonical = canonicalEditorKey(key);
  if (SENSITIVE_EDITOR_KEYS.has(canonical)) return true;
  if (typeof value !== "string") return false;
  return /^(?:x_|proxy_|http_)?(?:auth|authorization|api_key)(?:_header|_token)?$/.test(canonical)
    || /_(?:auth|authorization|api_key|access_key|private_key|secret_key|client_secret|password|passwd|token|credential|cookie)$/.test(canonical);
}

function fixtureBytesInValue(key: string, value: unknown): boolean {
  const normalized = canonicalEditorKey(key).replace(/_/g, "");
  if (!["bytes", "content", "body", "payload", "raw", "filecontent", "filebytes"].includes(normalized)) return false;
  if (typeof value === "string") return PADDED_BASE64.test(value) || LONG_BASE64.test(value);
  return ["bytes", "filebytes", "raw"].includes(normalized)
    && Array.isArray(value)
    && value.length > 0
    && value.every((entry) => typeof entry === "number" && Number.isInteger(entry) && entry >= 0 && entry <= 255);
}

export function draftEditContainsSensitiveData(value: unknown): boolean {
  const visit = (entry: unknown): boolean => {
    if (typeof entry === "string") {
      return FIXTURE_ASSET_REFERENCE.test(entry)
        || DATA_URL_BYTES.test(entry)
        || LONG_BASE64.test(entry)
        || PRIVATE_KEY.test(entry)
        || JWT_LIKE.test(entry)
        || PROVIDER_KEY_LIKE.test(entry)
        || AUTH_HEADER_LIKE.test(entry)
        || AWS_ACCESS_KEY.test(entry)
        || CREDENTIAL_URL.test(entry)
        || ASSIGNED_SECRET.test(entry);
    }
    if (Array.isArray(entry)) return entry.some(visit);
    if (!isRecord(entry)) return false;
    return Object.entries(entry).some(([key, nested]) =>
      fixtureBytesInValue(key, nested)
      || (!isEnvReferenceField(key, nested) && sensitiveKey(key, nested))
      || visit(nested));
  };
  return visit(value);
}

export function draftEditorValueText(field: DraftEditorFieldContract): string {
  if (!field.present || field.valueStatus === "withheld_sensitive") return "";
  if (field.valueType === "string" || field.valueType === "multiline" || field.valueType === "code" || field.valueType === "enum") {
    return String(field.value ?? "");
  }
  if (field.valueType === "boolean" || field.valueType === "integer" || field.valueType === "number") {
    return String(field.value);
  }
  return JSON.stringify(field.value, null, 2);
}

function parseEditorValue(field: DraftEditorFieldContract, text: string): DraftEditorValidation<unknown> {
  try {
    switch (field.valueType) {
      case "string":
      case "multiline":
      case "code":
        return { ok: true, data: text };
      case "enum":
        return field.enumValues?.includes(text)
          ? { ok: true, data: text }
          : { ok: false, message: "请选择服务端允许的值。" };
      case "boolean":
        return text === "true" || text === "false"
          ? { ok: true, data: text === "true" }
          : { ok: false, message: "布尔值只能选择 true 或 false。" };
      case "integer": {
        if (!/^-?\d+$/.test(text.trim())) return { ok: false, message: "请输入整数。" };
        const parsed = Number(text);
        return Number.isSafeInteger(parsed)
          ? { ok: true, data: parsed }
          : { ok: false, message: "整数超出安全范围。" };
      }
      case "number": {
        const parsed = Number(text);
        return text.trim() && Number.isFinite(parsed)
          ? { ok: true, data: parsed }
          : { ok: false, message: "请输入有效数字。" };
      }
      case "string_array": {
        const parsed: unknown = JSON.parse(text);
        return isStringArray(parsed) && parsed.every((entry) => entry.trim())
          ? { ok: true, data: parsed }
          : { ok: false, message: "请输入由非空字符串组成的 JSON 数组。" };
      }
      case "json":
        return { ok: true, data: JSON.parse(text) as unknown };
    }
  } catch {
    return { ok: false, message: "内容不是有效的 JSON。" };
  }
}

const canonical = (value: unknown): string => JSON.stringify(value);

/** Build a one-field top-level PATCH. Unchanged values are rejected so a
 * no-op cannot needlessly invalidate a reviewed/sandboxed version. */
export function prepareDraftFieldEdit(
  field: DraftEditorFieldContract,
  text: string,
  unset: boolean,
): DraftEditorValidation<DraftFieldEditPreview> {
  if (!field.editable) {
    return {
      ok: false,
      message: field.readonlyReason || "这个字段由 Allmeta Ontology 维护，请先更新 Allmeta Ontology 后重新生成。",
    };
  }
  if (unset) {
    if (!field.unsettable) return { ok: false, message: "这个必填字段不能移除。" };
    if (!field.present) return { ok: false, message: "这个字段当前已经不存在。" };
    return {
      ok: true,
      data: {
        field,
        patch: { unset: [field.key] },
        before: field.valueStatus === "available" ? field.value : undefined,
        after: undefined,
        beforeWithheld: field.valueStatus === "withheld_sensitive",
      },
    };
  }
  const parsed = parseEditorValue(field, text);
  if (!parsed.ok) return parsed;
  if (draftEditContainsSensitiveData(parsed.data)) {
    return {
      ok: false,
      message: "不能在草稿里填写密钥、凭证、fixture bytes 或 fixture asset ID。密钥请使用 *_env/profile，fixture 请去测试数据界面上传。",
    };
  }
  if (field.present && field.valueStatus === "available" && canonical(parsed.data) === canonical(field.value)) {
    return { ok: false, message: "内容没有变化，不需要创建新版本。" };
  }
  return {
    ok: true,
    data: {
      field,
      patch: { set: { [field.key]: parsed.data } },
      before: field.valueStatus === "available" ? field.value : undefined,
      after: parsed.data,
      beforeWithheld: field.valueStatus === "withheld_sensitive",
    },
  };
}

export function readPatchedDraftVersionReceipt(
  value: unknown,
  expected: { tenantSlug: string; domain: string; slug: string; baseVersionId: string },
): DraftEditorValidation<PatchedDraftVersionReceipt> {
  if (!isRecord(value) || "drafts" in value || !isRecord(value.scope) || !exactEvidenceEffect(value.evidenceEffect)) {
    return { ok: false, message: "服务端没有返回完整的新版本回执。" };
  }
  const scope = value.scope;
  if (
    typeof scope.tenantId !== "string" || !scope.tenantId
    || scope.tenantSlug !== expected.tenantSlug
    || scope.domain !== expected.domain
    || scope.slug !== expected.slug
    || scope.baseVersionId !== expected.baseVersionId
    || value.domain !== expected.domain
    || value.baseVersionId !== expected.baseVersionId
    || value.changedSlug !== expected.slug
  ) {
    return { ok: false, message: "新版本回执与当前租户、领域或草稿不一致。" };
  }
  if (typeof value.versionId !== "string" || !value.versionId || value.versionId === expected.baseVersionId || value.regressionReady !== false) {
    return { ok: false, message: "服务端没有确认已创建新的无证据版本。" };
  }
  return { ok: true, data: value as unknown as PatchedDraftVersionReceipt };
}

export function draftDiffText(value: unknown, withheld = false): string {
  if (withheld) return "（原值包含敏感数据，服务端未返回）";
  if (value === undefined) return "（字段不存在）";
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

/** Turn store/compiler diagnostics into an operator-facing explanation. Do
 * not echo any response that itself looks like a credential or fixture. */
export function humanDraftEditFailure(message: unknown): string {
  const text = typeof message === "string" ? message.trim() : "";
  if (!text) return "服务端没有说明失败原因，请刷新草稿后重试。";
  if (draftEditContainsSensitiveData(text)) {
    return "服务端错误里包含了敏感内容，界面已隐藏。请检查密钥引用或测试 fixture 的放置方式。";
  }
  if (/不能包含字面密钥|fixture bytes|fixture asset/i.test(text)) return text;
  if (/draft version not found|draft not found/i.test(text)) return "这个草稿版本已经变化或不存在，请刷新后重新打开。";
  if (/immutable or unknown|identity field changed|cannot be unset/i.test(text)) return "这个字段由系统维护，不能用草稿编辑器修改。";
  if (/generatedCode|compile|lint|typescript/i.test(text)) return "修改后的代码没有通过安全检查或 TypeScript 编译，请先修正代码。";
  if (/invalid draft patch|must be|is invalid|has no expanded/i.test(text)) return "修改后的内容不符合 Agent 运行契约，请检查字段类型、事件、工具和计划之间是否一致。";
  if (/patch must set or unset/i.test(text)) return "没有检测到实际修改，请先改动一个字段。";
  return text.length > 240 ? `${text.slice(0, 237)}…` : text;
}
