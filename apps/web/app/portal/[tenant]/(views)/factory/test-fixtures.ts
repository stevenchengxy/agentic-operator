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

function requiredText(value: string, label: string): string {
  if (!value.trim()) throw new Error(`${label}不能为空`);
  return value;
}

/** Parse one complete test-case payload. Arrays and scalar JSON are not event payloads. */
export function parseTestCasePayload(source: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error("payload 不是有效的 JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("payload 必须是一个 JSON 对象");
  }
  return parsed as Record<string, unknown>;
}

export function buildCasePayloadDecision(caseId: string, payload: Record<string, unknown>): string {
  return `[测试用例决策: 补数据] ${JSON.stringify({
    case_payloads: [{ case_id: requiredText(caseId, "测试用例 ID"), payload }],
  })}`;
}

export function buildBinaryAssetDecision(input: {
  caseId: string;
  path: string;
  placement: BinaryFixturePlacement;
  receipt: FixtureAssetReceipt;
}): string {
  const { receipt } = input;
  return `[测试用例决策: 补数据] ${JSON.stringify({
    binary_files: [{
      case_id: requiredText(input.caseId, "测试用例 ID"),
      path: requiredText(input.path, "JSON Pointer"),
      asset_id: requiredText(receipt.assetId, "fixture asset ID"),
      sha256: requiredText(receipt.sha256, "fixture sha256"),
      as: input.placement,
      ...(receipt.mimeType ? { mime_type: receipt.mimeType } : {}),
      ...(receipt.filename ? { filename: receipt.filename } : {}),
    }],
  })}`;
}

async function fileAsBase64(file: BinaryFixtureFile): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  if (typeof btoa !== "function") throw new Error("当前浏览器无法编码上传文件");
  return btoa(binary);
}

function validReceipt(value: FixtureAssetReceipt): FixtureAssetReceipt {
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
    throw new Error("fixture 上传接口返回了无效资产回执");
  }
  return value;
}

/**
 * Upload bytes to the run-scoped asset endpoint, then notify the brain with an
 * immutable asset reference. The base64 value never enters inject/transcript.
 */
export async function uploadBinaryFixtureAndInject(input: {
  runId: string;
  caseId: string;
  path: string;
  placement: BinaryFixturePlacement;
  file: BinaryFixtureFile;
  upload: (path: string, body: Record<string, unknown>) => Promise<FactoryApiResult<FixtureAssetReceipt>>;
  inject: (text: string) => Promise<void>;
}): Promise<FixtureAssetReceipt> {
  const runId = requiredText(input.runId, "运行 ID");
  const caseId = requiredText(input.caseId, "测试用例 ID");
  const path = requiredText(input.path, "JSON Pointer");
  if (!path.startsWith("/")) throw new Error("JSON Pointer 必须以 / 开头");
  if (!input.file.name.trim()) throw new Error("文件名不能为空");

  const base64 = await fileAsBase64(input.file);
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

  const receipt = validReceipt(result.data);
  await input.inject(buildBinaryAssetDecision({
    caseId,
    path,
    placement: input.placement,
    receipt,
  }));
  return receipt;
}
