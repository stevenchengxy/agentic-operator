import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, appendFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BrainEvent } from "@agentic/agent-factory";
import {
  appendFactoryRunTranscript,
  readFactoryRunTranscript,
  deleteFactoryRunTranscript,
} from "../src/services/agent-factory/factory-run-transcript";
import { structuralProjection } from "../src/services/agent-factory/run-registry";

let root: string;
let prevRoot: string | undefined;

beforeEach(() => {
  prevRoot = process.env.AGENTIC_DATA_ROOT;
  root = mkdtempSync(path.join(tmpdir(), "frn-transcript-"));
  process.env.AGENTIC_DATA_ROOT = root;
});
afterEach(() => {
  if (prevRoot === undefined) delete process.env.AGENTIC_DATA_ROOT;
  else process.env.AGENTIC_DATA_ROOT = prevRoot;
  rmSync(root, { recursive: true, force: true });
});

const ev = (t: string, extra: Record<string, unknown> = {}): BrainEvent =>
  ({ t, ...extra }) as unknown as BrainEvent;

describe("factory-run NDJSON transcript sidecar", () => {
  it("round-trips appended events in order", async () => {
    const events = [ev("plan", { version: 1 }), ev("think", { delta: "a" }), ev("done", { status: "finished" })];
    await appendFactoryRunTranscript("tnt-1", "run-1", events);
    const back = await readFactoryRunTranscript("tnt-1", "run-1");
    expect(back).toEqual(events);
  });

  it("appends incrementally (O(delta)) and reads the concatenation", async () => {
    await appendFactoryRunTranscript("tnt-1", "run-2", [ev("agent.created", { slug: "a" })]);
    await appendFactoryRunTranscript("tnt-1", "run-2", [ev("sandbox", { fullChainRan: true })]);
    const back = await readFactoryRunTranscript("tnt-1", "run-2");
    expect(back.map((e) => (e as { t: string }).t)).toEqual(["agent.created", "sandbox"]);
  });

  it("returns [] for a run with no sidecar", async () => {
    expect(await readFactoryRunTranscript("tnt-1", "missing")).toEqual([]);
  });

  it("skips a torn final line from a crash mid-append", async () => {
    await appendFactoryRunTranscript("tnt-1", "run-3", [ev("plan"), ev("done")]);
    // Simulate a partial write with no trailing newline + truncated JSON.
    const file = path.join(root, "logs", "factory-runs", "tnt-1", "run-3.ndjson");
    appendFileSync(file, '{"t":"sandbox","fullChain', "utf8");
    const back = await readFactoryRunTranscript("tnt-1", "run-3");
    expect(back.map((e) => (e as { t: string }).t)).toEqual(["plan", "done"]);
  });

  it("isolates tenants and sanitizes ids (no path traversal)", async () => {
    await appendFactoryRunTranscript("tnt-a", "../escape", [ev("plan")]);
    // Written under the sanitized tenant dir, not outside the data root.
    const back = await readFactoryRunTranscript("tnt-a", "../escape");
    expect(back).toHaveLength(1);
    expect(await readFactoryRunTranscript("tnt-b", "../escape")).toEqual([]);
  });

  it("deletes a sidecar", async () => {
    await appendFactoryRunTranscript("tnt-1", "run-4", [ev("done")]);
    await deleteFactoryRunTranscript("tnt-1", "run-4");
    expect(await readFactoryRunTranscript("tnt-1", "run-4")).toEqual([]);
  });
});

describe("structuralProjection (SQLite transcript = no think deltas)", () => {
  it("drops think deltas but keeps every structural frame", () => {
    const events = [
      ev("plan"),
      ev("think", { delta: "x" }),
      ev("agent.created", { slug: "a" }),
      ev("think", { delta: "y" }),
      ev("sandbox", { fullChainRan: true }),
      ev("done", { status: "finished" }),
    ];
    const projected = structuralProjection(events);
    expect(projected.map((e) => (e as { t: string }).t)).toEqual([
      "plan",
      "agent.created",
      "sandbox",
      "done",
    ]);
  });

  it("keeps evidence-bearing frames so derivation stays whole", () => {
    // The evidence + completion derivations only read done/sandbox — both survive.
    const projected = structuralProjection([ev("think", { delta: "noise" }), ev("sandbox", { simulated: false, fullChainRan: true }), ev("done", { status: "finished", completionKind: "delivery" })]);
    expect(projected.some((e) => (e as { t: string }).t === "sandbox")).toBe(true);
    expect(projected.some((e) => (e as { t: string }).t === "done")).toBe(true);
    expect(projected.some((e) => (e as { t: string }).t === "think")).toBe(false);
  });
});
