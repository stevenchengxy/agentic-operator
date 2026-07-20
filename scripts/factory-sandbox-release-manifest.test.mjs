import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  FACTORY_SANDBOX_LEGACY_RELEASE_SCHEMA,
  createFactorySandboxReleaseManifest,
  factorySandboxDeploymentEnv,
  validateFactorySandboxReleaseManifest,
} from "./factory-sandbox-release-manifest.mjs";

const commit = "a".repeat(40);
const controlDigest = `sha256:${"b".repeat(64)}`;
const workloadDigest = `sha256:${"c".repeat(64)}`;
const controlSbomDigest = `sha256:${"d".repeat(64)}`;
const workloadSbomDigest = `sha256:${"e".repeat(64)}`;
const gatewayDigest = `sha256:${"3".repeat(64)}`;
const gatewaySbomDigest = `sha256:${"4".repeat(64)}`;
const candidateDigest = `sha256:${"1".repeat(64)}`;
const candidateSbomDigest = `sha256:${"2".repeat(64)}`;
const executorDigest = `sha256:${"5".repeat(64)}`;
const executorSbomDigest = `sha256:${"6".repeat(64)}`;
const baseImage = `docker.io/library/node@sha256:${"f".repeat(64)}`;

function manifest() {
  return createFactorySandboxReleaseManifest({
    repository: "example/agentic-operator",
    commit,
    releaseTag: "v1.2.3",
    baseImage,
    platform: "linux/amd64",
    controlName: "ghcr.io/example/agentic-sandbox-control",
    controlDigest,
    controlSbomDigest,
    workloadName: "ghcr.io/example/agentic-sandbox-workload",
    workloadDigest,
    workloadSbomDigest,
    gatewayName: "ghcr.io/example/agentic-sandbox-gateway",
    gatewayDigest,
    gatewaySbomDigest,
    candidateName: "ghcr.io/example/agentic-codeact-candidate",
    candidateDigest,
    candidateSbomDigest,
    executorName: "ghcr.io/example/agentic-production-codeact-executor",
    executorDigest,
    executorSbomDigest,
  });
}

test("creates canonical digest-only image references and exact deployment allowlists", () => {
  const value = manifest();
  assert.equal(
    value.images.control.reference,
    `ghcr.io/example/agentic-sandbox-control@${controlDigest}`,
  );
  assert.equal(value.source.sourceRef, "refs/tags/v1.2.3");
  assert.equal(value.runnerBuildId, commit);
  assert.equal(
    value.images.gateway.reference,
    `ghcr.io/example/agentic-sandbox-gateway@${gatewayDigest}`,
  );
  assert.equal(
    value.images.candidate.reference,
    `ghcr.io/example/agentic-codeact-candidate@${candidateDigest}`,
  );
  assert.equal(
    value.images.executor.reference,
    `ghcr.io/example/agentic-production-codeact-executor@${executorDigest}`,
  );
  const env = factorySandboxDeploymentEnv(value);
  assert.match(env, new RegExp(`FACTORY_SB_RUNTIME_IMAGE_DIGEST=${workloadDigest}`));
  assert.match(
    env,
    new RegExp(`FACTORY_CODEACT_CANDIDATE_IMAGE=ghcr.io/example/agentic-codeact-candidate@${candidateDigest}`),
  );
  assert.match(env, /FACTORY_CODEACT_ALLOWED_IMAGE_DIGESTS=\["ghcr\.io\/example\/agentic-codeact-candidate@sha256:/);
  assert.match(env, /FACTORY_EXEC_GENERATED=1/);
  assert.match(env, /FACTORY_SANDBOX_CONTROL_PULL_POLICY=never/);
  assert.match(env, /FACTORY_SANDBOX_GATEWAY_IMAGE=ghcr\.io\/example\/agentic-sandbox-gateway@sha256:/);
  assert.match(env, /EXTERNAL_SANDBOX_CONTROL_IMAGE=ghcr\.io\/example\/agentic-sandbox-control@sha256:/);
  assert.match(env, /EXTERNAL_SANDBOX_GATEWAY_IMAGE=ghcr\.io\/example\/agentic-sandbox-gateway@sha256:/);
  assert.match(env, /EXTERNAL_SANDBOX_CANDIDATE_IMAGE_ALLOWLIST=\["ghcr\.io\/example\/agentic-codeact-candidate@sha256:/);
  assert.match(env, /PRODUCTION_CODEACT_EXECUTOR_IMAGE=ghcr\.io\/example\/agentic-production-codeact-executor@sha256:/);
  assert.doesNotMatch(env, /:latest/);
});

test("rejects tags, uppercase/short digests and inconsistent derived references", () => {
  assert.throws(
    () => createFactorySandboxReleaseManifest({
      ...manifestInput(),
      workloadDigest: "sha256:ABC",
    }),
    /lowercase sha256/,
  );
  const changed = structuredClone(manifest());
  changed.images.workload.reference = `${changed.images.workload.name}:latest`;
  assert.throws(
    () => validateFactorySandboxReleaseManifest(changed),
    /not canonical|inconsistent/,
  );
});

test("CLI verification binds repository, source SHA and ref before writing env", () => {
  const root = mkdtempSync(path.join(tmpdir(), "factory-sandbox-release-"));
  try {
    const manifestFile = path.join(root, "release.json");
    const envFile = path.join(root, "release.env");
    const created = spawnSync(process.execPath, [
      path.resolve("scripts/factory-sandbox-release-manifest.mjs"),
      "create",
      "--repository", "example/agentic-operator",
      "--commit", commit,
      "--release-tag", "v1.2.3",
      "--base-image", baseImage,
      "--control-name", "ghcr.io/example/agentic-sandbox-control",
      "--control-digest", controlDigest,
      "--control-sbom-digest", controlSbomDigest,
      "--workload-name", "ghcr.io/example/agentic-sandbox-workload",
      "--workload-digest", workloadDigest,
      "--workload-sbom-digest", workloadSbomDigest,
      "--gateway-name", "ghcr.io/example/agentic-sandbox-gateway",
      "--gateway-digest", gatewayDigest,
      "--gateway-sbom-digest", gatewaySbomDigest,
      "--candidate-name", "ghcr.io/example/agentic-codeact-candidate",
      "--candidate-digest", candidateDigest,
      "--candidate-sbom-digest", candidateSbomDigest,
      "--executor-name", "ghcr.io/example/agentic-production-codeact-executor",
      "--executor-digest", executorDigest,
      "--executor-sbom-digest", executorSbomDigest,
      "--output", manifestFile,
    ], { encoding: "utf8" });
    assert.equal(created.status, 0, created.stderr);
    const verified = spawnSync(process.execPath, [
      path.resolve("scripts/factory-sandbox-release-manifest.mjs"),
      "env",
      "--manifest", manifestFile,
      "--expected-repository", "example/agentic-operator",
      "--expected-commit", commit,
      "--expected-ref", "refs/tags/v1.2.3",
      "--output", envFile,
    ], { encoding: "utf8" });
    assert.equal(verified.status, 0, verified.stderr);
    const deploymentEnv = readFileSync(envFile, "utf8");
    assert.match(deploymentEnv, /FACTORY_SANDBOX_WORKLOAD_IMAGE=.*@sha256:/);
    assert.match(deploymentEnv, /FACTORY_SANDBOX_GATEWAY_IMAGE=.*@sha256:/);
    assert.match(deploymentEnv, /EXTERNAL_SANDBOX_WORKLOAD_IMAGE=.*@sha256:/);
    assert.match(deploymentEnv, /FACTORY_CODEACT_CANDIDATE_IMAGE=.*@sha256:/);
    assert.match(deploymentEnv, /PRODUCTION_CODEACT_EXECUTOR_IMAGE=.*@sha256:/);

    const rejected = spawnSync(process.execPath, [
      path.resolve("scripts/factory-sandbox-release-manifest.mjs"),
      "verify",
      "--manifest", manifestFile,
      "--expected-commit", "d".repeat(40),
    ], { encoding: "utf8" });
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /does not match the deployment policy/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("release workflow builds all five first-party execution roles and cryptographically attests provenance and SBOM", () => {
  const workflow = readFileSync(".github/workflows/release.yml", "utf8");
  for (const required of [
    "target: sandbox-control",
    "target: sandbox-workload",
    "target: sandbox-broker-gateway",
    "target: codeact-candidate",
    "target: production-codeact-executor",
    "provenance: mode=max",
    "sbom: true",
    "actions/attest@",
    "sbom-path:",
    "gh attestation verify",
    "https://spdx.dev/Document/v2.3",
    "factory-sandbox-release-manifest.mjs",
    "NODE_BASE_IMAGE=${{ env.SANDBOX_NODE_BASE_IMAGE }}",
    "release_sha\" != \"$GITHUB_SHA",
    "anchore/scan-action@",
    "severity-cutoff: critical",
    "executor.spdx.json",
    "executor.vulnerabilities.json",
    "attest-executor-provenance",
    "attest-executor-sbom",
    "--executor-name",
    "--executor-digest",
    "--executor-sbom-digest",
    "Verify published production executor role and source labels",
  ]) {
    assert.match(workflow, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.doesNotMatch(workflow, /agentic-(?:sandbox-(?:control|workload)|codeact-candidate|production-codeact-executor):latest/);
  for (const line of workflow.split("\n")) {
    const action = line.match(/^\s*-?\s*uses:\s+([^\s#]+)/)?.[1];
    if (action) assert.match(action, /@[a-f0-9]{40}$/, `release action is not SHA-pinned: ${action}`);
  }
});

test("CI smoke-builds the production executor and checks immutable source/role labels and SPDX", () => {
  const workflow = readFileSync(".github/workflows/ci.yml", "utf8");
  const dockerfile = readFileSync("apps/api/Dockerfile", "utf8");
  for (const required of [
    "target: production-codeact-executor",
    "tags: agentic-production-codeact-executor:ci",
    "io.agentic.sandbox.role",
    "org.opencontainers.image.revision",
    "org.opencontainers.image.source",
    "executor.spdx.json",
    "executor.vulnerabilities.json",
    "severity-cutoff: critical",
  ]) {
    assert.match(workflow, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(
    dockerfile,
    /FROM sandbox-common AS production-codeact-executor[\s\S]+io\.agentic\.sandbox\.role=production-codeact-executor/,
  );
  assert.match(
    dockerfile,
    /FROM sandbox-common AS production-codeact-executor[\s\S]+org\.opencontainers\.image\.source=\$AGENTIC_SOURCE_REPOSITORY/,
  );
});

test("offline verifier requires executor evidence for v4 but keeps explicit v3 sandbox-only support", () => {
  const verifier = readFileSync("scripts/verify-factory-sandbox-supply-chain.sh", "utf8");
  assert.match(verifier, /agent-factory-sandbox-image-release\/v4/);
  assert.match(verifier, /agent-factory-sandbox-image-release\/v3/);
  assert.match(verifier, /executor\.provenance\.sigstore\.json/);
  assert.match(verifier, /executor\.sbom\.sigstore\.json/);
  assert.match(verifier, /actual_executor_sbom/);
});

test("legacy v3 manifests remain verifiable as sandbox-only and never invent an executor", () => {
  const legacy = structuredClone(manifest());
  legacy.schema = FACTORY_SANDBOX_LEGACY_RELEASE_SCHEMA;
  delete legacy.images.executor;
  const verified = validateFactorySandboxReleaseManifest(legacy);
  assert.equal(verified.schema, FACTORY_SANDBOX_LEGACY_RELEASE_SCHEMA);
  assert.equal(verified.images.executor, undefined);
  const env = factorySandboxDeploymentEnv(verified);
  assert.doesNotMatch(env, /^PRODUCTION_CODEACT_EXECUTOR_IMAGE=/m);
  assert.match(env, /legacy v3 sandbox-only bundle/);
});

function manifestInput() {
  return {
    repository: "example/agentic-operator",
    commit,
    releaseTag: "v1.2.3",
    baseImage,
    platform: "linux/amd64",
    controlName: "ghcr.io/example/agentic-sandbox-control",
    controlDigest,
    controlSbomDigest,
    workloadName: "ghcr.io/example/agentic-sandbox-workload",
    workloadDigest,
    workloadSbomDigest,
    gatewayName: "ghcr.io/example/agentic-sandbox-gateway",
    gatewayDigest,
    gatewaySbomDigest,
    candidateName: "ghcr.io/example/agentic-codeact-candidate",
    candidateDigest,
    candidateSbomDigest,
    executorName: "ghcr.io/example/agentic-production-codeact-executor",
    executorDigest,
    executorSbomDigest,
  };
}
