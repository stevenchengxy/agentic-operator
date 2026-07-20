import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";

import type { DeclarativeTool } from "@agentic/agent-factory";
import {
  factoryAuthorizationChallenges,
  factoryToolProbes,
  factoryTools,
  getDb,
  tenants,
} from "@agentic/db";
import type { CanonicalCassetteDocument } from "@agentic/shared/cassette";

import { DrizzleFactoryAuthorizationChallengeStore } from "../src/services/agent-factory/authorization-challenge-store";
import {
  cassetteConfigHash,
  verifyCassetteEvidenceAttestation,
} from "../src/services/agent-factory/cassette-evidence-attestation";
import { DrizzleToolStore } from "../src/services/agent-factory/stores";
import {
  listGlobalToolProbeReceipts,
  saveGlobalToolProbeReceipt,
  summarizeGlobalToolProbeReceipts,
} from "../src/services/agent-factory/tool-probe-store";

const suffix = randomUUID();
const tenantId = `ten-signed-fixture-${suffix}`;
const tenantSlug = `signed-fixture-${suffix}`;
const domain = `domain-signed-fixture-${suffix}`;
const toolName = `vendor.fixture-${suffix}`;
const roots: string[] = [];

function tool(description = "Lookup a vendor record"): DeclarativeTool {
  return {
    name: toolName,
    description,
    method: "POST",
    urlTemplate: "https://vendor.invalid/lookup",
    sideEffect: "read",
    operation: "read",
    effectScope: "external",
    sandboxPolicy: "live_external",
    domain,
    paramsSchema: { id: { type: "string", required: true } },
    returnsSchema: { ok: { type: "boolean", required: true } },
    capabilities: [{
      systems: ["Vendor"],
      kinds: ["external_api"],
      roles: ["reads"],
      operations: ["lookup"],
      probeRequired: true,
    }],
    probeStatus: "required",
  };
}

function request() {
  const recordedAt = new Date().toISOString();
  return {
    domain,
    name: toolName,
    config: {},
    exchanges: [{ args: { id: "candidate-1" }, status: 200, body: { ok: true } }],
    recordedAt,
    expiresAt: new Date(Date.parse(recordedAt) + 60 * 60_000).toISOString(),
  };
}

describe("DrizzleToolStore signed fixture lifecycle", () => {
  beforeAll(() => {
    getDb().insert(tenants).values({ id: tenantId, slug: tenantSlug, name: "Signed fixture test" }).run();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  afterAll(() => {
    getDb().delete(factoryAuthorizationChallenges)
      .where(eq(factoryAuthorizationChallenges.tenantId, tenantId)).run();
    getDb().delete(factoryToolProbes)
      .where(eq(factoryToolProbes.tenantId, tenantId)).run();
    getDb().delete(factoryTools)
      .where(and(eq(factoryTools.scopeKey, tenantId), eq(factoryTools.domainKey, domain))).run();
    getDb().delete(tenants).where(eq(tenants.id, tenantId)).run();
  });

  it("signs and persists an exact human-authorized declarative fixture", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "factory-signed-fixture-"));
    roots.push(root);
    vi.stubEnv("AGENTIC_DATA_ROOT", root);
    const store = new DrizzleToolStore(tenantId, domain, tenantSlug);
    await store.save(tool());
    const exactRequest = request();
    const preparation = await store.prepareSignedFixture(exactRequest);
    expect(preparation).toMatchObject({
      subjectDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      definitionHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      schemaHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      configHash: cassetteConfigHash({}),
    });
    // A human may add a sandbox fixture after this exact config already passed
    // a live probe. The fixture must not erase production eligibility.
    saveGlobalToolProbeReceipt(tenantId, domain, {
      toolName,
      status: "verified",
      definitionHash: preparation.definitionHash,
      schemaHash: preparation.schemaHash,
      evidence: {
        evidenceMode: "live-probe",
        cassettePath: "/evidence/existing-live.json",
        attestationKeyId: "factory-api-v1",
        attestationExpiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      },
      verifiedAt: new Date().toISOString(),
    });
    const execution = { runId: `run-${suffix}`, conversationId: `run-${suffix}` };
    const challenges = new DrizzleFactoryAuthorizationChallengeStore(tenantId, domain);
    const challenge = await challenges.issue(domain, {
      kind: "probe",
      subjectDigest: preparation.subjectDigest,
      ...execution,
      question: "是否确认这份精确 sandbox fixture？",
      declineLabel: "不创建",
      confirmLabel: "确认仅用于沙箱",
    });
    const authorization = await challenges.consume(domain, {
      challenge,
      answer: challenge.token,
      actor: "usr-fixture-reviewer",
      question: challenge.question,
      context: challenge.context,
      options: challenge.options,
    });
    const receipt = await store.createSignedFixture({
      ...exactRequest,
      expectedDefinitionHash: preparation.definitionHash,
      expectedSubjectDigest: preparation.subjectDigest,
      authorization,
      execution,
    });
    expect(receipt).toMatchObject({
      verified: true,
      evidenceMode: "signed-fixture",
      confirmedBy: "usr-fixture-reviewer",
      definitionHash: preparation.definitionHash,
    });
    const document = JSON.parse(await readFile(receipt.cassettePath, "utf8")) as CanonicalCassetteDocument;
    expect(verifyCassetteEvidenceAttestation(document, {
      tenantId,
      tenantSlug,
      domainId: domain,
      toolName,
      definitionHash: preparation.definitionHash,
      configHash: preparation.configHash,
      allowedModes: ["signed-fixture"],
    }, { dataRoot: root })).toMatchObject({ valid: true });
    const row = getDb().select().from(factoryTools).where(and(
      eq(factoryTools.scopeKey, tenantId),
      eq(factoryTools.domainKey, domain),
      eq(factoryTools.name, toolName),
    )).all()[0]!;
    expect(row.probeStatus).toBe("verified");
    expect(row.probeEvidence).toMatchObject({
      evidenceMode: "signed-fixture",
      actor: "usr-fixture-reviewer",
      cassettePath: receipt.cassettePath,
    });
    const authoritative = summarizeGlobalToolProbeReceipts(
      listGlobalToolProbeReceipts(tenantId, domain),
    );
    expect(authoritative).toMatchObject({
      productionVerifiedDefinitionHashes: [preparation.definitionHash],
      evidenceMode: "live-probe",
      evidence: { cassettePath: "/evidence/existing-live.json" },
    });
    expect((await store.list(domain))[0]).toMatchObject({
      verifiedDefinitionHashes: [preparation.definitionHash],
      productionVerifiedDefinitionHashes: [preparation.definitionHash],
      probeEvidenceMode: "live-probe",
    });
  });

  it("fails closed when entries or the current declarative definition drift", async () => {
    const store = new DrizzleToolStore(tenantId, domain, tenantSlug);
    await store.save(tool("Definition before review"));
    const exactRequest = request();
    const preparation = await store.prepareSignedFixture(exactRequest);
    await expect(store.createSignedFixture({
      ...exactRequest,
      exchanges: [{ args: { id: "candidate-1" }, status: 200, body: { ok: false } }],
      expectedDefinitionHash: preparation.definitionHash,
      expectedSubjectDigest: preparation.subjectDigest,
      authorization: {} as never,
      execution: { runId: "run", conversationId: "run" },
    })).rejects.toThrow(/definition, config, entries, or expiry changed/);

    await store.save({
      ...tool("Definition changed after review"),
      urlTemplate: "https://vendor.invalid/v2/lookup",
    });
    await expect(store.createSignedFixture({
      ...exactRequest,
      expectedDefinitionHash: preparation.definitionHash,
      expectedSubjectDigest: preparation.subjectDigest,
      authorization: {} as never,
      execution: { runId: "run", conversationId: "run" },
    })).rejects.toThrow(/definition, config, entries, or expiry changed/);
  });

  it("rejects a literal secret at the API boundary before it can be hashed or persisted", async () => {
    const store = new DrizzleToolStore(tenantId, domain, tenantSlug);
    await store.save(tool());
    const exactRequest = request();
    await expect(store.prepareSignedFixture({
      ...exactRequest,
      exchanges: [{
        args: { id: "candidate-1" },
        status: 200,
        body: { ok: true, access_token: "sk-forbidden-12345678" },
      }],
    })).rejects.toThrow(/literal credential/);
  });
});
