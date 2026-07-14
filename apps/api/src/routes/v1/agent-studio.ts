import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { and, eq } from "drizzle-orm";
import {
  AgentVersionDiffQuerySchema,
  AgentVersionDiffResponseSchema,
  AgentDraftResponseSchema,
  AgentEditorResponseSchema,
  CreateAgentRunBodySchema,
  CreateAgentRunResponseSchema,
  CreateAgentDraftBodySchema,
  CreateRunSessionBodySchema,
  CreateRunSessionResponseSchema,
  GenerateDraftInstructionsBodySchema,
  GenerateDraftInstructionsResponseSchema,
  GetAgentVersionResponseSchema,
  GetRunSessionResponseSchema,
  GetRunTraceQuerySchema,
  GetRunTraceResponseSchema,
  ListAgentRunsQuerySchema,
  ListAgentRunsResponseSchema,
  ListAgentVersionsQuerySchema,
  ListAgentVersionsResponseSchema,
  PatchAgentDraftBodySchema,
  PublishAgentDraftBodySchema,
  PublishAgentDraftResponseSchema,
  RestoreAgentVersionBodySchema,
  RunOutputResponseSchema,
  ValidateAgentDraftResponseSchema,
} from "@agentic/contracts";
import { getDb, runs } from "@agentic/db";
import { isLLMError } from "@agentic/llm-gateway";
import { requireAuth } from "../../plugins/auth";
import { writeAudit } from "../../plugins/audit";
import {
  AgentStudioNotFoundError,
  createAgentDraft,
  createNewAgentDraft,
  deleteAgentDraft,
  DraftPublishConflictError,
  DraftImpactConfirmationError,
  DraftIdentityError,
  DraftRevisionConflictError,
  DraftValidationError,
  diffAgentVersions,
  generateDraftInstructions,
  getAgentEditor,
  getAgentVersion,
  getDraft,
  listAgentVersions,
  patchAgentDraft,
  publishDraft,
  restoreAgentVersion,
  validateDraft,
} from "../../services/agent-drafts";
import type { AuditCtx } from "../../services/manifest-import";
import { getRunOutput, getRunTrace } from "../../services/studio-observability";
import {
  createRunSession,
  getStudioRunSession,
  listAgentStudioRuns,
} from "../../services/studio-history";
import {
  reserveStudioRun,
  StudioRunInputError,
} from "../../services/studio-runner";

function parseIfMatch(value: string | string[] | undefined): number | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) return null;
  const normalized = raw.trim().replace(/^W\//, "").replaceAll('"', "");
  const revision = Number(normalized);
  return Number.isInteger(revision) && revision > 0 ? revision : null;
}

function setDraftEtag(reply: FastifyReply, revision: number): void {
  reply.header("etag", `\"${revision}\"`);
}

function auditCtxFor(req: FastifyRequest): AuditCtx {
  return {
    log: {
      error: (obj, message) => req.log.error(obj, message ?? ""),
      info: (obj, message) => req.log.info(obj, message ?? ""),
    },
  };
}

function llmStatus(code: string): number {
  if (code === "auth") return 401;
  if (code === "rate_limit") return 429;
  if (code === "timeout") return 504;
  if (code === "bad_request" || code === "model_not_found") return 400;
  if (code === "not_configured") return 503;
  return 502;
}

function studioFailure(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof AgentStudioNotFoundError) {
    return reply.fail("not_found", error.message, 404);
  }
  if (error instanceof DraftRevisionConflictError) {
    return reply.fail(
      "draft_revision_conflict",
      error.message,
      409,
      "Reload the current revision and merge or reapply your changes.",
      { current: error.current },
    );
  }
  if (error instanceof DraftPublishConflictError) {
    return reply.fail(
      "publish_conflict",
      error.message,
      409,
      "The same live agent changed. Review the live/draft diff before publishing.",
      {
        baseWorkflowVersionId: error.baseWorkflowVersionId,
        liveWorkflowVersionId: error.liveWorkflowVersionId,
      },
    );
  }
  if (error instanceof DraftImpactConfirmationError) {
    return reply.fail(
      "impact_confirmation_required",
      error.message,
      409,
      "Review the affected sections and retry with confirmImpact=true.",
      { impacts: error.impacts },
    );
  }
  if (error instanceof DraftIdentityError) {
    return reply.fail(
      "agent_identity_immutable",
      error.message,
      400,
      "Create a new agent when you need a different stable agent id.",
      { expectedId: error.expectedId, receivedId: error.receivedId },
    );
  }
  if (error instanceof DraftValidationError) {
    return reply.fail(
      "draft_invalid",
      error.message,
      400,
      "Resolve all validation errors before publishing.",
      { validation: error.validation },
    );
  }
  if (error instanceof StudioRunInputError) {
    const status =
      error.code === "session_not_found"
        ? 404
        : error.code.endsWith("expired")
          ? 410
          : 400;
    return reply.fail(
      error.code,
      error.message,
      status,
      undefined,
      error.issues,
    );
  }
  if (isLLMError(error)) {
    return reply.fail(error.code, error.message, llmStatus(error.code));
  }
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith("agent_conflict:")) {
    return reply.fail(
      "agent_conflict",
      message.slice("agent_conflict:".length),
      409,
    );
  }
  throw error;
}

export async function agentStudioRoutes(app: FastifyInstance): Promise<void> {
  app.get<{
    Params: { id: string };
    Querystring: { draftId?: string };
  }>("/agents/:id/editor", async (req, reply) => {
    const auth = requireAuth(req);
    try {
      const editor = AgentEditorResponseSchema.parse(
        getAgentEditor(auth, req.params.id, req.query.draftId),
      );
      if (editor.draft) setDraftEtag(reply, editor.draft.revision);
      return reply.ok(editor);
    } catch (error) {
      return studioFailure(reply, error);
    }
  });

  app.get<{ Params: { id: string; versionId: string } }>(
    "/agents/:id/versions/:versionId",
    async (req, reply) => {
      const auth = requireAuth(req);
      try {
        return reply.ok(
          GetAgentVersionResponseSchema.parse({
            version: getAgentVersion(auth, req.params.id, req.params.versionId),
          }),
        );
      } catch (error) {
        return studioFailure(reply, error);
      }
    },
  );

  app.get<{
    Params: { id: string };
    Querystring: { from?: string; to?: string };
  }>("/agents/:id/diff", async (req, reply) => {
    const auth = requireAuth(req);
    const query = AgentVersionDiffQuerySchema.parse(req.query);
    try {
      return reply.ok(
        AgentVersionDiffResponseSchema.parse(
          diffAgentVersions(auth, req.params.id, query.from, query.to),
        ),
      );
    } catch (error) {
      return studioFailure(reply, error);
    }
  });

  app.post("/agents/drafts", async (req, reply) => {
    const auth = requireAuth(req);
    const body = CreateAgentDraftBodySchema.parse(req.body ?? {});
    if (!body.definition) {
      return reply.fail(
        "definition_required",
        "A complete Agent Definition v2 is required when creating a new agent draft.",
        400,
      );
    }
    try {
      const draft = createNewAgentDraft(auth, body.definition);
      setDraftEtag(reply, draft.revision);
      writeAudit({
        tenantId: auth.tenantId,
        action: "agent.draft.create",
        targetType: "agent_draft",
        targetId: draft.id,
        meta: {
          agent_id: draft.agentId,
          definition_hash: draft.definitionHash,
        },
      });
      return reply.ok(
        AgentDraftResponseSchema.parse({ draft, etag: String(draft.revision) }),
        201,
      );
    } catch (error) {
      return studioFailure(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>(
    "/agents/:id/drafts",
    async (req, reply) => {
      const auth = requireAuth(req);
      const body = CreateAgentDraftBodySchema.parse(req.body ?? {});
      try {
        const draft = createAgentDraft(auth, req.params.id, body);
        setDraftEtag(reply, draft.revision);
        writeAudit({
          tenantId: auth.tenantId,
          action: "agent.draft.create",
          targetType: "agent_draft",
          targetId: draft.id,
          meta: {
            agent_id: draft.agentId,
            definition_hash: draft.definitionHash,
          },
        });
        return reply.ok(
          AgentDraftResponseSchema.parse({
            draft,
            etag: String(draft.revision),
          }),
          201,
        );
      } catch (error) {
        return studioFailure(reply, error);
      }
    },
  );

  app.get<{ Params: { draftId: string } }>(
    "/agent-drafts/:draftId",
    async (req, reply) => {
      const auth = requireAuth(req);
      try {
        const draft = getDraft(auth, req.params.draftId);
        setDraftEtag(reply, draft.revision);
        return reply.ok(
          AgentDraftResponseSchema.parse({
            draft,
            etag: String(draft.revision),
          }),
        );
      } catch (error) {
        return studioFailure(reply, error);
      }
    },
  );

  app.patch<{
    Params: { draftId: string };
    Headers: { "if-match"?: string };
  }>("/agent-drafts/:draftId", async (req, reply) => {
    const auth = requireAuth(req);
    const expectedRevision = parseIfMatch(req.headers["if-match"]);
    if (!expectedRevision) {
      return reply.fail(
        "precondition_required",
        "PATCH requires If-Match with the last seen draft revision.",
        428,
      );
    }
    const body = PatchAgentDraftBodySchema.parse(req.body);
    try {
      const draft = patchAgentDraft(
        auth,
        req.params.draftId,
        expectedRevision,
        body.definition,
      );
      setDraftEtag(reply, draft.revision);
      writeAudit({
        tenantId: auth.tenantId,
        action: "agent.draft.update",
        targetType: "agent_draft",
        targetId: draft.id,
        meta: {
          revision: draft.revision,
          definition_hash: draft.definitionHash,
        },
      });
      return reply.ok(
        AgentDraftResponseSchema.parse({ draft, etag: String(draft.revision) }),
      );
    } catch (error) {
      return studioFailure(reply, error);
    }
  });

  app.delete<{ Params: { draftId: string } }>(
    "/agent-drafts/:draftId",
    async (req, reply) => {
      const auth = requireAuth(req);
      try {
        deleteAgentDraft(auth, req.params.draftId);
        writeAudit({
          tenantId: auth.tenantId,
          action: "agent.draft.delete",
          targetType: "agent_draft",
          targetId: req.params.draftId,
        });
        return reply.ok({ deleted: true, draftId: req.params.draftId });
      } catch (error) {
        return studioFailure(reply, error);
      }
    },
  );

  app.post<{ Params: { draftId: string } }>(
    "/agent-drafts/:draftId/validate",
    async (req, reply) => {
      const auth = requireAuth(req);
      try {
        const result = ValidateAgentDraftResponseSchema.parse(
          validateDraft(auth, req.params.draftId),
        );
        writeAudit({
          tenantId: auth.tenantId,
          action: "agent.draft.validate",
          targetType: "agent_draft",
          targetId: req.params.draftId,
          meta: {
            status: result.validation.status,
            issue_count: result.validation.issues.length,
            definition_hash: result.validation.definitionHash,
          },
        });
        return reply.ok(result);
      } catch (error) {
        return studioFailure(reply, error);
      }
    },
  );

  app.post<{ Params: { draftId: string } }>(
    "/agent-drafts/:draftId/generate-instructions",
    async (req, reply) => {
      const auth = requireAuth(req);
      const body = GenerateDraftInstructionsBodySchema.parse(req.body);
      try {
        const generated = GenerateDraftInstructionsResponseSchema.parse(
          await generateDraftInstructions(auth, req.params.draftId, body),
        );
        writeAudit({
          tenantId: auth.tenantId,
          action: "agent.prompt.generate",
          targetType: "agent_draft",
          targetId: req.params.draftId,
          meta: {
            mode: body.mode,
            provider: generated.provenance.provider,
            model: generated.provenance.model,
            source_hash: generated.provenance.source_hash,
          },
        });
        return reply.ok(generated);
      } catch (error) {
        return studioFailure(reply, error);
      }
    },
  );

  app.post<{ Params: { draftId: string } }>(
    "/agent-drafts/:draftId/publish",
    async (req, reply) => {
      const auth = requireAuth(req);
      const body = PublishAgentDraftBodySchema.parse(req.body ?? {});
      try {
        const published = PublishAgentDraftResponseSchema.parse(
          await publishDraft(auth, req.params.draftId, body, auditCtxFor(req)),
        );
        writeAudit({
          tenantId: auth.tenantId,
          action: "agent.draft.publish",
          targetType: "agent_draft",
          targetId: req.params.draftId,
          meta: {
            workflow_version_id: published.workflowVersionId,
            agent_version_id: published.agentVersionId,
            definition_hash: published.definitionHash,
          },
        });
        return reply.ok(published, 201);
      } catch (error) {
        return studioFailure(reply, error);
      }
    },
  );

  app.get<{
    Params: { id: string };
    Querystring: { cursor?: string; limit?: number | string };
  }>("/agents/:id/versions", async (req, reply) => {
    const auth = requireAuth(req);
    const query = ListAgentVersionsQuerySchema.parse(req.query);
    try {
      return reply.ok(
        ListAgentVersionsResponseSchema.parse(
          listAgentVersions(auth, req.params.id, query),
        ),
      );
    } catch (error) {
      return studioFailure(reply, error);
    }
  });

  app.post<{ Params: { id: string; versionId: string } }>(
    "/agents/:id/versions/:versionId/restore",
    async (req, reply) => {
      const auth = requireAuth(req);
      RestoreAgentVersionBodySchema.parse(req.body ?? {});
      try {
        const draft = restoreAgentVersion(
          auth,
          req.params.id,
          req.params.versionId,
        );
        setDraftEtag(reply, draft.revision);
        writeAudit({
          tenantId: auth.tenantId,
          action: "agent.version.restore",
          targetType: "agent_version",
          targetId: req.params.versionId,
          meta: { draft_id: draft.id, agent_id: draft.agentId },
        });
        return reply.ok(
          AgentDraftResponseSchema.parse({
            draft,
            etag: String(draft.revision),
          }),
          201,
        );
      } catch (error) {
        return studioFailure(reply, error);
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    "/agents/:id/runs",
    async (req, reply) => {
      const auth = requireAuth(req);
      const body = CreateAgentRunBodySchema.parse(req.body);
      try {
        const reserved = CreateAgentRunResponseSchema.parse(
          await reserveStudioRun(auth, req.params.id, body),
        );
        writeAudit({
          tenantId: auth.tenantId,
          action: "agent.run.studio",
          targetType: "run",
          targetId: reserved.runId,
          meta: {
            agent_id: req.params.id,
            session_id: reserved.sessionId,
            target: body.target.kind,
            tool_policy: body.toolPolicy,
            definition_hash: reserved.definitionHash,
          },
        });
        return reply.ok(reserved, 202);
      } catch (error) {
        return studioFailure(reply, error);
      }
    },
  );

  app.get<{
    Params: { id: string };
    Querystring: Record<string, string | undefined>;
  }>("/agents/:id/runs", async (req, reply) => {
    const auth = requireAuth(req);
    const query = ListAgentRunsQuerySchema.parse(req.query);
    try {
      return reply.ok(
        ListAgentRunsResponseSchema.parse(
          listAgentStudioRuns(auth, req.params.id, query),
        ),
      );
    } catch (error) {
      return studioFailure(reply, error);
    }
  });

  app.post("/run-sessions", async (req, reply) => {
    const auth = requireAuth(req);
    const body = CreateRunSessionBodySchema.parse(req.body);
    try {
      const session = createRunSession(auth, body.agentId, body.title);
      writeAudit({
        tenantId: auth.tenantId,
        action: "agent.run_session.create",
        targetType: "agent_run_session",
        targetId: session.id,
        meta: { agent_id: session.agentId },
      });
      return reply.ok(CreateRunSessionResponseSchema.parse({ session }), 201);
    } catch (error) {
      return studioFailure(reply, error);
    }
  });

  app.get<{ Params: { id: string } }>(
    "/run-sessions/:id",
    async (req, reply) => {
      const auth = requireAuth(req);
      const session = getStudioRunSession(auth, req.params.id);
      if (!session) {
        return reply.fail("not_found", "run session not found", 404);
      }
      return reply.ok(GetRunSessionResponseSchema.parse(session));
    },
  );

  app.get<{
    Params: { id: string };
    Querystring: { after?: string | number; limit?: string | number };
  }>("/runs/:id/trace", async (req, reply) => {
    const auth = requireAuth(req);
    const query = GetRunTraceQuerySchema.parse(req.query);
    const trace = getRunTrace(
      auth.tenantId,
      req.params.id,
      query.after,
      query.limit,
    );
    if (!trace) return reply.fail("not_found", "run not found", 404);
    return reply.ok(GetRunTraceResponseSchema.parse(trace));
  });

  app.get<{ Params: { id: string } }>(
    "/runs/:id/output",
    async (req, reply) => {
      const auth = requireAuth(req);
      const output = await getRunOutput(auth.tenantId, req.params.id);
      if (!output) return reply.fail("not_found", "run not found", 404);
      return reply.ok(RunOutputResponseSchema.parse(output));
    },
  );

  app.get<{ Params: { id: string } }>(
    "/runs/:id/trace/stream",
    async (req, reply) => {
      const auth = requireAuth(req);
      const owned = getDb()
        .select({ status: runs.status })
        .from(runs)
        .where(
          and(eq(runs.tenantId, auth.tenantId), eq(runs.id, req.params.id)),
        )
        .limit(1)
        .all()[0];
      if (!owned) return reply.fail("not_found", "run not found", 404);

      const lastEventHeader = req.headers["last-event-id"];
      const rawLastEvent = Array.isArray(lastEventHeader)
        ? lastEventHeader[0]
        : lastEventHeader;
      let after = Math.max(0, Number(rawLastEvent ?? 0) || 0);
      let lastHeartbeat = Date.now();
      let closed = false;
      req.raw.on("close", () => {
        closed = true;
      });
      reply.hijack();
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      reply.raw.write(": agent-studio trace stream\n\n");

      while (!closed) {
        const page = getRunTrace(auth.tenantId, req.params.id, after, 500);
        if (!page) break;
        for (const event of page.events) {
          reply.raw.write(
            `id: ${event.seq}\nevent: trace\ndata: ${JSON.stringify(event)}\n\n`,
          );
          after = event.seq;
        }
        const current = getDb()
          .select({ status: runs.status })
          .from(runs)
          .where(
            and(eq(runs.tenantId, auth.tenantId), eq(runs.id, req.params.id)),
          )
          .limit(1)
          .all()[0];
        if (
          !current ||
          ["ok", "failed", "cancelled"].includes(current.status)
        ) {
          reply.raw.write(
            `event: end\ndata: ${JSON.stringify({ status: current?.status ?? "gone", after })}\n\n`,
          );
          break;
        }
        if (Date.now() - lastHeartbeat >= 15_000) {
          reply.raw.write(`: heartbeat ${Date.now()}\n\n`);
          lastHeartbeat = Date.now();
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 350));
      }
      if (!reply.raw.destroyed) reply.raw.end();
      return reply;
    },
  );
}
