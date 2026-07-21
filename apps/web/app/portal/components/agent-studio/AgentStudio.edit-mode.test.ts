/**
 * Structural regression coverage for Agent Studio's safety-critical edit mode.
 *
 * The production component depends on Next App Router, tenant context, React
 * Query, Monaco, and live API hooks. The web unit-test environment deliberately
 * has no DOM harness for that tree, so these checks protect the wiring that
 * previously allowed a saved draft to open with every field immediately
 * editable. End-to-end browser QA covers the rendered interaction.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(resolve(__dirname, "AgentStudio.tsx"), "utf8");
const fieldsSource = readFileSync(resolve(__dirname, "fields.tsx"), "utf8");
const helpSource = readFileSync(
  resolve(__dirname, "AgentStudioHelp.tsx"),
  "utf8",
);
const globalCss = readFileSync(
  resolve(__dirname, "..", "..", "..", "global.css"),
  "utf8",
);

describe("Agent Studio edit-mode wiring", () => {
  it("keeps the draft Edit action in the header without a redundant view-mode notice", () => {
    expect(source).not.toContain("Draft is protected in view mode");
    expect(source).not.toContain("Click Edit before changing fields.");
    expect(source).toContain(
      "editing || generatedCompatibility || upgradedCompatibility",
    );
    expect(source).toContain("{editing && (");
  });

  it("opens in protected view mode and requires editing before fields unlock", () => {
    expect(source).toContain("const [editing, setEditing] = useState(false)");
    expect(source).toMatch(
      /const editable = Boolean\([\s\S]{0,160}editing &&[\s\S]{0,160}draft &&[\s\S]{0,160}!codeCompatibility/,
    );
    expect(source).toMatch(
      /codeCompatibility[\s\S]{0,160}\? studioUi\(t, "Read only"\)[\s\S]{0,160}: editing[\s\S]{0,120}\? studioUi\(t, "Editing"\)[\s\S]{0,120}: studioUi\(t, "View mode"\)/,
    );
  });

  it("keeps protected definitions fully legible instead of dimming the form", () => {
    expect(source).toContain('className="agent-studio-section-content"');
    expect(source).not.toMatch(
      /!editable[\s\S]{0,120}\["test", "versions"\][\s\S]{0,120}0\.78/,
    );
    expect(source).not.toContain("opacity: disabled ? 0.65 : 1");
    expect(source).toContain("readOnly={disabled}");
    expect(globalCss).toContain(".agent-studio-control:disabled");
    expect(globalCss).toContain("-webkit-text-fill-color: var(--text-2)");
    expect(globalCss).toMatch(
      /\.agent-studio-control:disabled[\s\S]{0,240}opacity: 1/,
    );
  });

  it("uses the Agent Studio readability scale for labels, guidance, and navigation", () => {
    expect(source).toContain('className="agent-studio-shell"');
    expect(fieldsSource).toContain("agent-studio-field-label");
    expect(fieldsSource).toContain("agent-studio-field-hint");
    expect(fieldsSource).toContain("agent-studio-control");
    expect(globalCss).toMatch(
      /\.agent-studio-field-label[\s\S]{0,180}font-size: 12px[\s\S]{0,100}font-weight: 650/,
    );
    expect(globalCss).toMatch(
      /\.agent-studio-field-hint,[\s\S]{0,220}color: var\(--text-2\)[\s\S]{0,100}font-size: 11\.5px/,
    );
    expect(globalCss).toMatch(
      /\.agent-studio-control \{[\s\S]{0,260}font-size: 13px[\s\S]{0,100}font-weight: 500/,
    );
    expect(globalCss).toMatch(
      /\.agent-studio-section-nav-item \{[\s\S]{0,180}color: var\(--text-2\)[\s\S]{0,100}font-size: 12\.5px/,
    );
  });

  it("aligns the Overview settings controls despite different helper lengths", () => {
    expect(source).toContain("agent-studio-overview-settings-grid");
    expect(globalCss).toContain(
      ".agent-studio-overview-settings-grid > .agent-studio-field",
    );
    expect(globalCss).toMatch(
      /\.agent-studio-form-grid > \.agent-studio-field,[\s\S]{0,320}display: flex !important[\s\S]{0,120}flex-direction: column/,
    );
    expect(globalCss).toMatch(
      /\.agent-studio-form-grid[\s\S]{0,420}> \.agent-studio-control \{[\s\S]{0,80}margin-top: auto/,
    );
    expect(globalCss).toMatch(
      /@media \(max-width: 900px\)[\s\S]{0,220}\.agent-studio-overview-settings-grid,[\s\S]{0,160}grid-template-columns: minmax\(0, 1fr\) !important/,
    );
  });

  it("responds to the editor panel width instead of relying only on the viewport", () => {
    expect(source).toContain('className="agent-studio-header-row"');
    expect(source).toContain('className="agent-studio-main-inner"');
    expect(source).toContain(
      'className="agent-studio-form-grid agent-studio-form-grid--2"',
    );
    expect(source).toContain("agent-studio-form-grid--3");
    expect(source).toContain('className="agent-studio-version-row"');
    expect(globalCss).toContain("container: agent-studio / inline-size");
    expect(globalCss).toMatch(
      /@container agent-studio \(max-width: 720px\)[\s\S]*?\.agent-studio-layout,[\s\S]*?grid-template-columns: minmax\(0, 1fr\)/,
    );
    expect(globalCss).toMatch(
      /@container agent-studio \(max-width: 720px\)[\s\S]*?\.agent-studio-section-nav[\s\S]*?overflow-x: auto !important/,
    );
    expect(globalCss).toMatch(
      /@container agent-studio \(max-width: 720px\)[\s\S]*?\.agent-studio-form-grid--2,[\s\S]*?grid-template-columns: minmax\(0, 1fr\) !important/,
    );
    expect(globalCss.indexOf("@media (max-width: 1280px)")).toBeLessThan(
      globalCss.indexOf("@container agent-studio (max-width: 720px)"),
    );
  });

  it("keeps the non-technical help guide readable", () => {
    expect(helpSource).toContain("fontSize: 17");
    expect(helpSource).toContain("fontSize: 12.5");
    expect(helpSource).not.toMatch(/fontSize: (?:9\.5|10)(?:,|})/);
    expect(helpSource).not.toMatch(/var\(--text-[34]\)/);
  });

  it("uses an existing draft or creates one before entering Edit mode", () => {
    expect(source).toMatch(
      /async function startEditing\(\)[\s\S]{0,500}if \(!editor\.data\.draft\)[\s\S]{0,160}makeDraft\(true\)/,
    );
    expect(source).toMatch(
      /editSessionStart\.current = cloneDefinition\(definition\)[\s\S]{0,100}setEditing\(true\)/,
    );
  });

  it("wires Save, Done, and Cancel without silently dropping changes", () => {
    expect(source).toContain("onClick={() => void persist(false)}");
    expect(source).toContain("onClick={() => void finishEditing()}");
    expect(source).toContain("onClick={() => void cancelEditing()}");
    expect(source).toMatch(
      /async function finishEditing\(\)[\s\S]{0,300}dirty && !\(await persist\(true\)\)[\s\S]{0,300}setEditing\(false\)/,
    );
    expect(source).toMatch(
      /async function cancelEditing\(\)[\s\S]{0,2200}persist\(true, cloneDefinition\(original\)\)[\s\S]{0,700}setEditing\(false\)/,
    );
    expect(source).toContain(
      "Changes already saved by autosave will also be safely restored.",
    );

    const persistStart = source.indexOf("const persist = useCallback");
    const autosaveEffectStart = source.indexOf("useEffect(() =>", persistStart);
    const persistSource = source.slice(persistStart, autosaveEffectStart);
    expect(persistStart).toBeGreaterThan(-1);
    expect(autosaveEffectStart).toBeGreaterThan(persistStart);
    expect(
      persistSource,
      "Save must checkpoint the draft without silently leaving Edit mode",
    ).not.toContain("setEditing(false)");
    expect(source).toContain(
      "const savedDuringSession = baseline !== JSON.stringify(original)",
    );
  });

  it("autosaves only while Edit mode is active", () => {
    expect(source).toContain(
      "if (!editing || !autoSave || !dirty || saveInFlight.current) return;",
    );
    expect(source).toContain("disabled={!editing}");
  });

  it("keeps code-defined compatibility agents visibly read-only", () => {
    expect(source).toMatch(
      /codeCompatibility[\s\S]{0,160}\? studioUi\(t, "Read only"\)[\s\S]{0,160}: editing[\s\S]{0,120}\? studioUi\(t, "Editing"\)[\s\S]{0,120}: studioUi\(t, "View mode"\)/,
    );
    expect(source).toMatch(
      /codeCompatibility \?\s*\(\s*<Button[\s\S]{0,320}disabled[\s\S]{0,320}Edit unavailable/,
    );
  });

  it("disables creativity when the selected model rejects temperature", () => {
    expect(source).toContain(
      "const runtimeTemperatureUnsupported = runtimeTemperatureRange === null",
    );
    expect(source).toContain(
      "This saved compatibility value is omitted by the gateway.",
    );
    expect(source).toContain(
      "disabled={!editable || runtimeTemperatureUnsupported}",
    );
    expect(source).toContain('"Not supported — omitted"');
  });

  it("packs draft notices side by side without crowding smaller screens", () => {
    expect(source).toContain("agent-studio-notice-grid--split");
    expect(globalCss).toContain(".agent-studio-notice-grid--split");
    expect(globalCss).toContain(
      "grid-template-columns: repeat(2, minmax(0, 1fr))",
    );
    expect(globalCss).toMatch(
      /@media \(max-width: 1100px\)[\s\S]{0,180}\.agent-studio-notice-grid--split[\s\S]{0,120}grid-template-columns: minmax\(0, 1fr\)/,
    );
  });
});
