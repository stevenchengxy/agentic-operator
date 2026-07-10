/**
 * Guards the workflow canvas's real-time, cascade-derived layout
 * (apps/web/.../workflows/layout.ts → topoLayout). This is what lets the
 * Workflows page render any tenant's DAG from the agents' triggers/emits
 * instead of a hand-tuned map — in particular the 招聘-v1 (zhaopin) tenant,
 * which reuses RAAS kebab-ids but has a different 6-agent shape.
 *
 * Columns = topological depth of the intra-tenant event cascade; island
 * agents (no event edges) are ordered by their kebab sequence so entry steps
 * land first and terminal steps (the external-boundary invite) land last.
 */
import { describe, it, expect } from "vitest";
import { topoLayout } from "../../web/app/portal/components/workflows/layout";

const col = (
  map: Record<string, { stage: number; lane: number }>,
  id: string,
) => map[id]?.stage;

describe("topoLayout — linear + parallel cascades", () => {
  it("lays a linear chain A→B→C into columns 0,1,2", () => {
    const m = topoLayout([
      { id: "a", triggers: [], emits: ["E1"] },
      { id: "b", triggers: ["E1"], emits: ["E2"] },
      { id: "c", triggers: ["E2"], emits: [] },
    ]);
    expect(col(m, "a")).toBe(0);
    expect(col(m, "b")).toBe(1);
    expect(col(m, "c")).toBe(2);
  });

  it("puts parallel listeners of the same event in the same column", () => {
    const m = topoLayout([
      { id: "src", triggers: [], emits: ["E"] },
      { id: "b", triggers: ["E"], emits: [] },
      { id: "c", triggers: ["E"], emits: [] },
    ]);
    expect(col(m, "src")).toBe(0);
    expect(col(m, "b")).toBe(1);
    expect(col(m, "c")).toBe(1);
    // distinct lanes within the column
    expect(m["b"]!.lane).not.toBe(m["c"]!.lane);
  });
});

describe("topoLayout — zhaopin 招聘-v1 6-agent cascade", () => {
  const AGENTS = [
    { id: "4", triggers: ["REQUIREMENT_LOGGED", "CLARIFICATION_READY", "JD_REJECTED"], emits: ["JD_GENERATED"] },
    { id: "9-1", triggers: ["RESUME_DOWNLOADED"], emits: ["RESUME_PROCESSED", "RESUME_LOCKED_CONFLICT"] },
    { id: "10-3", triggers: ["RESUME_PROCESSED"], emits: ["CANDIDATE_IDENTITY_CHECKED"] },
    { id: "10-1", triggers: ["RESUME_PROCESSED"], emits: ["MATCH_RULE_CHECK_PASSED", "MATCH_RULE_CHECK_FAILED"] },
    { id: "10-2", triggers: ["MATCH_RULE_CHECK_PASSED"], emits: ["MATCH_PASSED_NEED_INTERVIEW", "MATCH_FAILED"] },
    { id: "11-1", triggers: ["INTERVIEW_INVITATION_REQUESTED"], emits: ["INTERVIEW_INVITATION_SENT", "INTERVIEW_INVITATION_FAILED"] },
  ];

  it("places the cascade left→right matching the real flow", () => {
    const m = topoLayout(AGENTS);
    expect(col(m, "9-1")).toBe(0); // processResume — entry (true root)
    expect(col(m, "4")).toBe(0); // createJD — island, sorts first
    expect(col(m, "10-3")).toBe(1); // dedup — triggered by RESUME_PROCESSED
    expect(col(m, "10-1")).toBe(1); // ruleCheck — triggered by RESUME_PROCESSED
    expect(col(m, "10-2")).toBe(2); // matchResume — after the rule gate
    expect(col(m, "11-1")).toBe(3); // invite — island, sequenced LAST (not col 0)
  });

  it("never strands the terminal invite step in column 0", () => {
    const m = topoLayout(AGENTS);
    expect(col(m, "11-1")).toBeGreaterThan(col(m, "10-2")!);
  });

  it("is deterministic — same input → identical output", () => {
    expect(topoLayout(AGENTS)).toEqual(topoLayout(AGENTS));
  });
});
