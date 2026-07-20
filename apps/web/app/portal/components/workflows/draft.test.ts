import { describe, expect, it } from "vitest";
import { WorkflowManifest } from "@agentic/contracts";
import type { DagAgent } from "@/lib/hooks/useAgents";
import {
  MissingAgentDefinitionError,
  addAgentToDraft,
  applyDraft,
  connectAgents,
  countDraftChanges,
  createAutomatedAgentDefinition,
  createHumanAgentDefinition,
  deriveEventEdges,
  deserializeDraft,
  emptyDraft,
  mergeAgentDefinitionIntoDraft,
  moveAgent,
  patchAgentDefinition,
  serializeDraft,
  toManifest,
  type CompleteAgentDefinition,
  type WorkflowDagAgent,
  type WorkflowDraft,
} from "./draft";

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

function definition(
  id: string,
  overrides: Record<string, unknown> = {},
): CompleteAgentDefinition {
  return {
    id,
    name: `${id}Agent`,
    title: `Agent ${id}`,
    description: `Complete definition for ${id}`,
    actor: ["Agent"],
    stage: 2,
    trigger: [`${id}_REQUESTED`],
    actions: [
      {
        id: `${id}-execute`,
        order: "1",
        name: "execute",
        description: "Perform the authored operation.",
        type: "logic",
        action_prompt: "Use supplied evidence only.",
        vendor_action_extension: { mode: "strict" },
      },
    ],
    triggered_event: [`${id}_COMPLETED`],
    ontology_instructions: "A complete, carefully authored system prompt.",
    user_prompt_template: "Process {{ event.data.subject }}.",
    tool_use: [
      {
        name: "meta.ping",
        config: { timeout_ms: 2_500 },
      },
    ],
    provider: "openai",
    model: "gpt-4.1",
    temperature: 0.2,
    max_tokens: 2_000,
    retries: 4,
    timeout_s: 90,
    concurrency: {
      enabled: true,
      max_concurrent_executions: 12,
      key: "event.data.subject",
      vendor_concurrency_extension: true,
    },
    extensions: {
      tenant_owned: { preserve: ["every", "field"] },
      canvas: {
        position: { x: 120, y: 240 },
        zoom: 1.25,
      },
    },
    vendor_top_level: { nested: { value: 42 } },
    ...overrides,
  } as CompleteAgentDefinition;
}

function fullAgent(
  id: string,
  source = definition(id),
  overrides: Partial<WorkflowDagAgent> = {},
): WorkflowDagAgent {
  const actor = source.actor[0] === "Human" ? "Human" : "Agent";
  const extensions = source.extensions as
    | { canvas?: { position?: { x: number; y: number } } }
    | undefined;
  const position =
    extensions?.canvas?.position ??
    (source.position as { x: number; y: number } | undefined);
  return {
    ...agent(id),
    name: source.name,
    title: source.title ?? source.name,
    actor,
    stage: typeof source.stage === "number" ? source.stage : 0,
    triggers: source.trigger,
    emits: source.triggered_event,
    definition: source,
    ...(position ? { position } : {}),
    ...overrides,
  };
}

describe("lossless definition editing", () => {
  it("preserves every complete and unknown field on a no-op round trip", () => {
    const original = definition("research");
    const [saved] = toManifest([fullAgent("research", original)]);

    expect(saved).toEqual(original);
    expect(saved?.vendor_top_level).toBe(original.vendor_top_level);
    expect(saved?.actions).toEqual(original.actions);
  });

  it("patches represented fields without flattening prompts, tools, or extensions", () => {
    const original = definition("research");
    const draft: WorkflowDraft = {
      agents: {
        research: {
          id: "research",
          title: "Evidence researcher",
          actions: [
            {
              order: "1",
              name: "verify",
              description: "Verify every claim.",
              type: "logic",
            },
          ],
          temperature: 0.6,
          position: { x: 500, y: 700 },
        },
      },
      added: new Set(),
      removed: new Set(),
    };

    const [saved] = toManifest(
      applyDraft([fullAgent("research", original)], draft),
    );

    expect(saved).toMatchObject({
      title: "Evidence researcher",
      temperature: 0.6,
      extensions: {
        canvas: {
          position: { x: 500, y: 700 },
          zoom: 1.25,
        },
        tenant_owned: { preserve: ["every", "field"] },
      },
      ontology_instructions: original.ontology_instructions,
      user_prompt_template: original.user_prompt_template,
      tool_use: original.tool_use,
      concurrency: original.concurrency,
      vendor_top_level: original.vendor_top_level,
    });
    expect(saved?.actions).toEqual(draft.agents.research?.actions);
  });

  it("uses null as an explicit delete for optional definition fields", () => {
    const patched = patchAgentDefinition(definition("cleanup"), {
      id: "cleanup",
      description: null,
      ontology_instructions: null,
      user_prompt_template: null,
      tool_use: null,
      provider: null,
      model: null,
      temperature: null,
      max_tokens: null,
      retries: null,
      timeout_s: null,
      concurrency: null,
      position: null,
    });

    for (const key of [
      "description",
      "ontology_instructions",
      "user_prompt_template",
      "tool_use",
      "provider",
      "model",
      "temperature",
      "max_tokens",
      "retries",
      "timeout_s",
      "concurrency",
      "position",
    ]) {
      expect(patched).not.toHaveProperty(key);
    }
    expect(patched.vendor_top_level).toEqual({ nested: { value: 42 } });
    expect(patched.extensions).toMatchObject({
      tenant_owned: { preserve: ["every", "field"] },
      canvas: { zoom: 1.25 },
    });
    expect(
      (patched.extensions as { canvas: Record<string, unknown> }).canvas,
    ).not.toHaveProperty("position");
  });

  it("fails closed when an existing DAG projection lacks its source definition", () => {
    expect(() => toManifest([agent("projection-only")])).toThrow(
      MissingAgentDefinitionError,
    );
  });
});

describe("new-agent factories", () => {
  it("creates a schema-valid automated definition with a real prompt and action", () => {
    const created = createAutomatedAgentDefinition({
      id: "summarize-report",
      title: "Summarize report",
      position: { x: 80, y: 160 },
    });

    expect(WorkflowManifest.safeParse([created]).success).toBe(true);
    expect(created.actor).toEqual(["Agent"]);
    expect(created.ontology_instructions).toContain("Summarize report");
    expect(created.extensions).toMatchObject({
      canvas: { position: { x: 80, y: 160 } },
    });
    expect(created.actions).toEqual([
      expect.objectContaining({
        type: "logic",
        action_prompt: expect.any(String),
      }),
    ]);
  });

  it("creates a schema-valid human task with an auditable approval form", () => {
    const created = createHumanAgentDefinition({ id: "legal-review" });

    expect(WorkflowManifest.safeParse([created]).success).toBe(true);
    expect(created.actor).toEqual(["Human"]);
    expect(created.actions).toEqual([
      expect.objectContaining({
        type: "manual",
        task_type: "approval",
        awaiting_role: "operator",
        form_schema: expect.any(Object),
      }),
    ]);
  });

  it("uses a complete factory definition only for a genuinely added node", () => {
    const draft: WorkflowDraft = {
      agents: {
        "human-check": {
          id: "human-check",
          title: "Human check",
          actor: "Human",
          triggers: ["CHECK_REQUESTED"],
          emits: ["CHECK_RESOLVED"],
        },
      },
      added: new Set(["human-check"]),
      removed: new Set(),
    };

    const applied = applyDraft([], draft);
    const saved = toManifest(applied);

    expect(applied[0]?.isDraftNew).toBe(true);
    expect(saved[0]?.actor).toEqual(["Human"]);
    expect(saved[0]?.actions[0]).toMatchObject({ type: "manual" });
    expect(WorkflowManifest.safeParse(saved).success).toBe(true);
  });

  it("adds an authored complete definition to a draft without reducing it", () => {
    const created = definition("authored");
    const draft = addAgentToDraft(emptyDraft(), created);
    const [saved] = toManifest(applyDraft([], draft));

    expect(saved).toEqual(created);
  });

  it("merges a returned Agent Studio definition as a workflow modification", () => {
    const returned = definition("authored", {
      title: "Edited in Agent Studio",
    });
    const merged = mergeAgentDefinitionIntoDraft(emptyDraft(), returned);

    expect(merged.agents.authored?.definition).toEqual(returned);
    expect(merged.added).toEqual(new Set());
    expect(countDraftChanges(merged)).toEqual({
      added: 0,
      modified: 1,
      removed: 0,
    });
  });

  it("keeps a local new agent classified as an addition after Studio edits", () => {
    const local = addAgentToDraft(emptyDraft(), definition("new-agent"));
    const returned = definition("new-agent", { title: "Studio title" });
    const merged = mergeAgentDefinitionIntoDraft(local, returned);

    expect(merged.added).toEqual(new Set(["new-agent"]));
    expect(merged.agents["new-agent"]?.title).toBe("Studio title");
  });
});

describe("canvas draft operations", () => {
  it("filters removals, preserves base order, and appends additions", () => {
    const draft: WorkflowDraft = {
      agents: {
        two: { id: "two", title: "Updated two" },
        three: {
          id: "three",
          definition: definition("three"),
          title: "Agent three",
        },
      },
      added: new Set(["three"]),
      removed: new Set(["one"]),
    };

    const applied = applyDraft([fullAgent("one"), fullAgent("two")], draft);

    expect(applied.map((item) => item.kebabId)).toEqual(["two", "three"]);
    expect(applied[0]?.title).toBe("Updated two");
  });

  it("connects nodes idempotently and preserves unrelated draft fields", () => {
    const source = fullAgent(
      "source",
      definition("source", {
        triggered_event: ["EXISTING", "FLOW_READY"],
      }),
    );
    const target = fullAgent(
      "target",
      definition("target", {
        trigger: ["FLOW_READY"],
      }),
    );
    const initial: WorkflowDraft = {
      agents: {
        source: { id: "source", model: "gpt-4.1-mini" },
      },
      added: new Set(),
      removed: new Set(),
    };

    const once = connectAgents(
      initial,
      [source, target],
      "source",
      "target",
      "FLOW_READY",
    );
    const twice = connectAgents(
      once,
      [source, target],
      "source",
      "target",
      "FLOW_READY",
    );

    expect(twice.agents.source).toMatchObject({
      model: "gpt-4.1-mini",
      emits: ["EXISTING", "FLOW_READY"],
    });
    expect(twice.agents.target?.triggers).toEqual(["FLOW_READY"]);
  });

  it("derives a live edge from trigger and emitted-event draft edits", () => {
    const base = [fullAgent("source"), fullAgent("target")];
    const draft: WorkflowDraft = {
      agents: {
        source: { id: "source", emits: ["FLOW_READY"] },
        target: { id: "target", triggers: ["FLOW_READY"] },
      },
      added: new Set(),
      removed: new Set(),
    };

    expect(deriveEventEdges(applyDraft(base, draft))).toEqual([
      { src: "source", dst: "target", event: "FLOW_READY" },
    ]);
  });

  it("trims event names and collapses duplicate edge declarations", () => {
    expect(
      deriveEventEdges([
        agent("source", { emits: [" FLOW_READY ", "FLOW_READY", ""] }),
        agent("target", {
          triggers: ["FLOW_READY", " FLOW_READY ", "FLOW_READY"],
        }),
      ]),
    ).toEqual([{ src: "source", dst: "target", event: "FLOW_READY" }]);
  });

  it("supports deterministic fan-in and fan-out for shared events", () => {
    expect(
      deriveEventEdges([
        agent("source-a", { emits: ["SHARED"] }),
        agent("source-b", { emits: ["SHARED"] }),
        agent("target-a", { triggers: ["SHARED"] }),
        agent("target-b", { triggers: ["SHARED"] }),
      ]),
    ).toEqual([
      { src: "source-a", dst: "target-a", event: "SHARED" },
      { src: "source-a", dst: "target-b", event: "SHARED" },
      { src: "source-b", dst: "target-a", event: "SHARED" },
      { src: "source-b", dst: "target-b", event: "SHARED" },
    ]);
  });

  it("does not fabricate edges for external triggers", () => {
    expect(
      deriveEventEdges([
        agent("entry", { triggers: ["EXTERNAL_REQUEST"] }),
        agent("worker", { emits: ["WORK_COMPLETED"] }),
      ]),
    ).toEqual([]);
  });

  it("keeps event matching case-sensitive like runtime dispatch", () => {
    expect(
      deriveEventEdges([
        agent("source", { emits: ["FLOW_READY"] }),
        agent("target", { triggers: ["flow_ready"] }),
      ]),
    ).toEqual([]);
  });

  it("persists finite canvas coordinates and stage through manifest output", () => {
    const moved = moveAgent(emptyDraft(), "move-me", { x: 900, y: 300 }, 5);
    const [saved] = toManifest(applyDraft([fullAgent("move-me")], moved));

    expect(saved).toMatchObject({
      stage: 5,
      extensions: {
        tenant_owned: { preserve: ["every", "field"] },
        canvas: {
          position: { x: 900, y: 300 },
          zoom: 1.25,
        },
      },
    });
    expect(saved).not.toHaveProperty("position");
  });

  it("reads a legacy top-level coordinate and migrates it without losing extensions", () => {
    const legacy = definition("legacy", {
      position: { x: 7, y: 11 },
      extensions: { tenant_owned: { source: "legacy" } },
    });
    const base = fullAgent("legacy", legacy, { position: undefined });
    const draft: WorkflowDraft = {
      agents: { legacy: { id: "legacy", title: "Legacy migrated" } },
      added: new Set(),
      removed: new Set(),
    };

    const [applied] = applyDraft([base], draft);
    const [saved] = toManifest(applied ? [applied] : []);

    expect(applied?.position).toEqual({ x: 7, y: 11 });
    expect(saved?.extensions).toMatchObject({
      tenant_owned: { source: "legacy" },
      canvas: { position: { x: 7, y: 11 } },
    });
    // Unknown legacy input is retained during a non-destructive migration;
    // canonical readers prefer extensions.canvas.position.
    expect(saved?.position).toEqual({ x: 7, y: 11 });
  });

  it("rejects invalid coordinates and stages", () => {
    expect(() =>
      moveAgent(emptyDraft(), "bad", { x: Number.NaN, y: 0 }),
    ).toThrow();
    expect(() => moveAgent(emptyDraft(), "bad", { x: 0, y: 0 }, -1)).toThrow();
  });

  it("round-trips complete definitions and positions through draft storage", () => {
    const source = addAgentToDraft(emptyDraft(), definition("stored"));
    const serialized = serializeDraft(source, "wfv-base-123");
    const restored = deserializeDraft(serialized);

    expect(serialized.baseVersionId).toBe("wfv-base-123");
    expect(restored.agents.stored?.definition).toEqual(
      source.agents.stored?.definition,
    );
    expect(restored.agents.stored?.position).toEqual({ x: 120, y: 240 });
    expect(restored.added).toEqual(new Set(["stored"]));
  });
});

describe("countDraftChanges", () => {
  it("counts added, modified, and removed nodes independently", () => {
    const draft: WorkflowDraft = {
      agents: {
        one: { id: "one", title: "modified" },
        two: { id: "two", title: "removed after edit" },
        three: { id: "three" },
      },
      added: new Set(["three"]),
      removed: new Set(["two"]),
    };

    expect(countDraftChanges(draft)).toEqual({
      added: 1,
      modified: 1,
      removed: 1,
    });
  });
});
