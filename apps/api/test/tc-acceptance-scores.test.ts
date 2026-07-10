import { describe, it, expect } from "vitest";
import { DrizzleAcceptanceRecorder } from "../src/services/agent-factory/stores";
import { getDb, acceptanceScores, eq, and } from "@agentic/db";

// #P1-6 — acceptance verdicts are denormalized per criterion per run, so pass-rate trends don't need
// replaying transcripts.

describe("#P1-6 acceptance_scores recorder", () => {
  it("persists one row per criterion and supports a pass-rate query", async () => {
    const runId = `run-acc-${Math.floor(Date.now() % 1e9)}`;
    const rec = new DrizzleAcceptanceRecorder();
    await rec.record(runId, "raas", "raas", [
      { key: "coverage", label: "覆盖", pass: true, detail: "6/6" },
      { key: "tools_resolve", label: "工具解析", pass: true, detail: "all" },
      { key: "chain_ran", label: "链路跑通", pass: false, detail: "degraded" },
    ]);
    const rows = getDb().select().from(acceptanceScores).where(eq(acceptanceScores.runId, runId)).all();
    expect(rows.length).toBe(3);
    const passed = rows.filter((r) => r.pass).length;
    expect(passed).toBe(2); // 2/3 pass-rate is now queryable
    const failing = getDb().select().from(acceptanceScores).where(and(eq(acceptanceScores.runId, runId), eq(acceptanceScores.pass, false))).all();
    expect(failing.map((r) => r.criterionKey)).toEqual(["chain_ran"]);
  });
});
