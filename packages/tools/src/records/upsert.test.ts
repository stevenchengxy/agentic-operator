import { describe, expect, it } from "vitest";
import {
  canonicalizeRecordSnapshot,
  deriveRecordKey,
  parseRecordType,
  recordsUpsert,
  RECORDS_UPSERT_PROBE_SAFETY,
} from "./upsert";

describe("records.upsert identity validation", () => {
  it("requires a supported record_type", () => {
    expect(() => parseRecordType(undefined)).toThrow(/record_type is required/);
    expect(() => parseRecordType("record")).toThrow(/unsupported record_type/);
    expect(parseRecordType("candidate")).toBe("candidate");
  });

  it("never invents snapshot-hash identities for durable business records", () => {
    expect(() => deriveRecordKey("candidate", { name: "No ID" }, "", {})).toThrow(/requires/);
    expect(() => deriveRecordKey("resume", { text: "resume" }, "", {})).toThrow(/requires/);
    expect(() => deriveRecordKey("job_posting", { title: "job" }, "", {})).toThrow(/requires/);
    expect(() =>
      deriveRecordKey("candidate_match_result", { candidate_id: "cand-1" }, "cand-1", {}),
    ).toThrow(/both/);
    expect(() =>
      deriveRecordKey("candidate_identity_result", { candidate_id: "cand-1" }, "cand-1", {}),
    ).toThrow(/candidate_id and resume_id/);
  });

  it("uses real identifiers and permits generated IDs only for communication logs", () => {
    expect(deriveRecordKey("candidate", { candidate_id: "cand-1" }, "cand-1", {})).toBe("cand-1");
    expect(deriveRecordKey("resume", { resume_id: "res-1" }, "", {})).toBe("res-1");
    expect(deriveRecordKey("job_posting", { requisition_id: "job-1" }, "", {})).toBe("job-1");
    expect(deriveRecordKey("candidate_match_result", { requisition_id: "job-1" }, "cand-1", {})).toBe("cand-1:job-1");
    expect(
      deriveRecordKey(
        "candidate_identity_result",
        { candidate_identity_result_id: "identity-1" },
        "cand-1",
        {},
      ),
    ).toBe("identity-1");
    expect(
      deriveRecordKey(
        "candidate_identity_result",
        { resume_id: "res-1" },
        "cand-1",
        {},
      ),
    ).toBe("cand-1:res-1");
    expect(deriveRecordKey("communication_log", {}, "", {})).toMatch(/^rec-/);
  });

  it("materializes the composite identity as Candidate_Identity_Result's primary key", () => {
    expect(
      canonicalizeRecordSnapshot(
        "candidate_identity_result",
        { candidate_id: "cand-1", resume_id: "res-1", same_person: false },
        "cand-1:res-1",
      ),
    ).toMatchObject({
      candidate_identity_result_id: "cand-1:res-1",
      candidate_id: "cand-1",
      resume_id: "res-1",
      same_person: false,
    });
    expect(
      canonicalizeRecordSnapshot(
        "candidate_identity_result",
        { candidate_identity_result_id: "identity-explicit" },
        "identity-explicit",
      ),
    ).toEqual({ candidate_identity_result_id: "identity-explicit" });
  });

  it("owns a complete lifecycle and rejects a spoofed probe context before database access", async () => {
    expect(recordsUpsert.factoryWriteProbeLifecycle?.identity).toEqual({
      id: "records.upsert/write-probe",
      revision: "1",
    });
    expect(RECORDS_UPSERT_PROBE_SAFETY).toMatchObject({
      testDataContract: { marker: { path: "_agent_factory_probe.marker" } },
      idempotency: { path: "_agent_factory_probe.idempotency_key" },
      isolation: {
        namespace: { path: "_agent_factory_probe.namespace" },
        target: { path: "_agent_factory_probe.target" },
      },
      cleanup: { handler: "records.upsert.canary.cleanup" },
      absenceProof: { handler: "records.upsert.canary.readback" },
    });
    await expect(recordsUpsert.handler({
      agentName: "agent-factory-probe",
      actionName: "records.upsert",
      correlationId: "business-correlation",
      tenantSlug: "real-tenant",
      event: {
        name: "probe:records.upsert",
        data: {
          _agent_factory_probe: {
            marker: `af-records-marker-${"a".repeat(24)}`,
            namespace: `af-records-namespace-${"a".repeat(24)}`,
            target: `af-records-target-${"a".repeat(24)}`,
            idempotency_key: `af-records-idempotency-${"a".repeat(64)}`,
          },
        },
      },
      config: { record_type: "candidate" },
    })).rejects.toThrow(/untrusted Agent Factory probe execution context/);
  });
});
