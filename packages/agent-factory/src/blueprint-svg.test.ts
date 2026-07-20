import { describe, expect, it } from "vitest";
import { renderBlueprintSvg, renderBlueprintReportSection } from "./blueprint-svg";
import type { BlueprintModel } from "./blueprint";

const model: BlueprintModel = {
  domain: "Agents-generation",
  phases: [
    {
      id: "intake",
      title: "接收与理解",
      intent: "读取简历并落库",
      anchors: [{ kind: "action", id: "processResume" }],
      steps: [
        { label: "解析简历", agent: "ProcessResumeAgent", anchors: [{ kind: "action", id: "processResume" }] },
        { label: "查重", agent: "RuleCheckAgent", anchors: [{ kind: "rule", id: "identity-dedup" }] },
      ],
    },
    {
      id: "match",
      title: "匹配与邀约",
      anchors: [{ kind: "action", id: "matchResume" }],
      steps: [{ label: "匹配打分", agent: "MatchResumeAgent", anchors: [{ kind: "event", id: "MATCH_PASSED" }] }],
    },
  ],
  diagrams: [],
  unresolved: [{ scope: "step", ref: "x/凭空", reason: "缺锚点", citedAnchors: [] }],
};

describe("renderBlueprintSvg", () => {
  it("renders a deterministic phase-flow svg (same in → byte-identical out)", () => {
    const a = renderBlueprintSvg(model, "phase-flow");
    const b = renderBlueprintSvg(model, "phase-flow");
    expect(a).toBe(b);
    expect(a.startsWith("<svg")).toBe(true);
    expect(a).toContain("</svg>");
    expect(a).toContain("接收与理解");
    expect(a).toContain("匹配与邀约");
    expect(a).toContain("processResume");
  });

  it("renders a deterministic sequence svg with actor lifelines", () => {
    const svg = renderBlueprintSvg(model, "sequence");
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain("ProcessResumeAgent");
    expect(svg).toContain("时序");
  });

  it("surfaces an unresolved count (fail-closed honesty, not hidden)", () => {
    expect(renderBlueprintSvg(model, "phase-flow")).toContain("未接地 1 项");
  });

  it("escapes XML in labels (no injection into the svg)", () => {
    const evil: BlueprintModel = {
      domain: "d",
      phases: [{ id: "p", title: "<script>alert(1)</script>", anchors: [{ kind: "action", id: "a" }], steps: [{ label: "x&y", anchors: [{ kind: "action", id: "a" }] }] }],
      diagrams: [],
      unresolved: [],
    };
    const svg = renderBlueprintSvg(evil, "phase-flow");
    expect(svg).not.toContain("<script>alert(1)</script>");
    expect(svg).toContain("&lt;script&gt;");
    expect(svg).toContain("x&amp;y");
  });

  it("renders an empty-state note when nothing grounded", () => {
    const empty: BlueprintModel = { domain: "d", phases: [], diagrams: [], unresolved: [] };
    const svg = renderBlueprintSvg(empty, "phase-flow");
    expect(svg).toContain("无可接地的阶段");
  });

  it("renders per-step reads/writes/emits data-flow and the per-phase deliberation", () => {
    const rich: BlueprintModel = {
      domain: "Agents-generation",
      phases: [
        {
          id: "intake",
          title: "接收",
          anchors: [{ kind: "action", id: "processResume" }],
          deliberation: "本阶段先读取候选人简历对象，落库后触发已处理事件，供下游匹配消费。",
          steps: [
            {
              label: "解析简历",
              agent: "ProcessResumeAgent",
              reads: ["Candidate"],
              writes: ["ResumeRecord"],
              emits: ["RESUME_PROCESSED"],
              anchors: [{ kind: "action", id: "processResume" }],
            },
          ],
        },
      ],
      diagrams: [],
      unresolved: [],
    };
    const svg = renderBlueprintSvg(rich, "phase-flow");
    expect(svg).toContain("读 Candidate");
    expect(svg).toContain("写 ResumeRecord");
    expect(svg).toContain("发 RESUME_PROCESSED");
    expect(svg).toContain("推理细化");
    expect(svg).toContain("候选人简历对象"); // the deliberation text is visible in the diagram
  });

  it("stays deterministic with deliberation + io present (same in → same out)", () => {
    const rich: BlueprintModel = {
      domain: "d",
      phases: [{ id: "p", title: "t", deliberation: "推理结论一二三四五六七八九十", anchors: [{ kind: "action", id: "a" }], steps: [{ label: "s", reads: ["E"], anchors: [{ kind: "action", id: "a" }] }] }],
      diagrams: [],
      unresolved: [],
    };
    expect(renderBlueprintSvg(rich, "phase-flow")).toBe(renderBlueprintSvg(rich, "phase-flow"));
  });
});

describe("renderBlueprintReportSection (embeds into the HTML/PDF report)", () => {
  it("wraps the diagrams + grounded phases into a self-contained section", () => {
    const withDiagram: BlueprintModel = { ...model, diagrams: [{ kind: "phase-flow", title: "蓝图", svg: renderBlueprintSvg(model, "phase-flow") }] };
    const html = renderBlueprintReportSection(withDiagram);
    expect(html.startsWith("<section")).toBe(true);
    expect(html).toContain("Ontology-grounded 蓝图");
    expect(html).toContain("接收与理解");
    expect(html).toContain("<svg"); // the diagram is embedded verbatim
    expect(html).toContain("缺本体证据"); // unresolved surfaced honestly
  });

  it("renders reads/writes/emits + deliberation in the report section", () => {
    const rich: BlueprintModel = {
      domain: "Agents-generation",
      phases: [
        {
          id: "intake",
          title: "接收",
          anchors: [{ kind: "action", id: "processResume" }],
          deliberation: "读取候选人对象后落库并发出已处理事件。",
          steps: [{ label: "解析", reads: ["Candidate"], emits: ["RESUME_PROCESSED"], anchors: [{ kind: "action", id: "processResume" }] }],
        },
      ],
      diagrams: [],
      unresolved: [],
    };
    const html = renderBlueprintReportSection(rich);
    expect(html).toContain("读 Candidate");
    expect(html).toContain("发 RESUME_PROCESSED");
    expect(html).toContain("推理细化");
    expect(html).toContain("已处理事件");
  });

  it("escapes phase/step text in the report HTML", () => {
    const evil: BlueprintModel = { domain: "d", phases: [{ id: "p", title: "<img src=x onerror=1>", anchors: [{ kind: "action", id: "a" }], steps: [{ label: "s", anchors: [{ kind: "action", id: "a" }] }] }], diagrams: [], unresolved: [] };
    const html = renderBlueprintReportSection(evil);
    expect(html).not.toContain("<img src=x onerror=1>");
    expect(html).toContain("&lt;img");
  });
});
