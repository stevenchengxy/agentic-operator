import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const webRoot = resolve(__dirname, "..", "..");
const page = readFileSync(
  resolve(webRoot, "app/portal/[tenant]/(views)/workflows/page.tsx"),
  "utf8",
);
const inspectors = readFileSync(
  resolve(webRoot, "app/portal/components/workflows/inspectors.tsx"),
  "utf8",
);
const editor = readFileSync(
  resolve(webRoot, "app/portal/components/workflows/AgentEditor.tsx"),
  "utf8",
);
const runConsole = readFileSync(
  resolve(webRoot, "app/portal/components/workflows/WorkflowRunConsole.tsx"),
  "utf8",
);
const runConsoleStyles = readFileSync(
  resolve(
    webRoot,
    "app/portal/components/workflows/WorkflowRunConsole.module.css",
  ),
  "utf8",
);
const styles = readFileSync(
  resolve(webRoot, "app/portal/[tenant]/(views)/workflows/workflow.module.css"),
  "utf8",
);

describe("enterprise workflow canvas authoring", () => {
  it("supports pointer-captured node movement and keyboard nudging", () => {
    expect(page).toContain("setPointerCapture(event.pointerId)");
    expect(page).toContain("nodePositionFromPointer(");
    expect(page).toContain("onPointerMove={updateNodeDrag}");
    expect(page).toContain(
      "onKeyDown={(event) => nudgeNode(event, a.kebabId)}",
    );
    expect(page).toContain('event.key !== "Escape"');
  });

  it("supports visible port-to-port link dragging with a keyboard alternative", () => {
    expect(page).toContain("data-workflow-input={a.kebabId}");
    expect(page).toContain("onPointerDown={(event) =>");
    expect(page).toContain("beginLinkDrag(event, a.kebabId)");
    expect(page).toContain("className={styles.connectionPreview}");
    expect(page).toContain("connectPair(connectFrom, a.kebabId)");
    expect(page).toContain("connectNode(a.kebabId)");
  });

  it("accepts palette drops at the canvas pointer position", () => {
    expect(inspectors).toContain(
      "event.dataTransfer.setData(WORKFLOW_AGENT_DRAG_TYPE, actor)",
    );
    expect(page).toContain("event.dataTransfer.getData(");
    expect(page).toContain("WORKFLOW_AGENT_DRAG_TYPE");
    expect(page).toContain("x: point.x - NODE_W / 2");
    expect(page).toContain("y: point.y - NODE_H / 2");
  });

  it("keeps canvas guidance outside the scrollable coordinate plane", () => {
    const shell = page.indexOf("className={styles.canvasShell}");
    const coach = page.indexOf("className={styles.canvasCoach}", shell);
    const canvas = page.indexOf("className={styles.canvas}", shell);
    expect(shell).toBeGreaterThan(-1);
    expect(coach).toBeGreaterThan(shell);
    expect(canvas).toBeGreaterThan(coach);
    expect(styles).toMatch(/\.canvasCoach\s*\{[^}]*position:\s*absolute;/s);
    expect(styles).toMatch(/\.dropHint\s*\{[^}]*position:\s*absolute;/s);
  });

  it("keeps complete agent settings in a resizable in-canvas panel", () => {
    expect(page).toContain("<Splitter");
    expect(page).toContain('axis="x"');
    expect(page).toContain('ariaLabel={t("workflowPage.resizeAria")}');
    expect(page).toContain("expandAgentPanel(a.kebabId)");
    expect(page).toContain("onToggleWidth={toggleAgentPanelWidth}");
    expect(page).not.toContain("async function navAgent(id: string)");
    expect(page).not.toContain("agentStudioWorkflowHref({");
    expect(styles).toContain("--workflow-inspector-width");
    expect(styles).toContain(".inspectorSplitter");
    expect(editor).toContain('t("agentEditor.completeSettings")');
    expect(editor).toContain('t("agentEditor.generatePrompt")');
    expect(editor).toContain('label={t("agentEditor.provider")}');
    expect(editor).toContain('label={t("agentEditor.concurrencyLimit")}');
    expect(editor).toContain('label={t("agentEditor.reasoningMode")}');
    expect(editor).toContain('label={t("agentEditor.traceLevel")}');
    expect(editor).toContain('label={t("agentEditor.artifactFilename")}');
  });

  it("keeps enterprise draft/live execution and evidence on the workflow page", () => {
    expect(page).toContain(
      'import { WorkflowRunConsole } from "@/app/portal/components/workflows/WorkflowRunConsole"',
    );
    expect(page.match(/setShowRunConsole\(true\)/g)).toHaveLength(2);
    expect(page).toContain("<WorkflowRunConsole");
    expect(runConsole).toContain('t("workflowRunConsole.currentDraftTest")');
    expect(runConsole).toContain('t("workflowRunConsole.publishedLive")');
    expect(runConsole).toContain('t("workflowRunConsole.toolEffects")');
    expect(runConsole).toContain('t("workflowRunConsole.failurePolicy")');
    expect(runConsole).toContain('t("workflowRunConsole.agentTrace")');
    expect(runConsole).toContain('t("workflowRunConsole.terminalOutputs")');
    expect(runConsole).toContain('t("workflowRunConsole.copyJson")');
    expect(runConsole).toContain('t("workflowRunConsole.examplePayload")');
    expect(runConsole).toContain('t("workflowRunConsole.loadExample")');
    expect(runConsole).toContain('t("workflowRunConsole.expectedFields")');
    expect(runConsole).toContain(
      't("workflowRunConsole.advancedPayloadOverlay")',
    );
    expect(runConsole).toContain("buildWorkflowPayloadGuide");
    expect(runConsoleStyles).toContain(".payloadRecipe");
    expect(runConsoleStyles).toContain(".rawPayloadHelp");
    expect(runConsoleStyles).toContain("@media (max-width: 900px)");
    expect(runConsoleStyles).toContain("grid-template-columns: minmax(0, 1fr)");
  });

  it("draws event links directly from the edited trigger and emit fields", () => {
    expect(page).toContain("deriveEventEdges(agents)");
    expect(page).toContain("previousDerivedEdgesRef");
    expect(page).toContain('t("workflowPage.announcement.autoLinked"');
    expect(page).toContain("workflowAgents={agents}");
  });
});
