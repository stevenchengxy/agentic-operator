import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { factoryToolProbes, getDb, tenants } from "@agentic/db";
import {
  findVerifiedToolProbeReceipt,
  listGlobalToolProbeReceipts,
  saveGlobalToolProbeReceipt,
  summarizeGlobalToolProbeReceipts,
} from "../src/services/agent-factory/tool-probe-store";
import { makeFactoryPorts } from "../src/services/agent-factory";
import { currentFactoryExecutionTools } from "../src/services/agent-factory/execution-resource-snapshot";

const suffix = randomUUID();
const tenantId = `ten-tool-probe-${suffix}`;
const tenantSlug = `tool-probe-${suffix}`;
const domain = "RAAS-v1";
const toolName = "ontology.writeInstance";
const firstHash = "a".repeat(64);
const secondHash = "b".repeat(64);
const liveHash = "c".repeat(64);

function replayEvidence(label: string) {
  return {
    config: label,
    evidenceMode: "signed-fixture" as const,
    attestationKeyId: "factory-api-v1",
    attestationExpiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
  };
}

describe("global tool probe receipt store", () => {
  beforeAll(() => {
    getDb().insert(tenants).values({ id: tenantId, slug: tenantSlug, name: "Tool probe test" }).run();
  });

  afterAll(() => {
    getDb().delete(factoryToolProbes).where(eq(factoryToolProbes.tenantId, tenantId)).run();
    getDb().delete(tenants).where(eq(tenants.id, tenantId)).run();
  });

  it("retains independent receipts for two definition/config hashes", () => {
    saveGlobalToolProbeReceipt(tenantId, domain, {
      toolName,
      status: "verified",
      definitionHash: firstHash,
      schemaHash: "schema-a",
      evidence: replayEvidence("candidate"),
      verifiedAt: "2026-07-13T01:00:00.000Z",
    });
    saveGlobalToolProbeReceipt(tenantId, domain, {
      toolName,
      status: "verified",
      definitionHash: secondHash,
      schemaHash: "schema-b",
      evidence: replayEvidence("job"),
      verifiedAt: "2026-07-13T02:00:00.000Z",
    });

    const receipts = listGlobalToolProbeReceipts(tenantId, domain);
    expect(receipts).toHaveLength(2);
    expect(receipts.map((receipt) => receipt.definitionHash).sort()).toEqual([firstHash, secondHash]);
    expect(summarizeGlobalToolProbeReceipts(receipts)).toMatchObject({
      status: "verified",
      definitionHash: secondHash,
      verifiedDefinitionHashes: [firstHash, secondHash],
      evidence: { config: "job" },
    });

    saveGlobalToolProbeReceipt(tenantId, domain, {
      toolName,
      status: "failed",
      definitionHash: firstHash,
      schemaHash: "schema-a-changed",
      evidence: { config: "candidate", failure: true },
    });
    const updated = listGlobalToolProbeReceipts(tenantId, domain);
    expect(updated).toHaveLength(2);
    expect(updated.find((receipt) => receipt.definitionHash === firstHash)?.status).toBe("failed");
    expect(summarizeGlobalToolProbeReceipts(updated)?.verifiedDefinitionHashes).toEqual([secondHash]);
  });

  it("does not let a signed fixture replace live promotion evidence for the same exact hash", async () => {
    const verifiedAt = new Date().toISOString();
    const attestationExpiresAt = new Date(Date.now() + 60 * 60_000).toISOString();
    saveGlobalToolProbeReceipt(tenantId, domain, {
      toolName,
      status: "verified",
      definitionHash: liveHash,
      evidence: {
        evidenceMode: "live-probe",
        cassettePath: "/evidence/live.json",
        attestationKeyId: "factory-api-v1",
        attestationExpiresAt,
      },
      verifiedAt,
    });
    saveGlobalToolProbeReceipt(tenantId, domain, {
      toolName,
      status: "verified",
      definitionHash: liveHash,
      evidence: {
        evidenceMode: "signed-fixture",
        cassettePath: "/evidence/fixture.json",
        attestationKeyId: "factory-api-v1",
        attestationExpiresAt,
      },
      verifiedAt: new Date(Date.now() + 1_000).toISOString(),
    });

    const receipts = listGlobalToolProbeReceipts(tenantId, domain);
    const exact = findVerifiedToolProbeReceipt(receipts, {
      toolName,
      definitionHash: liveHash,
      productionOnly: true,
    });
    expect(exact?.evidence).toMatchObject({
      evidenceMode: "live-probe",
      cassettePath: "/evidence/live.json",
    });
    expect(summarizeGlobalToolProbeReceipts(receipts))
      .toMatchObject({ productionVerifiedDefinitionHashes: [liveHash] });
    expect(findVerifiedToolProbeReceipt(receipts, {
      toolName,
      definitionHash: "d".repeat(64),
    })).toBeUndefined();
    const global = (await makeFactoryPorts(tenantSlug, tenantId, domain)
      .toolRegistry!.list()).find((tool) => tool.name === toolName);
    expect(global).toMatchObject({
      verifiedDefinitionHashes: [secondHash, liveHash].sort(),
      productionVerifiedDefinitionHashes: [liveHash],
      probeEvidenceMode: "live-probe",
    });
    expect((await currentFactoryExecutionTools({
      tenantId,
      tenantSlug,
      domainId: domain,
    })).find((tool) => tool.name === toolName)).toMatchObject({
      verifiedDefinitionHashes: [secondHash, liveHash].sort(),
      productionVerifiedDefinitionHashes: [liveHash],
      probeEvidenceMode: "live-probe",
    });
  });

  it("excludes unattested and expired receipts from sandbox-ready hashes", () => {
    const isolatedTool = `${toolName}.stale`;
    const unattestedHash = "e".repeat(64);
    const expiredHash = "f".repeat(64);
    saveGlobalToolProbeReceipt(tenantId, domain, {
      toolName: isolatedTool,
      status: "verified",
      definitionHash: unattestedHash,
      evidence: { evidenceMode: "signed-fixture", cassettePath: "/untrusted.json" },
      verifiedAt: new Date().toISOString(),
    });
    saveGlobalToolProbeReceipt(tenantId, domain, {
      toolName: isolatedTool,
      status: "verified",
      definitionHash: expiredHash,
      evidence: {
        evidenceMode: "live-probe",
        cassettePath: "/expired.json",
        attestationKeyId: "factory-api-v1",
        attestationExpiresAt: new Date(Date.now() - 1_000).toISOString(),
      },
      verifiedAt: new Date(Date.now() - 2_000).toISOString(),
    });
    const receipts = listGlobalToolProbeReceipts(tenantId, domain)
      .filter((receipt) => receipt.toolName === isolatedTool);
    expect(summarizeGlobalToolProbeReceipts(receipts)).toMatchObject({
      status: "required",
      verifiedDefinitionHashes: [],
      productionVerifiedDefinitionHashes: [],
    });
    expect(findVerifiedToolProbeReceipt(receipts, {
      toolName: isolatedTool,
      definitionHash: unattestedHash,
    })).toBeUndefined();
    expect(findVerifiedToolProbeReceipt(receipts, {
      toolName: isolatedTool,
      definitionHash: expiredHash,
    })).toBeUndefined();
  });
});
