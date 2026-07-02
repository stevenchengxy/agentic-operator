import { describe, it, expect } from "vitest";
import { makeDeliveredRuntime } from "@agentic/runtime";
import { isAgentRuntime, type MemoryHandle } from "@agentic/agent-sdk";

// #REDESIGN FU1 — the DELIVERED (Inngest) adapter provides the SAME unified AgentRuntime socket the
// CodeAct (runtime) tier does. This proves the power-strip: `makeDeliveredRuntime` satisfies
// `isAgentRuntime`, its memory delegates to the injected durable MemoryHandle, emit/invoke route to
// the injected durable primitives, and spawn — which has no ephemeral code-gen on the delivered tier
// — DECOMPOSES VIA invoke.

function fakeMemory(): { handle: MemoryHandle; store: Map<string, unknown> } {
  const store = new Map<string, unknown>();
  const handle: MemoryHandle = {
    async get<T = unknown>(key: string): Promise<T | null> { return store.has(key) ? (store.get(key) as T) : null; },
    async put<T = unknown>(key: string, value: T): Promise<void> { store.set(key, value); },
    async delete(key: string): Promise<void> { store.delete(key); },
    async search(): Promise<never[]> { return []; },
  };
  return { handle, store };
}

describe("#REDESIGN FU1 — delivered adapter provides a valid AgentRuntime socket", () => {
  it("satisfies isAgentRuntime (identical shape to the CodeAct tier)", () => {
    const { handle } = fakeMemory();
    const rt = makeDeliveredRuntime({
      agentName: "PublishJd", tenantSlug: "raas", correlationId: "cid-1", subject: "req-9",
      memory: handle,
      reason: async () => ({ ok: true }),
      toolRun: async () => ({ done: true }),
      emit: () => {},
      invoke: async () => ({ from: "sibling" }),
    });
    expect(isAgentRuntime(rt)).toBe(true);
    expect(rt.agentName).toBe("PublishJd");
    expect(rt.tenantSlug).toBe("raas");
    expect(rt.correlationId).toBe("cid-1");
    expect(rt.subject).toBe("req-9");
    expect(typeof rt.tools?.run).toBe("function"); // back-compat alias present
  });

  it("memory delegates to the injected durable handle; emit + invoke route to injected primitives", async () => {
    const { handle, store } = fakeMemory();
    const emitted: Array<{ event: string; payload: Record<string, unknown> }> = [];
    let invokedWith: { ref: string; input: unknown } | null = null;
    const rt = makeDeliveredRuntime({
      agentName: "a", tenantSlug: "t", correlationId: "c",
      memory: handle,
      reason: async () => ({ ok: true }),
      toolRun: async (name) => ({ tool: name }),
      emit: (event, payload) => emitted.push({ event, payload }),
      invoke: async (ref, input) => { invokedWith = { ref, input }; return { ok: true }; },
    });

    await rt.memory.put("plan", { step: 2 });
    expect(store.get("plan")).toEqual({ step: 2 });
    expect(await rt.memory.get("plan")).toEqual({ step: 2 });

    rt.emit("JD_PUBLISHED", { jobId: "j1" });
    expect(emitted).toEqual([{ event: "JD_PUBLISHED", payload: { jobId: "j1" } }]);

    await rt.invoke("EvaluateInterview", { candidate: "x" });
    expect(invokedWith).toEqual({ ref: "EvaluateInterview", input: { candidate: "x" } });

    expect(await rt.tool("matchResume", { r: 1 })).toEqual({ tool: "matchResume" });
  });

  it("spawn DECOMPOSES VIA invoke on the delivered tier (ok when the sibling resolves, error when it doesn't)", async () => {
    const { handle } = fakeMemory();
    const rtOk = makeDeliveredRuntime({
      agentName: "a", tenantSlug: "t", correlationId: "c", memory: handle,
      reason: async () => ({}), toolRun: async () => ({}), emit: () => {},
      invoke: async () => ({ result: "done" }),
    });
    const s1 = await rtOk.spawn("SubTask", { x: 1 });
    expect(s1.ok).toBe(true);
    expect(s1.data).toEqual({ result: "done" });

    const rtMiss = makeDeliveredRuntime({
      agentName: "a", tenantSlug: "t", correlationId: "c", memory: handle,
      reason: async () => ({}), toolRun: async () => ({}), emit: () => {},
      invoke: async () => null, // unresolved sibling
    });
    const s2 = await rtMiss.spawn("Unknown");
    expect(s2.ok).toBe(false);
    expect(s2.error).toMatch(/invoke/);
  });
});
