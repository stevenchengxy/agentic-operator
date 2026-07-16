import { describe, expect, it } from "vitest";
import {
  agentStudioWorkflowHref,
  readWorkflowReturnState,
  storeWorkflowReturnState,
  workflowCanvasHref,
} from "./workflow-navigation";

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();
  get length() {
    return this.values.size;
  }
  clear() {
    this.values.clear();
  }
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  key(index: number) {
    return Array.from(this.values.keys())[index] ?? null;
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

describe("workflow editor return navigation", () => {
  it("stores tenant-scoped canvas state and rejects a foreign tenant", () => {
    const storage = new MemoryStorage();
    const token = storeWorkflowReturnState(
      {
        tenant: "acme",
        workflowSlug: "support",
        workflowVersionId: "wfv-1",
        selectedAgent: "triage",
        editing: true,
        tool: "select",
        zoom: 0.8,
        scrollLeft: 120,
        scrollTop: 80,
      },
      storage,
    );

    expect(readWorkflowReturnState(token, "acme", { storage })).toMatchObject({
      workflowSlug: "support",
      selectedAgent: "triage",
      zoom: 0.8,
    });
    expect(readWorkflowReturnState(token, "other", { storage })).toBeNull();
  });

  it("rejects expired or malformed return state", () => {
    const storage = new MemoryStorage();
    const token = storeWorkflowReturnState(
      {
        tenant: "acme",
        workflowSlug: "support",
        workflowVersionId: null,
        selectedAgent: "triage",
        editing: true,
        tool: "connect",
        zoom: 1,
        scrollLeft: 0,
        scrollTop: 0,
      },
      storage,
    )!;
    const current = readWorkflowReturnState(token, "acme", { storage })!;

    expect(
      readWorkflowReturnState(token, "acme", {
        storage,
        now: current.createdAt + 13 * 60 * 60 * 1_000,
      }),
    ).toBeNull();
    expect(
      readWorkflowReturnState("../unsafe", "acme", { storage }),
    ).toBeNull();
  });

  it("builds explicit editor and canvas URLs without arbitrary return paths", () => {
    expect(
      agentStudioWorkflowHref({
        tenant: "acme",
        agentId: "support triage",
        workflowSlug: "support",
        resumeToken: "return-token",
        agentDraftId: "agd-1",
      }),
    ).toBe(
      "/portal/acme/agents/support%20triage?edit=1&from=workflow&workflow=support&resume=return-token&draftId=agd-1",
    );
    expect(
      workflowCanvasHref({
        tenant: "acme",
        workflowSlug: "support",
        agentId: "triage",
        resumeToken: "return-token",
        agentDraftId: "agd-1",
      }),
    ).toBe(
      "/portal/acme/workflows?workflow=support&mode=edit&agent=triage&resume=return-token&agentDraft=agd-1",
    );
  });
});
