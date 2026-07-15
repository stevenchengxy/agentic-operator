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
    expect(guide).toContain("Deployment failed");
    expect(guide).toContain("Stop before deploying when");
  });

  it("ships the durable guide with the same lifecycle, examples, and glossary", () => {
    expect(markdown).toContain("## Edit a workflow safely");
    expect(markdown).toContain("## Worked example 1: customer support triage");
    expect(markdown).toContain("## Worked example 2: invoice approval");
    expect(markdown).toContain("## Troubleshooting");
    expect(markdown).toContain("## Glossary");
    expect(markdown).toContain("## Before deploying: quick checklist");
  });
});
