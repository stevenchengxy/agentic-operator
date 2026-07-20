/**
 * ontology.writeInstance — strict Allmeta instance writer.
 *
 * Connection origin and bearer credentials are resolved only through env
 * references in trusted manifest config. A model can supply only an object
 * label and JSON properties. Before POST, the tool enforces tenant/domain/
 * object/action allowlists and validates the payload against the live Allmeta
 * DataObject schema. The server-computed idempotency key is bound to the full
 * canonical write, while Allmeta's primary-key MERGE provides replay safety.
 */

import { createHash } from "node:crypto";
import { z } from "zod";
import {
  defineTool,
  type ToolContext,
  type ToolWriteProbeExecutionContext,
  type ToolWriteProbeLifecycleInput,
} from "@agentic/agent-kit";
import {
  stableJson,
  type WriteProbeSafetyContract,
} from "@agentic/shared";
import { readEnvironmentReference } from "../config/env-ref";

type JsonRecord = Record<string, unknown>;

export class OntologyWriteInstanceError extends Error {
  readonly kind = "ontology_write_instance";
  readonly terminal: boolean;
  readonly retryable: boolean;

  constructor(
    readonly code: string,
    message: string,
    options: { status?: number; retryable?: boolean; cause?: unknown } = {},
  ) {
    super(`${code}: ${message}`, { cause: options.cause });
    this.name = "OntologyWriteInstanceError";
    this.status = options.status;
    this.retryable = options.retryable === true;
    this.terminal = !this.retryable;
  }

  readonly status?: number;
}

export interface OntologyWriteInstanceOptions {
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
}

export interface OntologyWriteInstanceContext {
  tenantSlug: string;
  tenantId?: string;
  actionName: string;
}

interface PropertySchema {
  name: string;
  type: string;
  required: boolean;
  nullable: boolean;
  allowedValues?: unknown[];
}

interface ObjectSchema {
  objectType: string;
  primaryKey: string;
  properties: PropertySchema[];
}

const IDENTIFIER_RE = /^[\p{L}_][\p{L}\p{N}_.:-]{0,127}$/u;
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_PAYLOAD_BYTES = 1024 * 1024;
const ABSOLUTE_MAX_PAYLOAD_BYTES = 10 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const PROBE_FIELD = "_agent_factory_probe";
const PROBE_MARKER_PREFIX = "af-allmeta-marker-";
const PROBE_NAMESPACE_PREFIX = "af-allmeta-namespace-";
const PROBE_TARGET_PREFIX = "af-allmeta-target-";
const PROBE_IDEMPOTENCY_PREFIX = "af-allmeta-idempotency-";

/** The serializable safety contract and executable lifecycle are code-owned.
 * A profile supplies only a dedicated test object/namespace and its field
 * mapping; Ontology descriptions cannot redirect cleanup to business data. */
export const ONTOLOGY_WRITE_INSTANCE_PROBE_SAFETY = {
  testDataContract: {
    kind: "synthetic_canary",
    marker: {
      kind: "argument",
      path: `${PROBE_FIELD}.marker`,
      valuePrefix: PROBE_MARKER_PREFIX,
    },
  },
  idempotency: {
    kind: "argument",
    path: `${PROBE_FIELD}.idempotency_key`,
    valuePrefix: PROBE_IDEMPOTENCY_PREFIX,
  },
  isolation: {
    namespace: {
      kind: "argument",
      path: `${PROBE_FIELD}.namespace`,
      valuePrefix: PROBE_NAMESPACE_PREFIX,
    },
    target: {
      kind: "argument",
      path: `${PROBE_FIELD}.target`,
      valuePrefix: PROBE_TARGET_PREFIX,
    },
  },
  cleanup: {
    kind: "handler",
    handler: "ontology.writeInstance.canary.cleanup",
  },
  absenceProof: {
    kind: "handler",
    handler: "ontology.writeInstance.canary.readback",
  },
} as const satisfies WriteProbeSafetyContract;

type OntologyProbeEnvelope = {
  schema: "agent-factory-allmeta-instance-canary/v1";
  marker: string;
  namespace: string;
  target: string;
  idempotency_key: string;
  execution: ToolWriteProbeExecutionContext;
};

type OntologyProbeProfile = {
  domain: string;
  action: string;
  objectType: string;
  namespace: string;
  primaryKeyField: string;
  markerField: string;
  namespaceField: string;
  idempotencyField: string;
};

type OntologyProbeIdentity = {
  profile: OntologyProbeProfile;
  envelope: OntologyProbeEnvelope;
  properties: JsonRecord;
};

function asRecord(value: unknown): JsonRecord | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function positiveInteger(
  value: unknown,
  fallback: number,
  maximum: number,
  field: string,
): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) <= 0 || (value as number) > maximum) {
    throw new OntologyWriteInstanceError(
      "invalid_allmeta_config",
      `${field} must be an integer between 1 and ${maximum}.`,
    );
  }
  return value as number;
}

function exactStringList(config: JsonRecord, field: string): string[] {
  const raw = config[field];
  if (
    !Array.isArray(raw) ||
    raw.length === 0 ||
    !raw.every((value) => typeof value === "string" && value.trim() && IDENTIFIER_RE.test(value.trim()))
  ) {
    throw new OntologyWriteInstanceError(
      "invalid_allmeta_config",
      `${field} must be a non-empty array of exact safe identifiers.`,
    );
  }
  const values = raw.map((value) => (value as string).trim());
  if (new Set(values).size !== values.length) {
    throw new OntologyWriteInstanceError(
      "invalid_allmeta_config",
      `${field} must not contain duplicates.`,
    );
  }
  return values;
}

function exactProbeExecution(
  value: ToolWriteProbeExecutionContext,
): ToolWriteProbeExecutionContext {
  if (
    value.agentName !== "agent-factory-probe"
    || value.actionName !== "ontology.writeInstance"
    || value.eventName !== "probe:ontology.writeInstance"
    || !/^probe:[a-f0-9]{12}$/.test(value.correlationId)
    || !/^af-probe-[a-f0-9]{24}$/.test(value.tenantSlug)
  ) {
    throw new OntologyWriteInstanceError(
      "untrusted_probe_context",
      "ontology.writeInstance refused an untrusted Agent Factory probe execution context.",
    );
  }
  return {
    agentName: value.agentName,
    actionName: value.actionName,
    correlationId: value.correlationId,
    tenantSlug: value.tenantSlug,
    eventName: value.eventName,
  };
}

function probeProfile(config: JsonRecord): OntologyProbeProfile {
  const businessDomain = stringField(config.domain);
  const businessAction = stringField(config.action);
  const domain = stringField(config.probe_domain);
  const action = stringField(config.probe_action);
  const objectType = stringField(config.probe_object);
  const namespace = stringField(config.probe_namespace);
  const primaryKeyField = stringField(config.probe_primary_key_field);
  const markerField = stringField(config.probe_marker_field);
  const namespaceField = stringField(config.probe_namespace_field);
  const idempotencyField = stringField(config.probe_idempotency_field);
  const identifiers = [businessDomain, businessAction, domain, action, objectType, primaryKeyField, markerField, namespaceField, idempotencyField];
  if (identifiers.some((value) => !value || !IDENTIFIER_RE.test(value))) {
    throw new OntologyWriteInstanceError(
      "invalid_probe_config",
      "The production profile must provide a safe probe object and exact canary field mapping.",
    );
  }
  if (domain === businessDomain || action === businessAction) {
    throw new OntologyWriteInstanceError(
      "probe_scope_not_isolated",
      "probe_domain and probe_action must be dedicated test scopes distinct from the business domain/action.",
    );
  }
  if (
    !namespace
    || namespace.length < 3
    || namespace.length > 80
    || !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(namespace)
  ) {
    throw new OntologyWriteInstanceError(
      "invalid_probe_config",
      "probe_namespace must be an explicit 3-80 character test-only namespace.",
    );
  }
  const fields = [primaryKeyField!, markerField!, namespaceField!, idempotencyField!];
  if (new Set(fields).size !== fields.length || fields.includes("domainId")) {
    throw new OntologyWriteInstanceError(
      "invalid_probe_config",
      "Probe primary-key, marker, namespace and idempotency fields must be distinct and cannot be domainId.",
    );
  }
  const businessObjects = exactStringList(config, "allowed_objects");
  if (businessObjects.includes(objectType!)) {
    throw new OntologyWriteInstanceError(
      "probe_object_not_dedicated",
      "probe_object must be a dedicated test DataObject and must not appear in the business allowed_objects list.",
    );
  }
  if (
    exactStringList(config, "allowed_domains").includes(domain!)
    || exactStringList(config, "allowed_actions").includes(action!)
  ) {
    throw new OntologyWriteInstanceError(
      "probe_scope_not_dedicated",
      "probe_domain/probe_action must stay outside the business domain/action allowlists.",
    );
  }
  return {
    domain: domain!,
    action: action!,
    objectType: objectType!,
    namespace,
    primaryKeyField: primaryKeyField!,
    markerField: markerField!,
    namespaceField: namespaceField!,
    idempotencyField: idempotencyField!,
  };
}

function exactProbeEnvelope(
  args: JsonRecord,
  execution: ToolWriteProbeExecutionContext,
  expected?: ToolWriteProbeLifecycleInput["canary"],
): OntologyProbeEnvelope {
  if (Object.keys(args).some((key) => key !== PROBE_FIELD)) {
    throw new OntologyWriteInstanceError(
      "untrusted_probe_payload",
      "The write probe accepts only its code-owned synthetic canary envelope.",
    );
  }
  const row = asRecord(args[PROBE_FIELD]);
  const marker = stringField(row?.marker);
  const namespace = stringField(row?.namespace);
  const target = stringField(row?.target);
  const idempotencyKey = stringField(row?.idempotency_key);
  const suffix = marker?.startsWith(PROBE_MARKER_PREFIX)
    ? marker.slice(PROBE_MARKER_PREFIX.length)
    : "";
  const idempotencySuffix = idempotencyKey?.startsWith(PROBE_IDEMPOTENCY_PREFIX)
    ? idempotencyKey.slice(PROBE_IDEMPOTENCY_PREFIX.length)
    : "";
  if (
    !/^[a-f0-9]{24}$/.test(suffix)
    || namespace !== `${PROBE_NAMESPACE_PREFIX}${suffix}`
    || target !== `${PROBE_TARGET_PREFIX}${suffix}`
    || !/^[a-f0-9]{64}$/.test(idempotencySuffix)
    || !idempotencySuffix.startsWith(suffix)
  ) {
    throw new OntologyWriteInstanceError(
      "invalid_probe_canary",
      "The ontology write canary is missing its exact isolated identities.",
    );
  }
  if (expected && (
    expected.marker !== marker
    || expected.namespace !== namespace
    || expected.target !== target
    || expected.idempotencyKey !== idempotencyKey
  )) {
    throw new OntologyWriteInstanceError(
      "probe_canary_mismatch",
      "The lifecycle canary does not match the prepared probe arguments.",
    );
  }
  return {
    schema: "agent-factory-allmeta-instance-canary/v1",
    marker: marker!,
    namespace: namespace!,
    target: target!,
    idempotency_key: idempotencyKey!,
    execution: exactProbeExecution(execution),
  };
}

function ontologyProbeIdentity(input: {
  args: JsonRecord;
  config: JsonRecord;
  execution: ToolWriteProbeExecutionContext;
  expected?: ToolWriteProbeLifecycleInput["canary"];
}): OntologyProbeIdentity {
  const profile = probeProfile(input.config);
  const envelope = exactProbeEnvelope(input.args, input.execution, input.expected);
  return {
    profile,
    envelope,
    properties: {
      [profile.primaryKeyField]: envelope.target,
      [profile.markerField]: envelope.marker,
      [profile.namespaceField]: `${profile.namespace}:${envelope.namespace}`,
      [profile.idempotencyField]: envelope.idempotency_key,
    },
  };
}

function exactProbeContract(input: ToolWriteProbeLifecycleInput): OntologyProbeIdentity {
  const contract = input.contract;
  if (
    input.toolName !== "ontology.writeInstance"
    || contract.testDataContract.marker.path !== ONTOLOGY_WRITE_INSTANCE_PROBE_SAFETY.testDataContract.marker.path
    || contract.testDataContract.marker.valuePrefix !== PROBE_MARKER_PREFIX
    || contract.idempotency.kind !== "argument"
    || contract.idempotency.path !== ONTOLOGY_WRITE_INSTANCE_PROBE_SAFETY.idempotency.path
    || contract.idempotency.valuePrefix !== PROBE_IDEMPOTENCY_PREFIX
    || contract.isolation.namespace.path !== ONTOLOGY_WRITE_INSTANCE_PROBE_SAFETY.isolation.namespace.path
    || contract.isolation.namespace.valuePrefix !== PROBE_NAMESPACE_PREFIX
    || contract.isolation.target.path !== ONTOLOGY_WRITE_INSTANCE_PROBE_SAFETY.isolation.target.path
    || contract.isolation.target.valuePrefix !== PROBE_TARGET_PREFIX
    || contract.cleanup.kind !== "handler"
    || contract.cleanup.handler !== ONTOLOGY_WRITE_INSTANCE_PROBE_SAFETY.cleanup.handler
    || contract.absenceProof.kind !== "handler"
    || contract.absenceProof.handler !== ONTOLOGY_WRITE_INSTANCE_PROBE_SAFETY.absenceProof.handler
  ) {
    throw new OntologyWriteInstanceError(
      "probe_contract_mismatch",
      "ontology.writeInstance refused a different write-probe safety contract.",
    );
  }
  return ontologyProbeIdentity({
    args: input.args,
    config: input.config,
    execution: input.execution,
    expected: input.canary,
  });
}

function trustedOrigin(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new OntologyWriteInstanceError(
      "invalid_allmeta_config",
      "base_url_env does not contain a valid absolute URL.",
    );
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    !["", "/"].includes(url.pathname) ||
    url.search ||
    url.hash
  ) {
    throw new OntologyWriteInstanceError(
      "invalid_allmeta_config",
      "Allmeta base URL must be an http(s) origin without credentials, path, query, or fragment.",
    );
  }
  return new URL(url.origin);
}

function requireTrustedEnvironment(
  env: Record<string, string | undefined>,
  reference: unknown,
  field: string,
): string {
  try {
    return readEnvironmentReference(env, reference, field);
  } catch (error) {
    throw new OntologyWriteInstanceError(
      "allmeta_dependency_missing",
      `${field} is invalid, unset, or empty.`,
      { cause: error },
    );
  }
}

function assertJsonValue(value: unknown, path: string, seen = new Set<object>(), depth = 0): void {
  if (depth > 32) {
    throw new OntologyWriteInstanceError("invalid_instance_payload", `${path} exceeds the maximum JSON nesting depth.`);
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new OntologyWriteInstanceError("invalid_instance_payload", `${path} contains a non-finite number.`);
    }
    return;
  }
  if (typeof value !== "object") {
    throw new OntologyWriteInstanceError(
      "invalid_instance_payload",
      `${path} contains non-JSON type '${typeof value}'.`,
    );
  }
  if (seen.has(value)) {
    throw new OntologyWriteInstanceError("invalid_instance_payload", `${path} contains a cycle.`);
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index++) {
        assertJsonValue(value[index], `${path}[${index}]`, seen, depth + 1);
      }
      return;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new OntologyWriteInstanceError("invalid_instance_payload", `${path} must contain plain JSON objects only.`);
    }
    for (const [key, item] of Object.entries(value as JsonRecord)) {
      if (["__proto__", "prototype", "constructor"].includes(key)) {
        throw new OntologyWriteInstanceError("invalid_instance_payload", `${path} contains forbidden key '${key}'.`);
      }
      assertJsonValue(item, `${path}.${key}`, seen, depth + 1);
    }
  } finally {
    seen.delete(value);
  }
}

async function readBoundedText(response: Response, maxBytes = MAX_RESPONSE_BYTES): Promise<string> {
  const advertised = Number(response.headers.get("content-length"));
  if (Number.isFinite(advertised) && advertised > maxBytes) {
    throw new OntologyWriteInstanceError(
      "allmeta_response_too_large",
      `Allmeta response exceeds ${maxBytes} bytes.`,
      { status: response.status },
    );
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    total += chunk.value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new OntologyWriteInstanceError(
        "allmeta_response_too_large",
        `Allmeta response exceeded ${maxBytes} bytes while reading.`,
        { status: response.status },
      );
    }
    chunks.push(Buffer.from(chunk.value));
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

function parseJsonObject(text: string, purpose: string, status: number): JsonRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new OntologyWriteInstanceError(
      "malformed_allmeta_response",
      `Allmeta ${purpose} response is not JSON.`,
      { status },
    );
  }
  const record = asRecord(parsed);
  if (!record) {
    throw new OntologyWriteInstanceError(
      "malformed_allmeta_response",
      `Allmeta ${purpose} response must be a JSON object.`,
      { status },
    );
  }
  return record;
}

function parseMaybeJson(value: unknown, field: string): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new OntologyWriteInstanceError(
      "malformed_object_schema",
      `Allmeta object schema field '${field}' contains malformed JSON.`,
    );
  }
}

function booleanField(record: JsonRecord, names: string[]): boolean {
  for (const name of names) {
    const value = record[name];
    if (typeof value === "boolean") return value;
    if (typeof value === "string") {
      if (value.toLowerCase() === "true") return true;
      if (value.toLowerCase() === "false") return false;
    }
  }
  return false;
}

export function normalizeAllmetaObjectSchema(raw: unknown, requestedObject: string): ObjectSchema {
  const envelope = asRecord(raw);
  const candidate = asRecord(envelope?.item) ?? asRecord(envelope?.data) ?? envelope;
  if (!candidate) {
    throw new OntologyWriteInstanceError("malformed_object_schema", "Allmeta object schema is not an object.");
  }
  const objectType = stringField(candidate.id ?? candidate.uid ?? candidate.name);
  if (!objectType || objectType !== requestedObject) {
    throw new OntologyWriteInstanceError(
      "object_schema_mismatch",
      `Allmeta returned schema '${objectType ?? "(missing)"}' for requested object '${requestedObject}'.`,
    );
  }
  const propertyValue = parseMaybeJson(candidate.properties ?? candidate.properties_json, "properties");
  if (!Array.isArray(propertyValue) || propertyValue.length === 0) {
    throw new OntologyWriteInstanceError(
      "malformed_object_schema",
      `Allmeta object '${objectType}' has no properties[].`,
    );
  }
  const properties: PropertySchema[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < propertyValue.length; index++) {
    const row = asRecord(propertyValue[index]);
    const name = stringField(row?.name);
    const type = stringField(row?.type);
    if (!row || !name || !type || !IDENTIFIER_RE.test(name) || seen.has(name)) {
      throw new OntologyWriteInstanceError(
        "malformed_object_schema",
        `Allmeta object '${objectType}' properties[${index}] has an invalid/duplicate name or missing type.`,
      );
    }
    seen.add(name);
    const rawAllowed = parseMaybeJson(
      row.allowed_values ?? row.allowedValues ?? row.enum ?? row.values,
      `${name}.allowed_values`,
    );
    if (rawAllowed !== undefined && !Array.isArray(rawAllowed)) {
      throw new OntologyWriteInstanceError(
        "malformed_object_schema",
        `Allmeta object '${objectType}' property '${name}' allowed values must be an array.`,
      );
    }
    properties.push({
      name,
      type,
      required: booleanField(row, ["is_required", "required", "mandatory"]),
      nullable: booleanField(row, ["nullable", "is_nullable"]),
      ...(rawAllowed === undefined ? {} : { allowedValues: rawAllowed as unknown[] }),
    });
  }
  const primaryKey = stringField(candidate.primary_key ?? candidate.primaryKey) ??
    properties.find((_, index) => {
      const row = asRecord(propertyValue[index]);
      return row ? booleanField(row, ["primary_key", "is_primary_key", "primary"]) : false;
    })?.name;
  if (!primaryKey || !seen.has(primaryKey)) {
    throw new OntologyWriteInstanceError(
      "malformed_object_schema",
      `Allmeta object '${objectType}' has no valid primary_key.`,
    );
  }
  return { objectType, primaryKey, properties };
}

function typeMatches(type: string, value: unknown): boolean {
  const normalized = type.toLowerCase().replace(/\s+/g, "");
  const bracketArray = normalized.endsWith("[]") ? normalized.slice(0, -2) : null;
  const genericArray = normalized.match(/^(?:array|list|set)[<\[(]([^>\])]+)[>\])]$/)?.[1];
  if (bracketArray !== null || genericArray !== undefined) {
    if (!Array.isArray(value)) return false;
    const itemType = bracketArray ?? genericArray;
    return !itemType || ["any", "unknown", "json"].includes(itemType)
      ? true
      : value.every((item) => typeMatches(itemType, item));
  }
  if (["array", "list", "set"].includes(normalized)) return Array.isArray(value);
  if (["string", "text", "date", "datetime", "timestamp", "uuid", "id", "url", "email"].includes(normalized)) {
    return typeof value === "string";
  }
  if (["integer", "int", "long"].includes(normalized)) return Number.isSafeInteger(value);
  if (["number", "float", "double", "decimal"].includes(normalized)) {
    return typeof value === "number" && Number.isFinite(value);
  }
  if (["boolean", "bool"].includes(normalized)) return typeof value === "boolean";
  if (["object", "map", "record", "dict", "dictionary"].includes(normalized)) return asRecord(value) !== null;
  if (["json", "any"].includes(normalized)) {
    try {
      assertJsonValue(value, "value");
      return true;
    } catch {
      return false;
    }
  }
  throw new OntologyWriteInstanceError(
    "unsupported_object_schema_type",
    `Allmeta property type '${type}' has no deterministic local validator.`,
  );
}

export function validateInstanceAgainstSchema(
  payload: JsonRecord,
  schema: ObjectSchema,
): { primaryValue: string | number } {
  const byName = new Map(schema.properties.map((property) => [property.name, property]));
  const unknown = Object.keys(payload).filter((name) => !byName.has(name));
  if (unknown.length) {
    throw new OntologyWriteInstanceError(
      "instance_schema_validation_failed",
      `payload contains undeclared properties: ${unknown.join(", ")}.`,
    );
  }
  for (const property of schema.properties) {
    const present = Object.prototype.hasOwnProperty.call(payload, property.name);
    const value = payload[property.name];
    if ((property.required || property.name === schema.primaryKey) && (!present || value === null || value === "")) {
      throw new OntologyWriteInstanceError(
        "instance_schema_validation_failed",
        `required property '${property.name}' is missing or empty.`,
      );
    }
    if (!present) continue;
    if (value === null) {
      if (!property.nullable) {
        throw new OntologyWriteInstanceError(
          "instance_schema_validation_failed",
          `property '${property.name}' is null but schema does not mark it nullable.`,
        );
      }
      continue;
    }
    if (!typeMatches(property.type, value)) {
      throw new OntologyWriteInstanceError(
        "instance_schema_validation_failed",
        `property '${property.name}' does not match Allmeta type '${property.type}'.`,
      );
    }
    if (
      property.allowedValues &&
      !property.allowedValues.some((candidate) => stableJson(candidate) === stableJson(value))
    ) {
      throw new OntologyWriteInstanceError(
        "instance_schema_validation_failed",
        `property '${property.name}' is outside its allowed values.`,
      );
    }
  }
  const primary = payload[schema.primaryKey];
  if ((typeof primary !== "string" || !primary.trim()) && typeof primary !== "number") {
    throw new OntologyWriteInstanceError(
      "instance_schema_validation_failed",
      `primary key '${schema.primaryKey}' must be a non-empty string or number.`,
    );
  }
  return { primaryValue: primary as string | number };
}

async function requestAllmeta(
  fetchImpl: typeof fetch,
  url: URL,
  init: RequestInit,
  timeoutMs: number,
  purpose: string,
): Promise<JsonRecord> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetchImpl(url, { ...init, redirect: "manual", signal: controller.signal });
  } catch (error) {
    throw new OntologyWriteInstanceError(
      controller.signal.aborted ? "allmeta_timeout" : "allmeta_transport_failed",
      controller.signal.aborted
        ? `Allmeta ${purpose} timed out after ${timeoutMs}ms.`
        : `Allmeta ${purpose} transport failed.`,
      { retryable: true, cause: error },
    );
  } finally {
    clearTimeout(timer);
  }
  if (response.status >= 300 && response.status < 400) {
    throw new OntologyWriteInstanceError(
      "allmeta_redirect_rejected",
      `Allmeta ${purpose} redirect was rejected; configure the final trusted origin.`,
      { status: response.status },
    );
  }
  if (!response.ok) {
    // Drain a bounded body for connection reuse, but never echo it—it can
    // contain business payloads or implementation details.
    await readBoundedText(response).catch(() => "");
    const retryable = response.status === 429 || response.status >= 500;
    throw new OntologyWriteInstanceError(
      "allmeta_http_error",
      `Allmeta ${purpose} returned HTTP ${response.status}.`,
      { status: response.status, retryable },
    );
  }
  const text = await readBoundedText(response);
  return parseJsonObject(text, purpose, response.status);
}

function probeConnection(
  config: JsonRecord,
  options: OntologyWriteInstanceOptions = {},
): {
  baseUrl: URL;
  headers: Record<string, string>;
  timeoutMs: number;
  fetchImpl: typeof fetch;
} {
  const env = options.env ?? process.env;
  const baseUrl = trustedOrigin(requireTrustedEnvironment(
    env,
    config.base_url_env,
    "ontology.writeInstance config.base_url_env",
  ));
  const apiKey = requireTrustedEnvironment(
    env,
    config.api_key_env,
    "ontology.writeInstance config.api_key_env",
  );
  return {
    baseUrl,
    headers: { Authorization: `Bearer ${apiKey}`, accept: "application/json" },
    timeoutMs: positiveInteger(config.timeout_ms, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, "timeout_ms"),
    fetchImpl: options.fetchImpl ?? fetch,
  };
}

async function readProbeInstance(
  identity: OntologyProbeIdentity,
  config: JsonRecord,
  options: OntologyWriteInstanceOptions = {},
): Promise<JsonRecord | null> {
  const connection = probeConnection(config, options);
  const url = new URL(
    `/api/v1/ontology/instances/${encodeURIComponent(identity.profile.objectType)}/${encodeURIComponent(identity.envelope.target)}?domain=${encodeURIComponent(identity.profile.domain)}`,
    connection.baseUrl,
  );
  try {
    return await requestAllmeta(
      connection.fetchImpl,
      url,
      { method: "GET", headers: connection.headers, cache: "no-store" },
      connection.timeoutMs,
      "write-probe instance readback",
    );
  } catch (error) {
    if (error instanceof OntologyWriteInstanceError && error.status === 404) return null;
    throw error;
  }
}

function probeInstanceMatches(
  value: JsonRecord,
  identity: OntologyProbeIdentity,
): boolean {
  return value.domainId === identity.profile.domain
    && Object.entries(identity.properties).every(([key, expected]) =>
      Object.prototype.hasOwnProperty.call(value, key)
      && stableJson(value[key]) === stableJson(expected));
}

async function deleteProbeInstance(
  identity: OntologyProbeIdentity,
  config: JsonRecord,
  options: OntologyWriteInstanceOptions = {},
): Promise<boolean> {
  const connection = probeConnection(config, options);
  const url = new URL(
    `/api/v1/ontology/instances/${encodeURIComponent(identity.profile.objectType)}/${encodeURIComponent(identity.envelope.target)}?domain=${encodeURIComponent(identity.profile.domain)}`,
    connection.baseUrl,
  );
  let result: JsonRecord;
  try {
    result = await requestAllmeta(
      connection.fetchImpl,
      url,
      { method: "DELETE", headers: connection.headers },
      connection.timeoutMs,
      "write-probe instance cleanup",
    );
  } catch (error) {
    if (error instanceof OntologyWriteInstanceError && error.status === 404) return false;
    throw error;
  }
  if (result.deleted !== 1) {
    throw new OntologyWriteInstanceError(
      "malformed_probe_cleanup_receipt",
      "Allmeta did not return deleted=1 for the exact disposable canary.",
    );
  }
  return true;
}

function internalProbeWriteConfig(
  identity: OntologyProbeIdentity,
  config: JsonRecord,
): JsonRecord {
  return {
    ...config,
    // The public profile's business allowlist deliberately excludes the test
    // object. Only this exact code-owned probe path can authorize it.
    domain: identity.profile.domain,
    action: identity.profile.action,
    allowed_tenants: [identity.envelope.execution.tenantSlug],
    allowed_domains: [identity.profile.domain],
    allowed_objects: [identity.profile.objectType],
    allowed_actions: [identity.profile.action],
  };
}

export async function writeAllmetaInstance(
  args: JsonRecord,
  config: JsonRecord,
  context: OntologyWriteInstanceContext,
  options: OntologyWriteInstanceOptions = {},
): Promise<{
  domain: string;
  object_type: string;
  primary_key: string;
  primary_value: string;
  idempotency_key: string;
  payload_sha256: string;
  schema_sha256: string;
  upserted: string[];
  count: number;
}> {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  for (const literal of ["base_url", "url", "endpoint", "api_key", "token", "authorization"]) {
    if (literal in config) {
      throw new OntologyWriteInstanceError(
        "untrusted_allmeta_config",
        `literal config '${literal}' is forbidden; use base_url_env/api_key_env.`,
      );
    }
  }
  const allowedArgNames = new Set(["object_type", "properties"]);
  const extraArgs = Object.keys(args).filter((name) => !allowedArgNames.has(name));
  if (extraArgs.length) {
    throw new OntologyWriteInstanceError(
      "untrusted_allmeta_parameter",
      `ontology.writeInstance accepts only object_type and properties; rejected: ${extraArgs.join(", ")}.`,
    );
  }
  const objectType = stringField(args.object_type);
  const payload = asRecord(args.properties);
  if (!objectType || !IDENTIFIER_RE.test(objectType) || !payload) {
    throw new OntologyWriteInstanceError(
      "invalid_instance_payload",
      "object_type must be a safe identifier and properties must be a JSON object.",
    );
  }
  if (Object.prototype.hasOwnProperty.call(payload, "domainId")) {
    throw new OntologyWriteInstanceError(
      "untrusted_allmeta_parameter",
      "properties.domainId is reserved and cannot be supplied by the model.",
    );
  }
  assertJsonValue(payload, "properties");
  const payloadText = stableJson(payload);
  const maxPayloadBytes = positiveInteger(
    config.max_payload_bytes,
    DEFAULT_MAX_PAYLOAD_BYTES,
    ABSOLUTE_MAX_PAYLOAD_BYTES,
    "max_payload_bytes",
  );
  if (Buffer.byteLength(payloadText, "utf8") > maxPayloadBytes) {
    throw new OntologyWriteInstanceError(
      "instance_payload_too_large",
      `properties exceed the configured ${maxPayloadBytes}-byte limit.`,
    );
  }

  const domain = stringField(config.domain);
  const action = stringField(config.action);
  if (!domain || !IDENTIFIER_RE.test(domain) || !action || !IDENTIFIER_RE.test(action)) {
    throw new OntologyWriteInstanceError(
      "invalid_allmeta_config",
      "trusted config.domain and config.action are required safe identifiers.",
    );
  }
  if (!context.actionName || context.actionName !== action) {
    throw new OntologyWriteInstanceError(
      "action_scope_mismatch",
      `current ontology action '${context.actionName || "(missing)"}' does not match profile action '${action}'.`,
    );
  }
  const tenantAllowlist = exactStringList(config, "allowed_tenants");
  const domainAllowlist = exactStringList(config, "allowed_domains");
  const objectAllowlist = exactStringList(config, "allowed_objects");
  const actionAllowlist = exactStringList(config, "allowed_actions");
  if (!tenantAllowlist.includes(context.tenantSlug) && !(context.tenantId && tenantAllowlist.includes(context.tenantId))) {
    throw new OntologyWriteInstanceError("tenant_not_allowed", `tenant '${context.tenantSlug}' is outside allowed_tenants.`);
  }
  if (!domainAllowlist.includes(domain)) {
    throw new OntologyWriteInstanceError("domain_not_allowed", `domain '${domain}' is outside allowed_domains.`);
  }
  if (!objectAllowlist.includes(objectType)) {
    throw new OntologyWriteInstanceError("object_not_allowed", `object '${objectType}' is outside allowed_objects.`);
  }
  if (!actionAllowlist.includes(action)) {
    throw new OntologyWriteInstanceError("action_not_allowed", `action '${action}' is outside allowed_actions.`);
  }

  const baseUrl = trustedOrigin(requireTrustedEnvironment(
    env,
    config.base_url_env,
    "ontology.writeInstance config.base_url_env",
  ));
  const apiKey = requireTrustedEnvironment(
    env,
    config.api_key_env,
    "ontology.writeInstance config.api_key_env",
  );
  const timeoutMs = positiveInteger(config.timeout_ms, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, "timeout_ms");
  const schemaUrl = new URL(
    `/api/v1/ontology/objects/${encodeURIComponent(objectType)}?domain=${encodeURIComponent(domain)}`,
    baseUrl,
  );
  const commonHeaders = { Authorization: `Bearer ${apiKey}`, accept: "application/json" };
  const schemaRaw = await requestAllmeta(
    fetchImpl,
    schemaUrl,
    { method: "GET", headers: commonHeaders, cache: "no-store" },
    timeoutMs,
    `schema read for ${objectType}`,
  );
  const schema = normalizeAllmetaObjectSchema(schemaRaw, objectType);
  const { primaryValue } = validateInstanceAgainstSchema(payload, schema);
  const payloadSha = createHash("sha256").update(payloadText, "utf8").digest("hex");
  const schemaSha = createHash("sha256").update(stableJson(schema), "utf8").digest("hex");
  const idempotencyKey = `allmeta-${createHash("sha256")
    .update(stableJson({ tenant: context.tenantId ?? context.tenantSlug, domain, action, objectType, primaryValue, payloadSha }))
    .digest("hex")}`;
  const writeUrl = new URL(
    `/api/v1/ontology/instances/${encodeURIComponent(objectType)}?domain=${encodeURIComponent(domain)}&validate=strict`,
    baseUrl,
  );
  const writeRaw = await requestAllmeta(
    fetchImpl,
    writeUrl,
    {
      method: "POST",
      headers: {
        ...commonHeaders,
        "content-type": "application/json",
        "idempotency-key": idempotencyKey,
      },
      body: JSON.stringify({ ...payload, domainId: domain }),
    },
    timeoutMs,
    `strict instance write for ${objectType}`,
  );
  const receipt = asRecord(writeRaw.data) ?? writeRaw;
  const upserted = receipt.upserted === undefined
    ? []
    : Array.isArray(receipt.upserted) && receipt.upserted.every((value) => typeof value === "string")
      ? receipt.upserted as string[]
      : null;
  const count = receipt.count === undefined ? upserted?.length : receipt.count;
  if (
    upserted === null ||
    !Number.isSafeInteger(count) ||
    (count as number) < 0 ||
    ((count as number) === 0 && upserted.length === 0)
  ) {
    throw new OntologyWriteInstanceError(
      "malformed_allmeta_receipt",
      "Allmeta returned 2xx without a non-empty upsert/count receipt; refusing to claim the instance was written.",
    );
  }
  return {
    domain,
    object_type: objectType,
    primary_key: schema.primaryKey,
    primary_value: String(primaryValue),
    idempotency_key: idempotencyKey,
    payload_sha256: payloadSha,
    schema_sha256: schemaSha,
    upserted,
    count: count as number,
  };
}

async function executeOntologyWriteProbe(
  ctx: ToolContext,
  args: JsonRecord,
  config: JsonRecord,
): Promise<Awaited<ReturnType<typeof writeAllmetaInstance>>> {
  const execution = exactProbeExecution({
    agentName: ctx.agentName as "agent-factory-probe",
    actionName: ctx.actionName,
    correlationId: ctx.correlationId,
    tenantSlug: ctx.tenantSlug,
    eventName: ctx.event?.name ?? "",
  });
  const identity = ontologyProbeIdentity({ args, config, execution });
  const existing = await readProbeInstance(identity, config);
  if (existing && !probeInstanceMatches(existing, identity)) {
    throw new OntologyWriteInstanceError(
      "probe_target_collision",
      "The dedicated probe target already exists but does not match this exact canary; refusing to overwrite it.",
    );
  }
  const writeConfig = internalProbeWriteConfig(identity, config);
  const writeArgs = {
    object_type: identity.profile.objectType,
    properties: identity.properties,
  };
  const writeContext: OntologyWriteInstanceContext = {
    tenantSlug: execution.tenantSlug,
    actionName: identity.profile.action,
  };
  const first = await writeAllmetaInstance(writeArgs, writeConfig, writeContext);
  const second = await writeAllmetaInstance(writeArgs, writeConfig, writeContext);
  const exactReceipt = (receipt: typeof first): boolean =>
    receipt.domain === identity.profile.domain
    && receipt.object_type === identity.profile.objectType
    && receipt.primary_key === identity.profile.primaryKeyField
    && receipt.primary_value === identity.envelope.target
    && receipt.upserted.includes(identity.envelope.target)
    && receipt.count >= 1;
  if (
    !exactReceipt(first)
    || !exactReceipt(second)
    || first.idempotency_key !== second.idempotency_key
    || first.payload_sha256 !== second.payload_sha256
    || first.schema_sha256 !== second.schema_sha256
  ) {
    throw new OntologyWriteInstanceError(
      "probe_idempotency_unverified",
      "Allmeta did not prove two identical writes resolved to the same exact canary identity.",
    );
  }
  const readback = await readProbeInstance(identity, config);
  if (!readback || !probeInstanceMatches(readback, identity)) {
    throw new OntologyWriteInstanceError(
      "probe_create_readback_failed",
      "The disposable Allmeta canary could not be read back with every isolation field intact.",
    );
  }
  return first;
}

/** Exact HTTP cleanup/readback for the profile-provided dedicated test
 * DataObject. It reads and compares all four canary fields before DELETE, so a
 * collision can never turn cleanup into deletion of unrelated data. */
export const ontologyWriteInstanceWriteProbeLifecycle = {
  identity: { id: "ontology.writeInstance/write-probe", revision: "1" },
  async cleanup(input: ToolWriteProbeLifecycleInput) {
    const identity = exactProbeContract(input);
    const existing = await readProbeInstance(identity, input.config);
    if (!existing) {
      return { completed: true, evidence: { matched: true, deleted: false } };
    }
    if (!probeInstanceMatches(existing, identity)) {
      throw new OntologyWriteInstanceError(
        "probe_cleanup_identity_mismatch",
        "Refusing cleanup because the existing Allmeta row is not the exact disposable canary.",
      );
    }
    const deleted = await deleteProbeInstance(identity, input.config);
    return { completed: true, evidence: { matched: true, deleted } };
  },
  async readback(input: ToolWriteProbeLifecycleInput) {
    const identity = exactProbeContract(input);
    const existing = await readProbeInstance(identity, input.config);
    if (!existing) return { absent: true, evidence: { rowAbsent: true } };
    return {
      absent: false,
      evidence: {
        rowAbsent: false,
        exactCanaryStillPresent: probeInstanceMatches(existing, identity),
      },
    };
  },
} as const;

export const ontologyWriteInstance = defineTool({
  name: "ontology.writeInstance",
  description:
    "Write one schema-valid instance through the configured Allmeta API. " +
    "The caller may provide only {object_type, properties}; URL, token, tenant, domain and action are trusted config/env concerns. " +
    "The tool enforces exact tenant/domain/object/action allowlists, fetches and validates against the live object schema, " +
    "then performs a strict primary-key-idempotent POST with a server-computed Idempotency-Key.",
  output: z.object({
    domain: z.string(),
    object_type: z.string(),
    primary_key: z.string(),
    primary_value: z.string(),
    idempotency_key: z.string().regex(/^allmeta-[a-f0-9]{64}$/),
    payload_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    schema_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    upserted: z.array(z.string()),
    count: z.number().int().nonnegative(),
  }),
  factoryWriteProbeLifecycle: ontologyWriteInstanceWriteProbeLifecycle,
  async handler(ctx) {
    const args = (ctx.event?.data ?? {}) as JsonRecord;
    const config = (ctx.config ?? {}) as JsonRecord;
    if (ctx.agentName === "agent-factory-probe") {
      return {
        data: await executeOntologyWriteProbe(ctx, args, config),
        meta: {
          provider: "allmeta",
          validation: "dedicated-canary+double-write+readback",
          idempotent: true,
        },
      };
    }
    return {
      data: await writeAllmetaInstance(
        args,
        config,
        {
          tenantSlug: ctx.tenantSlug,
          tenantId: ctx.tenantId,
          actionName: ctx.ontologyActionName ?? "",
        },
      ),
      meta: { provider: "allmeta", validation: "live-schema+strict", idempotent: true },
    };
  },
});
