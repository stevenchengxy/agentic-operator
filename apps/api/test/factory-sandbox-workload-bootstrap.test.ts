import { afterEach, describe, expect, it, vi } from "vitest";

const gateway = vi.hoisted(() => ({
  calls: 0,
}));

vi.mock("../src/services/llm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/llm")>();
  return {
    ...actual,
    getLLMGateway: () => {
      gateway.calls += 1;
      throw new Error("sandbox workload must not load a production LLM gateway");
    },
  };
});

import { bootstrapSandboxWorkloadRuntime } from "../src/bootstrap";

describe("external sandbox workload bootstrap", () => {
  afterEach(() => {
    delete process.env.SANDBOX_MODEL_PROXY_ORIGIN;
    delete process.env.SANDBOX_MODEL_PROXY_TOKEN;
    delete process.env.SANDBOX_RUNNER_EGRESS_MODE;
    delete process.env.AGENTIC_PROCESS_ROLE;
    delete process.env.SANDBOX_MODEL_PROXY_HTTP_ALLOWED_HOSTS;
  });

  it("starts with an internal semantic proxy and without production LLM credentials", async () => {
    process.env.SANDBOX_MODEL_PROXY_ORIGIN = "http://api.internal";
    process.env.SANDBOX_MODEL_PROXY_TOKEN = "test-only-sandbox-model-proxy-token-32-bytes";
    process.env.SANDBOX_RUNNER_EGRESS_MODE = "deny_all";
    process.env.AGENTIC_PROCESS_ROLE = "sandbox-runner-workload";
    process.env.SANDBOX_MODEL_PROXY_HTTP_ALLOWED_HOSTS = "api.internal";
    const result = await bootstrapSandboxWorkloadRuntime();

    expect(result.functions).toEqual([]);
    expect(gateway.calls).toBe(0);
  });
});
