/**
 * Host-side readiness gate for the single-host production topology.
 *
 * Compose is given immutable local image IDs by setup. This script observes
 * the containers Docker actually started and refuses readiness unless both
 * Container.Config.Image and Container.Image equal those IDs. It also checks
 * the image build/role labels and the candidate image allowlists, then stores
 * a secret-free attestation on the API's durable data bind.
 */

import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseProductionEnvText } from "./production-env-file";
import {
  FACTORY_PRODUCTION_IMAGE_ATTESTATION_SCHEMA,
  assertFactoryProductionImageAttestation,
  expectedProductionImages,
  productionImageAttestationKeyId,
  signFactoryProductionImageAttestation,
  verifyProductionImageObservation,
  type FactoryProductionImageAttestation,
  type ObservedProductionContainer,
} from "../src/services/agent-factory/production-image-attestation";

export {
  FACTORY_PRODUCTION_IMAGE_ATTESTATION_SCHEMA,
  assertFactoryProductionImageAttestation,
  expectedProductionImages,
  productionImageAttestationKeyId,
  signFactoryProductionImageAttestation,
  verifyProductionImageObservation,
};
export type {
  ExpectedProductionImages,
  FactoryProductionImageAttestation,
  FactoryProductionImageAttestationBody,
  ObservedProductionContainer,
} from "../src/services/agent-factory/production-image-attestation";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

function parseEnvFile(filename: string): Record<string, string> {
  if (!existsSync(filename)) throw new Error(`${path.basename(filename)} does not exist`);
  return parseProductionEnvText(readFileSync(filename, "utf8"));
}


function run(command: string, args: string[]): string {
  return execFileSync(command, args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function composeArgs(envFile: string): string[] {
  return [
    "compose", "--env-file", envFile,
    "-f", "docker-compose.yml",
    "-f", "docker-compose.production.yml",
    "--profile", "factory-sandbox",
  ];
}

function inspectService(envFile: string, service: string): ObservedProductionContainer {
  const containerId = run("docker", [...composeArgs(envFile), "ps", "-q", service]);
  if (!containerId || containerId.includes("\n")) {
    throw new Error(`${service} does not resolve to exactly one container`);
  }
  const inspected = JSON.parse(run("docker", ["container", "inspect", containerId])) as Array<{
    Id?: string;
    Image?: string;
    Config?: { Image?: string; Labels?: Record<string, string> };
    State?: { Status?: string; Health?: { Status?: string } };
  }>;
  const row = inspected[0];
  if (!row?.Id) throw new Error(`Docker returned no inspection record for ${service}`);
  return {
    service,
    containerId: row.Id,
    configImage: row.Config?.Image ?? "",
    imageId: row.Image ?? "",
    status: row.State?.Status ?? "unknown",
    ...(row.State?.Health?.Status ? { health: row.State.Health.Status } : {}),
    buildId: row.Config?.Labels?.["org.opencontainers.image.revision"],
    role: row.Config?.Labels?.["io.agentic.sandbox.role"],
  };
}

function inspectCandidate(imageId: string): { imageId: string; buildId?: string; role?: string } {
  const inspected = JSON.parse(run("docker", ["image", "inspect", imageId])) as Array<{
    Id?: string;
    Config?: { Labels?: Record<string, string> };
  }>;
  const row = inspected[0];
  if (!row?.Id) throw new Error("Docker returned no candidate image inspection record");
  return {
    imageId: row.Id,
    buildId: row.Config?.Labels?.["org.opencontainers.image.revision"],
    role: row.Config?.Labels?.["io.agentic.sandbox.role"],
  };
}

function writeAttestation(filename: string, value: FactoryProductionImageAttestation): void {
  const temporary = `${filename}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    renameSync(temporary, filename);
    chmodSync(filename, 0o600);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

export interface ProductionImageVerificationResult {
  attestation: FactoryProductionImageAttestation;
  ttlMs: number;
  outputFile: string;
}

function configuredTtlMs(env: Record<string, string | undefined>): number {
  const ttlMs = Number(
    env.FACTORY_PRODUCTION_IMAGE_ATTESTATION_TTL_MS
      || 5 * 60_000,
  );
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 10_000 || ttlMs > 15 * 60_000) {
    throw new Error(
      "FACTORY_PRODUCTION_IMAGE_ATTESTATION_TTL_MS must be between 10000 and 900000",
    );
  }
  return ttlMs;
}

export function verifyProductionImagesOnce(options: {
  envFile?: string;
  env?: Record<string, string>;
  privateKeyFile?: string;
  publicKeyFile?: string;
  outputFile?: string;
  now?: Date;
  inspectService?: (envFile: string, service: string) => ObservedProductionContainer;
  inspectCandidate?: (imageId: string) => { imageId: string; buildId?: string; role?: string };
  write?: (filename: string, value: FactoryProductionImageAttestation) => void;
} = {}): ProductionImageVerificationResult {
  const envFile = path.resolve(
    root,
    options.envFile
      || process.env.FACTORY_PRODUCTION_ENV_FILE?.trim()
      || ".env.production",
  );
  // The watch path calls this whole function every round. Re-reading the env
  // and re-inspecting every container prevents a fresh signature over an old
  // observation body after a deployment or allowlist change.
  const env = options.env ?? parseEnvFile(envFile);
  const expected = expectedProductionImages(env);
  const observeService = options.inspectService ?? inspectService;
  const observeCandidate = options.inspectCandidate ?? inspectCandidate;
  const containers = expected.services.map((row) => observeService(envFile, row.service));
  const trustRoot = path.join(root, ".secrets", "agent-factory", "production-image-attestation");
  const privateKeyFile = options.privateKeyFile ?? path.resolve(
    root,
    process.env.FACTORY_PRODUCTION_IMAGE_ATTESTATION_PRIVATE_KEY_HOST_FILE?.trim()
      || path.join(trustRoot, "private.pem"),
  );
  const publicKeyFile = options.publicKeyFile ?? path.resolve(
    root,
    env.FACTORY_PRODUCTION_IMAGE_ATTESTATION_PUBLIC_KEY_HOST_FILE?.trim()
      || path.join(trustRoot, "public.pem"),
  );
  const privateKey = readFileSync(privateKeyFile);
  const publicKey = readFileSync(publicKeyFile);
  const keyId = productionImageAttestationKeyId(publicKey);
  const ttlMs = configuredTtlMs(env);
  const body = verifyProductionImageObservation({
    expected,
    containers,
    candidate: observeCandidate(expected.candidateImageId),
    keyId,
    ttlMs,
    now: options.now,
  });
  const attestation = signFactoryProductionImageAttestation(body, privateKey);
  assertFactoryProductionImageAttestation(attestation, expected, {
    publicKey,
    now: options.now,
    maxTtlMs: ttlMs,
  });
  const output = options.outputFile ?? path.resolve(
    root,
    process.env.FACTORY_PRODUCTION_IMAGE_ATTESTATION_HOST_FILE?.trim()
      || "data/factory-production-image-attestation.json",
  );
  (options.write ?? writeAttestation)(output, attestation);
  return { attestation, ttlMs, outputFile: output };
}

function resultSummary(result: ProductionImageVerificationResult) {
  const { attestation, outputFile } = result;
  return {
    ok: true,
    schema: attestation.schema,
    keyId: attestation.keyId,
    topology: attestation.topology,
    buildId: attestation.buildId,
    evidenceHash: attestation.evidenceHash,
    verifiedAt: attestation.verifiedAt,
    expiresAt: attestation.expiresAt,
    attestationFile: path.relative(root, outputFile),
    services: attestation.services.map((row) => ({ service: row.service, imageId: row.imageId })),
    candidateImageId: attestation.candidate.imageId,
  };
}

function abortableWait(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

export async function watchProductionImageAttestations(options: {
  signal?: AbortSignal;
  verifyOnce?: () => ProductionImageVerificationResult | Promise<ProductionImageVerificationResult>;
  wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
  onSuccess?: (result: ProductionImageVerificationResult) => void;
  onFailure?: (error: unknown) => void;
  defaultTtlMs?: number;
  /** Re-read the configured TTL even when Docker observation fails, so a
   * shortened policy cannot leave the watcher sleeping on an old interval. */
  readTtlMs?: () => number;
} = {}): Promise<void> {
  const verifyOnce = options.verifyOnce ?? (() => verifyProductionImagesOnce());
  const wait = options.wait ?? abortableWait;
  let intervalMs = Math.max(1_000, Math.floor((options.defaultTtlMs ?? 5 * 60_000) / 3));
  while (!options.signal?.aborted) {
    try {
      const result = await verifyOnce();
      intervalMs = Math.max(1_000, Math.floor(result.ttlMs / 3));
      options.onSuccess?.(result);
    } catch (error) {
      // Never replace the last valid file with failure output. It naturally
      // expires, at which point API health and every protected entry turn red.
      options.onFailure?.(error);
    }
    if (options.readTtlMs) {
      try {
        intervalMs = Math.max(1_000, Math.floor(options.readTtlMs() / 3));
      } catch (error) {
        // Retain the last known safe interval. The proof is not refreshed and
        // will still expire; an unreadable env must never create evidence.
        options.onFailure?.(error);
      }
    }
    if (options.signal?.aborted) break;
    await wait(intervalMs, options.signal);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const watch = args.includes("--watch");
  if (args.some((arg) => arg !== "--watch")) {
    throw new Error("usage: verify-factory-production-images.ts [--watch]");
  }
  if (!watch) {
    process.stdout.write(`${JSON.stringify(resultSummary(verifyProductionImagesOnce()), null, 2)}\n`);
    return;
  }
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    const envFile = path.resolve(
      root,
      process.env.FACTORY_PRODUCTION_ENV_FILE?.trim() || ".env.production",
    );
    await watchProductionImageAttestations({
      signal: controller.signal,
      defaultTtlMs: configuredTtlMs(parseEnvFile(envFile)),
      readTtlMs: () => configuredTtlMs(parseEnvFile(envFile)),
      onSuccess: (result) => process.stdout.write(`${JSON.stringify(resultSummary(result))}\n`),
      onFailure: (error) => process.stderr.write(
        `[factory-production-images] observation failed; last proof was not overwritten: ${String((error as Error)?.message ?? error).slice(0, 500)}\n`,
      ),
    });
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`[factory-production-images] ${String((error as Error)?.message ?? error)}\n`);
    process.exitCode = 1;
  });
}
