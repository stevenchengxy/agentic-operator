/** Usage reads preserve token provenance and never rewrite enforcement state. */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents,
  getDb,
  llmCalls,
  memberships,
  runs,
  tenantBudgets,
  tenants,
  users,
  workflows,
} from "@agentic/db";
import { makeId } from "@agentic/shared";
import { buildTestEnv, type TestEnv } from "./harness";

describe("usage/budget durable reconciliation", () => {
  let env: TestEnv;
  const tenantId = makeId("ten");
  const slug = `budget-reconcile-${makeId("tag").slice(-8)}`;
  const runId = makeId("run");

  beforeAll(async () => {
    env = await buildTestEnv();
    const db = getDb();
    const now = new Date();
    const workflowId = makeId("wf");
    const agentId = makeId("agt");
    const operator = db
      .select({ id: users.id })
      .from(users)
      .where(
        eq(
          users.email,
          process.env.AGENTIC_DEV_USER_EMAIL ?? "test-platform-admin@agentic.invalid",
        ),
      )
      .all()[0]!;
    db.insert(tenants).values({ id: tenantId, slug, name: slug }).run();
    db.insert(memberships)
      .values({ userId: operator.id, tenantId, role: "admin" })
      .run();
    db.insert(workflows)
      .values({
        id: workflowId,
        tenantId,
        slug: "accounting",
        name: "Accounting",
      })
      .run();
    db.insert(agents)
      .values({
        id: agentId,
        workflowId,
        kebabId: "accountingAgent",
        name: "accountingAgent",
        title: "Accounting Agent",
        actor: "Agent",
        kind: "code",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    db.insert(tenantBudgets)
      .values({
        tenantId,
        monthlyTokenCap: 1_000_000,
        monthlyUsdCap: 250,
        usedTokensMonth: 123_456,
        usedUsdMonth: 7,
        periodStart: new Date(now.getTime() - 3_600_000),
      })
      .run();
    db.insert(runs)
      .values({
        id: runId,
        tenantId,
        agentId,
        status: "ok",
        startedAt: now,
        endedAt: now,
        durationMs: 20,
        tokensIn: 100_000,
        tokensOut: 50_000,
        model: "gpt-4o-mini",
        correlationId: makeId("cor"),
      })
      .run();
    db.insert(llmCalls)
      .values({
        id: makeId("llm"),
        tenantId,
        domain: "factory-test",
        conversationId: "factory-conversation",
        purpose: "design",
        requestedModel: "gpt-4o-mini",
        servedModel: "gpt-4o-mini",
        provider: "openai",
        approxTokensIn: 100_000,
        approxTokensOut: 50_000,
        tokenSource: "estimated_chars",
        ok: true,
        createdAt: now,
      })
      .run();
    db.insert(llmCalls)
      .values({
        id: makeId("llm"),
        tenantId,
        runId,
        conversationId: "runtime",
        purpose: "agent:accountingAgent",
        requestedModel: "gpt-4o-mini",
        servedModel: "gpt-4o-mini",
        provider: "openai",
        approxTokensIn: 100_000,
        approxTokensOut: 50_000,
        tokenSource: "provider",
        ok: true,
        createdAt: now,
      })
      .run();
    db.insert(llmCalls)
      .values({
        id: makeId("llm"),
        tenantId,
        conversationId: "runtime",
        purpose: "legacy-unattributed",
        requestedModel: "gpt-4o-mini",
        servedModel: "gpt-4o-mini",
        provider: "openai",
        approxTokensIn: 10,
        approxTokensOut: 5,
        tokenSource: null,
        ok: true,
        createdAt: now,
      })
      .run();
  });

  afterAll(() => {
    getDb().delete(llmCalls).where(eq(llmCalls.tenantId, tenantId)).run();
    getDb().delete(tenants).where(eq(tenants.id, tenantId)).run();
  });

  it("/usage de-duplicates linked calls, excludes ambiguous legacy calls, and is read-only", async () => {
    const res = await env.fetch("/v1/usage", {
      headers: { "x-agentic-tenant": slug },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: true;
      data: {
        budget: { usedTokensMonth: number; usedUsdMonth: number };
        totals: {
          tokensIn: number;
          tokensOut: number;
          usdCents: number;
          testRuns: number;
        };
        coverage: {
          auxiliaryCallTokens: number;
          linkedRuntimeCallTokens: number;
          ambiguousRuntimeCallTokens: number;
          ambiguousRuntimeCalls: number;
          exactProviderTokens: number;
          estimatedTokens: number;
          legacyRunTokens: number;
          tokenCoverageComplete: boolean;
        };
      };
    };
    expect(body.data.budget.usedTokensMonth).toBe(123_456);
    expect(body.data.budget.usedUsdMonth).toBe(7);
    expect(body.data.totals).toMatchObject({
      tokensIn: 200_000,
      tokensOut: 100_000,
      usdCents: 10,
    });
    expect(body.data.coverage.auxiliaryCallTokens).toBe(150_000);
    expect(body.data.coverage.linkedRuntimeCallTokens).toBe(150_000);
    expect(body.data.coverage.ambiguousRuntimeCallTokens).toBe(15);
    expect(body.data.coverage.ambiguousRuntimeCalls).toBe(1);
    expect(body.data.coverage.exactProviderTokens).toBe(150_000);
    expect(body.data.coverage.estimatedTokens).toBe(150_000);
    expect(body.data.coverage.legacyRunTokens).toBe(0);
    expect(body.data.coverage.tokenCoverageComplete).toBe(false);
    expect(body.data.totals.testRuns).toBe(0);
    const stored = getDb()
      .select()
      .from(tenantBudgets)
      .where(eq(tenantBudgets.tenantId, tenantId))
      .all()[0]!;
    expect(stored.usedTokensMonth).toBe(123_456);
    expect(stored.usedUsdMonth).toBe(7);
  });

  it("/budgets returns the authoritative gateway counters", async () => {
    const res = await env.fetch("/v1/budgets", {
      headers: { "x-agentic-tenant": slug },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: true;
      data: { usedTokensMonth: number; usedUsdMonth: number };
    };
    expect(body.data.usedTokensMonth).toBe(123_456);
    expect(body.data.usedUsdMonth).toBe(7);
  });
});
