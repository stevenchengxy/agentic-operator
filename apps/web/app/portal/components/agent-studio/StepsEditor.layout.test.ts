import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(resolve(__dirname, "StepsEditor.tsx"), "utf8");
const globalCss = readFileSync(
  resolve(__dirname, "..", "..", "..", "global.css"),
  "utf8",
);

describe("Steps editor responsive layout wiring", () => {
  it("exposes stable hooks for aligned identity controls and narrow cards", () => {
    expect(source).toContain('className="agent-studio-steps-editor"');
    expect(source).toContain('className="agent-studio-step-card"');
    expect(source).toContain('className="agent-studio-step-card-body"');
    expect(source).toContain('className="agent-studio-step-identity-grid"');
    expect(source).toContain('className="agent-studio-step-actions"');
  });

  it("lets field grids shrink to their panel instead of forcing horizontal scroll", () => {
    expect(source).toContain("repeat(auto-fit, minmax(min(220px, 100%), 1fr))");
    expect(source).toContain("repeat(auto-fit, minmax(min(280px, 100%), 1fr))");
    expect(source).not.toMatch(/minmax\((?:180|220|280)px, 1fr\)/);
  });

  it("allows step headers and action rows to wrap on compact screens", () => {
    expect(source).toContain('className="agent-studio-step-card-summary"');
    expect(source).toContain('flexWrap: "wrap"');
    expect(source).toContain('className="agent-studio-step-order-actions"');
  });

  it("bottom-aligns identity controls and stacks them by card width", () => {
    expect(globalCss).toContain(
      ".agent-studio-step-identity-grid > .agent-studio-field",
    );
    expect(globalCss).toMatch(
      /\.agent-studio-step-identity-grid[\s\S]{0,420}> \.agent-studio-control \{[\s\S]{0,80}margin-top: auto/,
    );
    expect(globalCss).toContain("container: agent-steps / inline-size");
    expect(globalCss).toMatch(
      /@container agent-steps \(max-width: 520px\)[\s\S]*?\.agent-studio-step-card-body[\s\S]*?padding: 12px !important/,
    );
    expect(globalCss).toMatch(
      /@container agent-steps \(max-width: 520px\)[\s\S]*?\.agent-studio-step-identity-grid,[\s\S]*?grid-template-columns: minmax\(0, 1fr\) !important/,
    );
  });
});
