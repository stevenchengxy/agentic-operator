import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import {
  canonicalEvidenceJson,
} from "@agentic/agent-factory";

import {
  readFactoryPromotionRegressionLedger,
  type FactoryPromotionRegressionRecord,
} from "./promotion-regression-ledger";
import { verifyFactoryPromotionFixtureCapsule } from "./promotion-regression-fixture-capsule";
import {
  buildFactoryProductionRegressionInventory,
  factoryPromotionLedgerCoverageIssues,
  readFactoryProductionDeploymentRows,
  type FactoryProductionDeploymentRow,
  type FactoryProductionRegressionInventory,
} from "./production-regression-inventory";
import {
  assertRegressionArtifactCassetteEvidence,
  type PersistedRegressionArtifact,
} from "./regression-artifact";

export const FACTORY_REGRESSION_EXPORT_SCHEMA =
  "agent-factory-regression-export/v1" as const;
export const FACTORY_REGRESSION_EXPORT_MANIFEST =
  "factory-regression-export.json";
export const FACTORY_REGRESSION_INVENTORY_FILE =
  "factory-production-inventory.json";

export interface FactoryRegressionExportSource {
  repository: string;
  workflow: ".github/workflows/factory-regression-export.yml";
  event: "push" | "workflow_dispatch";
  ref: string;
  sha: string;
  runId: string;
  runAttempt: string;
  /** Fresh consumer identity. CI/release generates the nonce before
   * dispatching this exact exporter run; it is not inferred from the SHA. */
  consumerWorkflow: ".github/workflows/ci.yml" | ".github/workflows/release.yml" | ".github/workflows/factory-regression-export.yml";
  consumerRunId: string;
  consumerRunAttempt: string;
  requestNonce: string;
}

export interface FactoryRegressionExportFile {
  path: string;
  sha256: string;
  bytes: number;
}

export interface FactoryRegressionExportManifest {
  schema: typeof FACTORY_REGRESSION_EXPORT_SCHEMA;
  createdAt: string;
  expiresAt: string;
  source: FactoryRegressionExportSource;
  inventoryFile: typeof FACTORY_REGRESSION_INVENTORY_FILE;
  inventorySha256: string;
  highWatermark: FactoryProductionRegressionInventory["highWatermark"];
  files: FactoryRegressionExportFile[];
  signature: string;
}

export interface FactoryRegressionExportVerificationExpected {
  repository: string;
  workflow: FactoryRegressionExportSource["workflow"];
  event: FactoryRegressionExportSource["event"];
  ref: FactoryRegressionExportSource["ref"];
  sha: string;
  runId: string;
  runAttempt: string;
  consumerWorkflow: FactoryRegressionExportSource["consumerWorkflow"];
  consumerRunId: string;
  consumerRunAttempt: string;
  requestNonce: string;
  /** Explicit binding to the checkpoint in this newly signed snapshot. This
   * is not an independent external witness; freshness comes from requestNonce. */
  highWatermarkStateHash: string;
}

const sha256 = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

function signingKey(value: string): Buffer {
  const key = Buffer.from(value, "utf8");
  if (key.length < 32)
    throw new Error(
      "Factory regression export signing key is missing or too short",
    );
  return key;
}

function manifestSignature(
  body: Omit<FactoryRegressionExportManifest, "signature">,
  key: Buffer,
): string {
  return `factory-regression-export:v1:${createHmac("sha256", key)
    .update(canonicalEvidenceJson(body), "utf8")
    .digest("hex")}`;
}

function exactSource(
  source: FactoryRegressionExportSource,
): FactoryRegressionExportSource {
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(source.repository) ||
    source.workflow !== ".github/workflows/factory-regression-export.yml" ||
    !["push", "workflow_dispatch"].includes(source.event) ||
    !/^refs\/(?:heads\/main|tags\/v[0-9A-Za-z._-]+)$/.test(source.ref) ||
    !/^[a-f0-9]{40}$/i.test(source.sha) ||
    !/^[0-9]+$/.test(source.runId) ||
    !/^[0-9]+$/.test(source.runAttempt) ||
    ![
      ".github/workflows/ci.yml",
      ".github/workflows/release.yml",
      ".github/workflows/factory-regression-export.yml",
    ].includes(source.consumerWorkflow) ||
    !/^[0-9]+$/.test(source.consumerRunId) ||
    !/^[0-9]+$/.test(source.consumerRunAttempt) ||
    !/^[A-Za-z0-9._:-]{16,160}$/.test(source.requestNonce)
  ) {
    throw new Error("Factory regression export source identity is incomplete");
  }
  return source;
}

function contained(root: string, relative: string): string {
  if (path.isAbsolute(relative) || relative.split("/").includes("..")) {
    throw new Error("Factory regression export path is not contained");
  }
  const base = path.resolve(root);
  const target = path.resolve(base, ...relative.split("/"));
  if (target === base || !target.startsWith(`${base}${path.sep}`)) {
    throw new Error("Factory regression export path escapes its root");
  }
  return target;
}

async function secureCopyFile(
  source: string,
  destination: string,
): Promise<void> {
  const stat = await fs.lstat(source);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error(
      "Factory regression export source contains a non-regular file",
    );
  await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  await fs.copyFile(source, destination, fsConstants.COPYFILE_EXCL);
  await fs.chmod(destination, 0o600);
}

async function secureCopyTree(
  source: string,
  destination: string,
): Promise<void> {
  const stat = await fs.lstat(source);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error(
      "Factory regression export source contains a non-directory tree",
    );
  await fs.mkdir(destination, { recursive: true, mode: 0o700 });
  for (const entry of await fs.readdir(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isSymbolicLink())
      throw new Error("Factory regression export refuses symlinked evidence");
    if (entry.isDirectory()) await secureCopyTree(from, to);
    else if (entry.isFile()) await secureCopyFile(from, to);
    else
      throw new Error(
        "Factory regression export source contains an unsupported filesystem entry",
      );
  }
}

async function walkFiles(
  root: string,
  directory = root,
): Promise<FactoryRegressionExportFile[]> {
  const files: FactoryRegressionExportFile[] = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink())
      throw new Error("Factory regression bundle contains a symlink");
    if (entry.isDirectory()) files.push(...(await walkFiles(root, file)));
    else if (entry.isFile()) {
      const relative = path.relative(root, file).split(path.sep).join("/");
      if (relative === FACTORY_REGRESSION_EXPORT_MANIFEST) continue;
      const bytes = await fs.readFile(file);
      files.push({
        path: relative,
        sha256: sha256(bytes),
        bytes: bytes.length,
      });
    } else
      throw new Error(
        "Factory regression bundle contains an unsupported filesystem entry",
      );
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

async function writePrivateJson(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
}

export async function exportFactoryRegressionBundle(args: {
  dataRoot: string;
  outputRoot: string;
  signingKey: string;
  source: FactoryRegressionExportSource;
  /** Test seam only. Production export always reads the live deployment DB. */
  deployments?: FactoryProductionDeploymentRow[];
  /** Test seam for proving the before/after database seqlock check. */
  readDeployments?: () => FactoryProductionDeploymentRow[];
  ttlSeconds?: number;
  now?: Date;
}): Promise<FactoryRegressionExportManifest> {
  const sourceRoot = path.resolve(args.dataRoot);
  const outputRoot = path.resolve(args.outputRoot);
  if (
    outputRoot === sourceRoot ||
    outputRoot.startsWith(`${sourceRoot}${path.sep}`)
  ) {
    throw new Error(
      "Factory regression export output must be outside AGENTIC_DATA_ROOT",
    );
  }
  const source = exactSource(args.source);
  const key = signingKey(args.signingKey);
  const now = args.now ?? new Date();
  const ttlSeconds = args.ttlSeconds ?? 6 * 60 * 60;
  if (
    !Number.isSafeInteger(ttlSeconds) ||
    ttlSeconds < 60 ||
    ttlSeconds > 24 * 60 * 60
  ) {
    throw new Error(
      "Factory regression export TTL must be between 60 and 86400 seconds",
    );
  }
  await fs.mkdir(outputRoot, { mode: 0o700 });
  const ledger = await readFactoryPromotionRegressionLedger(sourceRoot);
  const readDeployments =
    args.readDeployments ??
    (() => args.deployments ?? readFactoryProductionDeploymentRows());
  const deployments = readDeployments();
  const inventory = buildFactoryProductionRegressionInventory({
    deployments,
    ledger,
    now,
  });
  const records = ledger.committed.map((entry) => entry.record!);

  const copiedVersions = new Set<string>();
  const copiedCapsules = new Set<string>();
  const expiresAtMs = now.getTime() + ttlSeconds * 1000;
  for (const promotion of records) {
    const artifactSource = contained(sourceRoot, promotion.artifact);
    const versionRelative = path.dirname(promotion.artifact);
    if (!copiedVersions.has(versionRelative)) {
      await secureCopyTree(
        path.dirname(artifactSource),
        contained(outputRoot, versionRelative),
      );
      copiedVersions.add(versionRelative);
    }
    // Verify the copied bytes with the API-only cassette key before the
    // independent export manifest signs them. CI receives the manifest key,
    // never the production cassette-attestation key.
    await assertRegressionArtifactCassetteEvidence(
      contained(outputRoot, promotion.artifact),
      { dataRoot: sourceRoot },
    );
    const artifact = JSON.parse(
      await fs.readFile(artifactSource, "utf8"),
    ) as PersistedRegressionArtifact;
    const capsule = await verifyFactoryPromotionFixtureCapsule({
      dataRoot: sourceRoot,
      record: promotion,
      artifact,
    });
    if (capsule) {
      const capsuleRelative = path
        .relative(sourceRoot, capsule.capsuleDirectory)
        .split(path.sep)
        .join("/");
      if (!copiedCapsules.has(capsuleRelative)) {
        await secureCopyTree(
          capsule.capsuleDirectory,
          contained(outputRoot, capsuleRelative),
        );
        copiedCapsules.add(capsuleRelative);
      }
    }
  }

  const ledgerOutput = path.join(outputRoot, "factory-regression-promotions");
  await fs.mkdir(path.join(ledgerOutput, "pending"), {
    recursive: true,
    mode: 0o700,
  });
  await fs.mkdir(path.join(ledgerOutput, "committed"), {
    recursive: true,
    mode: 0o700,
  });
  for (const entry of ledger.committed) {
    await secureCopyFile(
      entry.file,
      path.join(ledgerOutput, "committed", path.basename(entry.file)),
    );
  }
  await secureCopyFile(
    path.join(
      sourceRoot,
      "factory-regression-promotions",
      "high-watermark.json",
    ),
    path.join(ledgerOutput, "high-watermark.json"),
  );
  // Treat the production DB + filesystem ledger as a seqlock snapshot. A
  // promotion that crosses either source while evidence is copied must make
  // this export fail; signing a coherent stale prefix would be worse than a
  // retry. Tests pass a fixed deployment seam, production re-reads the DB.
  const endingLedger = await readFactoryPromotionRegressionLedger(sourceRoot);
  const endingInventory = buildFactoryProductionRegressionInventory({
    deployments: readDeployments(),
    ledger: endingLedger,
    now,
  });
  if (
    canonicalEvidenceJson(endingInventory) !== canonicalEvidenceJson(inventory)
  ) {
    throw new Error(
      "Factory production inventory changed while the regression export was copied",
    );
  }
  const inventoryPath = path.join(
    outputRoot,
    FACTORY_REGRESSION_INVENTORY_FILE,
  );
  await writePrivateJson(inventoryPath, inventory);
  const inventoryRaw = await fs.readFile(inventoryPath);
  const files = await walkFiles(outputRoot);
  const body: Omit<FactoryRegressionExportManifest, "signature"> = {
    schema: FACTORY_REGRESSION_EXPORT_SCHEMA,
    createdAt: now.toISOString(),
    expiresAt: new Date(expiresAtMs).toISOString(),
    source,
    inventoryFile: FACTORY_REGRESSION_INVENTORY_FILE,
    inventorySha256: sha256(inventoryRaw),
    highWatermark: inventory.highWatermark,
    files,
  };
  const manifest = { ...body, signature: manifestSignature(body, key) };
  await writePrivateJson(
    path.join(outputRoot, FACTORY_REGRESSION_EXPORT_MANIFEST),
    manifest,
  );
  // Verify the exact copied bytes before the workflow is allowed to upload
  // them. A concurrent ledger change may make the source snapshot unusable;
  // publishing a bundle that only downstream CI can reject is avoidable.
  await verifyFactoryRegressionExportBundle({
    dataRoot: outputRoot,
    signingKey: args.signingKey,
    expected: {
      repository: source.repository,
      workflow: source.workflow,
      event: source.event,
      ref: source.ref,
      sha: source.sha,
      runId: source.runId,
      runAttempt: source.runAttempt,
      consumerWorkflow: source.consumerWorkflow,
      consumerRunId: source.consumerRunId,
      consumerRunAttempt: source.consumerRunAttempt,
      requestNonce: source.requestNonce,
      highWatermarkStateHash: inventory.highWatermark.stateHash,
    },
    now,
  });
  return manifest;
}

function parseManifest(value: unknown): FactoryRegressionExportManifest {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Factory regression export manifest is invalid");
  const manifest = value as FactoryRegressionExportManifest;
  if (
    manifest.schema !== FACTORY_REGRESSION_EXPORT_SCHEMA ||
    manifest.inventoryFile !== FACTORY_REGRESSION_INVENTORY_FILE ||
    !Array.isArray(manifest.files) ||
    typeof manifest.signature !== "string"
  )
    throw new Error("Factory regression export manifest contract is invalid");
  return manifest;
}

export async function verifyFactoryRegressionExportBundle(args: {
  dataRoot: string;
  signingKey: string;
  expected: FactoryRegressionExportVerificationExpected;
  now?: Date;
}): Promise<FactoryProductionRegressionInventory> {
  const root = path.resolve(args.dataRoot);
  const key = signingKey(args.signingKey);
  const manifest = parseManifest(
    JSON.parse(
      await fs.readFile(
        path.join(root, FACTORY_REGRESSION_EXPORT_MANIFEST),
        "utf8",
      ),
    ),
  );
  const { signature, ...body } = manifest;
  const expectedSignature = manifestSignature(body, key);
  const actualBytes = Buffer.from(signature, "utf8");
  const expectedBytes = Buffer.from(expectedSignature, "utf8");
  if (
    actualBytes.length !== expectedBytes.length ||
    !timingSafeEqual(actualBytes, expectedBytes)
  ) {
    throw new Error("Factory regression export signature is invalid");
  }
  const source = exactSource(manifest.source);
  if (
    source.repository !== args.expected.repository ||
    source.workflow !== args.expected.workflow ||
    source.event !== args.expected.event ||
    source.ref !== args.expected.ref ||
    source.sha !== args.expected.sha ||
    source.runId !== args.expected.runId ||
    source.runAttempt !== args.expected.runAttempt ||
    source.consumerWorkflow !== args.expected.consumerWorkflow ||
    source.consumerRunId !== args.expected.consumerRunId ||
    source.consumerRunAttempt !== args.expected.consumerRunAttempt ||
    source.requestNonce !== args.expected.requestNonce
  ) {
    throw new Error(
      "Factory regression export workflow/event/ref/commit/run identity does not match CI",
    );
  }
  const now = (args.now ?? new Date()).getTime();
  const createdAt = Date.parse(manifest.createdAt);
  const expiresAt = Date.parse(manifest.expiresAt);
  if (
    !Number.isFinite(createdAt) ||
    !Number.isFinite(expiresAt) ||
    createdAt > now + 5 * 60 * 1000 ||
    expiresAt <= createdAt ||
    expiresAt - createdAt > 24 * 60 * 60 * 1000 ||
    expiresAt <= now
  ) {
    throw new Error(
      "Factory regression export is expired or has invalid timestamps",
    );
  }
  const actualFiles = await walkFiles(root);
  if (
    canonicalEvidenceJson(actualFiles) !== canonicalEvidenceJson(manifest.files)
  ) {
    throw new Error(
      "Factory regression export file inventory is incomplete or has drifted",
    );
  }
  const inventoryRaw = await fs.readFile(
    contained(root, manifest.inventoryFile),
  );
  if (sha256(inventoryRaw) !== manifest.inventorySha256)
    throw new Error("Factory production inventory hash mismatch");
  const inventory = JSON.parse(
    inventoryRaw.toString("utf8"),
  ) as FactoryProductionRegressionInventory;
  if (
    inventory.schema !== "agent-factory-production-regression-inventory/v1" ||
    inventory.generatedAt !== manifest.createdAt
  ) {
    throw new Error("Factory production inventory contract is inconsistent");
  }
  const ledger = await readFactoryPromotionRegressionLedger(root);
  const ledgerIssues = factoryPromotionLedgerCoverageIssues(ledger);
  if (ledgerIssues.length) {
    throw new Error("Factory promotion ledger is incomplete or inconsistent");
  }
  const records = ledger.committed.flatMap((entry) =>
    entry.record ? [entry.record] : [],
  );
  // Re-open the signed copy's capsule sidecars, not only the source snapshot.
  // This closes a verify→copy race and makes upload fail before CI ever sees a
  // bundle with missing/drifted/path-escaping binary evidence.
  for (const record of records) {
    const artifactPath = contained(root, record.artifact);
    const artifact = JSON.parse(
      await fs.readFile(artifactPath, "utf8"),
    ) as PersistedRegressionArtifact;
    await verifyFactoryPromotionFixtureCapsule({
      dataRoot: root,
      record,
      artifact,
    });
  }
  if (
    !ledger.highWatermark ||
    ledger.highWatermark.committedCount !==
      inventory.highWatermark.committedCount ||
    ledger.highWatermark.ledgerDigest !==
      inventory.highWatermark.ledgerDigest ||
    ledger.highWatermark.stateHash !== inventory.highWatermark.stateHash ||
    canonicalEvidenceJson(manifest.highWatermark) !==
      canonicalEvidenceJson(inventory.highWatermark)
  ) {
    throw new Error(
      "Factory production inventory and promotion high-watermark do not match",
    );
  }
  if (
    inventory.highWatermark.stateHash !==
    args.expected.highWatermarkStateHash
  ) {
    throw new Error(
      "Factory production inventory high-watermark does not match the consumer checkpoint",
    );
  }
  const promotionProjection = records
    .map((record: FactoryPromotionRegressionRecord) => ({
      promotionId: record.promotionId,
      tenantId: record.tenantId,
      tenantSlug: record.tenantSlug,
      domain: record.domain,
      slugs: [...record.slugs].sort(),
      versionId: record.versionId,
      suiteFingerprint: record.suiteFingerprint,
      deploymentId: record.deploymentId,
      recordHash: record.recordHash,
    }))
    .sort((a, b) => a.promotionId.localeCompare(b.promotionId));
  if (
    canonicalEvidenceJson(promotionProjection) !==
    canonicalEvidenceJson(inventory.promotions)
  ) {
    throw new Error(
      "Factory production inventory does not exactly cover the committed promotion ledger",
    );
  }
  for (const live of inventory.liveAgents) {
    if (
      !inventory.promotions.some(
        (promotion) =>
          promotion.tenantId === live.tenantId &&
          promotion.domain === live.domain &&
          promotion.versionId === live.versionId &&
          promotion.suiteFingerprint === live.suiteFingerprint &&
          promotion.slugs.includes(live.slug),
      )
    ) {
      throw new Error(
        "Factory live production inventory is not covered by a committed promotion",
      );
    }
  }
  if (!inventory.liveAgents.length)
    throw new Error("Factory live production inventory is empty");
  return inventory;
}
