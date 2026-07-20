#!/usr/bin/env node

import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const FACTORY_SANDBOX_RELEASE_SCHEMA =
  "agent-factory-sandbox-image-release/v4";
export const FACTORY_SANDBOX_LEGACY_RELEASE_SCHEMA =
  "agent-factory-sandbox-image-release/v3";

const SHA256 = /^sha256:[a-f0-9]{64}$/;
const GIT_SHA = /^[a-f0-9]{40}$/;
const RELEASE_TAG = /^v[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/;
const OCI_NAME = /^(?:[a-z0-9]+(?:[._-][a-z0-9]+)*)(?::[0-9]+)?\/[a-z0-9]+(?:[._/-][a-z0-9]+)*$/;
const PLATFORM = /^linux\/(?:amd64|arm64)$/;

function fail(message) {
  throw new Error(`Factory sandbox release manifest: ${message}`);
}

function exactString(value, label) {
  if (typeof value !== "string" || !value.trim() || value !== value.trim()) {
    fail(`${label} must be a non-empty trimmed string`);
  }
  return value;
}

function exactObject(value, label, allowed) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) fail(`${label}.${unknown} is unsupported`);
  return value;
}

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (!name?.startsWith("--")) fail(`unexpected argument ${String(name)}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) fail(`${name} requires a value`);
    if (values.has(name)) fail(`${name} was supplied more than once`);
    values.set(name, value);
    index += 1;
  }
  return values;
}

function required(args, name) {
  const value = args.get(name);
  if (!value) fail(`${name} is required`);
  return value;
}

function imageRecord({ name, digest, sbomDigest, target, platform }) {
  if (!OCI_NAME.test(name)) fail(`${target} image name is not a canonical OCI repository name`);
  if (!SHA256.test(digest)) fail(`${target} image digest must be lowercase sha256:<64 hex>`);
  if (!SHA256.test(sbomDigest)) fail(`${target} SBOM digest must be lowercase sha256:<64 hex>`);
  if (!PLATFORM.test(platform)) fail(`${target} image platform is unsupported`);
  return {
    name,
    digest,
    sbomDigest,
    reference: `${name}@${digest}`,
    target,
    platform,
  };
}

function digestReference(value, label) {
  const reference = exactString(value, label);
  const marker = reference.lastIndexOf("@");
  const name = reference.slice(0, marker);
  const digest = reference.slice(marker + 1);
  if (marker < 1 || !OCI_NAME.test(name) || !SHA256.test(digest)) {
    fail(`${label} must be a canonical OCI repository@sha256:<64 hex> reference`);
  }
  return reference;
}

function createFactorySandboxReleaseManifestForSchema(input, schema) {
  const repository = exactString(input.repository, "source.repository");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    fail("source.repository must be owner/repository");
  }
  const commit = exactString(input.commit, "source.commit");
  if (!GIT_SHA.test(commit)) fail("source.commit must be a lowercase 40-character git SHA");
  const releaseTag = exactString(input.releaseTag, "source.releaseTag");
  if (!RELEASE_TAG.test(releaseTag)) fail("source.releaseTag must be a semantic vX.Y.Z tag");
  const sourceRef = `refs/tags/${releaseTag}`;
  const signerWorkflow = `${repository}/.github/workflows/release.yml`;
  const platform = input.platform || "linux/amd64";
  const baseImage = digestReference(input.baseImage, "baseImage");
  const control = imageRecord({
    name: exactString(input.controlName, "images.control.name"),
    digest: exactString(input.controlDigest, "images.control.digest"),
    sbomDigest: exactString(input.controlSbomDigest, "images.control.sbomDigest"),
    target: "sandbox-control",
    platform,
  });
  const workload = imageRecord({
    name: exactString(input.workloadName, "images.workload.name"),
    digest: exactString(input.workloadDigest, "images.workload.digest"),
    sbomDigest: exactString(input.workloadSbomDigest, "images.workload.sbomDigest"),
    target: "sandbox-workload",
    platform,
  });
  const gateway = imageRecord({
    name: exactString(input.gatewayName, "images.gateway.name"),
    digest: exactString(input.gatewayDigest, "images.gateway.digest"),
    sbomDigest: exactString(input.gatewaySbomDigest, "images.gateway.sbomDigest"),
    target: "sandbox-broker-gateway",
    platform,
  });
  const candidate = imageRecord({
    name: exactString(input.candidateName, "images.candidate.name"),
    digest: exactString(input.candidateDigest, "images.candidate.digest"),
    sbomDigest: exactString(input.candidateSbomDigest, "images.candidate.sbomDigest"),
    target: "codeact-candidate",
    platform,
  });
  const executor = schema === FACTORY_SANDBOX_RELEASE_SCHEMA
    ? imageRecord({
      name: exactString(input.executorName, "images.executor.name"),
      digest: exactString(input.executorDigest, "images.executor.digest"),
      sbomDigest: exactString(input.executorSbomDigest, "images.executor.sbomDigest"),
      target: "production-codeact-executor",
      platform,
    })
    : undefined;
  const images = executor
    ? { control, workload, gateway, candidate, executor }
    : { control, workload, gateway, candidate };
  const names = Object.values(images).map((image) => image.name);
  if (new Set(names).size !== names.length) {
    fail("each first-party execution image must use a distinct OCI repository");
  }
  return {
    schema,
    source: { repository, commit, releaseTag, sourceRef, signerWorkflow },
    runnerBuildId: commit,
    baseImage,
    images,
    requiredAttestations: {
      provenancePredicateType: "https://slsa.dev/provenance/v1",
      sbomPredicateType: "https://spdx.dev/Document/v2.3",
    },
  };
}

export function createFactorySandboxReleaseManifest(input) {
  return createFactorySandboxReleaseManifestForSchema(
    input,
    FACTORY_SANDBOX_RELEASE_SCHEMA,
  );
}

export function validateFactorySandboxReleaseManifest(value) {
  const root = exactObject(value, "manifest", [
    "schema",
    "source",
    "runnerBuildId",
    "baseImage",
    "images",
    "requiredAttestations",
  ]);
  if (
    root.schema !== FACTORY_SANDBOX_RELEASE_SCHEMA
    && root.schema !== FACTORY_SANDBOX_LEGACY_RELEASE_SCHEMA
  ) {
    fail("schema is unsupported");
  }
  const source = exactObject(root.source, "source", [
    "repository",
    "commit",
    "releaseTag",
    "sourceRef",
    "signerWorkflow",
  ]);
  const images = exactObject(
    root.images,
    "images",
    root.schema === FACTORY_SANDBOX_RELEASE_SCHEMA
      ? ["control", "workload", "gateway", "candidate", "executor"]
      : ["control", "workload", "gateway", "candidate"],
  );
  const requiredAttestations = exactObject(
    root.requiredAttestations,
    "requiredAttestations",
    ["provenancePredicateType", "sbomPredicateType"],
  );
  const recreated = createFactorySandboxReleaseManifestForSchema({
    repository: source.repository,
    commit: source.commit,
    releaseTag: source.releaseTag,
    baseImage: root.baseImage,
    platform: images.control?.platform,
    controlName: images.control?.name,
    controlDigest: images.control?.digest,
    controlSbomDigest: images.control?.sbomDigest,
    workloadName: images.workload?.name,
    workloadDigest: images.workload?.digest,
    workloadSbomDigest: images.workload?.sbomDigest,
    gatewayName: images.gateway?.name,
    gatewayDigest: images.gateway?.digest,
    gatewaySbomDigest: images.gateway?.sbomDigest,
    candidateName: images.candidate?.name,
    candidateDigest: images.candidate?.digest,
    candidateSbomDigest: images.candidate?.sbomDigest,
    executorName: images.executor?.name,
    executorDigest: images.executor?.digest,
    executorSbomDigest: images.executor?.sbomDigest,
  }, root.schema);
  if (JSON.stringify(root) !== JSON.stringify(recreated)) {
    fail("content is not canonical or contains inconsistent derived fields");
  }
  if (
    requiredAttestations.provenancePredicateType !== "https://slsa.dev/provenance/v1"
    || requiredAttestations.sbomPredicateType !== "https://spdx.dev/Document/v2.3"
  ) {
    fail("required attestation predicate types were weakened");
  }
  return recreated;
}

export function factorySandboxDeploymentEnv(manifest) {
  const value = validateFactorySandboxReleaseManifest(manifest);
  const lines = [
    `FACTORY_SANDBOX_CONTROL_IMAGE=${value.images.control.reference}`,
    `FACTORY_SANDBOX_WORKLOAD_IMAGE=${value.images.workload.reference}`,
    `FACTORY_SANDBOX_GATEWAY_IMAGE=${value.images.gateway.reference}`,
    `FACTORY_CODEACT_CANDIDATE_IMAGE=${value.images.candidate.reference}`,
    `FACTORY_CODEACT_ALLOWED_IMAGE_DIGESTS=${JSON.stringify([value.images.candidate.reference])}`,
    "FACTORY_EXEC_GENERATED=1",
    "FACTORY_SANDBOX_CONTROL_PULL_POLICY=never",
    "FACTORY_SANDBOX_WORKLOAD_PULL_POLICY=never",
    `FACTORY_SB_RUNNER_BUILD_ID=${value.runnerBuildId}`,
    `FACTORY_SB_RUNTIME_IMAGE_DIGEST=${value.images.workload.digest}`,
    `FACTORY_SB_ALLOWED_BUILD_IDS=${JSON.stringify([value.runnerBuildId])}`,
    `FACTORY_SB_ALLOWED_IMAGE_DIGESTS=${JSON.stringify([value.images.workload.digest])}`,
    `EXTERNAL_SANDBOX_CONTROL_IMAGE=${value.images.control.reference}`,
    `EXTERNAL_SANDBOX_WORKLOAD_IMAGE=${value.images.workload.reference}`,
    `EXTERNAL_SANDBOX_GATEWAY_IMAGE=${value.images.gateway.reference}`,
    `EXTERNAL_SANDBOX_CANDIDATE_IMAGE=${value.images.candidate.reference}`,
    `EXTERNAL_SANDBOX_CANDIDATE_IMAGE_ALLOWLIST=${JSON.stringify([value.images.candidate.reference])}`,
    `EXTERNAL_SANDBOX_RUNNER_BUILD_ID=${value.runnerBuildId}`,
    `EXTERNAL_SANDBOX_RUNTIME_IMAGE_DIGEST=${value.images.workload.digest}`,
  ];
  if (value.images.executor) {
    lines.push(`PRODUCTION_CODEACT_EXECUTOR_IMAGE=${value.images.executor.reference}`);
  } else {
    // v3 remains verifiable for already-published sandbox-only bundles. It can
    // never silently choose a production executor; production Compose will
    // continue to fail closed on its required executor image variable.
    lines.push("# legacy v3 sandbox-only bundle: PRODUCTION_CODEACT_EXECUTOR_IMAGE is intentionally absent");
  }
  lines.push("");
  return lines.join("\n");
}

function writeOutput(file, value) {
  const resolved = path.resolve(file);
  const temporary = `${resolved}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, value, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    renameSync(temporary, resolved);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

function main(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;
  const args = parseArgs(rest);
  if (command === "create") {
    const manifest = createFactorySandboxReleaseManifest({
      repository: required(args, "--repository"),
      commit: required(args, "--commit"),
      releaseTag: required(args, "--release-tag"),
      baseImage: required(args, "--base-image"),
      platform: args.get("--platform") || "linux/amd64",
      controlName: required(args, "--control-name"),
      controlDigest: required(args, "--control-digest"),
      controlSbomDigest: required(args, "--control-sbom-digest"),
      workloadName: required(args, "--workload-name"),
      workloadDigest: required(args, "--workload-digest"),
      workloadSbomDigest: required(args, "--workload-sbom-digest"),
      gatewayName: required(args, "--gateway-name"),
      gatewayDigest: required(args, "--gateway-digest"),
      gatewaySbomDigest: required(args, "--gateway-sbom-digest"),
      candidateName: required(args, "--candidate-name"),
      candidateDigest: required(args, "--candidate-digest"),
      candidateSbomDigest: required(args, "--candidate-sbom-digest"),
      executorName: required(args, "--executor-name"),
      executorDigest: required(args, "--executor-digest"),
      executorSbomDigest: required(args, "--executor-sbom-digest"),
    });
    const json = `${JSON.stringify(manifest, null, 2)}\n`;
    const output = args.get("--output");
    if (output) writeOutput(output, json);
    else process.stdout.write(json);
    return;
  }
  if (command === "verify" || command === "env") {
    const file = required(args, "--manifest");
    const manifest = validateFactorySandboxReleaseManifest(
      JSON.parse(readFileSync(path.resolve(file), "utf8")),
    );
    const expectedRepository = args.get("--expected-repository");
    const expectedCommit = args.get("--expected-commit");
    const expectedRef = args.get("--expected-ref");
    if (expectedRepository && manifest.source.repository !== expectedRepository) {
      fail("source.repository does not match the deployment policy");
    }
    if (expectedCommit && manifest.source.commit !== expectedCommit) {
      fail("source.commit does not match the deployment policy");
    }
    if (expectedRef && manifest.source.sourceRef !== expectedRef) {
      fail("source.sourceRef does not match the deployment policy");
    }
    if (command === "env") {
      const env = factorySandboxDeploymentEnv(manifest);
      const output = args.get("--output");
      if (output) writeOutput(output, env);
      else process.stdout.write(env);
    } else {
      process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
    }
    return;
  }
  fail("usage: create|verify|env [options]");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${String(error?.message ?? error)}\n`);
    process.exitCode = 1;
  }
}
