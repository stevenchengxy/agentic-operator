import { describe, expect, it } from "vitest";
import {
  applyIntegrationHumanBoundaries,
  consumeIntegrationBoundaryAnswer,
  type IntegrationHumanBoundary,
  type IntegrationToolBinding,
} from "./integration-binding";

// #HUMAN-BOUNDARY — the live-run gap (frn-95ee19d9215a): a clarify-confirmed 人工边界 must become
// design-admissible (identity gaps stop blocking authoring) WITHOUT ever satisfying execution
// readiness. These are the two pure halves: the server-side answer consumption and the binding
// overlay the design/readiness gates apply.

const gap = (system: string, role: string, extra: Partial<IntegrationToolBinding> = {}): IntegrationToolBinding => ({
  requirement: { id: `a:${system}:${role}`, actionName: "createJD", system, kind: "external", role, operations: [], objectTypes: [], replayable: true },
  status: "missing",
  reason: "no capability matched",
  ...extra,
});

const confirmed = (system: string, mode: string): IntegrationHumanBoundary => ({
  system, mode, interactionId: "hitl_test", actor: "usr-1", confirmedAt: 1_784_283_000_000,
});

describe("applyIntegrationHumanBoundaries — the design-admissible overlay", () => {
  it("rewrites a confirmed identity gap to status human_boundary with an audit trail", () => {
    const out = applyIntegrationHumanBoundaries(
      [gap("RAAS_System", "read"), gap("RAAS_System", "write"), gap("GoHire_System", "call")],
      [confirmed("RAAS_System", "read"), confirmed("RAAS_System", "write")],
    );
    expect(out[0]!.status).toBe("human_boundary");
    expect(out[0]!.humanBoundary).toMatchObject({ interactionId: "hitl_test", actor: "usr-1" });
    expect(out[1]!.status).toBe("human_boundary");
    expect(out[2]!.status).toBe("missing"); // unconfirmed system untouched
  });

  it('mode "all" covers both roles; matching is NFKC/case-insensitive', () => {
    const out = applyIntegrationHumanBoundaries(
      [gap("RAAS_System", "read"), gap("raas_system", "WRITE")],
      [confirmed("RAAS_SYSTEM", "all")],
    );
    expect(out.every((binding) => binding.status === "human_boundary")).toBe(true);
  });

  it("NEVER rewrites an ambiguous choice or a binding that already has a tool identity", () => {
    const ambiguous = gap("RAAS_System", "read", { selectionRequired: true });
    const bound = gap("RAAS_System", "write", { toolName: "entities.write", status: "needs_config" });
    const out = applyIntegrationHumanBoundaries([ambiguous, bound], [confirmed("RAAS_System", "all")]);
    expect(out[0]!.status).toBe("missing"); // still a human CHOICE, not a boundary
    expect(out[1]!.status).toBe("needs_config"); // config path untouched
  });

  it("no confirmations → bindings pass through unchanged", () => {
    const input = [gap("RAAS_System", "read")];
    expect(applyIntegrationHumanBoundaries(input, undefined)).toBe(input);
  });
});

describe("consumeIntegrationBoundaryAnswer — server-side, gate-owned pair list", () => {
  const pending = [
    { system: "RAAS_System", mode: "read" },
    { system: "Allmeta_Ontology_System", mode: "write" },
  ];

  it("an affirmative 人工边界 answer confirms EXACTLY the asked pairs", () => {
    const out = consumeIntegrationBoundaryAnswer(pending, "这几项确认人工边界，留作待配置集成。", { interactionId: "hitl_x", confirmedAt: 1 });
    expect(out).toHaveLength(2);
    expect(out![0]).toMatchObject({ system: "RAAS_System", mode: "read", interactionId: "hitl_x" });
  });

  it("a negated answer confirms nothing", () => {
    expect(consumeIntegrationBoundaryAnswer(pending, "不保留人工边界，请用真实工具接。", { confirmedAt: 1 })).toBeNull();
    expect(consumeIntegrationBoundaryAnswer(pending, "人工边界不合适，先接 RAAS。", { confirmedAt: 1 })).toBeNull();
  });

  it("an unrelated answer (choosing a tool) confirms nothing", () => {
    expect(consumeIntegrationBoundaryAnswer(pending, "用 ontology.fetchActionRules 来连。", { confirmedAt: 1 })).toBeNull();
  });

  it("empty pending list is a no-op", () => {
    expect(consumeIntegrationBoundaryAnswer([], "确认人工边界", { confirmedAt: 1 })).toBeNull();
  });
});
