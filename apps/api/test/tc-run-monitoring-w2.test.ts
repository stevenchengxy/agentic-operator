/**
 * W2 — AI run summary (lazy + cached).
 *
 * Seeds a run + steps + one captured LLM turn, stubs the shared gateway, and
 * asserts:
 *   - POST /v1/runs/:id/summary returns a structured summary (success →
 *     businessDetails; failure → problem + likelyCauses) and CACHES it so the
 *     subsequent GET returns the same without another gateway call.
 *   - Regenerate (second POST) replaces the cache.
 *   - Degrades to a digest-only summary when the gateway returns non-JSON, and
 *     the digest faithfully carries the run's steps/error.
 *   - 404 for a run the tenant doesn't own.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { like } from "drizzle-orm";
import { agents, getDb, llmTurns, runs, steps, tenants, workflows } from "@agentic/db";
import { makeId } from "@agentic/shared";
import { buildTestEnv, type TestEnv } from "./harness";
import { _setLLMGatewayForTests } from "../src/services/llm";

interface EnvelopeOk<T> {
  ok: true;
  data: T;
}
interface Summary {
  scored: boolean;
  status: string;
  headline: string;
  narrative: string;
  businessDetails: string[];
  problem: string | null;
  likelyCauses: string[];
  suggestions: string[];
  model: string;
  digest: string;
}

const SUF = `w2${Date.now().toString(36)}`.toLowerCase().slice(-8);
const TENANT = `w2-${SUF}`;
const OTHER = `w2o-${SUF}`;

// Programmable stub for the shared gateway.
let nextReply: { text: string; model: string } = { text: "", model: "stub-model" };
let chatCalls = 0;
const stubGateway = {
  chat: async () => {
    chatCalls++;
    return {
      text: nextReply.text,
      provider: "mock",
      model: nextReply.model,
      tokensIn: 10,
      tokensOut: 20,
      finishReason: "stop",
      latencyMs: 1,
    };
  },
} as never;

describe("W2: AI run summary", () => {
  let env: TestEnv;
  let tenantId: string;
  let otherId: string;
  let okRunId = "";
  let failRunId = "";
  let otherRunId = "";
  let savedDevTenant: string | undefined;

  beforeAll(async () => {
    env = await buildTestEnv();
    _setLLMGatewayForTests(stubGateway);
    const db = getDb();

    tenantId = makeId("ten");
    otherId = makeId("ten");
    db.insert(tenants)
      .values([
        { id: tenantId, slug: TENANT, name: "W2 tenant" },
        { id: otherId, slug: OTHER, name: "W2 other" },
      ])
      .run();

    const wfId = makeId("wf");
    db.insert(workflows).values({ id: wfId, tenantId, slug: "w2-wf", name: "w2 wf" }).run();
    const agentId = makeId("agt");
    db.insert(agents)
      .values({
        id: agentId,
        workflowId: wfId,
        kebabId: `w2-${SUF}`,
        name: "matchResume",
        title: "简历匹配",
        actor: "Agent",
        kind: "manifest",
        enabled: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .run();

    const mkRun = (status: string, err: string | null): string => {
      const id = makeId("run");
      db.insert(runs)
        .values({
          id,
          tenantId,
          agentId,
          status: status as never,
          startedAt: new Date(Date.now() - 3000),
          endedAt: new Date(),
          durationMs: 3000,
          correlationId: makeId("cor"),
          subject: `cand-${id.slice(-4)}`,
          errorMessage: err,
        })
        .run();
      db.insert(steps)
        .values({
          id: makeId("stp"),
          runId: id,
          ord: 0,
          name: "computeMatch",
          type: "logic",
          status: status === "failed" ? "failed" : "ok",
          startedAt: new Date(Date.now() - 2000),
          endedAt: new Date(),
          durationMs: 2000,
          error: err,
        })
        .run();
      db.insert(llmTurns)
        .values({
          id: makeId("llt"),
          tenantId,
          runId: id,
          stepId: null,
          ord: 0,
          responseText: "matched candidate at 82",
          reasoning: "weighed skills vs jd",
          toolCallsJson: [{ name: "match", input: { cand: "x" } }],
          provider: "mock",
          model: "m",
          tokensIn: 5,
          tokensOut: 5,
          finishReason: "stop",
          latencyMs: 1,
          correlationId: makeId("cor"),
          createdAt: new Date(),
        })
        .run();
      return id;
    };
    okRunId = mkRun("ok", null);
    failRunId = mkRun("failed", "TypeError: cannot read property 'score' of undefined");

    // A run owned by the OTHER tenant, for the 404 check.
    const owf = makeId("wf");
    db.insert(workflows).values({ id: owf, tenantId: otherId, slug: "w2o-wf", name: "o" }).run();
    const oa = makeId("agt");
    db.insert(agents)
      .values({ id: oa, workflowId: owf, kebabId: `w2o-${SUF}`, name: "o", actor: "Agent", kind: "manifest", enabled: true, createdAt: new Date(), updatedAt: new Date() })
      .run();
    otherRunId = makeId("run");
    db.insert(runs)
      .values({ id: otherRunId, tenantId: otherId, agentId: oa, status: "ok", startedAt: new Date(), correlationId: makeId("cor") })
      .run();

    savedDevTenant = process.env.AGENTIC_DEV_TENANT;
    process.env.AGENTIC_DEV_TENANT = TENANT;
  });

  afterAll(() => {
    if (savedDevTenant === undefined) delete process.env.AGENTIC_DEV_TENANT;
    else process.env.AGENTIC_DEV_TENANT = savedDevTenant;
    _setLLMGatewayForTests(null);
    getDb().delete(tenants).where(like(tenants.slug, `w2%-${SUF}`)).run();
  });

  async function post(id: string): Promise<{ status: number; summary: Summary | null }> {
    const res = await env.fetch(`/v1/runs/${id}/summary`, { method: "POST" });
    if (res.status !== 200) return { status: res.status, summary: null };
    return { status: 200, summary: ((await res.json()) as EnvelopeOk<{ summary: Summary }>).data.summary };
  }
  async function get(id: string): Promise<Summary | null> {
    const res = await env.fetch(`/v1/runs/${id}/summary`);
    return ((await res.json()) as EnvelopeOk<{ summary: Summary | null }>).data.summary;
  }

  it("generates a business summary for a successful run and caches it", async () => {
    nextReply = {
      text: JSON.stringify({
        headline: "简历匹配成功",
        narrative: "对候选人完成匹配并给出评分。",
        businessDetails: ["候选人匹配度 82", "触发下游面试邀约"],
        problem: null,
        likelyCauses: [],
        suggestions: [],
      }),
      model: "opus-stub",
    };
    chatCalls = 0;
    const { summary } = await post(okRunId);
    expect(summary).toBeTruthy();
    expect(summary!.scored).toBe(true);
    expect(summary!.status).toBe("ok");
    expect(summary!.businessDetails).toContain("候选人匹配度 82");
    expect(summary!.problem).toBeNull();
    expect(summary!.model).toBe("opus-stub");
    expect(chatCalls).toBe(1);

    // Cached: GET returns the same summary without another gateway call.
    const cached = await get(okRunId);
    expect(cached!.businessDetails).toContain("候选人匹配度 82");
    expect(chatCalls).toBe(1);
  });

  it("describes the problem + likely causes for a failed run", async () => {
    nextReply = {
      text: JSON.stringify({
        headline: "匹配步骤崩溃",
        narrative: "computeMatch 抛出类型错误。",
        businessDetails: [],
        problem: "computeMatch 读取 score 字段时空指针",
        likelyCauses: ["上游 match API 返回结构与预期不符（data.data 少一层）", "候选人无评分字段"],
        suggestions: ["核对 match API 响应封套", "对缺失评分做兜底"],
      }),
      model: "opus-stub",
    };
    const { summary } = await post(failRunId);
    expect(summary!.status).toBe("failed");
    expect(summary!.problem).toContain("score");
    expect(summary!.likelyCauses.length).toBeGreaterThanOrEqual(1);
    expect(summary!.suggestions.length).toBeGreaterThanOrEqual(1);
    // The digest faithfully carries the step + the run error.
    expect(summary!.digest).toContain("computeMatch");
    expect(summary!.digest).toContain("TypeError");
  });

  it("degrades to a digest-only summary when the gateway returns non-JSON", async () => {
    nextReply = { text: "sorry, I cannot do that", model: "mock-model" };
    const { summary } = await post(okRunId);
    expect(summary!.scored).toBe(false);
    expect(summary!.digest).toContain("步骤");
  });

  it("404s a run the tenant does not own", async () => {
    const { status } = await post(otherRunId);
    expect(status).toBe(404);
  });
});
