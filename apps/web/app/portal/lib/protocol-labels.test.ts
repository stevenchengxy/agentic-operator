import { describe, expect, it } from "vitest";
import type { Translate } from "./preferences-context";
import {
  agentKindLabel,
  runStatusLabel,
  workflowStatusLabel,
  workflowTestStatusLabel,
} from "./protocol-labels";

const t = ((key: string) => `translated:${key}`) as Translate;

describe("protocol labels", () => {
  it("translates known protocol values", () => {
    expect(runStatusLabel(t, "running")).toBe(
      "translated:protocol.runStatus.running",
    );
    expect(workflowTestStatusLabel(t, "partial")).toBe(
      "translated:protocol.testStatus.partial",
    );
    expect(workflowStatusLabel(t, "live")).toBe(
      "translated:protocol.workflowStatus.live",
    );
    expect(agentKindLabel(t, "manifest")).toBe(
      "translated:protocol.agentKind.manifest",
    );
  });

  it("preserves unknown values verbatim", () => {
    expect(runStatusLabel(t, "future_status")).toBe("future_status");
    expect(workflowTestStatusLabel(t, "FUTURE")).toBe("FUTURE");
    expect(workflowStatusLabel(t, "archived-v2")).toBe("archived-v2");
    expect(agentKindLabel(t, "remote")).toBe("remote");
  });
});
