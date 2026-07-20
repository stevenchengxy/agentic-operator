import { describe, expect, it } from "vitest";
import { AGENT_FACTORY_DOMAIN_KEYS } from "./useAgentFactoryDomains";

describe("agent factory domain query keys", () => {
  it("isolates persisted bindings in the React Query cache by runtime tenant", () => {
    expect(AGENT_FACTORY_DOMAIN_KEYS.tenant("tenant-a"))
      .not.toEqual(AGENT_FACTORY_DOMAIN_KEYS.tenant("tenant-b"));
    expect(AGENT_FACTORY_DOMAIN_KEYS.tenant("tenant-a").slice(0, 1))
      .toEqual(AGENT_FACTORY_DOMAIN_KEYS.all);
  });
});
