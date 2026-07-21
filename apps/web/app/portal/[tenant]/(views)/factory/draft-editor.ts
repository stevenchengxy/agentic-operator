import type { Translate } from "@/app/portal/lib/preferences-context";

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
  t: Translate,
  value: unknown,
  expected: { tenantSlug: string; domain: string; slug: string; versionId: string },
): DraftEditorValidation<DraftEditorContract> {
  if (!isRecord(value) || value.schema !== "agent-factory-draft-editor/v1" || !isRecord(value.scope)) {
    return { ok: false, message: t("factory.draftEditor.contract.unrecognized") };
  }
  const scope = value.scope;
  if (
    typeof scope.tenantId !== "string" || !scope.tenantId
    || scope.tenantSlug !== expected.tenantSlug
    || scope.domain !== expected.domain
    || scope.slug !== expected.slug
    || scope.versionId !== expected.versionId
  ) {
    return { ok: false, message: t("factory.draftEditor.contract.scopeChanged") };
  }
  if (!Array.isArray(value.fields) || !exactEvidenceEffect(value.evidenceEffect)) {
    return { ok: false, message: t("factory.draftEditor.contract.incomplete") };
  }
  const fields = value.fields.map(parseField);
  if (fields.length === 0 || fields.some((field) => !field)) {
    return { ok: false, message: t("factory.draftEditor.contract.uneditableFields") };
  }
  const keys = fields.map((field) => field!.key);
  if (new Set(keys).size !== keys.length) {
    return { ok: false, message: t("factory.draftEditor.contract.duplicateFields") };
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

function parseEditorValue(t: Translate, field: DraftEditorFieldContract, text: string): DraftEditorValidation<unknown> {
  try {
    switch (field.valueType) {
      case "string":
      case "multiline":
      case "code":
        return { ok: true, data: text };
      case "enum":
        return field.enumValues?.includes(text)
          ? { ok: true, data: text }
          : { ok: false, message: t("factory.draftEditor.validation.enumNotAllowed") };
      case "boolean":
        return text === "true" || text === "false"
          ? { ok: true, data: text === "true" }
          : { ok: false, message: t("factory.draftEditor.validation.booleanOnly") };
      case "integer": {
        if (!/^-?\d+$/.test(text.trim())) return { ok: false, message: t("factory.draftEditor.validation.integerRequired") };
        const parsed = Number(text);
        return Number.isSafeInteger(parsed)
          ? { ok: true, data: parsed }
          : { ok: false, message: t("factory.draftEditor.validation.integerOutOfRange") };
      }
      case "number": {
        const parsed = Number(text);
        return text.trim() && Number.isFinite(parsed)
          ? { ok: true, data: parsed }
          : { ok: false, message: t("factory.draftEditor.validation.numberInvalid") };
      }
      case "string_array": {
        const parsed: unknown = JSON.parse(text);
        return isStringArray(parsed) && parsed.every((entry) => entry.trim())
          ? { ok: true, data: parsed }
          : { ok: false, message: t("factory.draftEditor.validation.stringArrayInvalid") };
      }
      case "json":
        return { ok: true, data: JSON.parse(text) as unknown };
    }
  } catch {
    return { ok: false, message: t("factory.draftEditor.validation.jsonInvalid") };
  }
}

const canonical = (value: unknown): string => JSON.stringify(value);

/** Build a one-field top-level PATCH. Unchanged values are rejected so a
 * no-op cannot needlessly invalidate a reviewed/sandboxed version. */
export function prepareDraftFieldEdit(
  t: Translate,
  field: DraftEditorFieldContract,
  text: string,
  unset: boolean,
): DraftEditorValidation<DraftFieldEditPreview> {
  if (!field.editable) {
    return {
      ok: false,
      message: field.readonlyReason || t("factory.draftEditor.edit.ontologyReadonly"),
    };
  }
  if (unset) {
    if (!field.unsettable) return { ok: false, message: t("factory.draftEditor.edit.requiredCannotUnset") };
    if (!field.present) return { ok: false, message: t("factory.draftEditor.edit.fieldAlreadyAbsent") };
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
  const parsed = parseEditorValue(t, field, text);
  if (!parsed.ok) return parsed;
  if (draftEditContainsSensitiveData(parsed.data)) {
    return {
      ok: false,
      message: t("factory.draftEditor.edit.sensitiveNotAllowed"),
    };
  }
  if (field.present && field.valueStatus === "available" && canonical(parsed.data) === canonical(field.value)) {
    return { ok: false, message: t("factory.draftEditor.edit.noChange") };
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
  t: Translate,
  value: unknown,
  expected: { tenantSlug: string; domain: string; slug: string; baseVersionId: string },
): DraftEditorValidation<PatchedDraftVersionReceipt> {
  if (!isRecord(value) || "drafts" in value || !isRecord(value.scope) || !exactEvidenceEffect(value.evidenceEffect)) {
    return { ok: false, message: t("factory.draftEditor.receipt.incomplete") };
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
    return { ok: false, message: t("factory.draftEditor.receipt.mismatch") };
  }
  if (typeof value.versionId !== "string" || !value.versionId || value.versionId === expected.baseVersionId || value.regressionReady !== false) {
    return { ok: false, message: t("factory.draftEditor.receipt.versionNotConfirmed") };
  }
  return { ok: true, data: value as unknown as PatchedDraftVersionReceipt };
}

export function draftDiffText(t: Translate, value: unknown, withheld = false): string {
  if (withheld) return t("factory.draftEditor.diff.valueWithheld");
  if (value === undefined) return t("factory.draftEditor.diff.fieldAbsent");
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

/** Turn store/compiler diagnostics into an operator-facing explanation. Do
 * not echo any response that itself looks like a credential or fixture. */
export function humanDraftEditFailure(t: Translate, message: unknown): string {
  const text = typeof message === "string" ? message.trim() : "";
  if (!text) return t("factory.draftEditor.failure.noReason");
  if (draftEditContainsSensitiveData(text)) {
    return t("factory.draftEditor.failure.sensitiveHidden");
  }
  if (/不能包含字面密钥|fixture bytes|fixture asset/i.test(text)) return text;
  if (/draft version not found|draft not found/i.test(text)) return t("factory.draftEditor.failure.draftVersionGone");
  if (/immutable or unknown|identity field changed|cannot be unset/i.test(text)) return t("factory.draftEditor.failure.systemManagedField");
  if (/generatedCode|compile|lint|typescript/i.test(text)) return t("factory.draftEditor.failure.codeCheckFailed");
  if (/invalid draft patch|must be|is invalid|has no expanded/i.test(text)) return t("factory.draftEditor.failure.contractMismatch");
  if (/patch must set or unset/i.test(text)) return t("factory.draftEditor.failure.noActualChange");
  return text.length > 240 ? `${text.slice(0, 237)}…` : text;
}
