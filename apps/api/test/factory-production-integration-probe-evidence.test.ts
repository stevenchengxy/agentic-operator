import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  probeDefinitionHash,
  type GeneratedAgentSpec,
  type RealTool,
} from "@agentic/agent-factory";
import { makeToolCassetteEntry } from "@agentic/shared/cassette";

const receiptState = vi.hoisted(() => ({ rows: [] as Array<Record<string, unknown>> }));

vi.mock("../src/services/agent-factory/tool-probe-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/agent-factory/tool-probe-store")>();
  return {
    ...actual,
    listGlobalToolProbeReceipts: () => receiptState.rows,
  };
});

import {
  attestLiveProbeCassette,
} from "../src/services/agent-factory/cassette-evidence-attestation";
import {
  verifyProductionIntegrationProbeEvidence,
} from "../src/services/agent-factory/production-integration-probe-gate";
import {
  UNVERIFIED_WRITE_PROBE_IDEMPOTENCY_HASH,
} from "../src/services/agent-factory/integration-probe";

const roots: string[] = [];
const env = {
  PRODUCTION_VENDOR_KEY: "production-secret",
};
const productionConfig = {
  base_url: "https://api.vendor.example",
  api_key_env: "PRODUCTION_VENDOR_KEY",
};

function baseTool(): RealTool {
  return {
    name: "vendor.send",
    summary: "Send to vendor",
    sideEffect: "write",
    operation: "write",
    effectScope: "external",
    sandboxPolicy: "requires_attempt_grant",
    capabilities: [],
    catalogDefinition: {
      name: "vendor.send",
      category: "vendor",
      sourcePath: "vendor/send.ts",
      sourceIdentity: { buildId: "build-1", handlerSha256: "a".repeat(64) },
      sideEffect: "write",
      operation: "write",
      effectScope: "external",
      sandboxPolicy: "requires_attempt_grant",
      configSchema: {
        base_url: { type: "string", required: true },
        api_key_env: { type: "string", required: true },
      },
      returnsSchema: {
        ok: { type: "boolean", required: true },
      },
    },
  };
}

function productionSpec(): GeneratedAgentSpec {
  return {
    key: "send",
    actionName: "send",
    slug: "send-agent",
    short: "SendAgent",
    domainId: "Agents-generation",
    nameZh: "发送",
    kind: "llm",
    trigger: ["READY"],
    emit: ["SENT"],
    tools: ["vendor.send"],
    toolConfigs: { "vendor.send": productionConfig },
    toolPolicies: {
      "vendor.send": {
        operation: "write",
        effectScope: "external",
        sandboxPolicy: "requires_attempt_grant",
      },
    },
    toolSideEffects: { "vendor.send": "write" },
    unresolvedTools: [],
    objects: [],
    systemPrompt: "发送",
    userPrompt: "",
    steps: [],
    ruleRefs: [],
    retries: 1,
    hitl: false,
    confidence: 1,
    promptSource: "llm",
  } as GeneratedAgentSpec;
}

async function installReceipt(input: {
  proofHashes?: string;
  idempotencyHash?: string;
  status?: number;
  body?: unknown;
} = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "factory-production-probe-gate-"));
  roots.push(root);
  const tool = baseTool();
  const definitionHash = probeDefinitionHash(tool, productionConfig, env)!;
  const hash = input.proofHashes ?? "b".repeat(64);
  const document = attestLiveProbeCassette({
    version: 1,
    tool: { name: tool.name, definitionHash },
    evidence: {
      recordedAt: new Date().toISOString(),
      mode: "live-probe",
      writeProbe: {
        schema: "agent-factory-write-probe/v1",
        markerHash: hash,
        namespaceHash: hash,
        targetHash: hash,
        idempotencyKeyHash: input.idempotencyHash ?? hash,
        create: { completed: true },
        cleanup: { completed: true },
        absence: { verified: true },
      },
    },
    entries: [makeToolCassetteEntry({
      toolName: tool.name,
      args: { marker: "redacted" },
      status: input.status ?? 200,
      body: input.body ?? { ok: true },
      recordedAt: new Date().toISOString(),
    })],
  }, {
    tenantId: "ten-production-probe",
    tenantSlug: "production-probe",
    domainId: "Agents-generation",
    toolName: tool.name,
    definitionHash,
    config: productionConfig,
    actor: "usr-production-prober",
  }, { dataRoot: root });
  const cassettePath = path.join(root, "factory-cassettes", "vendor-send.json");
  await fs.mkdir(path.dirname(cassettePath), { recursive: true });
  await fs.writeFile(cassettePath, JSON.stringify(document), "utf8");
  receiptState.rows = [{
    toolName: tool.name,
    status: "verified",
    definitionHash,
    evidence: {
      evidenceMode: "live-probe",
      cassettePath,
      attestationKeyId: document.evidence!.attestation!.keyId,
      attestationExpiresAt: document.evidence!.attestation!.expiresAt,
    },
    verifiedAt: new Date().toISOString(),
  }];
  return {
    root,
    cassettePath,
    document,
    tool: { ...tool, productionVerifiedDefinitionHashes: [definitionHash] },
  };
}

afterEach(async () => {
  receiptState.rows = [];
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("production integration probe durable evidence", () => {
  it("HMAC-verifies the exact current production config and rejects byte tampering", async () => {
    const installed = await installReceipt();
    const input = {
      tenantId: "ten-production-probe",
      tenantSlug: "production-probe",
      domainId: "Agents-generation",
      specs: [productionSpec()],
      tools: [installed.tool],
      env,
      dataRoot: installed.root,
    };
    await expect(verifyProductionIntegrationProbeEvidence(input)).resolves.toEqual([]);

    await fs.writeFile(installed.cassettePath, JSON.stringify({
      ...installed.document,
      entries: installed.document.entries.map((entry) => ({
        ...entry,
        response: { ...entry.response, body: { ok: false } },
      })),
    }), "utf8");
    await expect(verifyProductionIntegrationProbeEvidence(input)).resolves.toEqual([
      expect.objectContaining({ code: "production_cassette_invalid", tool: "vendor.send" }),
    ]);

    const outside = path.join(installed.root, "valid-but-outside-evidence-volume.json");
    await fs.writeFile(outside, JSON.stringify(installed.document), "utf8");
    await fs.rm(installed.cassettePath);
    await fs.symlink(outside, installed.cassettePath);
    await expect(verifyProductionIntegrationProbeEvidence(input)).resolves.toEqual([
      expect.objectContaining({ code: "production_cassette_invalid", tool: "vendor.send" }),
    ]);
  });

  it("rejects collision-prone legacy write hashes at the production boundary", async () => {
    const installed = await installReceipt({ proofHashes: "deadbeef" });
    await expect(verifyProductionIntegrationProbeEvidence({
      tenantId: "ten-production-probe",
      tenantSlug: "production-probe",
      domainId: "Agents-generation",
      specs: [productionSpec()],
      tools: [installed.tool],
      env,
      dataRoot: installed.root,
    })).resolves.toEqual([
      expect.objectContaining({
        code: "production_write_probe_incomplete",
        tool: "vendor.send",
      }),
    ]);
  });

  it("re-derives success instead of trusting a corrupted verified-row status", async () => {
    const installed = await installReceipt({ status: 500, body: { ok: false } });
    await expect(verifyProductionIntegrationProbeEvidence({
      tenantId: "ten-production-probe",
      tenantSlug: "production-probe",
      domainId: "Agents-generation",
      specs: [productionSpec()],
      tools: [installed.tool],
      env,
      dataRoot: installed.root,
    })).resolves.toEqual([
      expect.objectContaining({ code: "production_cassette_invalid", tool: "vendor.send" }),
    ]);
  });

  it("revalidates the HMAC-covered response against the current return schema", async () => {
    const installed = await installReceipt({ body: { wrong: true } });
    await expect(verifyProductionIntegrationProbeEvidence({
      tenantId: "ten-production-probe",
      tenantSlug: "production-probe",
      domainId: "Agents-generation",
      specs: [productionSpec()],
      tools: [installed.tool],
      env,
      dataRoot: installed.root,
    })).resolves.toEqual([
      expect.objectContaining({ code: "production_cassette_invalid", tool: "vendor.send" }),
    ]);
  });

  it("rejects the signed sentinel used when idempotency was not verified", async () => {
    const installed = await installReceipt({
      idempotencyHash: UNVERIFIED_WRITE_PROBE_IDEMPOTENCY_HASH,
    });
    await expect(verifyProductionIntegrationProbeEvidence({
      tenantId: "ten-production-probe",
      tenantSlug: "production-probe",
      domainId: "Agents-generation",
      specs: [productionSpec()],
      tools: [installed.tool],
      env,
      dataRoot: installed.root,
    })).resolves.toEqual([
      expect.objectContaining({ code: "production_write_probe_incomplete", tool: "vendor.send" }),
    ]);
  });
});
