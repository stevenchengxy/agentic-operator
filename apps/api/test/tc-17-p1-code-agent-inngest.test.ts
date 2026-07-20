/**
 * TC-17 — Phase 1 code-agent Inngest registration (P1-RT-08).
 *
 * Targets:
 *   - `registerCodeAgentFn` builds an InngestFunction with a stable id and the
 *     `__system/code.<name>.invoke` trigger.
 *   - `buildCodeAgentFns` produces functions only for explicit opt-ins.
 *   - `bootstrapCodeAgents()` returns the function map alongside its DB
 *     summary so the API server can splice them into `serve()`.
 *   - `codeAgentEventName` / `codeAgentFnId` helpers return the expected
 *     stable strings the API route uses to enqueue.
 *
 * The API route's `?async=1` path (which sends the event via `inngest.send`)
 * is exercised at the API integration level once the runtime engineer's
 * `apps/api/src/server.ts` import cascade is unblocked. The unit surface
 * here is the registration map — that's the contract every code agent
 * relies on.
 */

import { describe, it, expect, beforeAll } from "vitest";
import path from "node:path";

import {
  BaseAgent,
  agentRegistry,
  bootstrapCodeAgents,
  buildCodeAgentFns,
  codeAgentEventName,
  codeAgentFnId,
  registerCodeAgentFn,
  setGateway,
} from "@agentic/agents";
import type { ChatMessage } from "@agentic/llm-gateway";
import { runMigrations } from "@agentic/db";

class PingAgent extends BaseAgent<{ message?: string }, string> {
  readonly name = "pingAgent";
  readonly description = "Test echo agent for inngest registration.";
  override readonly inngestEnabled = true;
  protected buildMessages({ message }: { message?: string }): ChatMessage[] {
    return [
      { role: "system", content: "Echo." },
      { role: "user", content: message ?? "ping" },
    ];
  }
}

class DirectAgent extends BaseAgent<void, string> {
  readonly name = "directAgent";
  readonly description = "Direct-only code capability.";
  protected buildMessages(): ChatMessage[] {
    return [{ role: "user", content: "direct" }];
  }
}

// Minimal stub gateway so bootstrapCodeAgents has something installed.
const stubGateway = {
  chat: async () => ({
    text: "pong",
    provider: "mock",
    model: "mock-model-v1",
    tokensIn: 1,
    tokensOut: 1,
    finishReason: "stop" as const,
    latencyMs: 0,
  }),
  defaultProvider: "mock",
  defaultModel: "mock-model-v1",
  hasProvider: () => true,
  listProviders: () => [],
};

beforeAll(async () => {
  const repoRoot = path.resolve(__dirname, "../../..");
  runMigrations(path.join(repoRoot, "packages/db/drizzle"));
  setGateway(stubGateway as never);
  agentRegistry.register(new PingAgent());
  agentRegistry.register(new DirectAgent());
  await bootstrapCodeAgents();
});

describe("TC-17: code-agent Inngest registration (P1-RT-08)", () => {
  it("codeAgentEventName / codeAgentFnId return the documented stable strings", () => {
    expect(codeAgentEventName("pingAgent")).toBe(
      "__system/code.pingAgent.invoke",
    );
    expect(codeAgentFnId("pingAgent")).toBe("__system.code.pingAgent");
  });

  it("registerCodeAgentFn returns an InngestFunction with the right id", () => {
    const agent = agentRegistry.get("pingAgent")!;
    const fn = registerCodeAgentFn(agent);
    // Inngest exposes the function id via `.id()` (or `.opts.id` on older
    // versions). Either path returns the same string.
    const idGetter = (fn as unknown as { id: () => string }).id;
    const optsId = (fn as unknown as { opts?: { id?: string } }).opts?.id;
    const fnId = typeof idGetter === "function" ? idGetter.call(fn) : optsId;
    expect(fnId).toBe("__system.code.pingAgent");
  });

  it("buildCodeAgentFns excludes direct-only code agents", () => {
    const fns = buildCodeAgentFns(agentRegistry.list());
    expect(fns).toHaveLength(1);
    expect(() =>
      registerCodeAgentFn(agentRegistry.get("directAgent")!),
    ).toThrow(/not opted into Inngest deployment/);
  });

  it("bootstrapCodeAgents exposes only opted-in codeAgentFns", async () => {
    const summary = await bootstrapCodeAgents();
    expect(Array.isArray(summary.codeAgentFns)).toBe(true);
    expect(summary.codeAgentFns).toHaveLength(1);
    expect(summary.agentCount).toBeGreaterThan(summary.codeAgentFns.length);
  });
});
