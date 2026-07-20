/**
 * bootstrapCodeAgents — at API startup, ensure every code-defined agent in
 * `agentRegistry` has matching rows in `agents` + `agent_versions`, plus a
 * `deployments` row for audit. Idempotent.
 *
 * Layout:
 *   1. Upsert `__system` tenant (just in case seed didn't run).
 *   2. Upsert `__system` workflow + workflow_version (versionId = SHA of code-agent set).
 *   3. For each registered agent:
 *      a. Upsert `agents` row (kind='code', kebab_id=agent.name).
 *      b. Upsert `agent_versions` row (manifest_json carries the sha).
 *      c. If no live `deployments` row exists for this agent_version, insert one.
 */

import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
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

import { agentRegistry } from "./registry";
import { buildCodeAgentFns } from "./code-agent-fn";
import type { InngestFunction } from "@agentic/runtime";

const SYSTEM_TENANT_SLUG = "__system";
const SYSTEM_WORKFLOW_SLUG = "__system";

interface BootstrapSummary {
  tenantId: string;
  workflowId: string;
  workflowVersionId: string;
  agentCount: number;
  deploymentsWritten: number;
  /** Persisted code-agent rows no longer present in the executable registry. */
  staleAgentsDisabled: number;
  /** Live deployments demoted because their executable agent is absent/disabled. */
  deploymentsRolledBack: number;
  /** Durable consumers only for code agents that explicitly opt in. */
  codeAgentFns: InngestFunction.Any[];
}

/** Resolve an honest code revision even in local builds without GIT_SHA. */
export function resolveCodeRevision(registered = agentRegistry.list()): string {
  const explicit = process.env.GIT_SHA?.trim();
  if (explicit) {
    return explicit.slice(0, 80).replace(/[^A-Za-z0-9._-]/g, "_");
  }
  const source = registered
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((agent) => {
      const proto = Object.getPrototypeOf(agent) as object | null;
      const methods = proto
        ? Object.getOwnPropertyNames(proto)
            .filter((name) => name !== "constructor")
            .sort()
            .map((name) => {
              const value = Object.getOwnPropertyDescriptor(proto, name)?.value;
              return [
                name,
                typeof value === "function" ? String(value) : value,
              ];
            })
        : [];
      return {
        name: agent.name,
        description: agent.description,
        enabled: agent.enabled,
        scope: agent.scope,
        runScope: agent.runScope,
        inngestEnabled: agent.inngestEnabled,
        defaultProvider: agent.defaultProvider ?? null,
        defaultModel: agent.defaultModel ?? null,
        maxSteps: agent.maxSteps,
        concurrency: agent.concurrency,
        constructor: String(agent.constructor),
        methods,
      };
    });
  const digest = createHash("sha256")
    .update(JSON.stringify(source), "utf8")
    .digest("hex")
    .slice(0, 16);
  return `local-${digest}`;
}

export async function bootstrapCodeAgents(): Promise<BootstrapSummary> {
  const db = getDb();
  const registered = agentRegistry.list();
  const sha = resolveCodeRevision(registered);

  // 1. Tenant
  let systemTenant = db
    .select()
    .from(tenants)
    .where(eq(tenants.slug, SYSTEM_TENANT_SLUG))
    .all()[0];
  if (!systemTenant) {
    const tid = makeId("ten");
    db.insert(tenants)
      .values({
        id: tid,
        slug: SYSTEM_TENANT_SLUG,
        name: "System",
        subtitle: "Code-defined agents (cross-tenant)",
        color: "#6f7178",
      })
      .run();
    systemTenant = db
      .select()
      .from(tenants)
      .where(eq(tenants.id, tid))
      .all()[0]!;
  }
  const tenantId = systemTenant.id;

  // 2. Workflow + Workflow version
  let systemWorkflow = db
    .select()
    .from(workflows)
    .where(
      and(
        eq(workflows.tenantId, tenantId),
        eq(workflows.slug, SYSTEM_WORKFLOW_SLUG),
      ),
    )
    .all()[0];
  if (!systemWorkflow) {
    const wid = makeId("wf");
    db.insert(workflows)
      .values({
        id: wid,
        tenantId,
        slug: SYSTEM_WORKFLOW_SLUG,
        name: "System (code agents)",
      })
      .run();
    systemWorkflow = db
      .select()
      .from(workflows)
      .where(eq(workflows.id, wid))
      .all()[0]!;
  }
  const workflowId = systemWorkflow.id;

  const versionStr = `code-${sha}`;
  let systemWorkflowVersion = db
    .select()
    .from(workflowVersions)
    .where(
      and(
        eq(workflowVersions.workflowId, workflowId),
        eq(workflowVersions.version, versionStr),
      ),
    )
    .all()[0];
  if (!systemWorkflowVersion) {
    const wvid = makeId("wfv");
    const manifest = agentRegistry.list().map((a) => ({
      id: a.name,
      name: a.name,
      title: a.name,
      description: a.description,
      actor: ["Agent"],
      trigger: [],
      actions: [],
      triggered_event: [],
      kind: "code",
      scope: a.scope,
      runScope: a.runScope,
      inngestEnabled: a.inngestEnabled,
    }));
    db.insert(workflowVersions)
      .values({
        id: wvid,
        workflowId,
        version: versionStr,
        manifestJson: manifest as unknown as object,
        actionsJson: null,
      })
      .run();
    systemWorkflowVersion = db
      .select()
      .from(workflowVersions)
      .where(eq(workflowVersions.id, wvid))
      .all()[0]!;
  }
  const workflowVersionId = systemWorkflowVersion.id;

  // 3. Agents + AgentVersions + Deployment
  let deploymentsWritten = 0;
  for (const a of registered) {
    let agentRow = db
      .select()
      .from(agents)
      .where(and(eq(agents.workflowId, workflowId), eq(agents.kebabId, a.name)))
      .all()[0];
    if (!agentRow) {
      const aid = makeId("agt");
      const now = new Date();
      db.insert(agents)
        .values({
          id: aid,
          workflowId,
          kebabId: a.name,
          name: a.name,
          title: a.name,
          actor: "Agent",
          kind: "code",
          enabled: a.enabled,
          createdAt: now,
          updatedAt: now,
        })
        .run();
      agentRow = db.select().from(agents).where(eq(agents.id, aid)).all()[0]!;
    } else {
      // Keep enabled + kind in sync if the in-process agent flipped them.
      db.update(agents)
        .set({ kind: "code", enabled: a.enabled })
        .where(eq(agents.id, agentRow.id))
        .run();
    }

    let avRow = db
      .select()
      .from(agentVersions)
      .where(
        and(
          eq(agentVersions.agentId, agentRow.id),
          eq(agentVersions.workflowVersionId, workflowVersionId),
        ),
      )
      .all()[0];
    if (!avRow) {
      const avid = makeId("agv");
      db.insert(agentVersions)
        .values({
          id: avid,
          agentId: agentRow.id,
          workflowVersionId,
          manifestJson: {
            type: "code",
            sha,
            name: a.name,
            description: a.description,
            scope: a.scope,
            runScope: a.runScope,
            inngestEnabled: a.inngestEnabled,
            defaultProvider: a.defaultProvider ?? null,
            defaultModel: a.defaultModel ?? null,
            maxSteps: a.maxSteps,
          } as unknown as object,
        })
        .run();
      avRow = db
        .select()
        .from(agentVersions)
        .where(eq(agentVersions.id, avid))
        .all()[0]!;
    }

    const liveForAgent = db
      .select({
        id: deployments.id,
        versionId: deployments.versionId,
        deployedAt: deployments.deployedAt,
      })
      .from(deployments)
      .innerJoin(agentVersions, eq(agentVersions.id, deployments.versionId))
      .where(
        and(
          eq(deployments.tenantId, tenantId),
          eq(deployments.target, "code_agent"),
          eq(deployments.status, "live"),
          eq(agentVersions.agentId, agentRow.id),
        ),
      )
      .all();
    const current = liveForAgent
      .filter((deployment) => deployment.versionId === avRow.id)
      .sort(
        (left, right) =>
          right.deployedAt.getTime() - left.deployedAt.getTime() ||
          right.id.localeCompare(left.id),
      )[0];
    const stale = liveForAgent.filter(
      (deployment) => deployment.id !== current?.id,
    );
    if (!current || stale.length > 0) {
      db.transaction((tx) => {
        for (const deployment of stale) {
          tx.update(deployments)
            .set({ status: "rolled_back" })
            .where(eq(deployments.id, deployment.id))
            .run();
        }
        if (!current) {
          tx.insert(deployments)
            .values({
              id: makeId("dpl"),
              tenantId,
              target: "code_agent",
              versionId: avRow.id,
              status: "live",
              note: `auto-registered at startup (sha=${sha})`,
            })
            .run();
          deploymentsWritten++;
        }
      });
    }
  }

  // 4. Reconcile the inverse direction as well. Upserting the currently
  // registered set is not sufficient: removed code used to leave an enabled
  // agent row and a live deployment behind forever. The UI then advertised a
  // callable function that no longer existed in the executable registry.
  // Reconcile every persisted code binding (including tenant-scoped bindings)
  // against the in-process source of truth and demote impossible deployments.
  const registeredByName = new Map(
    registered.map((agent) => [agent.name, agent]),
  );
  let staleAgentsDisabled = 0;
  let deploymentsRolledBack = 0;
  const persistedCodeAgents = db
    .select({
      id: agents.id,
      kebabId: agents.kebabId,
      enabled: agents.enabled,
      workflowTenantId: workflows.tenantId,
      workflowSlug: workflows.slug,
    })
    .from(agents)
    .innerJoin(workflows, eq(workflows.id, agents.workflowId))
    .where(eq(agents.kind, "code"))
    .all();

  db.transaction((tx) => {
    for (const row of persistedCodeAgents) {
      const executable = registeredByName.get(row.kebabId);
      const ownerMatchesScope =
        executable?.scope === "system"
          ? row.workflowTenantId === tenantId &&
            row.workflowSlug === SYSTEM_WORKFLOW_SLUG
          : executable?.scope === "tenant"
            ? row.workflowTenantId !== tenantId &&
              row.workflowSlug === "__code_agents__"
            : false;
      const shouldEnable = executable?.enabled === true && ownerMatchesScope;
      if (row.enabled !== shouldEnable) {
        tx.update(agents)
          .set({ enabled: shouldEnable, updatedAt: new Date() })
          .where(eq(agents.id, row.id))
          .run();
        if (!shouldEnable) staleAgentsDisabled += 1;
      }
      if (shouldEnable) continue;

      const impossibleLiveDeployments = tx
        .select({ id: deployments.id })
        .from(deployments)
        .innerJoin(agentVersions, eq(agentVersions.id, deployments.versionId))
        .where(
          and(
            eq(deployments.target, "code_agent"),
            eq(deployments.status, "live"),
            eq(agentVersions.agentId, row.id),
          ),
        )
        .all();
      for (const deployment of impossibleLiveDeployments) {
        tx.update(deployments)
          .set({ status: "rolled_back" })
          .where(eq(deployments.id, deployment.id))
          .run();
        deploymentsRolledBack += 1;
      }
    }
  });

  return {
    tenantId,
    workflowId,
    workflowVersionId,
    agentCount: registered.length,
    deploymentsWritten,
    staleAgentsDisabled,
    deploymentsRolledBack,
    codeAgentFns: buildCodeAgentFns(registered),
  };
}
