import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import {
  agents,
  deployments,
  getDb,
  runs,
  workflows,
  workflowVersions,
} from "@agentic/db";
import { ManifestUploadBody } from "@agentic/contracts";
import { requirePermission } from "../../plugins/rbac";
import { writeAudit } from "../../plugins/audit";
import {
  getAgentDetail,
  listAgentRuns,
  listAgents,
} from "../../queries/agents";
import { reregisterInngest } from "../../services/inngest-registry";
import { syncTenantApp } from "../../services/inngest-sync";
import {
  BlockingIssuesError,
  commit,
  OverwriteRequiredError,
} from "../../services/manifest-import";
import { withTenantWorkflowMutationLease } from "../../services/tenant-workflow-mutation";

async function synchronizeTenantRuntime(tenantSlug: string): Promise<number> {
  const registered = await reregisterInngest({ tenantSlug, scope: "tenant" });
  const sync = await syncTenantApp(tenantSlug);
  if (!sync.ok) {
    throw new Error(
      `Inngest rejected tenant app sync${sync.status ? ` (${sync.status})` : ""}: ${sync.error ?? "unknown error"}`,
    );
  }
  return registered.appFnCount ?? registered.fnCount;
}

export async function agentsRoutes(app: FastifyInstance) {
  // GET /v1/agents?kind=code|manifest|all — list (optional kind filter)
  //
  // The `?tenant=` query param used to override the authed tenant slug and
  // was a classic IDOR — any authed caller could pass `?tenant=raas` and read
  // raas's agent catalog from inside __system, etc. P0-AUTH-03 removes the
  // override entirely; the listed tenant is now exclusively driven by
  // `auth.tenantSlug`. Code agents still implicitly include the synthetic
  // `__system` tenant because that's where platform code agents live.
  app.get<{ Querystring: { kind?: string } }>("/agents", async (req, reply) => {
    const auth = requirePermission(req, "agents.read");
    const rawKind = (req.query as { kind?: string }).kind;
    const kind: "code" | "manifest" | "all" =
      rawKind === "code" || rawKind === "manifest" ? rawKind : "all";
    const tenantSlug = auth.tenantSlug;
    const tenantsToQuery =
      kind === "code" ? ["__system", tenantSlug] : [tenantSlug];
    const lists = await Promise.all(
      Array.from(new Set(tenantsToQuery)).map((t) => listAgents(t, { kind })),
    );
    return reply.ok(lists.flat());
  });

  // GET /v1/agents/:kebab — detail
  app.get<{ Params: { kebab: string } }>(
    "/agents/:kebab",
    async (req, reply) => {
      const auth = requirePermission(req, "agents.read");
      const detail = await getAgentDetail(auth.tenantSlug, req.params.kebab);
      if (!detail) return reply.fail("not_found", "agent not found", 404);
      const recentRuns = await listAgentRuns(auth.tenantSlug, detail.id, 20);
      return reply.ok({ ...detail, recentRuns });
    },
  );

  // POST /v1/agents — compatibility surface for a real manifest deployment.
  // The old implementation wrote SQLite rows only and claimed a restart would
  // activate them, although runtime bootstrap reads the models directory. Keep
  // the public route but delegate to the durable disk + DB + Inngest commit saga.
  app.post("/agents", async (req, reply) => {
    const auth = requirePermission(req, "agents.write");
    const parsed = ManifestUploadBody.parse(req.body);
    const canonicalWorkflowSlug = `${auth.tenantSlug}-default`;
    if (parsed.workflowSlug && parsed.workflowSlug !== canonicalWorkflowSlug) {
      return reply.fail(
        "unsupported_workflow_slug",
        `this runtime serves one workflow per tenant; workflowSlug must be ${canonicalWorkflowSlug}`,
        422,
      );
    }
    try {
      const out = await withTenantWorkflowMutationLease({
        tenantId: auth.tenantId,
        kind: "agents_manifest_deploy",
        fn: async (lease) => {
          lease.assertOwned();
          const value = await commit(
            {
              mode: "commit",
              workflow: parsed.manifest,
              actions: parsed.actions,
              target: "production",
              // This compatibility route is itself the explicit Deploy action.
              // The six-step import route retains the separate overwrite guard.
              confirm_overwrite: true,
              conflict_resolutions: [],
              note: parsed.note,
            },
            {
              tenantId: auth.tenantId,
              tenantSlug: auth.tenantSlug,
              workflowSlug: canonicalWorkflowSlug,
            },
            {
              actorUserId: auth.userId ?? undefined,
              log: {
                error: (obj, msg) => req.log.error(obj, msg ?? ""),
                info: (obj, msg) => req.log.info(obj, msg ?? ""),
              },
            },
          );
          lease.assertOwned();
          return value;
        },
      });
      return reply.ok(out);
    } catch (err) {
      if (err instanceof OverwriteRequiredError) {
        return reply.status(409).send(err.payload);
      }
      if (err instanceof BlockingIssuesError) {
        return reply.status(400).send({
          ok: false,
          error: {
            code: "blocking_issues",
            message:
              "deployment refused because the manifest has blocking issues",
            hint: err.issues
              .slice(0, 6)
              .map((issue) => `${issue.path}: ${issue.message}`)
              .join("; "),
          },
          issues: err.issues,
        });
      }
      throw err;
    }
  });

  // PATCH /v1/agents/:kebab — 上线/下线 a single agent (toggle `enabled`).
  //
  // Flipping `enabled` then re-registering the tenant is the runtime
  // disable/enable path: a disabled manifest agent is dropped from the served
  // Inngest function set (see packages/runtime bootstrapTenant), so no event
  // routes to it until it's re-enabled. Code agents have no Inngest function;
  // their `enabled` flag is honored at invoke time instead. Idempotent —
  // toggling to the current state still returns 200 with the row state.
  app.patch<{
    Params: { kebab: string };
    Body: { enabled?: unknown; title?: unknown };
  }>("/agents/:kebab", async (req, reply) => {
    const auth = requirePermission(req, "agents.write");
    const body = (req.body ?? {}) as { enabled?: unknown; title?: unknown };
    const hasEnabled = typeof body.enabled === "boolean";
    const hasTitle = typeof body.title === "string";
    if (!hasEnabled && !hasTitle) {
      return reply.fail(
        "invalid_body",
        "body must include { enabled: boolean } and/or { title: string }",
        400,
      );
    }
    const db = getDb();
    const row = db
      .select({
        id: agents.id,
        kebabId: agents.kebabId,
        name: agents.name,
        title: agents.title,
        kind: agents.kind,
        enabled: agents.enabled,
      })
      .from(agents)
      .innerJoin(workflows, eq(workflows.id, agents.workflowId))
      .where(
        and(
          eq(workflows.tenantId, auth.tenantId),
          eq(agents.kebabId, req.params.kebab),
        ),
      )
      .all()[0];
    if (!row) return reply.fail("not_found", "agent not found", 404);

    const title = hasTitle ? String(body.title).trim() : row.title;
    if (hasTitle && !title)
      return reply.fail("invalid_body", "title 不能为空", 400);
    if (title && title.length > 200) {
      return reply.fail(
        "invalid_body",
        "title cannot exceed 200 characters",
        400,
      );
    }
    const enabled = hasEnabled ? (body.enabled as boolean) : row.enabled;
    const titleChanged = title !== row.title;
    const enabledChanged = enabled !== row.enabled;

    if (titleChanged || enabledChanged) {
      db.update(agents)
        .set({ title, enabled, updatedAt: new Date() })
        .where(eq(agents.id, row.id))
        .run();
    }

    // An enable/disable mutation is complete only after the rebuilt handler
    // has been accepted by Inngest. Roll the row and runtime back together on
    // any failure; returning a green "next boot will reflect it" was a false
    // success because events could still reach the old function set.
    let fnCount: number | undefined;
    if (enabledChanged) {
      try {
        fnCount = await synchronizeTenantRuntime(auth.tenantSlug);
      } catch (error) {
        let rollbackError: unknown = null;
        try {
          db.update(agents)
            .set({
              title: row.title,
              enabled: row.enabled,
              updatedAt: new Date(),
            })
            .where(eq(agents.id, row.id))
            .run();
          await synchronizeTenantRuntime(auth.tenantSlug);
        } catch (failure) {
          rollbackError = failure;
        }
        writeAudit({
          tenantId: auth.tenantId,
          actorUserId: auth.userId ?? undefined,
          action: "agent.update.failed",
          targetType: "agent",
          targetId: row.id,
          meta: {
            kebabId: row.kebabId,
            error: String((error as Error)?.message ?? error).slice(0, 500),
            rollback_ok: rollbackError === null,
            rollback_error: rollbackError
              ? String(
                  (rollbackError as Error)?.message ?? rollbackError,
                ).slice(0, 500)
              : null,
          },
        });
        req.log.error(
          { err: error, rollbackErr: rollbackError, kebabId: row.kebabId },
          "agent update failed to synchronize with Inngest",
        );
        if (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            "agent update and runtime rollback both failed",
          );
        }
        throw error;
      }
    }

    if (titleChanged) {
      writeAudit({
        tenantId: auth.tenantId,
        actorUserId: auth.userId ?? undefined,
        action: "agent.rename",
        targetType: "agent",
        targetId: row.id,
        meta: { kebabId: row.kebabId, from: row.title, to: title },
      });
    }
    if (enabledChanged) {
      writeAudit({
        tenantId: auth.tenantId,
        actorUserId: auth.userId ?? undefined,
        action: enabled ? "agent.enable" : "agent.disable",
        targetType: "agent",
        targetId: row.id,
        meta: { kebabId: row.kebabId, kind: row.kind, inngest_fns: fnCount },
      });
    }

    return reply.ok({
      kebabId: row.kebabId,
      name: row.name,
      title,
      kind: row.kind,
      enabled,
      reregistered: enabledChanged,
      runtimeSynchronized: enabledChanged,
      fnCount,
    });
  });

  // DELETE /v1/agents/:kebab — remove a manifest agent from its durable source,
  // then synchronize the new function set. Deleting only its SQLite projection
  // is not sufficient: bootstrap would recreate it from workflow.json.
  app.delete<{ Params: { kebab: string }; Querystring: { force?: string } }>(
    "/agents/:kebab",
    async (req, reply) => {
      const auth = requirePermission(req, "agents.write");
      return withTenantWorkflowMutationLease({
        tenantId: auth.tenantId,
        kind: "agents_delete",
        workId: req.params.kebab,
        fn: async (lease) => {
          lease.assertOwned();
          const db = getDb();
          const row = db
            .select({
              id: agents.id,
              kebabId: agents.kebabId,
              name: agents.name,
              kind: agents.kind,
              enabled: agents.enabled,
              workflowId: workflows.id,
              workflowSlug: workflows.slug,
            })
            .from(agents)
            .innerJoin(workflows, eq(workflows.id, agents.workflowId))
            .where(
              and(
                eq(workflows.tenantId, auth.tenantId),
                eq(agents.kebabId, req.params.kebab),
              ),
            )
            .all()[0];
          if (!row) return reply.fail("not_found", "agent not found", 404);

          const runCount = db
            .select({ id: runs.id })
            .from(runs)
            .where(eq(runs.agentId, row.id))
            .all().length;
          const force = req.query.force === "1" || req.query.force === "true";

          let sourceRemoved = false;
          let runtimeSynchronized = false;
          let deploymentId: string | null = null;
          let version: string | null = null;

          if (row.kind === "manifest") {
            const live = db
              .select({
                manifest: workflowVersions.manifestJson,
                actions: workflowVersions.actionsJson,
              })
              .from(deployments)
              .innerJoin(
                workflowVersions,
                eq(workflowVersions.id, deployments.versionId),
              )
              .where(
                and(
                  eq(deployments.tenantId, auth.tenantId),
                  eq(deployments.target, "workflow"),
                  eq(deployments.status, "live"),
                  eq(workflowVersions.workflowId, row.workflowId),
                ),
              )
              .all()[0];
            if (live) {
              if (!Array.isArray(live.manifest)) {
                throw new Error(
                  "live workflow manifest is not an array; refusing an unsafe deletion",
                );
              }
              const nextManifest = live.manifest.filter(
                (entry) =>
                  !entry ||
                  typeof entry !== "object" ||
                  (entry as { id?: unknown }).id !== row.kebabId,
              );
              sourceRemoved = nextManifest.length !== live.manifest.length;
              if (sourceRemoved) {
                const out = await commit(
                  {
                    mode: "commit",
                    workflow: nextManifest,
                    actions: Array.isArray(live.actions)
                      ? live.actions
                      : undefined,
                    target: "production",
                    confirm_overwrite: true,
                    conflict_resolutions: [],
                    note: `Agent ${row.kebabId} removed by operator`,
                  },
                  {
                    tenantId: auth.tenantId,
                    tenantSlug: auth.tenantSlug,
                    workflowSlug: row.workflowSlug,
                  },
                  {
                    actorUserId: auth.userId ?? undefined,
                    log: {
                      error: (obj, msg) => req.log.error(obj, msg ?? ""),
                      info: (obj, msg) => req.log.info(obj, msg ?? ""),
                    },
                  },
                );
                runtimeSynchronized = true;
                deploymentId = out.deployment_id;
                version = out.version;
              }
            }
          }

          // Code agents and legacy projections without a live manifest do not have
          // an editable source artifact here. Disable them honestly; for a manifest
          // projection, synchronize so any matching disk function is excluded.
          if (!sourceRemoved) {
            db.update(agents)
              .set({ enabled: false, updatedAt: new Date() })
              .where(eq(agents.id, row.id))
              .run();
            if (row.kind === "manifest") {
              try {
                await synchronizeTenantRuntime(auth.tenantSlug);
                runtimeSynchronized = true;
              } catch (error) {
                db.update(agents)
                  .set({ enabled: row.enabled, updatedAt: new Date() })
                  .where(eq(agents.id, row.id))
                  .run();
                let rollbackError: unknown = null;
                try {
                  await synchronizeTenantRuntime(auth.tenantSlug);
                } catch (failure) {
                  rollbackError = failure;
                }
                if (rollbackError) {
                  throw new AggregateError(
                    [error, rollbackError],
                    "agent delete and runtime rollback both failed",
                  );
                }
                throw error;
              }
            }
          }

          let deleted = false;
          // Physical deletion is safe only after the durable manifest no longer
          // contains the agent. Otherwise a later bootstrap would resurrect it.
          if (sourceRemoved && (runCount === 0 || force)) {
            db.transaction(() => {
              if (force && runCount > 0) {
                db.delete(runs).where(eq(runs.agentId, row.id)).run();
              }
              db.delete(agents).where(eq(agents.id, row.id)).run();
            });
            deleted = true;
          }
          const disabled = !deleted;
          writeAudit({
            tenantId: auth.tenantId,
            actorUserId: auth.userId ?? undefined,
            action: deleted ? "agent.delete" : "agent.disable",
            targetType: "agent",
            targetId: row.id,
            meta: {
              kebabId: row.kebabId,
              kind: row.kind,
              runCount,
              force,
              sourceRemoved,
              runtimeSynchronized,
              deploymentId,
              version,
            },
          });
          lease.assertOwned();
          return reply.ok({
            kebabId: row.kebabId,
            deleted,
            disabled,
            runCount,
            sourceRemoved,
            reregistered: runtimeSynchronized,
            runtimeSynchronized,
            deploymentId,
            version,
            note: disabled
              ? sourceRemoved
                ? "该智能体已从运行清单移除并下线；因保留运行历史，未物理删除记录。使用 ?force=1 可清理历史后删除。"
                : "该智能体没有可由此接口安全修改的运行清单，已真实下线但保留来源记录。"
              : undefined,
          });
        },
      });
    },
  );
}
