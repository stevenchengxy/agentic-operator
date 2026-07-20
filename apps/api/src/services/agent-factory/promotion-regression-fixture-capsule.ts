import { constants as fsConstants, promises as fs } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

import {
  canonicalEvidenceJson,
  FACTORY_TEST_FIXTURE_ASSET_SCHEMA,
  isFactoryTestFixtureAssetBinding,
  type FactoryTestFixtureAssetBinding,
} from "@agentic/agent-factory";

import { FsFactoryFixtureAssetStore } from "./fixture-asset-store";
import {
  containsFactoryFixtureAssetReference,
  materializeFactoryFixturePayload,
} from "./fixture-materializer";
import type { FactoryPromotionRegressionRecord } from "./promotion-regression-ledger";
import type { PersistedRegressionArtifact } from "./regression-artifact";

export const FACTORY_PROMOTION_FIXTURE_CAPSULE_SCHEMA =
  "agent-factory-promotion-fixture-capsule/v1" as const;
export const FACTORY_PROMOTION_FIXTURE_CAPSULE_REF_SCHEMA =
  "agent-factory-promotion-fixture-capsule-ref/v1" as const;

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const CAPSULE_PATH_PREFIX = "factory-regression-promotions/fixture-capsules/";

export interface FactoryPromotionFixtureCapsuleRef {
  schema: typeof FACTORY_PROMOTION_FIXTURE_CAPSULE_REF_SCHEMA;
  /** Portable path below AGENTIC_DATA_ROOT. */
  manifest: string;
  manifestHash: string;
  bindingCount: number;
}

export interface FactoryPromotionFixtureCapsuleEntry {
  assetId: string;
  conversationId: string;
  caseId: string;
  path: string;
  sha256: string;
  bytes: number;
  mimeType: string;
  filename: string;
  /** Preserved only as approved descriptor identity. Capsule reads do not
   * apply the short-lived source-store expiry. */
  sourceExpiresAt: string;
  /** Content-addressed path below the capsule manifest directory. */
  content: string;
}

export interface FactoryPromotionFixtureCapsuleManifest {
  schema: typeof FACTORY_PROMOTION_FIXTURE_CAPSULE_SCHEMA;
  promotionId: string;
  tenantId: string;
  domain: string;
  createdAt: string;
  entries: FactoryPromotionFixtureCapsuleEntry[];
  manifestHash: string;
}

export interface VerifiedFactoryPromotionFixtureCapsule {
  manifest: FactoryPromotionFixtureCapsuleManifest;
  manifestPath: string;
  capsuleDirectory: string;
}

const sha256 = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

export function factoryPromotionFixtureCapsuleManifestHash(
  value: Omit<FactoryPromotionFixtureCapsuleManifest, "manifestHash">,
): string {
  return `factory-promotion-fixture-capsule:v1:${sha256(canonicalEvidenceJson(value))}`;
}

function exactText(value: unknown, field: string, max = 256): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > max ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error(`invalid promotion fixture capsule ${field}`);
  }
  return value;
}

function portableRelative(value: unknown, field: string): string {
  const checked = exactText(value, field, 1024);
  if (
    path.isAbsolute(checked) ||
    checked.includes("\\") ||
    checked.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error(`promotion fixture capsule ${field} is not a contained portable path`);
  }
  return checked;
}

function fixtureBindings(value: unknown): FactoryTestFixtureAssetBinding[] {
  const bindings: FactoryTestFixtureAssetBinding[] = [];
  let fixtureReferenceSeen = false;
  const visit = (entry: unknown): void => {
    if (!entry || typeof entry !== "object") return;
    if (!Array.isArray(entry)) {
      const record = entry as Record<string, unknown>;
      const schema = record.schema;
      if (
        typeof schema === "string" &&
        schema.startsWith("agent-factory-test-fixture-asset/")
      ) {
        fixtureReferenceSeen = true;
        if (
          schema !== FACTORY_TEST_FIXTURE_ASSET_SCHEMA ||
          !isFactoryTestFixtureAssetBinding(record)
        ) {
          throw new Error("promotion regression contains an unsupported or malformed binary fixture binding");
        }
        bindings.push(record);
        return;
      }
    }
    for (const nested of Array.isArray(entry)
      ? entry
      : Object.values(entry as Record<string, unknown>)) {
      visit(nested);
    }
  };
  visit(value);
  if (containsFactoryFixtureAssetReference(value) && !fixtureReferenceSeen) {
    throw new Error("promotion regression contains an unrecognized binary fixture reference");
  }
  const unique = new Map<string, FactoryTestFixtureAssetBinding>();
  for (const binding of bindings) {
    const key = `${binding.conversationId}\0${binding.assetId}`;
    const existing = unique.get(key);
    if (existing && canonicalEvidenceJson(existing) !== canonicalEvidenceJson(binding)) {
      throw new Error("promotion regression reuses a binary fixture identity with different approved metadata");
    }
    unique.set(key, binding);
  }
  return [...unique.values()].sort((left, right) =>
    `${left.conversationId}:${left.assetId}`.localeCompare(
      `${right.conversationId}:${right.assetId}`,
    ),
  );
}

export function promotionRegressionHasBinaryFixtures(
  artifact: PersistedRegressionArtifact,
): boolean {
  return fixtureBindings(artifact).length > 0;
}

function contentRelative(sha: string): string {
  return `objects/sha256/${sha.slice(0, 2)}/${sha}.bin`;
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await fs.open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("promotion fixture capsule directory is not a real directory");
  }
  await fs.chmod(directory, 0o700);
}

async function writePrivateBytes(file: string, bytes: Uint8Array): Promise<void> {
  await ensurePrivateDirectory(path.dirname(file));
  const handle = await fs.open(
    file,
    fsConstants.O_CREAT |
      fsConstants.O_EXCL |
      fsConstants.O_WRONLY |
      fsConstants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(path.dirname(file));
}

async function writePrivateJson(file: string, value: unknown): Promise<void> {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await ensurePrivateDirectory(path.dirname(file));
  const handle = await fs.open(
    temporary,
    fsConstants.O_CREAT |
      fsConstants.O_EXCL |
      fsConstants.O_WRONLY |
      fsConstants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.link(temporary, file);
    await fs.unlink(temporary);
    await syncDirectory(path.dirname(file));
  } catch (error) {
    await fs.unlink(temporary).catch(() => undefined);
    throw error;
  }
}

function capsuleRelativeDirectory(promotionId: string): string {
  const exactPromotionId = exactText(promotionId, "promotionId", 96);
  if (!/^fpr-[a-f0-9-]{8,80}$/.test(exactPromotionId)) {
    throw new Error("invalid promotion fixture capsule promotionId");
  }
  return `${CAPSULE_PATH_PREFIX}${exactPromotionId}`;
}

async function containedRegularFile(root: string, relative: string): Promise<string> {
  const portable = portableRelative(relative, "path");
  const base = path.resolve(root);
  const candidate = path.resolve(base, ...portable.split("/"));
  if (candidate === base || !candidate.startsWith(`${base}${path.sep}`)) {
    throw new Error("promotion fixture capsule path escapes its root");
  }
  const stat = await fs.lstat(candidate);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("promotion fixture capsule path is not a regular file");
  }
  const [realBase, realCandidate] = await Promise.all([
    fs.realpath(base),
    fs.realpath(candidate),
  ]);
  if (
    realCandidate === realBase ||
    !realCandidate.startsWith(`${realBase}${path.sep}`)
  ) {
    throw new Error("promotion fixture capsule path escapes its real root");
  }
  return candidate;
}

function validateCapsuleManifest(
  value: unknown,
  record: Pick<FactoryPromotionRegressionRecord, "promotionId" | "tenantId" | "domain" | "fixtureCapsule">,
): FactoryPromotionFixtureCapsuleManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("promotion fixture capsule manifest is not an object");
  }
  const manifest = value as FactoryPromotionFixtureCapsuleManifest;
  if (manifest.schema !== FACTORY_PROMOTION_FIXTURE_CAPSULE_SCHEMA) {
    throw new Error(`unsupported promotion fixture capsule schema: ${String(manifest.schema)}`);
  }
  if (
    manifest.promotionId !== record.promotionId ||
    manifest.tenantId !== record.tenantId ||
    manifest.domain !== record.domain
  ) {
    throw new Error("promotion fixture capsule identity does not match its ledger record");
  }
  exactText(manifest.createdAt, "createdAt", 64);
  if (!Number.isFinite(Date.parse(manifest.createdAt))) {
    throw new Error("promotion fixture capsule createdAt is invalid");
  }
  if (!Array.isArray(manifest.entries) || !manifest.entries.length) {
    throw new Error("promotion fixture capsule entries are empty");
  }
  const identities = new Set<string>();
  for (const entry of manifest.entries) {
    exactText(entry.assetId, "assetId", 96);
    exactText(entry.conversationId, "conversationId", 128);
    exactText(entry.caseId, "caseId", 128);
    exactText(entry.path, "fixturePath", 1024);
    exactText(entry.mimeType, "mimeType", 128);
    exactText(entry.filename, "filename", 255);
    exactText(entry.sourceExpiresAt, "sourceExpiresAt", 64);
    if (!SHA256_PATTERN.test(entry.sha256)) {
      throw new Error("promotion fixture capsule entry sha256 is invalid");
    }
    if (!Number.isSafeInteger(entry.bytes) || entry.bytes <= 0) {
      throw new Error("promotion fixture capsule entry byte count is invalid");
    }
    if (!Number.isFinite(Date.parse(entry.sourceExpiresAt))) {
      throw new Error("promotion fixture capsule source expiry identity is invalid");
    }
    const content = portableRelative(entry.content, "content");
    if (content !== contentRelative(entry.sha256)) {
      throw new Error("promotion fixture capsule content path is not content-addressed");
    }
    const identity = `${entry.conversationId}\0${entry.assetId}`;
    if (identities.has(identity)) {
      throw new Error("promotion fixture capsule contains duplicate binding identities");
    }
    identities.add(identity);
  }
  if (manifest.entries.length !== record.fixtureCapsule?.bindingCount) {
    throw new Error("promotion fixture capsule binding count does not match its ledger record");
  }
  const { manifestHash, ...body } = manifest;
  const expectedHash = factoryPromotionFixtureCapsuleManifestHash(body);
  if (
    manifestHash !== expectedHash ||
    manifestHash !== record.fixtureCapsule?.manifestHash
  ) {
    throw new Error("promotion fixture capsule manifest hash mismatch");
  }
  return manifest;
}

/** Freeze short-lived source fixtures at the promotion transaction boundary.
 * This is intentionally called only after the exact suite was replayed and
 * human-reviewed, and before production commit. */
export async function stageFactoryPromotionFixtureCapsule(args: {
  dataRoot: string;
  promotionId: string;
  tenantId: string;
  domain: string;
  artifact: PersistedRegressionArtifact;
}): Promise<FactoryPromotionFixtureCapsuleRef | undefined> {
  const bindings = fixtureBindings(args.artifact);
  if (!bindings.length) return undefined;
  const dataRoot = path.resolve(args.dataRoot);
  const relativeDirectory = capsuleRelativeDirectory(args.promotionId);
  const capsuleDirectory = path.resolve(
    dataRoot,
    ...relativeDirectory.split("/"),
  );
  if (!capsuleDirectory.startsWith(`${dataRoot}${path.sep}`)) {
    throw new Error("promotion fixture capsule directory escapes AGENTIC_DATA_ROOT");
  }
  const fixtureStore = new FsFactoryFixtureAssetStore({
    root: path.join(dataRoot, "factory-fixture-assets"),
  });
  try {
    await ensurePrivateDirectory(capsuleDirectory);
    const entries: FactoryPromotionFixtureCapsuleEntry[] = [];
    const writtenContent = new Set<string>();
    for (const binding of bindings) {
      const loaded = await fixtureStore.readForEvidenceExport(
        {
          tenantId: args.tenantId,
          domain: args.domain,
          conversationId: binding.conversationId,
        },
        binding.assetId,
      );
      if (
        !loaded ||
        loaded.sha256 !== binding.sha256.toLowerCase() ||
        loaded.bytes !== binding.bytes ||
        loaded.expiresAt !== binding.expiresAt ||
        loaded.mimeType !== (binding.mimeType ?? "application/octet-stream") ||
        loaded.filename !== (binding.filename ?? "fixture.bin")
      ) {
        throw new Error(
          "promotion binary fixture is missing, expired, or inconsistent with the reviewed suite",
        );
      }
      const bytes = Buffer.from(loaded.base64, "base64");
      if (bytes.length !== loaded.bytes || sha256(bytes) !== loaded.sha256) {
        throw new Error("promotion binary fixture bytes do not match their reviewed identity");
      }
      const content = contentRelative(loaded.sha256);
      if (!writtenContent.has(content)) {
        await writePrivateBytes(path.join(capsuleDirectory, ...content.split("/")), bytes);
        writtenContent.add(content);
      }
      entries.push({
        assetId: binding.assetId,
        conversationId: binding.conversationId,
        caseId: loaded.caseId,
        path: loaded.path,
        sha256: loaded.sha256,
        bytes: loaded.bytes,
        mimeType: loaded.mimeType,
        filename: loaded.filename,
        sourceExpiresAt: loaded.expiresAt,
        content,
      });
    }
    entries.sort((left, right) =>
      `${left.conversationId}:${left.assetId}`.localeCompare(
        `${right.conversationId}:${right.assetId}`,
      ),
    );
    const body = {
      schema: FACTORY_PROMOTION_FIXTURE_CAPSULE_SCHEMA,
      promotionId: args.promotionId,
      tenantId: args.tenantId,
      domain: args.domain,
      createdAt: new Date().toISOString(),
      entries,
    } satisfies Omit<FactoryPromotionFixtureCapsuleManifest, "manifestHash">;
    const manifest: FactoryPromotionFixtureCapsuleManifest = {
      ...body,
      manifestHash: factoryPromotionFixtureCapsuleManifestHash(body),
    };
    await writePrivateJson(path.join(capsuleDirectory, "capsule.json"), manifest);
    await syncDirectory(capsuleDirectory);
    return {
      schema: FACTORY_PROMOTION_FIXTURE_CAPSULE_REF_SCHEMA,
      manifest: `${relativeDirectory}/capsule.json`,
      manifestHash: manifest.manifestHash,
      bindingCount: entries.length,
    };
  } catch (error) {
    await fs.rm(capsuleDirectory, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

/** Verify both the artifact/capsule relationship and every private sidecar.
 * Old promotions without binary descriptors remain valid. Any promotion that
 * contains a descriptor but lacks a capsule fails closed. */
export async function verifyFactoryPromotionFixtureCapsule(args: {
  dataRoot: string;
  record: FactoryPromotionRegressionRecord;
  artifact: PersistedRegressionArtifact;
}): Promise<VerifiedFactoryPromotionFixtureCapsule | undefined> {
  const bindings = fixtureBindings(args.artifact);
  const ref = args.record.fixtureCapsule;
  if (!bindings.length) {
    if (ref) {
      throw new Error("promotion without binary fixtures unexpectedly declares a fixture capsule");
    }
    return undefined;
  }
  if (!ref) {
    throw new Error("promotion contains binary fixtures but has no immutable fixture capsule");
  }
  if (ref.schema !== FACTORY_PROMOTION_FIXTURE_CAPSULE_REF_SCHEMA) {
    throw new Error(`unsupported promotion fixture capsule reference schema: ${String(ref.schema)}`);
  }
  const expectedPrefix = capsuleRelativeDirectory(args.record.promotionId);
  if (ref.manifest !== `${expectedPrefix}/capsule.json`) {
    throw new Error("promotion fixture capsule manifest path is not owned by this promotion");
  }
  const manifestPath = await containedRegularFile(args.dataRoot, ref.manifest);
  const manifest = validateCapsuleManifest(
    JSON.parse(await fs.readFile(manifestPath, "utf8")),
    args.record,
  );
  const capsuleDirectory = path.dirname(manifestPath);
  const bindingMap = new Map(
    bindings.map((binding) => [
      `${binding.conversationId}\0${binding.assetId}`,
      binding,
    ]),
  );
  if (bindingMap.size !== manifest.entries.length) {
    throw new Error("promotion fixture capsule does not exactly cover artifact bindings");
  }
  for (const entry of manifest.entries) {
    const binding = bindingMap.get(`${entry.conversationId}\0${entry.assetId}`);
    if (
      !binding ||
      binding.sha256.toLowerCase() !== entry.sha256 ||
      binding.bytes !== entry.bytes ||
      binding.expiresAt !== entry.sourceExpiresAt ||
      (binding.mimeType ?? "application/octet-stream") !== entry.mimeType ||
      (binding.filename ?? "fixture.bin") !== entry.filename
    ) {
      throw new Error("promotion fixture capsule entry does not match its reviewed descriptor");
    }
    const contentPath = await containedRegularFile(capsuleDirectory, entry.content);
    const bytes = await fs.readFile(contentPath);
    if (bytes.length !== entry.bytes || sha256(bytes) !== entry.sha256) {
      throw new Error("promotion fixture capsule content hash or size drifted");
    }
  }
  return { manifest, manifestPath, capsuleDirectory };
}

export async function removeFactoryPromotionFixtureCapsule(args: {
  dataRoot: string;
  record: FactoryPromotionRegressionRecord;
}): Promise<void> {
  if (!args.record.fixtureCapsule) return;
  const relativeDirectory = capsuleRelativeDirectory(args.record.promotionId);
  const expectedManifest = `${relativeDirectory}/capsule.json`;
  if (args.record.fixtureCapsule.manifest !== expectedManifest) {
    throw new Error("refusing to delete a promotion fixture capsule outside its owned directory");
  }
  const root = path.resolve(args.dataRoot);
  const capsuleDirectory = path.resolve(root, ...relativeDirectory.split("/"));
  if (!capsuleDirectory.startsWith(`${root}${path.sep}`)) {
    throw new Error("refusing to delete an escaping promotion fixture capsule path");
  }
  await fs.rm(capsuleDirectory, { recursive: true, force: true });
  await syncDirectory(path.dirname(capsuleDirectory));
}

/** Build an in-memory, immutable reader for promoted replay. Expiry is an
 * identity field only: the source fixture may be long deleted by this point. */
export async function createFactoryPromotionFixtureMaterializer(args: {
  dataRoot: string;
  record: FactoryPromotionRegressionRecord;
  artifact: PersistedRegressionArtifact;
}): Promise<
  | ((input: {
      domain: string;
      conversationId: string;
      caseId: string;
      payload: Record<string, unknown>;
    }) => Promise<Record<string, unknown>>)
  | undefined
> {
  const verified = await verifyFactoryPromotionFixtureCapsule(args);
  if (!verified) return undefined;
  const contents = new Map<string, FactoryPromotionFixtureCapsuleEntry & { base64: string }>();
  for (const entry of verified.manifest.entries) {
    const contentPath = await containedRegularFile(verified.capsuleDirectory, entry.content);
    const bytes = await fs.readFile(contentPath);
    if (bytes.length !== entry.bytes || sha256(bytes) !== entry.sha256) {
      throw new Error("promotion fixture capsule content drifted while opening replay");
    }
    contents.set(`${entry.conversationId}\0${entry.assetId}`, {
      ...entry,
      base64: bytes.toString("base64"),
    });
  }
  return async (input) => {
    if (input.domain !== args.record.domain) {
      throw new Error("promotion fixture replay domain is outside the committed record");
    }
    return materializeFactoryFixturePayload({
      ...input,
      tenantId: args.record.tenantId,
      store: {
        async read(scope, assetId) {
          if (
            scope.tenantId !== args.record.tenantId ||
            scope.domain !== args.record.domain ||
            scope.conversationId !== input.conversationId
          ) {
            return null;
          }
          const entry = contents.get(`${scope.conversationId}\0${assetId}`);
          if (!entry) return null;
          return {
            assetId: entry.assetId,
            sha256: entry.sha256,
            bytes: entry.bytes,
            mimeType: entry.mimeType,
            filename: entry.filename,
            expiresAt: entry.sourceExpiresAt,
            caseId: entry.caseId,
            path: entry.path,
            base64: entry.base64,
          };
        },
      },
    });
  };
}
