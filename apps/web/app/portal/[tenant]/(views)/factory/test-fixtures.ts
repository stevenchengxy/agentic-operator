import type { Translate } from "@/app/portal/lib/preferences-context";
import type { FactoryApiResult } from "./factory-api";

export type BinaryFixturePlacement = "object" | "data_url" | "base64_string";

export interface FixtureAssetReceipt {
  assetId: string;
  sha256: string;
  bytes: number;
  mimeType?: string;
  filename?: string;
}

export interface BinaryFixtureFile {
  name: string;
  type: string;
  size: number;
  arrayBuffer: () => Promise<ArrayBuffer>;
}

function requiredText(t: Translate, value: string, label: string): string {
  if (!value.trim()) throw new Error(t("factory.testFixture.validation.required", { label }));
  return value;
}

/** Parse one complete test-case payload. Arrays and scalar JSON are not event payloads. */
export function parseTestCasePayload(source: string, t: Translate): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error(t("factory.testFixture.validation.invalidJson"));
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(t("factory.testFixture.validation.objectRequired"));
  }
  return parsed as Record<string, unknown>;
}

export function buildCasePayloadDecision(caseId: string, payload: Record<string, unknown>, t: Translate): string {
  return `[测试用例决策: 补数据] ${JSON.stringify({
    case_payloads: [{ case_id: requiredText(t, caseId, t("factory.testFixture.field.caseId")), payload }],
  })}`;
}

export function buildBinaryAssetDecision(input: {
  caseId: string;
  path: string;
  placement: BinaryFixturePlacement;
  receipt: FixtureAssetReceipt;
}, t: Translate): string {
  const { receipt } = input;
  return `[测试用例决策: 补数据] ${JSON.stringify({
    binary_files: [{
      case_id: requiredText(t, input.caseId, t("factory.testFixture.field.caseId")),
      path: requiredText(t, input.path, "JSON Pointer"),
      asset_id: requiredText(t, receipt.assetId, "fixture asset ID"),
      sha256: requiredText(t, receipt.sha256, "fixture sha256"),
      as: input.placement,
      ...(receipt.mimeType ? { mime_type: receipt.mimeType } : {}),
      ...(receipt.filename ? { filename: receipt.filename } : {}),
    }],
  })}`;
}

async function fileAsBase64(file: BinaryFixtureFile, t: Translate): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  if (typeof btoa !== "function") throw new Error(t("factory.testFixture.validation.browserEncodingUnavailable"));
  return btoa(binary);
}

function validReceipt(value: FixtureAssetReceipt, t: Translate): FixtureAssetReceipt {
  if (
    !value
    || typeof value.assetId !== "string"
    || !value.assetId.trim()
    || typeof value.sha256 !== "string"
    || !value.sha256.trim()
    || typeof value.bytes !== "number"
    || !Number.isFinite(value.bytes)
    || value.bytes < 0
  ) {
    throw new Error(t("factory.testFixture.validation.invalidReceipt"));
  }
  return value;
}

/**
 * Upload bytes to the run-scoped asset endpoint, then notify the brain with an
 * immutable asset reference. The base64 value never enters inject/transcript.
 */
export async function uploadBinaryFixtureAndInject(input: {
  t: Translate;
  runId: string;
  caseId: string;
  path: string;
  placement: BinaryFixturePlacement;
  file: BinaryFixtureFile;
  upload: (path: string, body: Record<string, unknown>) => Promise<FactoryApiResult<FixtureAssetReceipt>>;
  inject: (text: string) => Promise<void>;
}): Promise<FixtureAssetReceipt> {
  const runId = requiredText(input.t, input.runId, input.t("factory.testFixture.field.runId"));
  const caseId = requiredText(input.t, input.caseId, input.t("factory.testFixture.field.caseId"));
  const path = requiredText(input.t, input.path, "JSON Pointer");
  if (!path.startsWith("/")) throw new Error(input.t("factory.testFixture.validation.pointerSlash"));
  if (!input.file.name.trim()) throw new Error(input.t("factory.testFixture.validation.filenameRequired"));

  const base64 = await fileAsBase64(input.file, input.t);
  const result = await input.upload(
    `/v1/agent-factory/runs/${encodeURIComponent(runId)}/fixtures`,
    {
      caseId,
      path,
      base64,
      mimeType: input.file.type || "application/octet-stream",
      filename: input.file.name,
    },
  );
  if (!result.ok) throw new Error(result.message);

  const receipt = validReceipt(result.data, input.t);
  await input.inject(buildBinaryAssetDecision({
    caseId,
    path,
    placement: input.placement,
    receipt,
  }, input.t));
  return receipt;
}
