import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@agentic/llm-gateway";

import { BaseAgent } from "./base-agent";
import { resolveCodeRevision } from "./bootstrap";
import { AgentRegistry } from "./registry";
import {
  ReportAgent,
  ReportOutputError,
} from "./system/report-agent";

class RevisionA extends BaseAgent<void, string> {
  readonly name = "revision-test";
  readonly description = "revision A";
  protected buildMessages(): ChatMessage[] {
    return [{ role: "user", content: "A" }];
  }
}

class RevisionB extends BaseAgent<void, string> {
  readonly name = "revision-test";
  readonly description = "revision B";
  protected buildMessages(): ChatMessage[] {
    return [{ role: "user", content: "B" }];
  }
}

describe.sequential("code-agent truth guards", () => {
  it("rejects duplicate production registrations", () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const registry = new AgentRegistry();
      registry.register(new RevisionA());
      expect(() => registry.register(new RevisionB())).toThrow(
        /Duplicate code-agent registration/,
      );
    } finally {
      if (previous === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previous;
    }
  });

  it("derives a changing local revision instead of the hard-coded code-dev version", () => {
    const previous = process.env.GIT_SHA;
    delete process.env.GIT_SHA;
    try {
      const a = resolveCodeRevision([new RevisionA()]);
      const b = resolveCodeRevision([new RevisionB()]);
      expect(a).toMatch(/^local-[a-f0-9]{16}$/);
      expect(b).toMatch(/^local-[a-f0-9]{16}$/);
      expect(a).not.toBe(b);
    } finally {
      if (previous === undefined) delete process.env.GIT_SHA;
      else process.env.GIT_SHA = previous;
    }
  });
});

describe("ReportAgent output truth", () => {
  const agent = new ReportAgent();

  it("accepts a complete self-contained HTML document", async () => {
    const result = await agent._parseOutput(
      "<!DOCTYPE html><html><head><title>Truth</title><style>body{color:#111}</style></head><body><h1>Truth</h1></body></html>",
      { tenantSlug: "__system", correlationId: "cor-test" },
    );
    expect(result.title).toBe("Truth");
    expect(result.html).toMatch(/^<!DOCTYPE html>/i);
  });

  it("rejects prose/partial HTML instead of returning a successful report", async () => {
    await expect(
      agent._parseOutput("Here is your report: <h1>Summary</h1>", {
        tenantSlug: "__system",
        correlationId: "cor-test",
      }),
    ).rejects.toBeInstanceOf(ReportOutputError);
  });

  it("rejects external resources in a purported self-contained report", async () => {
    await expect(
      agent._parseOutput(
        '<!DOCTYPE html><html><head><title>Remote</title></head><body><img src="https://example.com/chart.png"></body></html>',
        { tenantSlug: "__system", correlationId: "cor-test" },
      ),
    ).rejects.toThrow(/external resources/);
  });
});
