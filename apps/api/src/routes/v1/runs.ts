import type { FastifyInstance } from "fastify";
import { readFile } from "node:fs/promises";
import { and, desc, eq } from "drizzle-orm";
import { agents, events, getDb, runs, tasks } from "@agentic/db";
import { getTenantInngest } from "@agentic/runtime";
import { makeId } from "@agentic/shared";
import { ListRunsQuery } from "@agentic/contracts";
import { requireAuth } from "../../plugins/auth";
import { requirePermission } from "../../plugins/rbac";
import { writeAudit } from "../../plugins/audit";
import {
  getRun,
  listRecentRuns,
  listRunsPaged,
  listSteps,
  listRunChain,
  softDeleteRun,
  restoreRun,
  bulkSoftDeleteRuns,
  purgeDeletedRuns,
} from "../../queries/runs";
import { getRunSummary } from "../../queries/reasoning";
import { generateRunSummary } from "../../services/run-summary";

export async function runsRoutes(app: FastifyInstance) {
  // GET /v1/runs — list.
  //
  // Two shapes on one route, chosen by the query:
  //   - `?page=N` (or the recycle-bin `?deleted=1`) → a PaginatedRuns envelope
  //     `{ rows, total, page, pageSize }` for server-side page controls.
  //   - no `page` → the legacy bare array (dashboard / logs / trace-tree still
  //     read `useRuns()` expecting an array, so this stays back-compatible).
  app.get("/runs", async (req, reply) => {
    const auth = requirePermission(req, "runs.read");
    const q = ListRunsQuery.parse(req.query);
    const wantDeleted = q.deleted === "1" || q.deleted === "true";

    if (q.page !== undefined || wantDeleted) {
      const paged = await listRunsPaged(auth.tenantSlug, {
        page: q.page,
        pageSize: q.pageSize,
        status: q.status,
        agentName: q.agent,
        query: q.q,
        parentRunId: q.parentRunId,
        deleted: wantDeleted,
      });
      return reply.ok(paged);
    }

    const rows = await listRecentRuns(auth.tenantSlug, {
      limit: q.limit,
      status: q.status,
      agentName: q.agent,
      query: q.q,
      parentRunId: q.parentRunId,
    });
    return reply.ok(rows);
  });

  // GET /v1/runs/:id — single, strictly tenant-scoped.
  //
  // Previously this handler fell back to `getRun("__system", id)` if the
  // caller's tenant didn't own the run, which leaked __system-tenant code-
  // agent runs (token usage, prompts, outputs) to every authed tenant.
  // P0-AUTH-02. Code-agent runs that need to be visible to the invoking
  // tenant are now stored under that tenant; cross-tenant __system runs are
  // an operator/platform-admin surface and require a dedicated route + grant.
  app.get<{ Params: { id: string } }>("/runs/:id", async (req, reply) => {
    const auth = requirePermission(req, "runs.read");
    const run = await getRun(auth.tenantSlug, req.params.id);
    if (!run) return reply.fail("not_found", "run not found", 404);
    const steps = await listSteps(run.id);
    // HITL: if the run is blocked on an open human task, surface it so the
    // run viewer can show a "waiting for approval" state + deep-link instead
    // of looking stalled. Newest open task wins.
    const waiting = getDb()
      .select({
        id: tasks.id,
        title: tasks.title,
        awaitingRole: tasks.awaitingRole,
        createdAt: tasks.createdAt,
      })
      .from(tasks)
      .where(and(eq(tasks.runId, run.id), eq(tasks.status, "open")))
      .orderBy(desc(tasks.createdAt))
      .all()[0];
    return reply.ok({ run, steps, waitingTask: waiting ?? null });
  });

  // GET /v1/runs/:id/chain — the whole cross-run cascade sharing this run's
  // correlationId, in pipeline order. The zhaopin 6-agent pipeline links runs
  // by re-emitting events with the same correlationId (NOT parentRunId), so the
  // parentRunId-based trace tab shows nothing; this surfaces the real chain.
  app.get<{ Params: { id: string } }>("/runs/:id/chain", async (req, reply) => {
    const auth = requirePermission(req, "runs.read");
    const chain = await listRunChain(auth.tenantSlug, req.params.id);
    if (!chain) return reply.fail("not_found", "run not found", 404);
    return reply.ok(chain);
  });

  // GET /v1/runs/:id/summary — the cached AI summary (W2), or null if not yet
  // generated. Tenant-scoped; cheap read (no LLM call).
  app.get<{ Params: { id: string } }>(
    "/runs/:id/summary",
    async (req, reply) => {
      const auth = requirePermission(req, "runs.read");
      const summary = getRunSummary(auth.tenantId, req.params.id);
      return reply.ok({ summary });
    },
  );

  // POST /v1/runs/:id/summary — generate (or regenerate) the AI summary and
  // cache it. Lazy: the run viewer calls this on first open when GET returned
  // null, and again on an explicit "regenerate". Degrades to a digest-only
  // summary when no real LLM provider is configured.
  app.post<{ Params: { id: string } }>(
    "/runs/:id/summary",
    async (req, reply) => {
      const auth = requirePermission(req, "runs.read");
      const summary = await generateRunSummary(auth.tenantSlug, req.params.id);
      if (!summary) return reply.fail("not_found", "run not found", 404);
      return reply.ok({ summary });
    },
  );

  // POST /v1/runs/:id/replay
  app.post<{ Params: { id: string } }>(
    "/runs/:id/replay",
    async (req, reply) => {
      const auth = requirePermission(req, "runs.replay");
      const db = getDb();
      const run = db.select().from(runs).where(eq(runs.id, req.params.id)).all()[0];
      if (!run) return reply.fail("not_found", "run not found", 404);
      if (run.tenantId !== auth.tenantId)
        return reply.fail("forbidden", "forbidden", 403);
      if (!run.triggerEventId)
        return reply.fail("no_trigger", "run has no trigger event", 400);

      const evt = db
        .select()
        .from(events)
        .where(eq(events.id, run.triggerEventId))
        .all()[0];
      if (!evt) return reply.fail("gone", "trigger event missing", 410);

      let payload: Record<string, unknown> = {};
      if (evt.payloadRef) {
        const [filePath, offsetStr] = evt.payloadRef.split("#");
        if (filePath && offsetStr != null) {
          try {
            const buf = await readFile(filePath);
            const offset = parseInt(offsetStr, 10);
            const nl = buf.indexOf(0x0a, offset);
            const line = buf.toString(
              "utf8",
              offset,
              nl === -1 ? undefined : nl,
            );
            payload = (JSON.parse(line).data ?? {}) as Record<string, unknown>;
          } catch {}
        }
      }

      const newEventId = makeId("evt");
      await getTenantInngest(auth.tenantSlug).send({
        name: `${auth.tenantSlug}/${evt.name}` as `${string}/${string}`,
        data: {
          ...payload,
          subject: evt.subject ?? undefined,
          __triggerEventId: newEventId,
          __replayOfRun: run.id,
        },
      });
      return reply.ok({ replayed_run: run.id, new_event_id: newEventId });
    },
  );

  // POST /v1/runs/:id/cancel — operator kill switch for an in-flight run.
  //
  // Two execution paths share `runs.status`:
  //   1. Manifest agents run inside Inngest functions registered in
  //      `packages/runtime/src/register.ts`. Each fn declares a `cancelOn`
  //      hook keyed on `${tenantSlug}/run.cancel` matching subjects, so
  //      Inngest aborts the function at the next step boundary. The
  //      route emits the cancel event via `inngest.send` (NOT inside a
  //      `step.run` — this is a plain route handler, not a step).
  //   2. Code-defined agents run synchronously in the invoke route.
  //      Their run engine polls `runs.status` at every checkpoint and
  //      throws `RunCancelledError` when the row flips to `cancelled`.
  //      That bubble-up causes the invoke route to return 200 with
  //      `cancelled:true` instead of an error envelope.
  //
  // The route flips `runs.status` synchronously so the UI updates fast;
  // the actual function termination is async (Inngest acks the cancel
  // event, then exits at the next step boundary). The response `note`
  // is honest about this.
  //
  // Idempotency: clicking Stop on a finished run is a no-op success —
  // operators routinely double-click; surfacing a 4xx for "already done"
  // is hostile UX. The audit row + Inngest emit only happen when we
  // actually flip the status.
  app.post<{ Params: { id: string } }>(
    "/runs/:id/cancel",
    async (req, reply) => {
      const auth = requirePermission(req, "runs.cancel");
      const db = getDb();
      const run = db.select().from(runs).where(eq(runs.id, req.params.id)).all()[0];
      if (!run) return reply.fail("not_found", "run not found", 404);
      if (run.tenantId !== auth.tenantId)
        return reply.fail("forbidden", "forbidden", 403);

      // Idempotent no-op when the run already reached a terminal state.
      // `cancelled` is terminal too — re-cancelling an already-cancelled
      // run returns 200 with the current row so a double-click does not
      // re-emit the Inngest cancel event or re-write the audit row.
      const TERMINAL = new Set(["ok", "failed", "cancelled"]);
      if (TERMINAL.has(run.status)) {
        req.log.info(
          {
            runId: run.id,
            tenantSlug: auth.tenantSlug,
            status: run.status,
            action: "run.cancel.noop",
          },
          "cancel: no-op (run already terminal)",
        );
        return reply.ok({
          runId: run.id,
          status: run.status,
          cancelled: false,
          note: `Run already terminal (status=${run.status}); no action taken.`,
        });
      }

      const previousStatus = run.status;
      const endedAt = new Date();
      const startedAtMs = run.startedAt?.getTime() ?? endedAt.getTime();
      const durationMs = endedAt.getTime() - startedAtMs;

      // Flip the run row first — both the UI and the code-agent
      // cooperative-cancel poll read this status. Doing the DB write
      // before the Inngest emit means the operator sees the cancel
      // state immediately even if Inngest is unreachable.
      db.update(runs)
        .set({
          status: "cancelled",
          endedAt,
          durationMs,
          errorMessage: "cancelled_by_operator",
        })
        .where(eq(runs.id, run.id))
        .run();

      writeAudit({
        tenantId: auth.tenantId,
        action: "run.cancel",
        targetType: "run",
        targetId: run.id,
        meta: { previousStatus, durationMs },
      });

      // Resolve the agent kind so we can give the operator an accurate
      // `note`. For manifest agents we must fire the Inngest cancel
      // signal; for code agents the cooperative poll handles termination
      // and we skip the Inngest send (no manifest fn to cancel).
      const agentRow = db
        .select({ kind: agents.kind })
        .from(agents)
        .where(eq(agents.id, run.agentId))
        .all()[0];
      const isManifest = agentRow?.kind !== "code";

      let inngestSent = false;
      let inngestError: string | null = null;
      if (isManifest) {
        try {
          // Resolve tenant slug for the namespaced event name. Cached at
          // the auth context so this is a no-op lookup in practice.
          await getTenantInngest(auth.tenantSlug).send({
            name: `${auth.tenantSlug}/run.cancel` as `${string}/${string}`,
            data: {
              runId: run.id,
              subject: run.subject ?? null,
              cancelledBy: auth.tenantSlug,
              previousStatus,
            },
          });
          inngestSent = true;
        } catch (err) {
          inngestError = err instanceof Error ? err.message : String(err);
          req.log.warn(
            { err, runId: run.id, action: "run.cancel.inngest_send_failed" },
            "cancel: inngest.send failed (run row already flipped to cancelled; manifest fn may continue until next checkpoint)",
          );
        }
      }

      req.log.info(
        {
          runId: run.id,
          tenantSlug: auth.tenantSlug,
          previousStatus,
          isManifest,
          inngestSent,
          action: "run.cancel",
        },
        "cancel: run flipped to cancelled",
      );

      const noteSuffix = isManifest
        ? inngestSent
          ? "Inngest cancel signal sent; manifest fn will exit at next step boundary."
          : `Inngest send failed (${inngestError ?? "unknown"}); run row flipped to cancelled, but the manifest fn may continue until its next step boundary.`
        : "Code agent will exit at the next cooperative-cancel checkpoint (between LLM calls).";

      return reply.ok({
        runId: run.id,
        status: "cancelled",
        cancelled: true,
        note: `Run status flipped to cancelled. ${noteSuffix}`,
      });
    },
  );

  // DELETE /v1/runs/:id — soft-delete (tombstone) a single run. Recoverable
  // from the recycle bin via POST /runs/:id/restore. Tenant-scoped and refuses
  // an in-flight run (cancel it first). Idempotent: re-deleting a tombstoned
  // run is a 200 no-op.
  app.delete<{ Params: { id: string } }>("/runs/:id", async (req, reply) => {
    const auth = requirePermission(req, "runs.delete");
    const reason = softDeleteRun(auth.tenantId, req.params.id);
    if (reason === "not_found")
      return reply.fail("not_found", "run not found", 404);
    if (reason === "active")
      return reply.fail(
        "run_active",
        "cannot delete an in-flight run — cancel it first",
        409,
      );
    if (reason === "ok") {
      writeAudit({
        tenantId: auth.tenantId,
        action: "run.delete",
        targetType: "run",
        targetId: req.params.id,
        meta: {},
      });
      return reply.ok({
        id: req.params.id,
        deleted: true,
        note: "Run soft-deleted (recoverable from the recycle bin).",
      });
    }
    // already_deleted → idempotent no-op success.
    return reply.ok({
      id: req.params.id,
      deleted: false,
      note: "Run already in the recycle bin; no action taken.",
    });
  });

  // POST /v1/runs/:id/restore — un-tombstone a soft-deleted run.
  app.post<{ Params: { id: string } }>(
    "/runs/:id/restore",
    async (req, reply) => {
      const auth = requirePermission(req, "runs.delete");
      const restored = restoreRun(auth.tenantId, req.params.id);
      if (restored) {
        writeAudit({
          tenantId: auth.tenantId,
          action: "run.restore",
          targetType: "run",
          targetId: req.params.id,
          meta: {},
        });
      }
      return reply.ok({
        id: req.params.id,
        restored,
        note: restored
          ? "Run restored from the recycle bin."
          : "Nothing to restore (run not found or not deleted).",
      });
    },
  );

  // DELETE /v1/runs?scope=… — bulk maintenance. scope=oldest&n=100 tombstones
  // the N oldest finished runs (清理最旧 N 条); scope=all tombstones every
  // finished run (一键清空); scope=purge HARD-deletes the recycle bin + log
  // files (清空回收站; irreversible). None ever touch an in-flight run.
  app.delete("/runs", async (req, reply) => {
    const auth = requirePermission(req, "runs.delete");
    const q = req.query as { scope?: string; n?: string };

    if (q.scope === "oldest") {
      const n = Number(q.n ?? 0);
      if (!Number.isFinite(n) || n <= 0)
        return reply.fail(
          "bad_request",
          "scope=oldest requires a positive `n`",
          400,
        );
      const deleted = bulkSoftDeleteRuns(auth.tenantId, "oldest", Math.trunc(n));
      writeAudit({
        tenantId: auth.tenantId,
        action: "run.delete.bulk",
        targetType: "run",
        targetId: `oldest:${Math.trunc(n)}`,
        meta: { scope: "oldest", n: Math.trunc(n), deleted },
      });
      return reply.ok({
        scope: "oldest",
        deleted,
        note: `Soft-deleted ${deleted} oldest finished run(s).`,
      });
    }

    if (q.scope === "all") {
      const deleted = bulkSoftDeleteRuns(auth.tenantId, "all");
      writeAudit({
        tenantId: auth.tenantId,
        action: "run.delete.bulk",
        targetType: "run",
        targetId: "all",
        meta: { scope: "all", deleted },
      });
      return reply.ok({
        scope: "all",
        deleted,
        note: `Soft-deleted ${deleted} finished run(s).`,
      });
    }

    if (q.scope === "purge") {
      const deleted = await purgeDeletedRuns(auth.tenantId);
      writeAudit({
        tenantId: auth.tenantId,
        action: "run.purge",
        targetType: "run",
        targetId: "recycle-bin",
        meta: { scope: "purge", deleted },
      });
      return reply.ok({
        scope: "purge",
        deleted,
        note: `Permanently removed ${deleted} run(s) from the recycle bin.`,
      });
    }

    return reply.fail(
      "bad_request",
      "scope must be one of: oldest | all | purge",
      400,
    );
  });
}
