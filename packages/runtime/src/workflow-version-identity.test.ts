import { describe, expect, it } from "vitest";

import {
  canonicalWorkflowVersionId,
  legacyWorkflowVersionId,
  workflowVersionContentMatches,
  workflowVersionIdentityKind,
} from "./workflow-version-identity";

describe("workflow version content identity", () => {
  const manifest = [{ id: "agent-a", actions: [{ order: "1" }] }];
  const actions = [{ id: "document-a" }];

  it("uses the full canonical manifest+actions digest for new versions", () => {
    const version = canonicalWorkflowVersionId(manifest, actions);
    expect(version).toMatch(/^auto-[a-f0-9]{64}$/);
    expect(
      canonicalWorkflowVersionId(
        [{ actions: [{ order: "1" }], id: "agent-a" }],
        [{ id: "document-a" }],
      ),
    ).toBe(version);
    expect(canonicalWorkflowVersionId(manifest, [{ id: "changed" }]))
      .not.toBe(version);
  });

  it("reuses a legacy short version only for exact canonical content", () => {
    const legacy = legacyWorkflowVersionId(manifest);
    expect(legacy).toMatch(/^auto-[a-f0-9]{8}$/);
    expect(workflowVersionIdentityKind(legacy, manifest, actions)).toBe(
      "legacy",
    );
    expect(
      workflowVersionContentMatches(
        { manifestJson: manifest, actionsJson: actions },
        manifest,
        actions,
      ),
    ).toBe(true);
    // A stored short-id collision must never be overwritten or reused.
    expect(
      workflowVersionContentMatches(
        {
          manifestJson: [{ id: "different-agent" }],
          actionsJson: actions,
        },
        manifest,
        actions,
      ),
    ).toBe(false);
  });
});
