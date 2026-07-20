import { describe, expect, it } from "vitest";
import {
  anchorResolves,
  blueprintIsGrounded,
  buildOntologyAnchorIndex,
  groundBlueprint,
  type BlueprintProposal,
} from "./blueprint";

const ontology = {
  objects: [{ id: "Job_Posting", name: "职位" }, { id: "Candidate", name: "候选人" }],
  actions: [{ id: "createJD", name: "createJD" }, { id: "processResume", name: "processResume" }],
  rules: [{ id: "identity-dedup", name: "身份查重" }],
  events: [{ id: "RESUME_PROCESSED", name: "RESUME_PROCESSED" }],
};

const index = buildOntologyAnchorIndex(ontology);

describe("ontology anchor index", () => {
  it("indexes ids and display names per kind", () => {
    expect(anchorResolves({ kind: "action", id: "createJD" }, index)).toBe(true);
    expect(anchorResolves({ kind: "entity", id: "Job_Posting" }, index)).toBe(true);
    expect(anchorResolves({ kind: "entity", id: "职位" }, index)).toBe(true);
    expect(anchorResolves({ kind: "event", id: "RESUME_PROCESSED" }, index)).toBe(true);
  });

  it("rejects ids that do not exist or are cited under the wrong kind", () => {
    expect(anchorResolves({ kind: "action", id: "invented" }, index)).toBe(false);
    // createJD is an action, not an entity — kind must match.
    expect(anchorResolves({ kind: "entity", id: "createJD" }, index)).toBe(false);
    expect(anchorResolves({ kind: "action", id: "" }, index)).toBe(false);
  });
});

describe("groundBlueprint — fail-closed anchoring", () => {
  it("keeps phases/steps that cite a resolving anchor", () => {
    const proposal: BlueprintProposal = {
      domain: "Agents-generation",
      phases: [
        {
          id: "intake",
          title: "接收与理解",
          anchors: [{ kind: "action", id: "processResume" }],
          steps: [
            { label: "解析简历", anchors: [{ kind: "action", id: "processResume" }] },
            { label: "查重", anchors: [{ kind: "rule", id: "identity-dedup" }] },
          ],
        },
      ],
    };
    const model = groundBlueprint(proposal, index);
    expect(blueprintIsGrounded(model)).toBe(true);
    expect(model.phases).toHaveLength(1);
    expect(model.phases[0]?.steps).toHaveLength(2);
    expect(model.unresolved).toHaveLength(0);
  });

  it("drops an ungrounded step into unresolved, never invents it", () => {
    const proposal: BlueprintProposal = {
      domain: "Agents-generation",
      phases: [
        {
          id: "intake",
          title: "接收",
          anchors: [{ kind: "action", id: "processResume" }],
          steps: [
            { label: "真步骤", anchors: [{ kind: "action", id: "processResume" }] },
            { label: "凭空步骤", anchors: [{ kind: "action", id: "hallucinated" }] },
          ],
        },
      ],
    };
    const model = groundBlueprint(proposal, index);
    expect(model.phases[0]?.steps).toHaveLength(1);
    expect(model.unresolved).toEqual([
      expect.objectContaining({ scope: "step", ref: "intake/凭空步骤" }),
    ]);
  });

  it("drops a phase whose anchors do not resolve", () => {
    const proposal: BlueprintProposal = {
      domain: "Agents-generation",
      phases: [
        {
          id: "ghost",
          title: "幽灵阶段",
          anchors: [{ kind: "entity", id: "Nonexistent" }],
          steps: [{ label: "x", anchors: [{ kind: "action", id: "createJD" }] }],
        },
      ],
    };
    const model = groundBlueprint(proposal, index);
    expect(model.phases).toHaveLength(0);
    expect(blueprintIsGrounded(model)).toBe(false);
    expect(model.unresolved[0]).toMatchObject({ scope: "phase", ref: "ghost" });
  });

  it("drops a phase whose every step fails to ground", () => {
    const proposal: BlueprintProposal = {
      domain: "Agents-generation",
      phases: [
        {
          id: "intake",
          title: "接收",
          anchors: [{ kind: "action", id: "processResume" }],
          steps: [{ label: "凭空", anchors: [{ kind: "rule", id: "no-such-rule" }] }],
        },
      ],
    };
    const model = groundBlueprint(proposal, index);
    expect(model.phases).toHaveLength(0);
    expect(model.unresolved.some((u) => u.scope === "phase" && u.ref === "intake")).toBe(true);
  });

  it("grounds step reads/writes/emits to real ontology ids and drops fabricated ones", () => {
    const proposal: BlueprintProposal = {
      domain: "Agents-generation",
      phases: [
        {
          id: "intake",
          title: "接收",
          anchors: [{ kind: "action", id: "processResume" }],
          steps: [
            {
              label: "解析简历",
              anchors: [{ kind: "action", id: "processResume" }],
              reads: ["Candidate", "凭空实体"], // one real entity + one fabricated → fabricated dropped
              writes: ["Job_Posting"],
              emits: ["RESUME_PROCESSED", "FAKE_EVENT"], // real event kept, fake dropped
            },
          ],
        },
      ],
    };
    const model = groundBlueprint(proposal, index);
    const step = model.phases[0]?.steps[0];
    expect(step?.reads).toEqual(["Candidate"]);
    expect(step?.writes).toEqual(["Job_Posting"]);
    expect(step?.emits).toEqual(["RESUME_PROCESSED"]);
  });

  it("drops reads/writes/emits to undefined when nothing grounds (never a fabricated leftover)", () => {
    const proposal: BlueprintProposal = {
      domain: "Agents-generation",
      phases: [
        {
          id: "intake",
          title: "接收",
          anchors: [{ kind: "action", id: "processResume" }],
          steps: [{ label: "解析", anchors: [{ kind: "action", id: "processResume" }], reads: ["凭空1", "凭空2"], emits: ["NOPE"] }],
        },
      ],
    };
    const model = groundBlueprint(proposal, index);
    const step = model.phases[0]?.steps[0];
    expect(step?.reads).toBeUndefined();
    expect(step?.emits).toBeUndefined();
    expect(step?.writes).toBeUndefined();
  });

  it("carries diagrams through and preserves ontologySig", () => {
    const proposal: BlueprintProposal = {
      domain: "Agents-generation",
      ontologySig: "sha256:abc",
      phases: [
        {
          id: "intake",
          title: "接收",
          anchors: [{ kind: "action", id: "processResume" }],
          steps: [{ label: "解析", anchors: [{ kind: "action", id: "processResume" }] }],
        },
      ],
      diagrams: [{ kind: "sequence", title: "招聘时序", svg: "<svg/>" }],
    };
    const model = groundBlueprint(proposal, index);
    expect(model.ontologySig).toBe("sha256:abc");
    expect(model.diagrams).toHaveLength(1);
    expect(model.diagrams[0]?.kind).toBe("sequence");
  });
});
