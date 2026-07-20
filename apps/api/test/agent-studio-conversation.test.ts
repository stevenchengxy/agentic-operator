import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  AgentDefinitionV2Schema,
  CreateAgentRunBodySchema,
  STUDIO_AGENT_RUN_CONTROL_EVENT,
  StudioAgentRunEventDataSchema,
  type StudioAgentRunEventData,
} from "@agentic/contracts";
import {
  agentRunSessions,
  agents,
  agentVersions,
  artifacts,
  events,
  getDb,
  runMessages,
  runs,
  tenants,
  workflows,
  workflowVersions,
} from "@agentic/db";
import { canonicalJson, inngest } from "@agentic/runtime";
import { makeId } from "@agentic/shared";
import {
  buildStudioExecutionEvent,
  executeReservedStudioRun,
  replayStudioRun,
  reserveStudioRun,
  STUDIO_CONVERSATION_HISTORY_METADATA_KEY,
} from "../src/services/studio-runner";
import { buildTestEnv, type TestEnv } from "./harness";

const SUFFIX = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const TENANT = `studio-chat-${SUFFIX}`.slice(0, 32);
const tenantId = makeId("ten");
const workflowId = makeId("wf");
const workflowVersionId = makeId("wfv");
const agentId = makeId("agt");
const agentVersionId = makeId("agv");
const legacyAgentId = makeId("agt");
const legacyAgentVersionId = makeId("agv");
const sessionId = makeId("ars");
const largeSessionId = makeId("ars");

const definition = AgentDefinitionV2Schema.parse({
  id: `conversation-agent-${SUFFIX}`,
  name: `conversationAgent${SUFFIX}`,
  title: "Conversation test agent",
  actor: ["Agent"],
  trigger: ["CHAT_MESSAGE_RECEIVED", "ALTERNATE_CHAT_MESSAGE"],
  inputs: [
    {
      id: "prompt",
      kind: "prompt",
      required: true,
      schema: { type: "string", minLength: 1 },
    },
  ],
  actions: [
    {
      order: "1",
      name: "acceptChatMessage",
      description: "Accept the chat turn in the Test Lab harness.",
      type: "delay",
      delay_ms: 0,
    },
  ],
  outputs: [{ id: "result", required: true, schema: {} }],
  output_config: {
    unwrap_single_output: true,
    artifact: { persist_run_input: false },
  },
});

const legacyDefinition = AgentDefinitionV2Schema.parse({
  id: `legacy-conversation-agent-${SUFFIX}`,
  name: `legacyConversationAgent${SUFFIX}`,
  title: "Legacy conversation test agent",
  actor: ["Agent"],
  trigger: ["LEGACY_CHAT_STARTED"],
  inputs: [
    {
      id: "prompt",
      kind: "prompt",
      required: true,
      schema: { type: "string", minLength: 1 },
    },
    {
      id: "payload",
      kind: "value",
      required: false,
      schema: { type: "object" },
      default: {},
    },
  ],
  actions: [
    {
      order: "1",
      name: "acceptLegacyChatMessage",
      description: "Accept a legacy payload-shaped Test Lab event.",
      type: "delay",
      delay_ms: 0,
    },
  ],
  outputs: [{ id: "result", required: true, schema: {} }],
  user_prompt_template: "{{json inputs.payload}}",
  output_config: {
    unwrap_single_output: true,
    artifact: { persist_run_input: true },
  },
  extensions: { compatibility_mode: "v1" },
});

interface Envelope<T> {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string };
}

interface DispatchedStudioEvent {
  name: string;
  data: StudioAgentRunEventData;
}

function dispatchedEvent(call: unknown): DispatchedStudioEvent {
  return (call as [DispatchedStudioEvent])[0];
}

describe("Agent Studio conversation context", () => {
  let env: TestEnv;
  let artifactRoot: string;
  let previousArtifactRoot: string | undefined;

  beforeAll(async () => {
    artifactRoot = await mkdtemp(path.join(os.tmpdir(), "agent-studio-chat-"));
    previousArtifactRoot = process.env.AGENTIC_ARTIFACTS_DIR;
    process.env.AGENTIC_ARTIFACTS_DIR = artifactRoot;

    const now = new Date();
    const db = getDb();
    db.insert(tenants)
      .values({ id: tenantId, slug: TENANT, name: "Studio chat test" })
      .run();
    db.insert(workflows)
      .values({
        id: workflowId,
        tenantId,
        slug: `studio-chat-${SUFFIX}`,
        name: "Studio chat workflow",
      })
      .run();
    db.insert(workflowVersions)
      .values({
        id: workflowVersionId,
        workflowId,
        version: "1.0.0",
        manifestJson: { agents: [definition, legacyDefinition] },
      })
      .run();
    db.insert(agents)
      .values([
        {
          id: agentId,
          tenantId,
          workflowId,
          kebabId: definition.id,
          name: definition.name,
          title: definition.title,
          actor: "Agent",
          kind: "manifest",
          enabled: true,
          lifecycle: "active",
          createdAt: now,
          updatedAt: now,
        },
        {
          id: legacyAgentId,
          tenantId,
          workflowId,
          kebabId: legacyDefinition.id,
          name: legacyDefinition.name,
          title: legacyDefinition.title,
          actor: "Agent",
          kind: "manifest",
          enabled: true,
          lifecycle: "active",
          createdAt: now,
          updatedAt: now,
        },
      ])
      .run();
    db.insert(agentVersions)
      .values([
        {
          id: agentVersionId,
          agentId,
          workflowVersionId,
          manifestJson: definition,
          definitionSchemaVersion: 2,
          contentHash: `sha256:${SUFFIX}`,
          publishedAt: now,
        },
        {
          id: legacyAgentVersionId,
          agentId: legacyAgentId,
          workflowVersionId,
          manifestJson: legacyDefinition,
          definitionSchemaVersion: 2,
          contentHash: `sha256:legacy-${SUFFIX}`,
          publishedAt: now,
        },
      ])
      .run();
    db.insert(agentRunSessions)
      .values([
        {
          id: sessionId,
          tenantId,
          agentId,
          title: "Bounded conversation",
          createdAt: now,
          updatedAt: now,
        },
        {
          id: largeSessionId,
          tenantId,
          agentId,
          title: "Large conversation",
          createdAt: now,
          updatedAt: now,
        },
      ])
      .run();
    db.insert(runMessages)
      .values(
        Array.from({ length: 24 }, (_, index) => {
          const ord = index + 1;
          return {
            id: makeId("msg"),
            tenantId,
            sessionId,
            runId: null,
            ord,
            role: ord % 2 === 1 ? ("user" as const) : ("assistant" as const),
            contentJson:
              ord % 2 === 1
                ? { prompt: `  User ${ord}\r\nkeeps spacing  `, inputs: {} }
                : { z: ord, a: { sequence: ord } },
          };
        }),
      )
      .run();
    db.insert(runMessages)
      .values({
        id: makeId("msg"),
        tenantId,
        sessionId: largeSessionId,
        runId: null,
        ord: 1,
        role: "assistant",
        contentJson: { payload: "x".repeat(80 * 1024) },
      })
      .run();
    env = await buildTestEnv();
  });

  afterAll(async () => {
    getDb().delete(tenants).where(eq(tenants.id, tenantId)).run();
    if (previousArtifactRoot === undefined) {
      delete process.env.AGENTIC_ARTIFACTS_DIR;
    } else {
      process.env.AGENTIC_ARTIFACTS_DIR = previousArtifactRoot;
    }
    await rm(artifactRoot, { recursive: true, force: true });
  });

  it("defaults older callers to isolated context", () => {
    const body = CreateAgentRunBodySchema.parse({
      target: { kind: "live", agentVersionId },
      prompt: "Start an isolated run.",
    });
    expect(body.contextMode).toBe("isolated");
  });

  it("snapshots bounded deterministic history, rejects overlapping turns, and replays the snapshot", async () => {
    const send = vi
      .spyOn(inngest, "send")
      .mockResolvedValue({ ids: [`evt-${SUFFIX}`] } as never);
    try {
      const exactPrompt =
        "  Current prompt must not enter prior history.\n\nKeep spacing.  ";
      const first = await reserveStudioRun(
        { tenantId, tenantSlug: TENANT, via: "dev" },
        agentId,
        {
          sessionId,
          contextMode: "session",
          target: { kind: "live", agentVersionId },
          triggerEvent: "ALTERNATE_CHAT_MESSAGE",
          prompt: exactPrompt,
          inputs: {},
          toolPolicy: "safe",
        },
      );
      const firstEvent = dispatchedEvent(send.mock.calls[0]);
      expect(send).toHaveBeenCalledTimes(1);
      expect(firstEvent.name).toBe(STUDIO_AGENT_RUN_CONTROL_EVENT);
      expect(StudioAgentRunEventDataSchema.parse(firstEvent.data)).toEqual(
        firstEvent.data,
      );
      expect(first.eventId).toBe(firstEvent.data.eventId);
      expect(first.eventName).toBe("ALTERNATE_CHAT_MESSAGE");
      expect(firstEvent.data.eventName).toBe(first.eventName);
      expect(firstEvent.data.runId).toBe(first.runId);
      expect(firstEvent.data.sessionId).toBe(first.sessionId);
      expect(firstEvent.data.prompt).toBe(exactPrompt);
      expect(firstEvent.data.inputs.prompt).toBe(exactPrompt);
      const expectedLogicalPayload = {
        event_type: "ALTERNATE_CHAT_MESSAGE",
        event_name: "ALTERNATE_CHAT_MESSAGE",
        event_id: first.eventId,
        request_id: firstEvent.data.correlationId,
        run_id: first.runId,
        session_id: first.sessionId,
        correlation_id: firstEvent.data.correlationId,
        prompt: exactPrompt,
        input: exactPrompt,
        context: exactPrompt,
      };
      expect(firstEvent.data.payload).toEqual(expectedLogicalPayload);
      const executionEvent = buildStudioExecutionEvent(
        firstEvent.data,
        firstEvent.data.inputs,
      );
      expect(executionEvent.name).toBe("ALTERNATE_CHAT_MESSAGE");
      expect(executionEvent.data).toEqual({
        ...expectedLogicalPayload,
        inputs: firstEvent.data.inputs,
      });

      const persistedEvent = getDb()
        .select()
        .from(events)
        .where(eq(events.id, first.eventId))
        .limit(1)
        .all()[0]!;
      const persistedRun = getDb()
        .select({ triggerEventId: runs.triggerEventId })
        .from(runs)
        .where(eq(runs.id, first.runId))
        .limit(1)
        .all()[0]!;
      expect(persistedEvent.name).toBe("ALTERNATE_CHAT_MESSAGE");
      expect(persistedRun.triggerEventId).toBe(first.eventId);
      const [ledgerPath, ledgerOffset = "0"] =
        persistedEvent.payloadRef!.split("#");
      const ledgerBytes = await readFile(ledgerPath!);
      const ledgerLine = ledgerBytes
        .subarray(Number(ledgerOffset))
        .toString("utf8")
        .split("\n")[0]!;
      const ledgerRecord = JSON.parse(ledgerLine) as {
        id: string;
        name: string;
        data: Record<string, unknown>;
      };
      expect(ledgerRecord.id).toBe(first.eventId);
      expect(ledgerRecord.name).toBe(first.eventName);
      const { inputs: _executionInputs, ...agentVisiblePayload } =
        executionEvent.data;
      expect(ledgerRecord.data).toEqual(firstEvent.data.payload);
      expect(ledgerRecord.data).toEqual(agentVisiblePayload);
      expect(ledgerRecord.data).not.toHaveProperty("tenantId");
      expect(ledgerRecord.data).not.toHaveProperty("definitionHash");
      expect(ledgerRecord.data).not.toHaveProperty("toolPolicy");
      const savedSessionResponse = await env.fetch(
        `/v1/run-sessions/${sessionId}`,
        { headers: { "x-agentic-tenant": TENANT } },
      );
      expect(savedSessionResponse.status).toBe(200);
      const savedSession = (await savedSessionResponse.json()) as Envelope<{
        continuation?: {
          runId: string;
          target: unknown;
          triggerEvent: string;
          inputs: Record<string, unknown>;
          toolPolicy: string;
        } | null;
      }>;
      expect(savedSession.data?.continuation).toEqual({
        runId: first.runId,
        target: { kind: "live", agentVersionId },
        triggerEvent: "ALTERNATE_CHAT_MESSAGE",
        inputs: {},
        toolPolicy: "safe",
      });
      const history = firstEvent.data.conversationHistory;
      expect(history).toHaveLength(20);
      expect(history[0]).toEqual({
        role: "user",
        content: "  User 5\nkeeps spacing  ",
      });
      expect(history[1]).toEqual({
        role: "assistant",
        content: canonicalJson({ z: 6, a: { sequence: 6 } }),
      });
      expect(JSON.stringify(history)).not.toContain("Current prompt");
      expect(
        Buffer.byteLength(JSON.stringify(history), "utf8"),
      ).toBeLessThanOrEqual(64 * 1024);

      const inputRow = getDb()
        .select({ path: artifacts.path })
        .from(artifacts)
        .where(
          and(eq(artifacts.runId, first.runId), eq(artifacts.role, "input")),
        )
        .limit(1)
        .all()[0]!;
      const input = JSON.parse(await readFile(inputRow.path, "utf8")) as Record<
        string,
        unknown
      >;
      expect(input[STUDIO_CONVERSATION_HISTORY_METADATA_KEY]).toEqual(history);

      const countsBeforeBusy = {
        events: getDb()
          .select({ id: events.id })
          .from(events)
          .where(eq(events.tenantId, tenantId))
          .all().length,
        runs: getDb()
          .select({ id: runs.id })
          .from(runs)
          .where(eq(runs.sessionId, sessionId))
          .all().length,
        messages: getDb()
          .select({ id: runMessages.id })
          .from(runMessages)
          .where(eq(runMessages.sessionId, sessionId))
          .all().length,
      };
      const busyResponse = await env.fetch(`/v1/agents/${agentId}/runs`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-agentic-tenant": TENANT,
        },
        body: JSON.stringify({
          sessionId,
          contextMode: "session",
          target: { kind: "live", agentVersionId },
          prompt: "This turn overlaps the first run.",
        }),
      });
      expect(busyResponse.status).toBe(409);
      const busy = (await busyResponse.json()) as Envelope<unknown>;
      expect(busy.error?.code).toBe("session_busy");
      expect(send).toHaveBeenCalledTimes(1);
      expect({
        events: getDb()
          .select({ id: events.id })
          .from(events)
          .where(eq(events.tenantId, tenantId))
          .all().length,
        runs: getDb()
          .select({ id: runs.id })
          .from(runs)
          .where(eq(runs.sessionId, sessionId))
          .all().length,
        messages: getDb()
          .select({ id: runMessages.id })
          .from(runMessages)
          .where(eq(runMessages.sessionId, sessionId))
          .all().length,
      }).toEqual(countsBeforeBusy);

      getDb()
        .update(runs)
        .set({ status: "ok", endedAt: new Date() })
        .where(eq(runs.id, first.runId))
        .run();
      await expect(
        reserveStudioRun(
          { tenantId, tenantSlug: TENANT, via: "dev" },
          agentId,
          {
            sessionId,
            contextMode: "session",
            target: { kind: "live", agentVersionId },
            triggerEvent: "CHAT_MESSAGE_RECEIVED",
            prompt: "Do not silently change this conversation's trigger.",
            inputs: {},
            toolPolicy: "safe",
          },
        ),
      ).rejects.toMatchObject({ code: "session_trigger_mismatch" });
      const nextOrd =
        getDb()
          .select({ ord: runMessages.ord })
          .from(runMessages)
          .where(eq(runMessages.sessionId, sessionId))
          .all()
          .reduce((max, row) => Math.max(max, row.ord), 0) + 1;
      const stringAssistantResult =
        '{"status":"ok","answer":"Keep this JSON-looking string verbatim."}';
      getDb()
        .insert(runMessages)
        .values({
          id: makeId("msg"),
          tenantId,
          sessionId,
          runId: first.runId,
          ord: nextOrd,
          role: "assistant",
          contentJson: stringAssistantResult,
        })
        .run();

      const followUpPrompt = "  Follow up using the same session.  ";
      const followUp = await reserveStudioRun(
        { tenantId, tenantSlug: TENANT, via: "dev" },
        agentId,
        {
          sessionId,
          contextMode: "session",
          target: { kind: "live", agentVersionId },
          triggerEvent: first.eventName,
          prompt: followUpPrompt,
          inputs: {},
          toolPolicy: "safe",
        },
      );
      const followUpEvent = dispatchedEvent(send.mock.calls[1]);
      expect(followUp.sessionId).toBe(first.sessionId);
      expect(followUp.runId).not.toBe(first.runId);
      expect(followUp.eventId).not.toBe(first.eventId);
      expect(followUp.eventName).toBe(first.eventName);
      expect(followUpEvent.data.eventId).toBe(followUp.eventId);
      expect(followUpEvent.data.runId).toBe(followUp.runId);
      expect(followUpEvent.data.sessionId).toBe(first.sessionId);
      expect(followUpEvent.data.correlationId).not.toBe(
        firstEvent.data.correlationId,
      );
      expect(followUpEvent.data.prompt).toBe(followUpPrompt);
      expect(followUpEvent.data.inputs.prompt).toBe(followUpPrompt);
      expect(followUpEvent.data.payload).toMatchObject({
        event_type: first.eventName,
        event_name: first.eventName,
        event_id: followUp.eventId,
        request_id: followUpEvent.data.correlationId,
        run_id: followUp.runId,
        session_id: first.sessionId,
        correlation_id: followUpEvent.data.correlationId,
        prompt: followUpPrompt,
        input: followUpPrompt,
        context: followUpPrompt,
      });
      expect(followUpEvent.data.conversationHistory.at(-1)).toEqual({
        role: "assistant",
        content: stringAssistantResult,
      });
      expect(followUpEvent.data.conversationHistory.at(-1)?.content).not.toBe(
        canonicalJson(stringAssistantResult),
      );
      expect(send).toHaveBeenCalledTimes(2);
      getDb()
        .update(runs)
        .set({ status: "ok", endedAt: new Date() })
        .where(eq(runs.id, followUp.runId))
        .run();

      const replay = await replayStudioRun(
        { tenantId, tenantSlug: TENANT, via: "dev" },
        first.runId,
        { version: "same", inputsPatch: {}, sessionId },
      );
      const replayEvent = dispatchedEvent(send.mock.calls[2]);
      expect(replayEvent.data.conversationHistory).toEqual(history);
      expect(replay.eventName).toBe("ALTERNATE_CHAT_MESSAGE");
      expect(replayEvent.data.eventName).toBe("ALTERNATE_CHAT_MESSAGE");
      expect(
        JSON.stringify(replayEvent.data.conversationHistory),
      ).not.toContain("Keep this JSON-looking string verbatim");
      const replayInputRow = getDb()
        .select({ path: artifacts.path })
        .from(artifacts)
        .where(
          and(eq(artifacts.runId, replay.runId), eq(artifacts.role, "input")),
        )
        .limit(1)
        .all()[0]!;
      const replayInput = JSON.parse(
        await readFile(replayInputRow.path, "utf8"),
      ) as Record<string, unknown>;
      expect(replayInput[STUDIO_CONVERSATION_HISTORY_METADATA_KEY]).toEqual(
        history,
      );
    } finally {
      send.mockRestore();
    }
  });

  it("caps a newest oversized assistant turn at 64 KiB", async () => {
    const send = vi
      .spyOn(inngest, "send")
      .mockResolvedValue({ ids: [`evt-large-${SUFFIX}`] } as never);
    try {
      await reserveStudioRun(
        { tenantId, tenantSlug: TENANT, via: "dev" },
        agentId,
        {
          sessionId: largeSessionId,
          contextMode: "session",
          target: { kind: "live", agentVersionId },
          prompt: "Continue after a large response.",
          inputs: {},
          toolPolicy: "safe",
        },
      );
      const history = dispatchedEvent(send.mock.calls[0]).data
        .conversationHistory;
      expect(history).toHaveLength(1);
      expect(history[0]?.role).toBe("assistant");
      expect(history[0]?.content.startsWith('{\n  "payload": "')).toBe(true);
      expect(
        Buffer.byteLength(JSON.stringify(history), "utf8"),
      ).toBeLessThanOrEqual(64 * 1024);
      expect(history[0]!.content.length).toBeLessThan(
        canonicalJson({ payload: "x".repeat(80 * 1024) }).length,
      );
    } finally {
      send.mockRestore();
    }
  });

  it("replaces a legacy payload input with the same canonical trigger envelope the agent and ledger observe", async () => {
    const send = vi
      .spyOn(inngest, "send")
      .mockResolvedValue({ ids: [`evt-legacy-${SUFFIX}`] } as never);
    try {
      const exactPrompt =
        "  Research the agentic runtime.\nPreserve this second line.  ";
      const reserved = await reserveStudioRun(
        { tenantId, tenantSlug: TENANT, via: "dev" },
        legacyAgentId,
        {
          contextMode: "isolated",
          target: { kind: "live", agentVersionId: legacyAgentVersionId },
          triggerEvent: "LEGACY_CHAT_STARTED",
          prompt: exactPrompt,
          inputs: {
            payload: {
              custom_field: "preserved",
              event_type: "CALLER_CANNOT_OVERRIDE",
              event_id: "evt-forged",
              inputs: { forged: true },
              payload: { recursive: true },
              tenantId: "ten-forged",
              __private: "drop-me",
            },
          },
          toolPolicy: "safe",
        },
      );

      expect(send).toHaveBeenCalledTimes(1);
      const controlEvent = dispatchedEvent(send.mock.calls[0]);
      const canonicalPayload = controlEvent.data.payload;
      expect(canonicalPayload).toEqual({
        custom_field: "preserved",
        event_type: "LEGACY_CHAT_STARTED",
        event_name: "LEGACY_CHAT_STARTED",
        event_id: reserved.eventId,
        request_id: controlEvent.data.correlationId,
        run_id: reserved.runId,
        session_id: reserved.sessionId,
        correlation_id: controlEvent.data.correlationId,
        prompt: exactPrompt,
        input: exactPrompt,
        context: exactPrompt,
      });
      expect(controlEvent.data.inputs.payload).toEqual(canonicalPayload);
      expect(canonicalPayload).not.toHaveProperty("inputs");
      expect(canonicalPayload).not.toHaveProperty("payload");
      expect(canonicalPayload).not.toHaveProperty("tenantId");
      expect(canonicalPayload).not.toHaveProperty("__private");

      const savedSessionResponse = await env.fetch(
        `/v1/run-sessions/${reserved.sessionId}`,
        { headers: { "x-agentic-tenant": TENANT } },
      );
      const savedSession = (await savedSessionResponse.json()) as Envelope<{
        continuation?: { inputs: Record<string, unknown> } | null;
      }>;
      // Continuation retains only what the operator supplied, not this turn's
      // runtime-generated ids. The next reservation will safely override any
      // forged reserved aliases again.
      expect(savedSession.data?.continuation?.inputs).toEqual({
        payload: {
          custom_field: "preserved",
          event_type: "CALLER_CANNOT_OVERRIDE",
          event_id: "evt-forged",
          inputs: { forged: true },
          payload: { recursive: true },
          tenantId: "ten-forged",
          __private: "drop-me",
        },
      });

      const executionEvent = buildStudioExecutionEvent(
        controlEvent.data,
        controlEvent.data.inputs,
      );
      expect(executionEvent).toEqual({
        name: "LEGACY_CHAT_STARTED",
        data: {
          ...canonicalPayload,
          inputs: controlEvent.data.inputs,
        },
      });

      const persistedEvent = getDb()
        .select({ payloadRef: events.payloadRef })
        .from(events)
        .where(eq(events.id, reserved.eventId))
        .limit(1)
        .all()[0]!;
      const [ledgerPath, ledgerOffset = "0"] =
        persistedEvent.payloadRef!.split("#");
      const ledgerLine = (await readFile(ledgerPath!, "utf8"))
        .slice(Number(ledgerOffset))
        .split("\n")[0]!;
      expect(JSON.parse(ledgerLine).data).toEqual(canonicalPayload);

      const inputRow = getDb()
        .select({ path: artifacts.path })
        .from(artifacts)
        .where(
          and(eq(artifacts.runId, reserved.runId), eq(artifacts.role, "input")),
        )
        .limit(1)
        .all()[0]!;
      const runInput = JSON.parse(
        await readFile(inputRow.path, "utf8"),
      ) as Record<string, unknown>;
      expect(runInput.prompt).toBe(exactPrompt);
      expect(runInput.payload).toEqual(canonicalPayload);
    } finally {
      send.mockRestore();
    }
  });

  it("executes the one dispatched control event through the pinned chat harness", async () => {
    const send = vi
      .spyOn(inngest, "send")
      .mockResolvedValue({ ids: [`evt-execute-${SUFFIX}`] } as never);
    try {
      const prompt = "  Execute this exact chat turn.\nSecond line.  ";
      const reserved = await reserveStudioRun(
        { tenantId, tenantSlug: TENANT, via: "dev" },
        agentId,
        {
          contextMode: "session",
          target: { kind: "live", agentVersionId },
          prompt,
          inputs: {},
          toolPolicy: "safe",
        },
      );
      expect(send).toHaveBeenCalledTimes(1);
      const dispatched = dispatchedEvent(send.mock.calls[0]);

      const result = await executeReservedStudioRun(dispatched.data);

      expect(result).toMatchObject({ ok: true, runId: reserved.runId });
      const completed = getDb()
        .select({ status: runs.status, triggerEventId: runs.triggerEventId })
        .from(runs)
        .where(eq(runs.id, reserved.runId))
        .limit(1)
        .all()[0]!;
      expect(completed).toEqual({
        status: "ok",
        triggerEventId: reserved.eventId,
      });
      const messages = getDb()
        .select({ role: runMessages.role, content: runMessages.contentJson })
        .from(runMessages)
        .where(eq(runMessages.runId, reserved.runId))
        .all();
      expect(messages.map((message) => message.role)).toEqual([
        "user",
        "assistant",
      ]);
      expect(messages[0]?.content).toMatchObject({ prompt });
      expect(messages[1]?.content).toEqual({ delay_ms: 0, sleptMs: 0 });
      expect(
        getDb()
          .select({ id: artifacts.id })
          .from(artifacts)
          .where(
            and(
              eq(artifacts.runId, reserved.runId),
              eq(artifacts.role, "output"),
            ),
          )
          .all().length,
      ).toBeGreaterThan(0);
    } finally {
      send.mockRestore();
    }
  });

  it("rejects an undeclared logical trigger before reserving or dispatching", async () => {
    const send = vi
      .spyOn(inngest, "send")
      .mockResolvedValue({ ids: [`evt-invalid-${SUFFIX}`] } as never);
    const runCount = getDb()
      .select({ id: runs.id })
      .from(runs)
      .where(eq(runs.tenantId, tenantId))
      .all().length;
    const eventCount = getDb()
      .select({ id: events.id })
      .from(events)
      .where(eq(events.tenantId, tenantId))
      .all().length;
    try {
      await expect(
        reserveStudioRun(
          { tenantId, tenantSlug: TENANT, via: "dev" },
          agentId,
          {
            contextMode: "isolated",
            target: { kind: "live", agentVersionId },
            triggerEvent: "NOT_DECLARED",
            prompt: "Do not reserve this run.",
            inputs: {},
            toolPolicy: "safe",
          },
        ),
      ).rejects.toMatchObject({ code: "trigger_event_invalid" });
      expect(send).not.toHaveBeenCalled();
      expect(
        getDb()
          .select({ id: runs.id })
          .from(runs)
          .where(eq(runs.tenantId, tenantId))
          .all(),
      ).toHaveLength(runCount);
      expect(
        getDb()
          .select({ id: events.id })
          .from(events)
          .where(eq(events.tenantId, tenantId))
          .all(),
      ).toHaveLength(eventCount);
    } finally {
      send.mockRestore();
    }
  });
});
