import { describe, expect, it } from "vitest";
import { isSystemScopedAgent } from "../src/config/system-agents";

describe("system-agent scope", () => {
  it("does not route testAgent into the production system tenant", () => {
    expect(isSystemScopedAgent("testAgent", { NODE_ENV: "production" })).toBe(
      false,
    );
    expect(isSystemScopedAgent("testAgent", { NODE_ENV: "development" })).toBe(
      false,
    );
  });

  it("keeps the isolated test harness routing", () => {
    expect(isSystemScopedAgent("testAgent", { NODE_ENV: "test" })).toBe(true);
  });

  it("keeps platform utilities out of every business-domain catalog", () => {
    for (const mode of ["production", "development", "test"] as const) {
      expect(isSystemScopedAgent("reasoningAgent", { NODE_ENV: mode })).toBe(
        true,
      );
      expect(isSystemScopedAgent("reportGenerator", { NODE_ENV: mode })).toBe(
        true,
      );
    }
  });
});
