import { describe, expect, it } from "vitest";
import { registerTestAgentForEnvironment } from "./test-agent-policy";

function registration(nodeEnv: string | undefined) {
  const registered: string[] = [];
  let created = 0;
  const enabled = registerTestAgentForEnvironment({
    env: nodeEnv === undefined ? {} : { NODE_ENV: nodeEnv },
    create: () => {
      created += 1;
      return "testAgent";
    },
    register: (agent) => registered.push(agent),
  });
  return { enabled, created, registered };
}

describe("testAgent registration policy", () => {
  it("is disabled in every non-test process", () => {
    expect(registration("production")).toEqual({ enabled: false, created: 0, registered: [] });
    expect(registration("development")).toEqual({ enabled: false, created: 0, registered: [] });
    expect(registration(undefined)).toEqual({ enabled: false, created: 0, registered: [] });
  });

  it("is enabled only for the explicit test harness", () => {
    expect(registration("test")).toEqual({
      enabled: true,
      created: 1,
      registered: ["testAgent"],
    });
  });
});
