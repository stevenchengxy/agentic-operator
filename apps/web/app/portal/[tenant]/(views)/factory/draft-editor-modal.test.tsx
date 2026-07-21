import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { PreferencesProvider } from "@/app/portal/lib/preferences-context";

import { DraftEditorModal } from "./draft-editor-modal";
import type { DraftEditorContract } from "./draft-editor";

const contract: DraftEditorContract = {
  schema: "agent-factory-draft-editor/v1",
  scope: {
    tenantId: "ten-one",
    tenantSlug: "tenant-one",
    domain: "domain-one",
    slug: "work-agent",
    versionId: "v-one",
  },
  fields: [{
    key: "trigger",
    label: "消费事件",
    help: "由 Ontology Action 的触发事件生成。",
    valueType: "string_array",
    editable: false,
    readonlyReason: "这个字段来自 Allmeta Ontology。请先更新 Allmeta Ontology 后重新生成。",
    unsettable: false,
    present: true,
    valueStatus: "available",
    value: ["WORK_REQUESTED"],
  }],
  evidenceEffect: {
    carriedForward: false,
    invalidatedForNewVersion: ["human_review", "sandbox", "regression", "promotion_preview"],
    requiredNext: ["human_review", "sandbox_replay", "promotion_preview"],
  },
};

describe("Factory draft editor modal read-only fields", () => {
  it("shows the Ontology reason and disables both value editing and save", () => {
    vi.stubGlobal("React", React);
    const html = renderToStaticMarkup(
      <PreferencesProvider>
        <DraftEditorModal contract={contract} onClose={vi.fn()} onSave={vi.fn()} />
      </PreferencesProvider>,
    );

    expect(html).toContain("ontology, read-only");
    expect(html).toContain("先更新 Allmeta Ontology 后重新生成");
    expect(html).toMatch(/<textarea[^>]*id="factory-draft-edit-value"[^>]*disabled=""/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Confirm and create new version<\/button>/);
    vi.unstubAllGlobals();
  });
});
