import {
  FACTORY_TEST_FIXTURE_ASSET_SCHEMA,
  isFactoryTestFixtureAssetBinding,
} from "@agentic/agent-factory";

import type {
  FactoryFixtureAssetReadResult,
  FactoryFixtureAssetScope,
} from "./fixture-asset-store";

const FIXTURE_SCHEMA_PREFIX = "agent-factory-test-fixture-asset/";

export interface FactoryFixtureMaterializationScope {
  tenantId: string;
  domain: string;
  conversationId: string;
  caseId: string;
}

export interface FactoryFixturePayloadMaterializationInput
  extends FactoryFixtureMaterializationScope {
  payload: Record<string, unknown>;
  store: FactoryFixtureMaterializationStore;
}

/** Minimal trusted reader contract shared by the short-lived sandbox store
 * and immutable promotion capsules. */
export interface FactoryFixtureMaterializationStore {
  read(
    scope: FactoryFixtureAssetScope,
    assetId: string,
  ): Promise<FactoryFixtureAssetReadResult | null>;
}

const fixturePointer = (parts: string[]): string => parts.length
  ? `/${parts.map((part) => part.replace(/~/g, "~0").replace(/\//g, "~1")).join("/")}`
  : "";

function isFixtureSchema(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const schema = (value as Record<string, unknown>).schema;
  return typeof schema === "string" && schema.startsWith(FIXTURE_SCHEMA_PREFIX);
}

/** True for both the current descriptor and unknown future descriptors.  The
 * latter must be detected so replay fails closed instead of handing an
 * unsupported object to generated code. */
export function containsFactoryFixtureAssetReference(value: unknown): boolean {
  if (isFixtureSchema(value)) return true;
  if (Array.isArray(value)) return value.some(containsFactoryFixtureAssetReference);
  if (!value || typeof value !== "object") return false;
  return Object.values(value as Record<string, unknown>).some(containsFactoryFixtureAssetReference);
}

async function materializeNode(input: FactoryFixtureMaterializationScope & {
  value: unknown;
  parts: string[];
  store: FactoryFixtureMaterializationStore;
}): Promise<unknown> {
  const { value } = input;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (isFixtureSchema(record)) {
      if (record.schema !== FACTORY_TEST_FIXTURE_ASSET_SCHEMA) {
        throw new Error("binary fixture uses an unsupported descriptor schema");
      }
      if (!isFactoryTestFixtureAssetBinding(record)) {
        throw new Error("binary fixture descriptor is malformed");
      }
      if (record.conversationId !== input.conversationId) {
        throw new Error("binary fixture is not bound to the approved conversation");
      }
      const pointer = fixturePointer(input.parts);
      const stored = await input.store.read({
        tenantId: input.tenantId,
        domain: input.domain,
        conversationId: input.conversationId,
      }, record.assetId);
      if (!stored) {
        throw new Error("binary fixture is missing, expired, deleted, or outside the approved tenant/domain/conversation scope");
      }
      if (stored.caseId !== input.caseId || stored.path !== pointer) {
        throw new Error("binary fixture is not bound to the approved test case and JSON path");
      }
      if (
        stored.sha256 !== record.sha256
        || stored.bytes !== record.bytes
        || stored.expiresAt !== record.expiresAt
        || stored.mimeType !== (record.mimeType ?? "application/octet-stream")
        || stored.filename !== (record.filename ?? "fixture.bin")
      ) {
        throw new Error("binary fixture metadata or content identity changed after approval");
      }
      if (record.as === "base64_string") return stored.base64;
      if (record.as === "data_url") {
        if (!record.mimeType) {
          throw new Error("binary data-URL fixture has no approved MIME type");
        }
        return `data:${record.mimeType};base64,${stored.base64}`;
      }
      return {
        encoding: "base64",
        data: stored.base64,
        sha256: stored.sha256,
        bytes: stored.bytes,
        ...(record.mimeType ? { mime_type: record.mimeType } : {}),
        ...(record.filename ? { filename: record.filename } : {}),
      };
    }
    return Object.fromEntries(await Promise.all(
      Object.entries(record).map(async ([key, child]) => [
        key,
        await materializeNode({ ...input, value: child, parts: [...input.parts, key] }),
      ]),
    ));
  }
  if (Array.isArray(value)) {
    return Promise.all(value.map((child, index) => materializeNode({
      ...input,
      value: child,
      parts: [...input.parts, String(index)],
    })));
  }
  return value;
}

/** Materialize only inside trusted API memory.  The returned value must be
 * passed directly to the disposable sandbox/regression worker; callers must
 * never write it into conversation state, model input, receipts or artifacts. */
export async function materializeFactoryFixturePayload(
  input: FactoryFixturePayloadMaterializationInput,
): Promise<Record<string, unknown>> {
  if (!input.tenantId.trim() || !input.domain.trim() || !input.conversationId.trim() || !input.caseId.trim()) {
    throw new Error("binary fixture materialization scope is incomplete");
  }
  const materialized = await materializeNode({
    ...input,
    value: input.payload,
    parts: [],
  });
  if (!materialized || typeof materialized !== "object" || Array.isArray(materialized)) {
    throw new Error("binary fixture payload must remain a JSON object");
  }
  return materialized as Record<string, unknown>;
}
