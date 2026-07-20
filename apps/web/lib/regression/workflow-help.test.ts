/**
 * Structural regression coverage for the production Workflows guide.
 *
 * The Workflows page depends on the App Router, tenant context, React Query,
 * and live API data, while the web unit-test environment intentionally has no
 * DOM harness. Browser QA exercises the rendered modal; these assertions keep
 * the discoverability and core non-technical content from being lost during a
 * page refactor.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const WEB_ROOT = resolve(__dirname, "..", "..");
const REPO_ROOT = resolve(WEB_ROOT, "..", "..");

function readWeb(relativePath: string): string {
  return readFileSync(resolve(WEB_ROOT, relativePath), "utf8");
}

describe("production Workflows user guide", () => {
  const page = readWeb("app/portal/[tenant]/(views)/workflows/page.tsx");
  const guide = readWeb("app/portal/components/workflows/WorkflowHelp.tsx");
  const markdown = readFileSync(
    resolve(REPO_ROOT, "docs/user-guides/workflows.md"),
    "utf8",
  );

  it("keeps Help discoverable in both view and edit action sets", () => {
    expect(page).toContain(
      'import { WorkflowHelp } from "@/app/portal/components/workflows/WorkflowHelp"',
    );
    expect(page.match(/key="help"/g)).toHaveLength(2);
    expect(page).toContain("<WorkflowHelp");
    expect(page).toContain("open={showHelp}");
    expect(page).toContain("onClose={() => setShowHelp(false)}");
  });

  it("shows real draft counts and markers instead of example edit state", () => {
    expect(page).toContain("<EditDraftBanner counts={draftCounts} />");
    expect(page).toContain("draft.added.has(a.kebabId)");
    expect(page).toContain("draft.agents[a.kebabId]");
    expect(page).not.toContain('a.kebabId === "10-1"');
  });

  it("keeps agent creation and complete agent editing on the canvas", () => {
    const inspectors = readWeb(
      "app/portal/components/workflows/inspectors.tsx",
    );
    expect(page).toContain('onAddAgent={() => addAgent("Agent")}');
    expect(inspectors).toContain('aria-label="Add agent"');
    expect(page).toContain("onDoubleClick={(event) =>");
    expect(page).toContain("expandAgentPanel(a.kebabId)");
    expect(page).toContain("Double-click to expand");
    expect(page).toContain("<Splitter");
    expect(page).toContain("onToggleWidth={toggleAgentPanelWidth}");
    expect(page).not.toContain("async function navAgent(id: string)");
    expect(page).not.toContain("createWorkflowAgentDraft.mutateAsync");
  });

  it("uses panel-aware hooks for the selector, canvas, and inspector", () => {
    const responsiveStyles = readWeb(
      "app/portal/[tenant]/(views)/workflows/workflow.module.css",
    );
    expect(page).toContain("className={styles.selectorBar}");
    expect(page).toContain("className={styles.workspace}");
    expect(page).toContain("className={styles.canvas}");
    expect(page).toContain("className={styles.inspector}");
    expect(responsiveStyles).toContain("container-name: workflow-page");
    expect(responsiveStyles).toContain(
      "@container workflow-page (max-width: 860px)",
    );
    expect(responsiveStyles).toContain("grid-template-columns: minmax(0, 1fr)");
  });

  it("explains the workflow lifecycle and fields in plain language", () => {
    expect(guide).toContain("A workflow is a shared plan");
    expect(guide).toContain("Change a draft, not the live workflow");
    expect(guide).toContain("Every workflow field in plain language");
    expect(guide).toContain("Canvas and inspector");
    expect(guide).toContain("Edit-mode fields and actions");
    expect(guide).toContain("New workflow fields");
  });

  it("includes two realistic worked examples and actionable troubleshooting", () => {
    expect(guide).toContain("Customer support triage");
    expect(guide).toContain("Invoice approval");
    expect(guide).toContain("The canvas looks empty");
    expect(guide).toContain("A box never starts");
    expect(guide).toContain("Draft test failed");
    expect(guide).toContain("Publication failed");
    expect(guide).toContain("Stop before publishing when");
  });

  it("ships the durable guide with the same lifecycle, examples, and glossary", () => {
    expect(markdown).toContain("## Run and test a workflow");
    expect(markdown).toContain("## Edit a workflow safely");
    expect(markdown).toContain("## Worked example 1: customer support triage");
    expect(markdown).toContain("## Worked example 2: invoice approval");
    expect(markdown).toContain("## Troubleshooting");
    expect(markdown).toContain("## Glossary");
    expect(markdown).toContain("## Before publishing: quick checklist");
  });
});
