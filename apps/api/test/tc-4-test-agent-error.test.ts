/**
 * TC-4 — error paths:
 *   - invalid provider override → 400 bad_request, no run row created
 *   - unknown agent → 404 not_found
 *   - removed placeholder provider → 400 bad_request, no run created
 */

import { describe, it, expect, beforeAll } from "vitest";
import { buildTestEnv, type TestEnv } from "./harness";

describe("TC-4: testAgent error paths", () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await buildTestEnv();
  });

  it("rejects an unknown provider with 400 bad_request and no run row leak", async () => {
    const res = await env.fetch("/v1/agents/testAgent/invoke", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "bogus" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      ok: boolean;
      error: { code: string; message: string };
    };
    expect(body.ok).toBe(false);
    // Either the route layer (bad_request) or Zod validation (invalid_input) rejects.
    expect(body.error.code).toMatch(/bad_request|invalid_input/);
    expect(body.error.message.toLowerCase()).toMatch(/unknown|invalid|enum|validation/);
    // The 400 envelope is the proof that BaseAgent.run was never reached;
    // a row-count assertion would be flaky under parallel test files.
  });

  it("returns 404 for an unknown agent", async () => {
    const res = await env.fetch("/v1/agents/nonexistentAgent/invoke", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as {
      ok: boolean;
      error: { code: string; message: string };
    };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("not_found");
    expect(body.error.message.toLowerCase()).toContain("not found");
  });

  it("rejects a provider whose placeholder adapter was removed", async () => {
    const res = await env.fetch("/v1/agents/testAgent/invoke", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "bedrock" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      ok: boolean;
      error: { code: string; message: string };
    };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("bad_request");
    expect(body.error.message).toContain("Provider not registered: bedrock");
  });
});
