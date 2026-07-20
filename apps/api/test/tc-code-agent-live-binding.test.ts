import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { ChatMessage } from "@agentic/llm-gateway";
import { BaseAgent, bootstrapCodeAgents } from "@agentic/agents";
import {
  agents,
  agentVersions,
  deployments,
  getDb,
  tenants,
} from "@agentic/db";
import { makeId } from "@agentic/shared";
import { ensureCodeAgentBinding } from "../src/services/code-agent-binding";
import { buildTestEnv } from "./harness";

class RevisionAgent extends BaseAgent<void, string> {
  readonly name: string;
  readonly description = "code-agent live revision invariant test";

  constructor(name: string) {
    super();
    this.name = name;
  }

  protected buildMessages(): ChatMessage[] {
    return [{ role: "user", content: "revision test" }];
  }
}

describe("tenant code-agent binding live-version invariant", () => {
  const originalSha = process.env.GIT_SHA;
  const tenantId = makeId("ten");
  const tenantSlug = `qa-probe-code-binding-${tenantId.slice(-8)}`;

  beforeAll(async () => {
    await buildTestEnv();
    getDb().insert(tenants)
      .values({ id: tenantId, slug: tenantSlug, name: tenantSlug })
      .run();
  });

  afterAll(() => {
    if (originalSha === undefined) delete process.env.GIT_SHA;
    else process.env.GIT_SHA = originalSha;
    getDb().delete(tenants).where(eq(tenants.id, tenantId)).run();
  });

  it("demotes the prior live revision and keeps exactly one live row per agent", () => {
    const agent = new RevisionAgent(`revisionAgent${Date.now().toString(36)}`);
    process.env.GIT_SHA = "revision-a";
    const first = ensureCodeAgentBinding(tenantSlug, agent);
    process.env.GIT_SHA = "revision-b";
    const second = ensureCodeAgentBinding(tenantSlug, agent);
    expect(second.agentVersionId).not.toBe(first.agentVersionId);

    const live = getDb()
      .select({
        deploymentId: deployments.id,
        agentVersionId: agentVersions.id,
      })
      .from(deployments)
      .innerJoin(agentVersions, eq(agentVersions.id, deployments.versionId))
      .where(
        and(
          eq(deployments.tenantId, tenantId),
          eq(deployments.target, "code_agent"),
          eq(deployments.status, "live"),
          eq(agentVersions.agentId, second.agentId),
        ),
      )
      .all();
    expect(live).toEqual([
      expect.objectContaining({ agentVersionId: second.agentVersionId }),
    ]);

    const firstDeployment = getDb()
      .select()
      .from(deployments)
      .where(
        and(
          eq(deployments.tenantId, tenantId),
          eq(deployments.versionId, first.agentVersionId),
        ),
      )
      .all()[0];
    expect(firstDeployment?.status).toBe("rolled_back");

    // Rebinding the already-live revision is idempotent and creates no
    // duplicate deployment row.
    ensureCodeAgentBinding(tenantSlug, agent);
    const liveAfterReplay = getDb()
      .select({ id: deployments.id })
      .from(deployments)
      .innerJoin(agentVersions, eq(agentVersions.id, deployments.versionId))
      .where(
        and(
          eq(deployments.tenantId, tenantId),
          eq(deployments.target, "code_agent"),
          eq(deployments.status, "live"),
          eq(agentVersions.agentId, second.agentId),
        ),
      )
      .all();
    expect(liveAfterReplay).toHaveLength(1);
  });

  it("disables persisted code with no executable registry entry and demotes its live deployment", async () => {
    const removed = new RevisionAgent(`removedAgent${Date.now().toString(36)}`);
    const binding = ensureCodeAgentBinding(tenantSlug, removed);

    const summary = await bootstrapCodeAgents();

    const row = getDb().select().from(agents).where(eq(agents.id, binding.agentId)).all()[0];
    const deployment = getDb()
      .select()
      .from(deployments)
      .where(
        and(
          eq(deployments.versionId, binding.agentVersionId),
          eq(deployments.target, "code_agent"),
        ),
      )
      .all()[0];
    expect(row?.enabled).toBe(false);
    expect(deployment?.status).toBe("rolled_back");
    expect(summary.staleAgentsDisabled).toBeGreaterThanOrEqual(1);
    expect(summary.deploymentsRolledBack).toBeGreaterThanOrEqual(1);
  });
});
