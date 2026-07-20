import { describe, it, expect } from "vitest";
import {
  applyDraft,
  countDraftChanges,
  emptyDraft,
  toManifest,
  type WorkflowDraft,
} from "./draft";
import type { DagAgent } from "@/lib/hooks/useAgents";

function agent(id: string, overrides: Partial<DagAgent> = {}): DagAgent {
  return {
    id,
    kebabId: id,
    name: id,
    title: `Agent ${id}`,
    actor: "Agent",
    stage: 0,
    triggers: [],
    emits: [],
    recentRunCount: 0,
    isLive: false,
    ...overrides,
  };
}

describe("applyDraft", () => {
  it("returns base list unchanged for empty draft", () => {
    const base = [agent("1"), agent("2")];
    expect(applyDraft(base, emptyDraft())).toEqual(base);
  });

  it("filters out removed agents", () => {
    const base = [agent("1"), agent("2")];
    const draft: WorkflowDraft = {
      agents: {},
      added: new Set(),
      removed: new Set(["1"]),
    };
    const out = applyDraft(base, draft);
    expect(out).toHaveLength(1);
    expect(out[0]?.kebabId).toBe("2");
  });

  it("overrides edited fields", () => {
    const base = [agent("1", { title: "old", triggers: ["A"] })];
    const draft: WorkflowDraft = {
      agents: { "1": { id: "1", title: "new", triggers: ["B"] } },
      added: new Set(),
      removed: new Set(),
    };
    const out = applyDraft(base, draft);
    expect(out[0]?.title).toBe("new");
    expect(out[0]?.triggers).toEqual(["B"]);
  });

  it("appends added agents", () => {
    const base = [agent("1")];
    const draft: WorkflowDraft = {
      agents: { "new-1": { id: "new-1", title: "Brand new" } },
      added: new Set(["new-1"]),
      removed: new Set(),
    };
    const out = applyDraft(base, draft);
    expect(out).toHaveLength(2);
    expect(out[1]?.kebabId).toBe("new-1");
    expect(out[1]?.title).toBe("Brand new");
  });
});

describe("toManifest", () => {
  it("converts agents to AgentSpec-shape entries", () => {
    const agents = [
      agent("1", {
        triggers: ["TRIG_A"],
        emits: ["EMIT_A"],
        title: "First",
      }),
    ];
    const out = toManifest(agents, {
      "1": {
        description: "Preserved description",
        actions: [
          { order: "1", name: "realAction", type: "tool", task_type: "search" },
        ],
      },
    });
    expect(out[0]?.id).toBe("1");
    expect(out[0]?.trigger).toEqual(["TRIG_A"]);
    expect(out[0]?.triggered_event).toEqual(["EMIT_A"]);
    expect(out[0]?.actor).toEqual(["Agent"]);
    expect(out[0]?.description).toBe("Preserved description");
    expect(out[0]?.actions).toEqual([
      { order: "1", name: "realAction", type: "tool", task_type: "search" },
    ]);
  });

  it("preserves Human actor", () => {
    const out = toManifest([agent("1", { actor: "Human" })], {
      "1": { description: "", actions: [] },
    });
    expect(out[0]?.actor).toEqual(["Human"]);
  });

  it("blocks serialization when canonical behavior is missing", () => {
    expect(() => toManifest([agent("1")], {})).toThrow(
      "Unsafe workflow deploy blocked",
    );
  });
});

describe("countDraftChanges", () => {
  it("counts added / modified / removed", () => {
    const draft: WorkflowDraft = {
      agents: {
        "1": { id: "1", title: "mod" },
        "2": { id: "2", title: "rm-then-edit" },
        "new-1": { id: "new-1" },
      },
      added: new Set(["new-1"]),
      removed: new Set(["2"]),
    };
    expect(countDraftChanges(draft)).toEqual({
      added: 1,
      modified: 1,
      removed: 1,
    });
  });
});
