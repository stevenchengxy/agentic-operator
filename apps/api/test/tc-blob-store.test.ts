import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { putBlob, getBlob, resolveBlobRef, makeBlobOffloader, blobDir } from "@agentic/runtime";
import { assembleEmitPayload, rehydratePayload } from "@agentic/runtime";

// #COMMS — content-addressed blob store: dedup by sha256, round-trip, and end-to-end offload+rehydrate
// through the real store (not a fake).

let dir: string;
let prev: string | undefined;

beforeAll(() => {
  prev = process.env.AGENTIC_BLOB_DIR;
  dir = mkdtempSync(path.join(tmpdir(), "blobstore-"));
  process.env.AGENTIC_BLOB_DIR = dir;
});
afterAll(() => {
  if (prev === undefined) delete process.env.AGENTIC_BLOB_DIR;
  else process.env.AGENTIC_BLOB_DIR = prev;
  rmSync(dir, { recursive: true, force: true });
});

function countFiles(root: string): number {
  let n = 0;
  for (const shard of readdirSync(root, { withFileTypes: true })) {
    if (shard.isDirectory()) n += readdirSync(path.join(root, shard.name)).length;
  }
  return n;
}

describe("#COMMS blob-store — content addressing + dedup", () => {
  it("blobDir honors AGENTIC_BLOB_DIR", () => {
    expect(blobDir()).toBe(dir);
  });

  it("same bytes → same hash, stored ONCE (dedup)", () => {
    const bytes = "X".repeat(20_000);
    const a = putBlob(bytes);
    const b = putBlob(bytes);
    expect(a.hash).toBe(b.hash);
    expect(a.bytes).toBe(20_000);
    expect(countFiles(dir)).toBe(1); // one physical file despite two puts
  });

  it("round-trips via getBlob / resolveBlobRef, missing → null", () => {
    const ref = putBlob("hello world blob");
    expect(getBlob(ref.hash)).toBe("hello world blob");
    expect(resolveBlobRef(ref)).toBe("hello world blob");
    expect(getBlob("deadbeef")).toBeNull();
  });

  it("different bytes → different hash + separate files", () => {
    const before = countFiles(dir);
    putBlob("A".repeat(20_001));
    putBlob("B".repeat(20_001));
    expect(countFiles(dir)).toBe(before + 2);
  });
});

describe("#COMMS offloader threshold + end-to-end through the real store", () => {
  it("makeBlobOffloader only offloads strings over the threshold", () => {
    const off = makeBlobOffloader({ thresholdBytes: 100 });
    expect(off("a", "short")).toBeNull(); // small string
    expect(off("b", 42)).toBeNull(); // number
    expect(off("c", { nested: true })).toBeNull(); // object stays inline
    const ref = off("d", "Z".repeat(200));
    expect(ref?.__ref).toBe("blob");
  });

  it("assemble → offload to real store → rehydrate restores the exact bytes", () => {
    const bigPdf = "JVBERi0x" + "Q".repeat(40_000);
    const offload = makeBlobOffloader({ thresholdBytes: 8_192 });
    const asm = assembleEmitPayload({
      incoming: { candidate_id: "c1", resume_pdf: bigPdf },
      lastResult: { parsed: true },
      meta: { subject: "s", producedBy: "ParseResume" },
      offload,
    });
    // wire payload is tiny (blob is a ref, not inline)
    expect(JSON.stringify(asm.payload).length).toBeLessThan(2_000);
    const rehydrated = rehydratePayload(asm.payload, (ref) => resolveBlobRef(ref));
    expect(rehydrated.resume_pdf).toBe(bigPdf);
    expect(rehydrated.candidate_id).toBe("c1");
  });

  // CROWN PROOF — the exact data-plane register.ts now implements: rehydrate-on-consume →
  // carry-forward+offload-on-emit, chained across TWO agent hops. A business field and a large blob
  // must survive both hops with NO data loss and NO context bloat (blob stored once across all hops).
  it("business field + blob survive a 2-hop agent chain (no loss, no bloat, dedup)", () => {
    const bigPdf = "JVBERi0x" + "Z".repeat(45_000);
    const offload = makeBlobOffloader({ thresholdBytes: 8_192 });
    const filesBefore = countFiles(dir);

    // Hop 0 → Agent A (ParseResume). External trigger: fields at top level, blob inline.
    const triggerData = { candidate_id: "c1", resume_pdf: bigPdf, subject: "req-1" };
    const aIncoming = rehydratePayload(triggerData, (ref) => resolveBlobRef(ref)); // no refs yet → passthrough
    // A's final step returns only a verdict — candidate_id + resume_pdf would be LOST pre-fix.
    const aEmit = assembleEmitPayload({
      incoming: aIncoming,
      lastResult: { parsed: true },
      meta: { subject: "req-1", producedBy: "ParseResume", correlationId: "cid", causationId: "evt-0" },
      offload,
    });
    expect(aEmit.carried).toEqual(expect.arrayContaining(["candidate_id", "resume_pdf"]));
    expect(aEmit.offloaded).toContain("resume_pdf");
    expect(JSON.stringify(aEmit.payload).length).toBeLessThan(2_000); // wire stayed small across the hop

    // Hop 1 → Agent B (MatchResume) receives A's emitted payload as its event.data.
    const bIncoming = rehydratePayload(aEmit.payload, (ref) => resolveBlobRef(ref));
    expect(bIncoming.candidate_id).toBe("c1"); // survived hop 1
    expect(bIncoming.resume_pdf).toBe(bigPdf); // blob rehydrated to the REAL bytes for B's handler
    // B's final step returns a score — again does NOT echo candidate_id/resume_pdf.
    const bEmit = assembleEmitPayload({
      incoming: bIncoming,
      lastResult: { matched: true, score: 0.91 },
      meta: { subject: "req-1", producedBy: "MatchResume", correlationId: "cid", causationId: "evt-1" },
      offload,
    });
    // candidate_id survived TWO hops without any agent explicitly forwarding it.
    expect(bEmit.payload.candidate_id).toBe("c1");
    expect(bEmit.payload.matched).toBe(true);
    expect(bEmit.payload.score).toBe(0.91);
    // blob re-offloaded to the SAME content hash → stored exactly once across both hops (dedup).
    const aRef = aEmit.payload.resume_pdf as { hash: string };
    const bRef = bEmit.payload.resume_pdf as { hash: string };
    expect(bRef.hash).toBe(aRef.hash);
    expect(countFiles(dir)).toBe(filesBefore + 1); // one physical blob for the whole chain
  });
});
