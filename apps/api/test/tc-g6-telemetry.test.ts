/**
 * TC-G6 — 双推理面统一遥测：llm-gateway（系统 B 的推理面）的每次 chat 成/败都经
 * setGatewayCallSink 出一条记录（provider/model/latency/purpose 归因），与系统 A 的
 * stream-gateway 并表进 llm_calls。这里用 mock provider 锁 sink 契约（零网络）。
 */

import { describe, it, expect, afterEach } from "vitest";
import { LLMGateway, registerAllProviders, resolveConfig, setGatewayCallSink, type GatewayCallRecord } from "@agentic/llm-gateway";

function mkGateway(): LLMGateway {
  const { gateway: cfg, adapterEnv } = resolveConfig({ LLM_DEFAULT_PROVIDER: "mock", LLM_DEFAULT_MODEL: "mock-model-v1" });
  const g = new LLMGateway(cfg);
  registerAllProviders(g, adapterEnv);
  return g;
}

afterEach(() => setGatewayCallSink(null));

describe("TC-G6: gateway call sink", () => {
  it("成功调用出一条 ok 记录（provider/servedModel/latency/purpose 齐全）", async () => {
    const recs: GatewayCallRecord[] = [];
    setGatewayCallSink((r) => recs.push(r));
    const g = mkGateway();
    const res = await g.chat({ messages: [{ role: "user", content: "ping" }], purpose: "agent:testAgent" });
    expect(res.text.length).toBeGreaterThan(0);
    expect(recs).toHaveLength(1);
    const r = recs[0]!;
    expect(r.ok).toBe(true);
    expect(r.provider).toBe("mock");
    expect(r.servedModel).toBeTruthy();
    expect(r.purpose).toBe("agent:testAgent");
    expect(r.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("终态失败也出一条 ok:false 记录（failureReason 携带错误码）", async () => {
    const recs: GatewayCallRecord[] = [];
    setGatewayCallSink((r) => recs.push(r));
    const g = mkGateway();
    await expect(
      g.chat({ messages: [{ role: "user", content: "x" }], provider: "anthropic" }), // 无 key → 终态失败
    ).rejects.toThrow();
    expect(recs).toHaveLength(1);
    expect(recs[0]!.ok).toBe(false);
    expect(recs[0]!.failureReason).toBeTruthy();
  });

  it("sink 自身抛错绝不影响调用方（telemetry best-effort）", async () => {
    setGatewayCallSink(() => {
      throw new Error("sink boom");
    });
    const g = mkGateway();
    const res = await g.chat({ messages: [{ role: "user", content: "ping" }] });
    expect(res.text.length).toBeGreaterThan(0); // 调用无恙
  });
});
