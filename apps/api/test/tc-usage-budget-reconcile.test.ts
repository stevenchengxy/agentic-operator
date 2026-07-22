/** Usage reads preserve token provenance and never rewrite enforcement state. */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents,
  getDb,
  llmCallTelemetry,
  memberships,
  runs,
  tenantBudgets,
  tenants,
  users,
  workflows,
} from "@agentic/db";
import { makeId } from "@agentic/shared";
import { calculateTenantUsage } from "../src/services/usage-accounting";
import { buildTestEnv, type TestEnv } from "./harness";

describe("usage/budget durable reconciliation", () => {
  let env: TestEnv;
  let periodStart: Date;
  const tenantId = makeId("ten");
  const slug = `budget-reconcile-${makeId("tag").slice(-8)}`;
  const runId = makeId("run");

  beforeAll(async () => {
    env = await buildTestEnv();
    const db = getDb();
    const now = new Date();
    periodStart = new Date(now.getTime() - 3_600_000);
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
        periodStart,
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
    db.insert(llmCallTelemetry)
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
    db.insert(llmCallTelemetry)
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
    db.insert(llmCallTelemetry)
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
    getDb()
      .delete(llmCallTelemetry)
      .where(eq(llmCallTelemetry.tenantId, tenantId))
      .run();
    getDb().delete(tenants).where(eq(tenants.id, tenantId)).run();
  });

  it("de-duplicates linked calls, excludes ambiguous legacy calls, and is read-only", () => {
    const usage = calculateTenantUsage(tenantId, periodStart);
    expect(usage).toMatchObject({
      tokensIn: 200_000,
      tokensOut: 100_000,
      // Telemetry rows carry token counts, not billed cost; calculateTenantUsage
      // derives usdCents from model pricing, and the seeded mock model is
      // unpriced → 0. The stored gateway counter (usedUsdMonth below) is the
      // authoritative billed figure; this test's real guard is the token
      // de-duplication / ambiguous-exclusion math above.
      usdCents: 0,
    });
    expect(usage.auxiliaryCallTokens).toBe(150_000);
    expect(usage.linkedRuntimeCallTokens).toBe(150_000);
    expect(usage.ambiguousRuntimeCallTokens).toBe(15);
    expect(usage.ambiguousRuntimeCalls).toBe(1);
    expect(usage.exactProviderTokens).toBe(150_000);
    expect(usage.estimatedTokens).toBe(150_000);
    expect(usage.legacyRunTokens).toBe(0);
    expect(usage.tokenCoverageComplete).toBe(false);
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
