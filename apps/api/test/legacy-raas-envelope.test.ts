import { describe, expect, it } from "vitest";
import {
  zhaopinLegacyRaasEventAdapter,
  unwrapLegacyRaasEventData,
  wrapLegacyRaasEventData,
} from "@tenants/zhaopin";

describe("legacy RAAS event envelope", () => {
  it("is explicitly owned by the zhaopin tenant adapter", () => {
    expect(zhaopinLegacyRaasEventAdapter.name).toBe(
      "zhaopin.legacy-raas-v1",
    );
    expect(
      zhaopinLegacyRaasEventAdapter.inbound({
        eventName: "RESUME_DOWNLOADED",
        data: {
          event_id: "evt-owned",
          payload: { upload_id: "upload-owned" },
        },
      }),
    ).toMatchObject({ upload_id: "upload-owned", subject: "upload-owned" });
  });

  it("unwraps the real RESUME_DOWNLOADED envelope used by old RAAS", () => {
    const flat = unwrapLegacyRaasEventData({
      entity_type: "Candidate",
      entity_id: null,
      event_id: "raas-event-1",
      payload: {
        upload_id: "upload-1",
        bucket: "recruit-resume-raw",
        object_key: "2026/04/resume.pdf",
        filename: "resume.pdf",
        employee_id: "EMP-1",
      },
      trace: { trace_id: "trace-1" },
    });

    expect(flat).toMatchObject({
      upload_id: "upload-1",
      bucket: "recruit-resume-raw",
      object_key: "2026/04/resume.pdf",
      filename: "resume.pdf",
      employee_id: "EMP-1",
      subject: "upload-1",
      __correlationId: "trace-1",
      __raas: {
        entity_type: "Candidate",
        event_id: "raas-event-1",
        trace: { trace_id: "trace-1" },
      },
    });
    expect(flat.payload).toBeUndefined();
  });

  it("leaves an ordinary new-runtime payload untouched", () => {
    const value = { payload: { nested_business_value: true }, subject: "s-1" };
    expect(unwrapLegacyRaasEventData(value)).toBe(value);
  });

  it("normalizes old resume filename aliases only at the zhaopin boundary", () => {
    expect(
      zhaopinLegacyRaasEventAdapter.inbound({
        eventName: "zhaopin/RESUME_DOWNLOADED",
        data: { resume_filename: "candidate-a.pdf" },
      }),
    ).toEqual({
      resume_filename: "candidate-a.pdf",
      filename: "candidate-a.pdf",
    });
    expect(
      zhaopinLegacyRaasEventAdapter.inbound({
        eventName: "RESUME_DOWNLOADED",
        data: { resume_file_path: "legacy/inbox/candidate-b.pdf" },
      }),
    ).toEqual({
      resume_file_path: "legacy/inbox/candidate-b.pdf",
      filename: "candidate-b.pdf",
    });

    const unrelated = { resume_file_path: "business/value.txt" };
    expect(
      zhaopinLegacyRaasEventAdapter.inbound({
        eventName: "OTHER_EVENT",
        data: unrelated,
      }),
    ).toBe(unrelated);
  });

  it("wraps output for old RAAS without bypassing the nested payload allow-list", () => {
    const wire = wrapLegacyRaasEventData({
      eventId: "evt-1",
      eventName: "MATCH_PASSED_NO_INTERVIEW",
      subject: "candidate-1",
      correlationId: "trace-1",
      sourceAgent: "matchResume",
      payload: {
        candidate_id: "candidate-1",
        job_requisition_id: "jr-1",
        match_score: 95,
      },
    });

    expect(wire.candidate_id).toBeUndefined();
    expect(wire.match_score).toBeUndefined();
    expect(wire).toMatchObject({
      entity_type: "Candidate",
      entity_id: "candidate-1",
      event_id: "evt-1",
      source_action: "matchResume",
      trace: { trace_id: "trace-1", event_name: "MATCH_PASSED_NO_INTERVIEW" },
      payload: {
        candidate_id: "candidate-1",
        job_requisition_id: "jr-1",
        matching_score: 95,
      },
    });
    expect(
      (wire.payload as Record<string, unknown>).match_score,
    ).toBeUndefined();
  });
});
