import { describe, expect, it } from "vitest";
import {
  reasoningAgentHref,
  reasoningWorkspaceTenant,
} from "./reasoning-workspace";

describe("standalone Reasoning workspace routing", () => {
  it.each(["raas", "zhaopin"])(
    "keeps a configured tenant in its own workspace: %s",
    (tenant) => {
      expect(reasoningWorkspaceTenant(tenant)).toBe(tenant);
      expect(reasoningAgentHref(tenant)).toBe(
        `/portal/${tenant}/reasoning-agent`,
      );
    },
  );

  it.each(["agents-generation", "__system", "unconfigured-tenant"])(
    "routes an unconfigured tenant to the dedicated RAAS workspace: %s",
    (tenant) => {
      expect(reasoningWorkspaceTenant(tenant)).toBe("raas");
      expect(reasoningAgentHref(tenant)).toBe("/portal/raas/reasoning-agent");
    },
  );
});
