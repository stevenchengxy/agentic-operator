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
const globalCss = readFileSync(
  resolve(__dirname, "..", "..", "..", "global.css"),
  "utf8",
);

describe("Agent Studio edit-mode wiring", () => {
  it("opens in protected view mode and requires editing before fields unlock", () => {
    expect(source).toContain("const [editing, setEditing] = useState(false)");
    expect(source).toMatch(
      /const editable = Boolean\([\s\S]{0,160}editing &&[\s\S]{0,160}draft &&[\s\S]{0,160}!codeCompatibility/,
    );
    expect(source).toMatch(
      /codeCompatibility[\s\S]{0,120}\? "Read only"[\s\S]{0,120}: editing[\s\S]{0,80}\? "Editing"[\s\S]{0,80}: "View mode"/,
    );
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
      /async function cancelEditing\(\)[\s\S]{0,1400}persist\(true, cloneDefinition\(original\)\)[\s\S]{0,500}setEditing\(false\)/,
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
      /codeCompatibility[\s\S]{0,120}\? "Read only"[\s\S]{0,120}: editing[\s\S]{0,80}\? "Editing"[\s\S]{0,80}: "View mode"/,
    );
    expect(source).toMatch(
      /codeCompatibility \?\s*\(\s*<Button[\s\S]{0,220}disabled[\s\S]{0,220}Edit unavailable/,
    );
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
