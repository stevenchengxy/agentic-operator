import { describe, expect, it } from "vitest";
import { LLM_SETTINGS_KEYS } from "./useLlmSettings";
import { FLEET_KEYS } from "./useModelFleet";

describe("tenant-scoped LLM query keys", () => {
  it("isolates settings snapshots and discovered gateway models by tenant", () => {
    expect(LLM_SETTINGS_KEYS.snapshot("tenant-a")).not.toEqual(
      LLM_SETTINGS_KEYS.snapshot("tenant-b"),
    );
    expect(LLM_SETTINGS_KEYS.gatewayModels("tenant-a", "newapi-csi")).toEqual(
      ["llm", "gateways", "tenant-a", "newapi-csi", "models"],
    );
  });

  it("isolates fleet and available-model caches by tenant", () => {
    expect(FLEET_KEYS.list("tenant-a")).not.toEqual(
      FLEET_KEYS.list("tenant-b"),
    );
    expect(FLEET_KEYS.available("tenant-a", "openai")).toEqual([
      "llm",
      "available-models",
      "tenant-a",
      "openai",
    ]);
  });
});
