import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { businessRecords, getDb, tenants } from "@agentic/db";
import { prepareWriteProbeCanary } from "@agentic/shared";
import {
  BUSINESS_RECORD_TYPES,
  RECORDS_UPSERT_PROBE_SAFETY,
} from "@agentic/tools/records";
import { globalToolRegistry, listGlobalTools } from "@agentic/tools";
import {
  integrationProbeScope,
  probeGlobalIntegration,
} from "../src/services/agent-factory/integration-probe";
import { registryWriteProbeLifecycleProvider } from "../src/services/agent-factory/write-probe-lifecycle-provider";

const descriptor = globalToolRegistry.get("records.upsert");
const catalog = listGlobalTools().find((tool) => tool.name === "records.upsert");
if (!descriptor || !catalog || !descriptor.factoryWriteProbeLifecycle) {
  throw new Error("records.upsert write-probe wiring is missing");
}

const syntheticState = () => ({
  tenantIds: getDb().select({ id: tenants.id }).from(tenants).all()
    .filter((row) => row.id.startsWith("ten-af-records-"))
    .map((row) => row.id).sort(),
  recordIds: getDb().select({ id: businessRecords.id }).from(businessRecords).all()
    .filter((row) => row.id.startsWith("rec-af-"))
    .map((row) => row.id).sort(),
});

describe("records.upsert code-owned write probe", () => {
  it("resolves the exact callback only through the trusted global registry identity", () => {
    expect(registryWriteProbeLifecycleProvider.resolve({
      source: "global_registry",
      descriptor,
      catalogSourceIdentity: catalog.sourceIdentity,
    })).toBe(descriptor.factoryWriteProbeLifecycle);
    expect(() => registryWriteProbeLifecycleProvider.resolve({
      source: "global_registry",
      descriptor,
      catalogSourceIdentity: {
        ...catalog.sourceIdentity,
        writeProbeLifecycle: {
          ...(catalog.sourceIdentity?.writeProbeLifecycle as Record<string, unknown>),
          revision: "tampered",
        },
      },
    })).toThrow(/does not match/);
  });

  it.each(BUSINESS_RECORD_TYPES)(
    "creates, exactly cleans, and proves absence for %s (including append config)",
    async (recordType) => {
      const before = syntheticState();
      const seed = createHash("sha256").update(`records-upsert:${recordType}`).digest("hex");
      const result = await probeGlobalIntegration({
        catalog,
        descriptor,
        args: {},
        config: { record_type: recordType, append: true },
        tenantSlug: integrationProbeScope({
          tenantId: "ten-records-probe-test",
          domainId: "Agents-generation",
        }),
        authorization: { actor: "test-reviewer", allowSideEffects: true },
        canarySeed: seed,
        writeProbeLifecycle: descriptor.factoryWriteProbeLifecycle,
        persistCassette: false,
      });

      expect(result).toMatchObject({
        verified: true,
        classification: "verified",
        writeProbeProof: {
          create: { completed: true },
          cleanup: { completed: true },
          absence: { verified: true },
        },
      });
      expect(syntheticState()).toEqual(before);
      const serialized = JSON.stringify(result.cassette);
      expect(serialized).not.toContain(`af-records-target-${seed.slice(0, 24)}`);
      expect(serialized).not.toContain(`af-records-idempotency-${seed}`);
    },
  );

  it("refuses a lifecycle argument mismatch and preserves the row until exact cleanup", async () => {
    const seed = "c".repeat(64);
    const prepared = prepareWriteProbeCanary({
      args: {},
      contract: RECORDS_UPSERT_PROBE_SAFETY,
      seed,
    });
    if (!prepared.ok) throw new Error(prepared.reason);
    const execution = {
      agentName: "agent-factory-probe" as const,
      actionName: "records.upsert",
      correlationId: `probe:${"d".repeat(12)}`,
      tenantSlug: `af-probe-${"e".repeat(24)}`,
      eventName: "probe:records.upsert",
    };
    const before = syntheticState();
    const created = await descriptor.handler({
      ...execution,
      event: { name: execution.eventName, data: prepared.canary.args },
      config: { record_type: "candidate", append: true },
    });
    const lifecycleInput = {
      toolName: "records.upsert",
      args: prepared.canary.args,
      config: { record_type: "candidate", append: true },
      contract: RECORDS_UPSERT_PROBE_SAFETY,
      canary: prepared.canary,
      execution,
      createResult: created.data,
    };
    expect(syntheticState().recordIds.length).toBe(before.recordIds.length + 1);

    await expect(descriptor.factoryWriteProbeLifecycle!.cleanup({
      ...lifecycleInput,
      args: {
        ...prepared.canary.args,
        _agent_factory_probe: {
          ...(prepared.canary.args._agent_factory_probe as Record<string, unknown>),
          marker: `af-records-marker-${"f".repeat(24)}`,
        },
      },
    })).rejects.toThrow(/does not match prepared probe arguments|invalid or non-isolated/);
    expect(syntheticState().recordIds.length).toBe(before.recordIds.length + 1);

    await expect(descriptor.factoryWriteProbeLifecycle!.cleanup(lifecycleInput))
      .resolves.toMatchObject({ completed: true });
    await expect(descriptor.factoryWriteProbeLifecycle!.readback(lifecycleInput))
      .resolves.toMatchObject({ absent: true });
    expect(syntheticState()).toEqual(before);
  });
});
