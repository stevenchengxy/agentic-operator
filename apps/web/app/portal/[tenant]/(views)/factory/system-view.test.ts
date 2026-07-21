import { describe, expect, it } from "vitest";
import { translate } from "@/lib/i18n";
import { deriveSystemA, type SysBrainEvent } from "./system-view";

const tr = (language: "en" | "zh") =>
  (key: string, vars?: Record<string, string | number>) =>
    translate(language, key, vars);

const events: SysBrainEvent[] = [
  {
    t: "tool.call",
    id: "call-1",
    name: "create_tool",
    reasoning: "Need a reusable connector",
  },
  { t: "subagent.start", task: "认知专家 · compliance" },
  {
    t: "tool.created",
    name: "weather.lookup",
    description: "Fetch weather",
  },
  { t: "tool.result", id: "call-1", ok: true },
  {
    t: "sandbox",
    simulated: false,
    fullChainRan: true,
    functionsRegistered: 2,
    ran: 1,
  },
];

describe("deriveSystemA i18n", () => {
  it("projects user-facing role and transcript labels in English", () => {
    const view = deriveSystemA(tr("en"), events, false);
    const asset = view.roles.find((role) => role.id === "asset");
    const sandbox = view.roles.find((role) => role.id === "sandbox");

    expect(asset?.name).toBe("Assets");
    expect(asset?.transcript.map((item) => item.label)).toEqual([
      "create_tool",
      "Spawn compliance",
      "Create tool weather.lookup",
    ]);
    expect(sandbox?.transcript[0]).toMatchObject({
      label: "Real sandbox deployment",
      detail: "Deployed 2 · Ran 1",
    });
  });

  it("keeps protocol detection stable while projecting Chinese labels", () => {
    const view = deriveSystemA(tr("zh"), events, false);
    const asset = view.roles.find((role) => role.id === "asset");

    expect(view.specialists).toBe(1);
    expect(asset?.name).toBe("资产角色");
    expect(asset?.transcript.map((item) => item.label)).toEqual([
      "create_tool",
      "派生 compliance",
      "造工具 weather.lookup",
    ]);
  });
});
