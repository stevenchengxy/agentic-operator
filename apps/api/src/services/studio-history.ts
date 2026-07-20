import { and, desc, eq, inArray, isNull, lt, or } from "drizzle-orm";
import {
  agentDraftRevisions,
  agentRunSessions,
  events,
  getDb,
  runMessages,
  runs,
} from "@agentic/db";
import { makeId } from "@agentic/shared";
import {
  ProviderIdSchema,
  type AgentRunHistoryRow,
  type AgentRunSession,
  type GetRunSessionResponse,
  type ListAgentRunsQuery,
  type ListAgentRunsResponse,
  type RunMessage,
  type StudioRunContinuation,
} from "@agentic/contracts";
import type { AuthedContext } from "../plugins/auth";
import { AgentStudioNotFoundError, findStudioAgent } from "./agent-drafts";

type RunRow = typeof runs.$inferSelect;

function promptPreview(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const prompt = (value as Record<string, unknown>).prompt;
  if (typeof prompt !== "string") return null;
  const compact = prompt.replace(/\s+/g, " ").trim();
  return compact ? compact.slice(0, 400) : null;
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function continuationForSession(
  tenantId: string,
  sessionId: string,
  messages: RunMessage[],
): StudioRunContinuation | null {
  const latest = getDb()
    .select({
      runId: runs.id,
      agentVersionId: runs.agentVersionId,
      sideEffectMode: runs.sideEffectMode,
      eventName: events.name,
      draftId: agentDraftRevisions.draftId,
      draftRevision: agentDraftRevisions.revision,
    })
    .from(runs)
    .leftJoin(events, eq(events.id, runs.triggerEventId))
    .leftJoin(
      agentDraftRevisions,
      eq(agentDraftRevisions.id, runs.draftRevisionId),
    )
    .where(and(eq(runs.tenantId, tenantId), eq(runs.sessionId, sessionId)))
    .orderBy(desc(runs.queuedAt), desc(runs.id))
    .limit(1)
    .all()[0];
  if (!latest?.eventName) return null;

  const target: StudioRunContinuation["target"] | null =
    latest.draftId && latest.draftRevision !== null
      ? {
          kind: "draft",
          draftId: latest.draftId,
          revision: latest.draftRevision,
        }
      : latest.agentVersionId
        ? { kind: "live", agentVersionId: latest.agentVersionId }
        : null;
  if (!target) return null;

  const userMessage = [...messages]
    .reverse()
    .find(
      (message) => message.runId === latest.runId && message.role === "user",
    );
  const content = recordValue(userMessage?.content);
  const inputs = recordValue(content.inputs);
  return {
    runId: latest.runId,
    target,
    triggerEvent: latest.eventName,
    inputs,
    toolPolicy:
      latest.sideEffectMode === "live"
        ? "live"
        : latest.sideEffectMode === "suppressed"
          ? "simulate"
          : "safe",
  };
}

function toHistoryRow(run: RunRow, message?: unknown): AgentRunHistoryRow {
  const parsedProvider = ProviderIdSchema.safeParse(run.provider);
  return {
    id: run.id,
    sessionId: run.sessionId,
    status: run.status,
    source: run.invocationSource,
    target: run.draftRevisionId
      ? { kind: "draft", draftRevisionId: run.draftRevisionId }
      : { kind: "live", agentVersionId: run.agentVersionId },
    definitionHash: run.definitionHash,
    subject: run.subject,
    promptPreview: promptPreview(message),
    testRun: run.isTest,
    sideEffectMode: run.sideEffectMode,
    outputValid: run.outputValid,
    queuedAt: run.queuedAt,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    durationMs: run.durationMs,
    provider: parsedProvider.success ? parsedProvider.data : null,
    model: run.model,
    tokensIn: run.tokensIn,
    tokensOut: run.tokensOut,
    error: run.errorMessage,
  };
}

export function createRunSession(
  ctx: AuthedContext,
  agentRef: string,
  title?: string,
): AgentRunSession {
  const agent = findStudioAgent(ctx, agentRef);
  if (!agent) throw new AgentStudioNotFoundError("agent");
  const id = makeId("ars");
  const now = new Date();
  getDb()
    .insert(agentRunSessions)
    .values({
      id,
      tenantId: ctx.tenantId,
      agentId: agent.id,
      createdBy: null,
      title: title ?? null,
      createdAt: now,
      updatedAt: now,
      lastRunAt: null,
    })
    .run();
  return getDb()
    .select()
    .from(agentRunSessions)
    .where(eq(agentRunSessions.id, id))
    .all()[0]!;
}

function listRowsForAgent(
  tenantId: string,
  agentId: string,
  input: ListAgentRunsQuery,
): ListAgentRunsResponse {
  const db = getDb();
  const predicates = [
    eq(runs.tenantId, tenantId),
    eq(runs.agentId, agentId),
    isNull(runs.deletedAt),
  ];
  if (input.versionId)
    predicates.push(eq(runs.agentVersionId, input.versionId));
  if (input.draftRevisionId) {
    predicates.push(eq(runs.draftRevisionId, input.draftRevisionId));
  }
  if (input.sessionId) predicates.push(eq(runs.sessionId, input.sessionId));
  if (input.source) predicates.push(eq(runs.invocationSource, input.source));
  if (input.status) predicates.push(eq(runs.status, input.status));

  if (input.cursor) {
    const cursor = db
      .select({ id: runs.id, queuedAt: runs.queuedAt })
      .from(runs)
      .where(
        and(
          eq(runs.tenantId, tenantId),
          eq(runs.agentId, agentId),
          eq(runs.id, input.cursor),
        ),
      )
      .limit(1)
      .all()[0];
    if (cursor) {
      predicates.push(
        or(
          lt(runs.queuedAt, cursor.queuedAt),
          and(eq(runs.queuedAt, cursor.queuedAt), lt(runs.id, cursor.id)),
        )!,
      );
    }
  }

  const rows = db
    .select()
    .from(runs)
    .where(and(...predicates))
    .orderBy(desc(runs.queuedAt), desc(runs.id))
    .limit(input.limit + 1)
    .all();
  const hasMore = rows.length > input.limit;
  const page = rows.slice(0, input.limit);
  const messagesByRun = new Map<string, unknown>();
  if (page.length > 0) {
    const messages = db
      .select({
        runId: runMessages.runId,
        content: runMessages.contentJson,
      })
      .from(runMessages)
      .where(
        and(
          eq(runMessages.tenantId, tenantId),
          eq(runMessages.role, "user"),
          inArray(
            runMessages.runId,
            page.map((run) => run.id),
          ),
        ),
      )
      .orderBy(runMessages.ord)
      .all();
    for (const message of messages) {
      if (message.runId && !messagesByRun.has(message.runId)) {
        messagesByRun.set(message.runId, message.content);
      }
    }
  }
  return {
    runs: page.map((run) => toHistoryRow(run, messagesByRun.get(run.id))),
    nextCursor: hasMore ? (page.at(-1)?.id ?? null) : null,
  };
}

export function listAgentStudioRuns(
  ctx: Pick<AuthedContext, "tenantId">,
  agentRef: string,
  input: ListAgentRunsQuery,
): ListAgentRunsResponse {
  const agent = findStudioAgent(ctx, agentRef);
  if (!agent) throw new AgentStudioNotFoundError("agent");
  return listRowsForAgent(ctx.tenantId, agent.id, input);
}

export function getStudioRunSession(
  ctx: Pick<AuthedContext, "tenantId">,
  sessionId: string,
): GetRunSessionResponse | null {
  const session = getDb()
    .select()
    .from(agentRunSessions)
    .where(
      and(
        eq(agentRunSessions.tenantId, ctx.tenantId),
        eq(agentRunSessions.id, sessionId),
      ),
    )
    .limit(1)
    .all()[0];
  if (!session) return null;
  const messages: RunMessage[] = getDb()
    .select()
    .from(runMessages)
    .where(
      and(
        eq(runMessages.tenantId, ctx.tenantId),
        eq(runMessages.sessionId, sessionId),
      ),
    )
    .orderBy(runMessages.ord)
    .all()
    .map((message) => ({
      id: message.id,
      sessionId: message.sessionId,
      runId: message.runId,
      ord: message.ord,
      role: message.role,
      content: message.contentJson,
      createdAt: message.createdAt,
    }));
  const history = listRowsForAgent(ctx.tenantId, session.agentId, {
    limit: 100,
    sessionId,
  });
  return {
    session,
    messages,
    runs: history.runs,
    continuation: continuationForSession(ctx.tenantId, sessionId, messages),
  };
}
