import { describe, it, expect } from "vitest";
import { assembleEmitPayload, rehydratePayload, extractBusinessFields, isBlobRef, type BlobRef } from "@agentic/runtime";

// #COMMS — the inter-agent message envelope. Proves: (1) carry-forward prevents data loss (a field
// that arrived in the trigger but the final step didn't echo survives), (2) the two entry shapes
// (external top-level / legacy under last_result) are unified, (3) oversized fields offload to a
// content-addressed BlobRef and rehydrate back, (4) provenance + back-compat last_result are kept.

const META = { subject: "req-1", correlationId: "cid-1", causationId: "evt-src", producedBy: "MatchResume", sourceRun: "run-9" };

describe("#COMMS assembleEmitPayload — carry-forward prevents data loss", () => {
  it("carries forward an incoming field the final step forgot to echo", () => {
    const r = assembleEmitPayload({
      incoming: { candidate_id: "c1", jd: "jd-text", subject: "req-1" }, // subject is meta, not business
      lastResult: { passed: true }, // final step only returned a verdict — candidate_id would be LOST today
      meta: META,
    });
    expect(r.payload.candidate_id).toBe("c1"); // preserved!
    expect(r.payload.jd).toBe("jd-text");
    expect(r.payload.passed).toBe(true);
    expect(r.carried).toEqual(expect.arrayContaining(["candidate_id", "jd"]));
    expect(r.carried).not.toContain("subject"); // meta isn't a business field
  });

  it("the producer's output OVERRIDES a carried-forward field of the same name", () => {
    const r = assembleEmitPayload({ incoming: { score: 1 }, lastResult: { score: 2 }, meta: META });
    expect(r.payload.score).toBe(2);
    expect(r.carried).not.toContain("score");
  });

  it("unifies the LEGACY shape (business fields under last_result) to top level", () => {
    const r = assembleEmitPayload({
      incoming: { source_agent: "ParseResume", last_result: { candidate_id: "c1", profile: { name: "X" } } },
      lastResult: { matched: true },
      meta: META,
    });
    expect(r.payload.candidate_id).toBe("c1"); // lifted out of the upstream last_result wrapper
    expect(r.payload.matched).toBe(true);
    expect(r.carried).toContain("candidate_id");
  });

  it("keeps last_result (back-compat) and stamps _meta provenance", () => {
    const r = assembleEmitPayload({ incoming: { a: 1 }, lastResult: { b: 2 }, meta: META });
    expect(r.payload.last_result).toEqual({ b: 2 }); // legacy consumers still work
    expect(r.payload.source_agent).toBe("MatchResume");
    expect(r.payload._meta).toMatchObject({ causationId: "evt-src", producedBy: "MatchResume", correlationId: "cid-1" });
  });

  it("reports declared contract fields that are missing (a data gap, not silent undefined)", () => {
    const r = assembleEmitPayload({
      incoming: { candidate_id: "c1" },
      lastResult: { passed: true },
      meta: META,
      contractFields: ["candidate_id", "job_requisition_id"], // JR id is nowhere → gap
    });
    expect(r.missing).toEqual(["job_requisition_id"]);
  });
});

describe("#COMMS blob offload + rehydrate — prevents context bloat", () => {
  const bigPdf = "JVBERi0x" + "A".repeat(50_000); // ~50KB base64 blob
  // A test offloader: offload any string value over 8KB to a fake content-addressed ref.
  const store = new Map<string, string>();
  const offload = (path: string, value: unknown): BlobRef | null => {
    if (typeof value === "string" && value.length > 8_000) {
      const hash = `h${value.length}_${value.slice(0, 4)}`; // deterministic fake hash (no Date/random)
      store.set(hash, value);
      return { __ref: "blob", hash, bytes: value.length, contentType: "text/plain", preview: value.slice(0, 16) };
    }
    return null;
  };

  it("offloads an oversized field to a BlobRef, leaving small fields inline", () => {
    const r = assembleEmitPayload({ incoming: { candidate_id: "c1", resume_pdf: bigPdf }, lastResult: { parsed: true }, meta: META, offload });
    expect(r.payload.candidate_id).toBe("c1"); // small stays inline
    expect(isBlobRef(r.payload.resume_pdf)).toBe(true);
    expect((r.payload.resume_pdf as BlobRef).bytes).toBe(bigPdf.length);
    expect(r.offloaded).toContain("resume_pdf");
    // the serialized wire payload is now tiny, not 50KB
    expect(JSON.stringify(r.payload).length).toBeLessThan(2_000);
  });

  it("rehydrates a BlobRef back to the real value via a resolver", () => {
    const r = assembleEmitPayload({ incoming: { resume_pdf: bigPdf }, lastResult: {}, meta: META, offload });
    const rehydrated = rehydratePayload(r.payload, (ref) => store.get(ref.hash) ?? null);
    expect(rehydrated.resume_pdf).toBe(bigPdf);
  });

  it("also offloads oversized fields inside the kept last_result (content-addressed dedup)", () => {
    const r = assembleEmitPayload({ incoming: {}, lastResult: { resume_pdf: bigPdf }, meta: META, offload });
    const lr = r.payload.last_result as Record<string, unknown>;
    expect(isBlobRef(lr.resume_pdf)).toBe(true);
    // same bytes at top-level and under last_result → same hash (single stored copy)
    expect((lr.resume_pdf as BlobRef).hash).toBe((r.payload.resume_pdf as BlobRef).hash);
  });
});

describe("#COMMS extractBusinessFields — strips meta, unifies shapes", () => {
  it("drops meta/wrapper keys and __-prefixed keys", () => {
    const b = extractBusinessFields({ candidate_id: "c1", subject: "s", source_agent: "A", __triggerEventId: "e", _meta: {} });
    expect(b).toEqual({ candidate_id: "c1" });
  });
});
