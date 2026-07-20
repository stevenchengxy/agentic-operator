import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { factoryRuns, getDb, tenants } from "@agentic/db";
import {
  getRun,
  recordRunFinish,
  recordRunProgress,
  recordRunStart,
} from "../src/services/agent-factory";
import {
  clearFactoryDomainBinding,
  setFactoryDomainBinding,
} from "../src/services/agent-factory/domain-binding";

const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
const tenantId = `ten-live-progress-${suffix}`;
const domain = `live-progress-${suffix}`;
const runId = `frn-live-progress-${suffix}`;

describe("Factory live run supervision persistence", () => {
  beforeAll(() => {
    getDb().insert(tenants).values({
      id: tenantId,
      slug: `live-progress-${suffix}`,
      name: "Live progress test",
    }).run();
    setFactoryDomainBinding(tenantId, { id: domain }, "explicit");
  });

  afterAll(() => {
    getDb().delete(factoryRuns).where(eq(factoryRuns.id, runId)).run();
    clearFactoryDomainBinding(tenantId);
    getDb().delete(tenants).where(eq(tenants.id, tenantId)).run();
  });

  it("persists exact live counters and resets stale counters on conversation reuse", () => {
    recordRunStart(domain, "first interaction", tenantId, runId);
    const budgetFrame = {
      t: "budget",
      turn: 2,
      maxTurns: 200,
      tokens: 12_345,
      maxTokens: 500_000,
      specsBuilt: 1,
    };
    recordRunProgress(runId, {
      transcript: [budgetFrame],
      tokensUsed: 12_345,
      turns: 2,
      agentsCount: 1,
      reachedTerminal: false,
    }, tenantId);

    expect(getRun(runId, tenantId)).toMatchObject({
      status: "running",
      tokensUsed: 12_345,
      turns: 2,
      agentsCount: 1,
      reachedTerminal: false,
      transcript: [budgetFrame],
    });

    recordRunFinish(runId, {
      status: "finished",
      tokensUsed: 12_500,
      turns: 3,
      agentsCount: 1,
      reachedTerminal: true,
      transcript: [budgetFrame, { t: "done", status: "finished" }],
    }, tenantId);

    recordRunStart(domain, "second interaction", tenantId, runId);
    expect(getRun(runId, tenantId)).toMatchObject({
      goal: "second interaction",
      status: "running",
      tokensUsed: 0,
      turns: 0,
      agentsCount: 0,
      reachedTerminal: false,
      transcript: [],
    });
  });
});
