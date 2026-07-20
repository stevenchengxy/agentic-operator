import { and, desc, eq } from "drizzle-orm";
import {
  agents,
  agentVersions,
  deployments,
  getDb,
  tenants,
  workflows,
  workflowVersions,
} from "@agentic/db";
import { makeId } from "@agentic/shared";
import type { BaseAgent } from "./base-agent";
import { resolveCodeRevision } from "./bootstrap";

export interface CodeAgentBinding {
  tenantId: string;
  workflowId: string;
  workflowVersionId: string;
  agentId: string;
  agentVersionId: string;
}

/** Resolve/materialize a code-agent binding without copying system utilities into a tenant catalog. */
export function ensureCodeAgentBinding(
  tenantSlug: string,
  agent: BaseAgent<unknown, unknown>,
  deployedBy?: string | null,
): CodeAgentBinding {
  const db = getDb();
  const executionTenant = db
    .select()
    .from(tenants)
    .where(eq(tenants.slug, tenantSlug))
    .all()[0];
  if (!executionTenant) throw new Error(`tenant '${tenantSlug}' not found`);

  // System agents are deployed exactly once by bootstrap. Invocation is a
  // read-only binding operation: deriving a revision from one agent here would
  // create a competing version and make bootstrap/runtime flip deployments.
  if (agent.scope === "system") {
    const systemTenant = db
      .select()
      .from(tenants)
      .where(eq(tenants.slug, "__system"))
      .all()[0];
    if (!systemTenant) throw new Error("system tenant '__system' not found");

    const liveBindings = db
      .select({
        workflowId: workflows.id,
        workflowVersionId: agentVersions.workflowVersionId,
        agentId: agents.id,
        agentVersionId: agentVersions.id,
      })
      .from(deployments)
      .innerJoin(agentVersions, eq(agentVersions.id, deployments.versionId))
      .innerJoin(agents, eq(agents.id, agentVersions.agentId))
      .innerJoin(workflows, eq(workflows.id, agents.workflowId))
      .where(
        and(
          eq(deployments.tenantId, systemTenant.id),
          eq(deployments.target, "code_agent"),
          eq(deployments.status, "live"),
          eq(workflows.tenantId, systemTenant.id),
          eq(workflows.slug, "__system"),
          eq(agents.kebabId, agent.name),
          eq(agents.kind, "code"),
        ),
      )
      .orderBy(desc(deployments.deployedAt), desc(deployments.id))
      .all();

    if (liveBindings.length !== 1) {
      throw new Error(
        `system code agent '${agent.name}' must have exactly one live canonical deployment (found ${liveBindings.length}); run bootstrap`,
      );
    }
    const binding = liveBindings[0]!;
    return {
      tenantId: executionTenant.id,
      workflowId: binding.workflowId,
      workflowVersionId: binding.workflowVersionId,
      agentId: binding.agentId,
      agentVersionId: binding.agentVersionId,
    };
  }

  const ownerSlug = tenantSlug;
  const ownerTenant = executionTenant;
  const workflowSlug = "__code_agents__";
  let workflow = db
    .select()
    .from(workflows)
    .where(
      and(
        eq(workflows.tenantId, ownerTenant.id),
        eq(workflows.slug, workflowSlug),
      ),
    )
    .all()[0];
  if (!workflow) {
    db.insert(workflows)
      .values({
        id: makeId("wf"),
        tenantId: ownerTenant.id,
        slug: workflowSlug,
        name: `${ownerTenant.name} (code agents)`,
      })
      .onConflictDoNothing({ target: [workflows.tenantId, workflows.slug] })
      .run();
    workflow = db
      .select()
      .from(workflows)
      .where(
        and(
          eq(workflows.tenantId, ownerTenant.id),
          eq(workflows.slug, workflowSlug),
        ),
      )
      .all()[0];
  }
  if (!workflow) {
    throw new Error(`failed to create code-agent workflow for '${ownerSlug}'`);
  }

  const revision = resolveCodeRevision([agent]);
  const version = `code-${revision}-${agent.name}`.slice(0, 120);
  let workflowVersion = db
    .select()
    .from(workflowVersions)
    .where(
      and(
        eq(workflowVersions.workflowId, workflow.id),
        eq(workflowVersions.version, version),
      ),
    )
    .all()[0];
  if (!workflowVersion) {
    db.insert(workflowVersions)
      .values({
        id: makeId("wfv"),
        workflowId: workflow.id,
        version,
        manifestJson: [
          {
            id: agent.name,
            name: agent.name,
            title: agent.name,
            description: agent.description,
            actor: ["Agent"],
            trigger: [],
            triggered_event: [],
            kind: "code",
            scope: agent.scope,
            runScope: agent.runScope,
            inngestEnabled: agent.inngestEnabled,
          },
        ],
        actionsJson: null,
        createdBy: deployedBy ?? null,
      })
      .onConflictDoNothing({
        target: [workflowVersions.workflowId, workflowVersions.version],
      })
      .run();
    workflowVersion = db
      .select()
      .from(workflowVersions)
      .where(
        and(
          eq(workflowVersions.workflowId, workflow.id),
          eq(workflowVersions.version, version),
        ),
      )
      .all()[0];
  }
  if (!workflowVersion) {
    throw new Error(
      `failed to create code-agent workflow version for '${agent.name}'`,
    );
  }

  let agentRow = db
    .select()
    .from(agents)
    .where(
      and(eq(agents.workflowId, workflow.id), eq(agents.kebabId, agent.name)),
    )
    .all()[0];
  if (!agentRow) {
    const now = new Date();
    db.insert(agents)
      .values({
        id: makeId("agt"),
        workflowId: workflow.id,
        kebabId: agent.name,
        name: agent.name,
        title: agent.name,
        actor: "Agent",
        kind: "code",
        enabled: agent.enabled,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({ target: [agents.workflowId, agents.kebabId] })
      .run();
    agentRow = db
      .select()
      .from(agents)
      .where(
        and(eq(agents.workflowId, workflow.id), eq(agents.kebabId, agent.name)),
      )
      .all()[0];
  } else if (agentRow.kind !== "code" || agentRow.enabled !== agent.enabled) {
    db.update(agents)
      .set({ kind: "code", enabled: agent.enabled, updatedAt: new Date() })
      .where(eq(agents.id, agentRow.id))
      .run();
  }
  if (!agentRow) {
    throw new Error(
      `failed to create tenant binding for code agent '${agent.name}'`,
    );
  }

  let agentVersion = db
    .select()
    .from(agentVersions)
    .where(
      and(
        eq(agentVersions.agentId, agentRow.id),
        eq(agentVersions.workflowVersionId, workflowVersion.id),
      ),
    )
    .all()[0];
  if (!agentVersion) {
    db.insert(agentVersions)
      .values({
        id: makeId("agv"),
        agentId: agentRow.id,
        workflowVersionId: workflowVersion.id,
        manifestJson: {
          type: "code",
          revision,
          name: agent.name,
          description: agent.description,
          scope: agent.scope,
          runScope: agent.runScope,
          inngestEnabled: agent.inngestEnabled,
          defaultProvider: agent.defaultProvider ?? null,
          defaultModel: agent.defaultModel ?? null,
          maxSteps: agent.maxSteps,
        },
      })
      .onConflictDoNothing({
        target: [agentVersions.agentId, agentVersions.workflowVersionId],
      })
      .run();
    agentVersion = db
      .select()
      .from(agentVersions)
      .where(
        and(
          eq(agentVersions.agentId, agentRow.id),
          eq(agentVersions.workflowVersionId, workflowVersion.id),
        ),
      )
      .all()[0];
  }
  if (!agentVersion) {
    throw new Error(`failed to create version binding for '${agent.name}'`);
  }

  const live = db
    .select({ id: deployments.id, agentVersionId: agentVersions.id })
    .from(deployments)
    .innerJoin(agentVersions, eq(agentVersions.id, deployments.versionId))
    .where(
      and(
        eq(deployments.tenantId, ownerTenant.id),
        eq(deployments.target, "code_agent"),
        eq(deployments.status, "live"),
        eq(agentVersions.agentId, agentRow.id),
      ),
    )
    .all();
  const current = live.find((item) => item.agentVersionId === agentVersion.id);
  const stale = live.filter((item) => item.agentVersionId !== agentVersion.id);
  if (!current || stale.length > 0) {
    db.transaction(() => {
      for (const deployment of stale) {
        db.update(deployments)
          .set({ status: "rolled_back" })
          .where(eq(deployments.id, deployment.id))
          .run();
      }
      if (!current) {
        db.insert(deployments)
          .values({
            id: makeId("dpl"),
            tenantId: ownerTenant.id,
            target: "code_agent",
            versionId: agentVersion.id,
            status: "live",
            deployedBy: deployedBy ?? null,
            note: `runtime-bound code agent (${revision})`,
          })
          .run();
      }
    });
  }

  return {
    // Runs remain caller-tenant scoped even when their canonical code identity
    // belongs to __system.
    tenantId: executionTenant.id,
    workflowId: workflow.id,
    workflowVersionId: workflowVersion.id,
    agentId: agentRow.id,
    agentVersionId: agentVersion.id,
  };
}
