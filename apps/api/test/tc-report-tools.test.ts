/**
 * TC — report/viz toolchain (factory ops sidebar 领域报告 backend):
 *   1. renderSvgChart is DETERMINISTIC (same spec → same SVG) and geometrically sane.
 *   2. extractHtmlDocument recovers a complete document from fenced/preambled LLM output.
 *   3. substituteCharts replaces {{CHART:id}} placeholders, appends unplaced charts,
 *      and never leaks unknown markers into the delivered report.
 *   4. PDF printing degrades with an ACTIONABLE error when no Chrome exists.
 */

import { describe, it, expect, afterEach } from "vitest";
import { renderSvgChart, findChrome, htmlFileToPdf } from "@agentic/tools";
import { extractHtmlDocument, substituteCharts } from "@agentic/agents/system";

describe("TC report-tools: viz.renderSvgChart", () => {
  it("bar chart is deterministic and contains every label + value", () => {
    const spec = { kind: "bar" as const, title: "各动作绑定工具数", data: [{ label: "简历解析", value: 3 }, { label: "简历匹配", value: 2 }] };
    const a = renderSvgChart(spec);
    const b = renderSvgChart(spec);
    expect(a.svg).toBe(b.svg); // deterministic — no Date/random
    expect(a.svg).toContain("<svg");
    expect(a.svg).toContain("简历解析");
    expect(a.svg).toContain("各动作绑定工具数");
    expect(a.svg).toContain(">3<");
    expect(a.height).toBeGreaterThan(0);
  });

  it("donut renders one ring segment per positive datum and escapes labels", () => {
    const { svg } = renderSvgChart({ kind: "donut", data: [{ label: "<Agent>", value: 5 }, { label: "Human", value: 5 }, { label: "zero", value: 0 }] });
    expect((svg.match(/stroke-dasharray/g) ?? []).length).toBe(2); // zero-value dropped
    expect(svg).toContain("&lt;Agent&gt;"); // escaped, never raw <Agent>
    expect(svg).toContain("50%");
  });

  it("flow chains steps with arrow markers; line survives a single point", () => {
    const flow = renderSvgChart({ kind: "flow", steps: ["⚡ RESUME_UPLOADED", "processResume", "⚡ RESUME_PROCESSED", "matchResume"] });
    expect(flow.svg).toContain("vizarr"); // arrow marker def + uses
    expect(flow.svg).toContain("processResume");
    const line = renderSvgChart({ kind: "line", data: [{ label: "d1", value: 7 }] });
    expect(line.svg).toContain("<circle");
    expect(line.svg).not.toContain("<polyline"); // no line with one point
  });

  it("rejects unknown kinds fail-closed", () => {
    expect(() => renderSvgChart({ kind: "scatter" as never, data: [] })).toThrow(/unknown kind/);
  });

  it("clamps hostile geometry: tiny width never emits negative-width rects; palette is attribute-escaped", () => {
    const { svg } = renderSvgChart({ kind: "bar", width: 120, data: [{ label: "a", value: 3 }] });
    expect(svg).not.toMatch(/width="-/); // negative-width <rect> disables rendering silently
    const inj = renderSvgChart({ kind: "bar", data: [{ label: "a", value: 1 }], palette: ['"><script>alert(1)</script>'] });
    expect(inj.svg).not.toContain("<script>"); // attribute breakout neutralized
  });
});

describe("TC report-tools: HTML extraction + chart substitution", () => {
  it("strips markdown fences and preamble down to the document", () => {
    const doc = "<!DOCTYPE html><html><head><title>T</title></head><body>x</body></html>";
    expect(extractHtmlDocument("好的，报告如下：\n" + doc)).toBe(doc);
    expect(extractHtmlDocument("```html\n" + doc + "\n```")).toBe(doc);
  });

  it("survives `$&`-style sequences in SVG bodies (String.replace pattern injection)", () => {
    // esc() output like `成本$&lt;100` contains `$&` — as a string replacement that would
    // re-insert the matched marker (then get stripped), silently mangling the label; and
    // `$'` in the appended-block path would splice document slices into the SVG.
    const evil = `<svg><text>成本$&lt;100 · Q1$'s · US$$50</text></svg>`;
    const placed = substituteCharts("<html><body>{{CHART:a}}</body></html>", [{ id: "a", title: "t", svg: evil }]);
    expect(placed).toContain(evil);
    const appended = substituteCharts("<html><body><p>x</p></body></html>", [{ id: "b", title: "t", svg: evil }]);
    expect(appended).toContain(evil);
    expect((appended.match(/<\/body>/g) ?? []).length).toBe(1); // no spliced second </body>
  });

  it("substitutes placed charts, appends unplaced ones, drops unknown markers", () => {
    const charts = [
      { id: "a", title: "图A", svg: "<svg>A</svg>" },
      { id: "b", title: "图B", svg: "<svg>B</svg>" },
    ];
    const html = "<html><body><p>x</p>{{CHART:a}}{{CHART:nope}}</body></html>";
    const out = substituteCharts(html, charts);
    expect(out).toContain("<svg>A</svg>"); // placed
    expect(out).toContain("<svg>B</svg>"); // unplaced → appended before </body>
    expect(out).not.toContain("{{CHART:"); // markers never reach the reader
    expect(out.indexOf("<svg>B</svg>")).toBeGreaterThan(out.indexOf("<svg>A</svg>"));
  });
});

describe("TC report-tools: PDF degrades actionably without Chrome", () => {
  const saved = process.env.CHROME_PATH;
  afterEach(() => {
    if (saved === undefined) delete process.env.CHROME_PATH;
    else process.env.CHROME_PATH = saved;
  });

  it("findChrome honours CHROME_PATH and returns null for a bogus path", () => {
    process.env.CHROME_PATH = "/definitely/not/a/browser";
    expect(findChrome()).toBeNull();
  });

  it("htmlFileToPdf throws the fix-it message (mentions CHROME_PATH), not a crash", async () => {
    process.env.CHROME_PATH = "/definitely/not/a/browser";
    await expect(htmlFileToPdf("/tmp/x.html", "/tmp/x.pdf")).rejects.toThrow(/CHROME_PATH/);
  });
});
