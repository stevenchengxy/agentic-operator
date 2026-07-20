import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  assertFactoryProductionImageAttestation,
  assertFactoryProductionImageTrustReady,
  expectedProductionImages,
  productionImageAttestationKeyId,
  signFactoryProductionImageAttestation,
  verifyProductionImageObservation,
} from "../src/services/agent-factory/production-image-attestation";
import {
  verifyProductionImagesOnce,
  watchProductionImageAttestations,
} from "../scripts/verify-factory-production-images";

const roots: string[] = [];
const image = (digit: string) => `sha256:${digit.repeat(64)}`;
const productionEnv = () => ({
  NODE_ENV: "production",
  FACTORY_PRODUCTION_IMAGE_ATTESTATION_TOPOLOGY: "single_host_compose",
  AGENTIC_BUILD_ID: "local-build-1",
  AGENTIC_API_IMAGE: image("1"),
  AGENTIC_WEB_IMAGE: image("2"),
  FACTORY_SANDBOX_CONTROL_IMAGE: image("3"),
  FACTORY_SANDBOX_WORKLOAD_IMAGE: image("4"),
  FACTORY_SANDBOX_GATEWAY_IMAGE: image("5"),
  PRODUCTION_CODEACT_EXECUTOR_IMAGE: image("6"),
  FACTORY_SB_RUNTIME_IMAGE_DIGEST: image("4"),
  FACTORY_SB_ALLOWED_BUILD_IDS: JSON.stringify(["local-build-1"]),
  FACTORY_SB_ALLOWED_IMAGE_DIGESTS: JSON.stringify([image("4")]),
  FACTORY_CODEACT_ALLOWED_IMAGE_DIGESTS: "",
  PRODUCTION_CODEACT_ALLOWED_CANDIDATE_REFS: JSON.stringify([image("7")]),
  PRODUCTION_CODEACT_ALLOWED_CANDIDATE_IMAGE_IDS: JSON.stringify([image("7")]),
  FACTORY_PRODUCTION_IMAGE_ATTESTATION_TTL_MS: "60000",
});
const externalProductionEnv = () => ({
  ...productionEnv(),
  FACTORY_PRODUCTION_IMAGE_ATTESTATION_TOPOLOGY: "external_sandbox",
  FACTORY_SB_RUNTIME_IMAGE_DIGEST: image("8"),
  FACTORY_SB_ALLOWED_BUILD_IDS: JSON.stringify(["remote-runner-build-9"]),
  FACTORY_SB_ALLOWED_IMAGE_DIGESTS: JSON.stringify([image("8")]),
});

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function signedFixture(
  now = new Date(0),
  env: Record<string, string> = productionEnv(),
) {
  const keys = generateKeyPairSync("ed25519");
  const expected = expectedProductionImages(env);
  const body = verifyProductionImageObservation({
    expected,
    keyId: productionImageAttestationKeyId(keys.publicKey),
    containers: expected.services.map((row, index) => ({
      service: row.service,
      containerId: `container-${index}`,
      configImage: row.imageId,
      imageId: row.imageId,
      status: "running",
      health: "healthy",
      buildId: expected.buildId,
      role: row.role,
    })),
    candidate: {
      imageId: expected.candidateImageId,
      buildId: expected.buildId,
      role: "codeact-candidate",
    },
    now,
    ttlMs: 60_000,
  });
  return {
    keys,
    expected,
    body,
    attestation: signFactoryProductionImageAttestation(body, keys.privateKey),
  };
}

describe("production image Ed25519 trust root", () => {
  it("accepts only an untampered, unexpired document from the configured key", () => {
    const fixture = signedFixture();
    expect(() => assertFactoryProductionImageAttestation(
      fixture.attestation,
      fixture.expected,
      { publicKey: fixture.keys.publicKey, now: new Date(1_000), maxTtlMs: 60_000 },
    )).not.toThrow();

    const tampered = {
      ...fixture.attestation,
      services: fixture.attestation.services.map((row, index) =>
        index === 0 ? { ...row, imageId: image("8") } : row),
    };
    expect(() => assertFactoryProductionImageAttestation(
      tampered,
      fixture.expected,
      { publicKey: fixture.keys.publicKey, now: new Date(1_000), maxTtlMs: 60_000 },
    )).toThrow(/hash is invalid|signature is invalid/);

    expect(() => assertFactoryProductionImageAttestation(
      fixture.attestation,
      fixture.expected,
      { publicKey: fixture.keys.publicKey, now: new Date(60_000), maxTtlMs: 60_000 },
    )).toThrow(/stale or expired/);

    const wrong = generateKeyPairSync("ed25519");
    expect(() => assertFactoryProductionImageAttestation(
      fixture.attestation,
      fixture.expected,
      { publicKey: wrong.publicKey, now: new Date(1_000), maxTtlMs: 60_000 },
    )).toThrow(/key id is not trusted/);
  });

  it("takes the candidate identity from the exact environment singleton, never from signed content", () => {
    const fixture = signedFixture();
    const maliciousBody = {
      ...fixture.body,
      candidate: { ...fixture.body.candidate, imageId: image("8") },
    };
    const malicious = signFactoryProductionImageAttestation(maliciousBody, fixture.keys.privateKey);
    expect(() => assertFactoryProductionImageAttestation(
      malicious,
      fixture.expected,
      { publicKey: fixture.keys.publicKey, now: new Date(1_000), maxTtlMs: 60_000 },
    )).toThrow(/production candidate image attestation is invalid/);

    expect(() => expectedProductionImages({
      ...productionEnv(),
      PRODUCTION_CODEACT_ALLOWED_CANDIDATE_IMAGE_IDS: JSON.stringify([image("7"), image("8")]),
    })).toThrow(/exactly one expected identity/);
  });

  it("verifies the API file boundary using only the public key", () => {
    const fixture = signedFixture();
    const root = mkdtempSync(path.join(tmpdir(), "factory-image-attestation-"));
    roots.push(root);
    const attestationFile = path.join(root, "attestation.json");
    const publicKeyFile = path.join(root, "public.pem");
    writeFileSync(attestationFile, JSON.stringify(fixture.attestation));
    writeFileSync(publicKeyFile, fixture.keys.publicKey.export({ type: "spki", format: "pem" }));

    const status = assertFactoryProductionImageTrustReady({
      env: {
        ...productionEnv(),
        FACTORY_PRODUCTION_IMAGE_ATTESTATION_FILE: attestationFile,
        FACTORY_PRODUCTION_IMAGE_ATTESTATION_PUBLIC_KEY_FILE: publicKeyFile,
      },
      now: new Date(1_000),
    });
    expect(status).toMatchObject({
      configured: true,
      ok: true,
      state: "ready",
      candidateImageId: image("7"),
      keyId: productionImageAttestationKeyId(fixture.keys.publicKey),
    });
  });

  it("attests only local control services for external_sandbox and requires it for promotion", () => {
    const env = externalProductionEnv();
    const fixture = signedFixture(new Date(0), env);
    expect(fixture.expected.services.map((row) => row.service)).toEqual([
      "api",
      "web",
      "codeact-executor",
    ]);
    const root = mkdtempSync(path.join(tmpdir(), "factory-external-image-attestation-"));
    roots.push(root);
    const attestationFile = path.join(root, "attestation.json");
    const publicKeyFile = path.join(root, "public.pem");
    writeFileSync(attestationFile, JSON.stringify(fixture.attestation));
    writeFileSync(publicKeyFile, fixture.keys.publicKey.export({ type: "spki", format: "pem" }));

    expect(assertFactoryProductionImageTrustReady({
      env: {
        ...env,
        FACTORY_PRODUCTION_IMAGE_ATTESTATION_FILE: attestationFile,
        FACTORY_PRODUCTION_IMAGE_ATTESTATION_PUBLIC_KEY_FILE: publicKeyFile,
      },
      now: new Date(1_000),
      requiredTopology: "external_sandbox",
    })).toMatchObject({
      ok: true,
      topology: "external_sandbox",
      diagnosticOnly: false,
    });

    expect(() => expectedProductionImages({
      ...env,
      FACTORY_SB_ALLOWED_BUILD_IDS: JSON.stringify([
        "remote-runner-build-9",
        "unreviewed-fallback-build",
      ]),
    })).toThrow(/exactly one expected identity/);
  });

  it("never accepts the same-host diagnostic proof where external topology is required", () => {
    const fixture = signedFixture();
    const root = mkdtempSync(path.join(tmpdir(), "factory-diagnostic-image-attestation-"));
    roots.push(root);
    const attestationFile = path.join(root, "attestation.json");
    const publicKeyFile = path.join(root, "public.pem");
    writeFileSync(attestationFile, JSON.stringify(fixture.attestation));
    writeFileSync(publicKeyFile, fixture.keys.publicKey.export({ type: "spki", format: "pem" }));
    expect(() => assertFactoryProductionImageTrustReady({
      env: {
        ...productionEnv(),
        FACTORY_PRODUCTION_IMAGE_ATTESTATION_FILE: attestationFile,
        FACTORY_PRODUCTION_IMAGE_ATTESTATION_PUBLIC_KEY_FILE: publicKeyFile,
      },
      now: new Date(1_000),
      requiredTopology: "external_sandbox",
    })).toThrow(/requires external_sandbox.*diagnostic-only/);
  });

  it("watch runs a complete fresh observation every round and never overwrites evidence after a failed observation", async () => {
    const keys = generateKeyPairSync("ed25519");
    const root = mkdtempSync(path.join(tmpdir(), "factory-image-watch-"));
    roots.push(root);
    const privateKeyFile = path.join(root, "private.pem");
    const publicKeyFile = path.join(root, "public.pem");
    const outputFile = path.join(root, "attestation.json");
    writeFileSync(privateKeyFile, keys.privateKey.export({ type: "pkcs8", format: "pem" }));
    writeFileSync(publicKeyFile, keys.publicKey.export({ type: "spki", format: "pem" }));
    const env = productionEnv();
    const expected = expectedProductionImages(env);
    let observation = 1;
    let inspected = 0;
    const runOnce = (now: Date) => verifyProductionImagesOnce({
      env,
      privateKeyFile,
      publicKeyFile,
      outputFile,
      now,
      inspectService: (_envFile, service) => {
        inspected += 1;
        const row = expected.services.find((entry) => entry.service === service)!;
        return {
          service,
          containerId: `container-${service}-observation-${observation}`,
          configImage: row.imageId,
          imageId: row.imageId,
          status: "running",
          health: "healthy",
          buildId: expected.buildId,
          role: row.role,
        };
      },
      inspectCandidate: () => ({
        imageId: expected.candidateImageId,
        buildId: expected.buildId,
        role: "codeact-candidate",
      }),
    });

    const controller = new AbortController();
    let rounds = 0;
    const hashes: string[] = [];
    await watchProductionImageAttestations({
      signal: controller.signal,
      wait: async () => undefined,
      verifyOnce: () => {
        rounds += 1;
        const result = runOnce(new Date((rounds - 1) * 1_000));
        hashes.push(result.attestation.evidenceHash);
        observation += 1;
        if (rounds === 2) controller.abort();
        return result;
      },
    });
    expect(rounds).toBe(2);
    expect(inspected).toBe(expected.services.length * 2);
    expect(new Set(hashes).size).toBe(2);

    const lastValid = readFileSync(outputFile, "utf8");
    expect(() => verifyProductionImagesOnce({
      env,
      privateKeyFile,
      publicKeyFile,
      outputFile,
      inspectService: () => { throw new Error("docker observation failed"); },
      inspectCandidate: () => ({
        imageId: expected.candidateImageId,
        buildId: expected.buildId,
        role: "codeact-candidate",
      }),
    })).toThrow(/docker observation failed/);
    expect(readFileSync(outputFile, "utf8")).toBe(lastValid);
  });

  it("uses at most one third of the current TTL even when observation fails", async () => {
    const controller = new AbortController();
    const waits: number[] = [];
    const failures: unknown[] = [];
    await watchProductionImageAttestations({
      signal: controller.signal,
      defaultTtlMs: 300_000,
      readTtlMs: () => 12_000,
      verifyOnce: () => { throw new Error("fresh Docker inspect failed"); },
      onFailure: (error) => failures.push(error),
      wait: async (ms) => {
        waits.push(ms);
        controller.abort();
      },
    });
    expect(waits).toEqual([4_000]);
    expect(failures).toHaveLength(1);
  });
});
