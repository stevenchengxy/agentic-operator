import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { healthRoute } from "../src/routes/health";
import {
  expectedProductionImages,
  productionImageAttestationKeyId,
  signFactoryProductionImageAttestation,
  verifyProductionImageObservation,
} from "../src/services/agent-factory/production-image-attestation";

const image = (digit: string) => `sha256:${digit.repeat(64)}`;
let root = "";

describe("production image trust readiness", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify();
    await app.register(healthRoute);
    await app.ready();
  });

  afterAll(async () => app.close());

  afterEach(() => {
    vi.unstubAllEnvs();
    if (root) rmSync(root, { recursive: true, force: true });
    root = "";
  });

  it("returns health 503 after the last host-signed image proof expires", async () => {
    const values = {
      NODE_ENV: "production",
      FACTORY_PRODUCTION_IMAGE_ATTESTATION_TOPOLOGY: "single_host_compose",
      AGENTIC_BUILD_ID: "health-build-1",
      AGENTIC_API_IMAGE: image("1"),
      AGENTIC_WEB_IMAGE: image("2"),
      FACTORY_SANDBOX_CONTROL_IMAGE: image("3"),
      FACTORY_SANDBOX_WORKLOAD_IMAGE: image("4"),
      FACTORY_SANDBOX_GATEWAY_IMAGE: image("5"),
      PRODUCTION_CODEACT_EXECUTOR_IMAGE: image("6"),
      FACTORY_SB_RUNTIME_IMAGE_DIGEST: image("4"),
      FACTORY_SB_ALLOWED_BUILD_IDS: JSON.stringify(["health-build-1"]),
      FACTORY_SB_ALLOWED_IMAGE_DIGESTS: JSON.stringify([image("4")]),
      FACTORY_CODEACT_ALLOWED_IMAGE_DIGESTS: "",
      PRODUCTION_CODEACT_ALLOWED_CANDIDATE_REFS: JSON.stringify([image("7")]),
      PRODUCTION_CODEACT_ALLOWED_CANDIDATE_IMAGE_IDS: JSON.stringify([image("7")]),
      FACTORY_PRODUCTION_IMAGE_ATTESTATION_TTL_MS: "10000",
    };
    const expected = expectedProductionImages(values);
    const keys = generateKeyPairSync("ed25519");
    const attestationBody = verifyProductionImageObservation({
      expected,
      keyId: productionImageAttestationKeyId(keys.publicKey),
      containers: expected.services.map((row, index) => ({
        service: row.service,
        containerId: `health-container-${index}`,
        configImage: row.imageId,
        imageId: row.imageId,
        status: "running",
        health: "healthy",
        buildId: expected.buildId,
        role: row.role,
      })),
      candidate: { imageId: expected.candidateImageId, buildId: expected.buildId, role: "codeact-candidate" },
      now: new Date(0),
      ttlMs: 10_000,
    });
    const attestation = signFactoryProductionImageAttestation(attestationBody, keys.privateKey);
    root = mkdtempSync(path.join(tmpdir(), "factory-production-health-"));
    const attestationFile = path.join(root, "attestation.json");
    const publicKeyFile = path.join(root, "public.pem");
    writeFileSync(attestationFile, JSON.stringify(attestation));
    writeFileSync(publicKeyFile, keys.publicKey.export({ type: "spki", format: "pem" }));
    for (const [name, value] of Object.entries({
      ...values,
      FACTORY_PRODUCTION_IMAGE_ATTESTATION_FILE: attestationFile,
      FACTORY_PRODUCTION_IMAGE_ATTESTATION_PUBLIC_KEY_FILE: publicKeyFile,
    })) vi.stubEnv(name, value);

    const live = await app.inject({ method: "GET", url: "/live" });
    expect(live.statusCode).toBe(200);
    expect(live.json()).toMatchObject({
      schema: "agentic-api-liveness/v1",
      live: true,
    });

    const response = await app.inject({ method: "GET", url: "/health" });
    const body = response.json() as {
      ok?: unknown;
      productionImageTrust?: { ok?: unknown; state?: unknown; note?: unknown };
    };

    expect(response.statusCode).toBe(503);
    expect(body.ok).toBe(false);
    expect(body.productionImageTrust).toMatchObject({
      ok: false,
      state: "blocked",
    });
    expect(typeof body.productionImageTrust?.note).toBe("string");
    expect(body.productionImageTrust?.note).toContain("expired");
  });
});
