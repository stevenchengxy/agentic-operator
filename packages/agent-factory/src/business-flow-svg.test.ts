import { describe, it, expect } from "vitest";
import { renderWorkflowSvg } from "./business-flow-svg";
import type { BusinessFlowModel } from "./business-flow";

/** 3-agent fixture: A --X_DONE--> B (success chain), B emits FAIL_Y (failure),
 *  C has an external trigger (RAAS) + non-empty writes & notifies; one external
 *  system name carries an "&" to exercise escaping. */
function fakeModel(): BusinessFlowModel {
  return {
    domain: "招聘 域",
    externals: [
      { name: "Foo & Bar 平台", kind: "external_platform", usedBy: ["c"], roles: ["writes"] },
      { name: "RAAS", kind: "external_platform", usedBy: ["c"], roles: ["triggers"] },
    ],
    agents: [
      {
        actionName: "parse",
        slug: "agent-alpha",
        nameZh: "简历解析",
        isSubAgent: false,
        triggers: [{ event: "RESUME_UPLOADED", external: true, source: "官网" }],
        reads: ["文件收件箱"],
        calls: [],
        writes: [],
        notifies: [],
        emits: [{ event: "X_DONE", semantic: "success", consumers: ["match"] }],
      },
      {
        actionName: "match",
        slug: "agent-beta",
        nameZh: "简历匹配",
        isSubAgent: false,
        triggers: [{ event: "X_DONE", external: false }],
        reads: [],
        calls: ["外部 HTTP API · matchResumeApi"],
        writes: [],
        notifies: [],
        emits: [{ event: "FAIL_Y", semantic: "failure", consumers: [] }],
      },
      {
        actionName: "offer",
        slug: "agent-gamma",
        nameZh: "发放 Offer",
        isSubAgent: false,
        triggers: [{ event: "MATCH_PASSED", external: true, source: "RAAS" }],
        reads: [],
        calls: [],
        writes: [{ object: "Offer", action: "CREATE" }],
        notifies: ["候选人 · email"],
        emits: [{ event: "OFFER_MADE", semantic: "external", consumers: [], externalConsumer: "Partner PG" }],
      },
    ],
    entries: [
      { event: "RESUME_UPLOADED", consumers: ["parse"] },
      { event: "MATCH_PASSED", consumers: ["offer"] },
    ],
  };
}

describe("renderWorkflowSvg", () => {
  const model = fakeModel();
  const svg = renderWorkflowSvg(model, { title: "融合蓝图" });

  it("① is an <svg> with a viewBox", () => {
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain("viewBox");
    expect(svg).toContain("viewBox=\"0 0 1400");
  });

  it("② renders every agent identifier", () => {
    expect(svg).toContain("agent-alpha");
    expect(svg).toContain("agent-beta");
    expect(svg).toContain("agent-gamma");
  });

  it("③ colors the failure emit with the red family", () => {
    expect(svg).toContain("#eb5757");
  });

  it("④ draws at least one cross-lane connector with an arrow marker", () => {
    expect(svg).toContain("<path");
    expect(svg).toMatch(/marker-end="url\(#wf-arrow/);
  });

  it("⑤ is deterministic (byte-identical on re-render)", () => {
    expect(renderWorkflowSvg(model, { title: "融合蓝图" })).toBe(svg);
  });

  it("⑥ escapes '&' and never emits a bare '& '", () => {
    expect(svg).toContain("&amp;");
    expect(svg).not.toContain("& ");
  });
});
