import { readFile } from "node:fs/promises";
import { and, asc, desc, eq, lt } from "drizzle-orm";
import {
  AgentDefinitionV2Schema,
  OperatorCheckRecordSchema,
  type AgentDefinitionV2,
  type OperatorCheckAssertion,
  type OperatorCheckPhase,
  type OperatorCheckRecord,
  type OperatorCheckScenarioId,
  type OperatorCheckScenarioResult,
  type OperatorCheckStage,
  type OperatorCheckSummary,
} from "@agentic/contracts";
import { auditLog, deployments, getDb } from "@agentic/db";
import { makeId } from "@agentic/shared";
import type { AuthedContext } from "../plugins/auth";
import { writeAudit } from "../plugins/audit";
import {
  createAgentDraft,
  createNewAgentDraft,
  definitionHash,
  findStudioAgent,
  getAgentEditor,
  getDraft,
  patchAgentDraft,
  publishDraft,
  validateDraft,
} from "./agent-drafts";

const CHECK_TARGET = "operator_check";
const CHECK_NOTE = "Operator self-test harness (managed)";
const CHECK_SCHEMA_VERSION = 1;
const RUN_DISCOVERY_TIMEOUT_MS = 30_000;
const RUN_COMPLETION_TIMEOUT_MS = 60_000;
// The operator check shares the tenant's normal production rate-limit bucket.
// Keep the harness deliberately quiet: the portal also polls for progress and
// a failed runtime can otherwise turn one diagnostic click into a request
// storm that masks the original problem with HTTP 429 responses.
const POLL_MS = 1_500;
// Publishing atomically swaps the API's function handler, while the Inngest
// dev server discovers that new handler on its five-second sync cadence. Give
// that external registration view one full cadence before firing the canary
// event so a freshly-created agent cannot miss its first trigger.
const RUNTIME_REGISTRATION_SETTLE_MS = 6_000;

export interface OperatorCheckHttpRequest {
  method?: "GET" | "POST";
  path: string;
  headers?: Record<string, string>;
  body?: unknown;
}

export interface OperatorCheckHttpResponse {
  statusCode: number;
  body: string;
}

export type OperatorCheckHttpClient = (
  request: OperatorCheckHttpRequest,
) => Promise<OperatorCheckHttpResponse>;

interface ScenarioFixture {
  id: OperatorCheckScenarioId;
  title: string;
  description: string;
  agentName: string;
  definition: AgentDefinitionV2;
  event(executionId: string): {
    subject: string;
    idempotencyKey: string;
    body: Record<string, unknown>;
  };
}

const artifactPolicy = {
  persist_individual_outputs: false,
  persist_run_input: true,
  persist_run_record: true as const,
};

const supportTriageDefinition = AgentDefinitionV2Schema.parse({
  id: "operator-selftest-support-triage",
  name: "operatorSelftestSupportTriage",
  title: "Operator Self-test · Support Triage",
  description:
    "A deterministic local-model canary that classifies a synthetic support request.",
  actor: ["Agent"],
  stage: 998,
  trigger: ["OPERATOR_SELFTEST_SUPPORT_REQUESTED"],
  trigger_bindings: {
    OPERATOR_SELFTEST_SUPPORT_REQUESTED: {
      prompt: { template: "Triage support request {{event.request_id}}." },
      request_id: { path: "$.request_id" },
      customer_message: { path: "$.customer_message" },
      priority_hint: { path: "$.priority_hint" },
    },
  },
  inputs: [
    {
      id: "prompt",
      label: "Request",
      kind: "prompt",
      required: true,
      schema: { type: "string", minLength: 1 },
      sensitivity: "none",
    },
    {
      id: "request_id",
      label: "Request ID",
      kind: "value",
      required: true,
      schema: { type: "string", minLength: 1 },
      sensitivity: "none",
    },
    {
      id: "customer_message",
      label: "Customer message",
      kind: "value",
      required: true,
      schema: { type: "string", minLength: 1 },
      sensitivity: "none",
    },
    {
      id: "priority_hint",
      label: "Priority hint",
      kind: "value",
      required: true,
      schema: { type: "string", enum: ["normal"] },
      sensitivity: "none",
    },
  ],
  ontology_instructions:
    "Classify the supplied synthetic support request. Never call tools or perform external actions.",
  user_prompt_template:
    "Request ID: {{inputs.request_id}}\nCustomer message: {{inputs.customer_message}}\nPriority hint: {{inputs.priority_hint}}",
  generated: true,
  tool_use: [],
  actions: [
    {
      id: "triage_support",
      order: "1",
      name: "triageSupportRequest",
      description: "Classify the synthetic support request.",
      type: "logic",
      action_prompt:
        "Classify the request using only the supplied synthetic input.",
      retries: 0,
      timeout_s: 30,
      output_mapping: {
        requestId: "$.inputs.request_id",
        category: { constant: "billing" },
        priority: "$.inputs.priority_hint",
        accepted: { constant: true },
        summary: "$.result",
      },
    },
  ],
  outputs: [
    {
      id: "triage",
      label: "Triage result",
      required: true,
      schema: {
        type: "object",
        required: ["requestId", "category", "priority", "accepted", "summary"],
        properties: {
          requestId: { type: "string" },
          category: { const: "billing" },
          priority: { const: "normal" },
          accepted: { const: true },
          summary: { type: "string", minLength: 1 },
        },
        additionalProperties: false,
      },
      sensitivity: "none",
    },
  ],
  output_config: {
    format: "json",
    strict: true,
    repair_attempts: 0,
    unwrap_single_output: true,
    artifact: {
      filename: "selftest-triage-output.json",
      ...artifactPolicy,
      persist_raw_response: true,
    },
  },
  triggered_event: ["OPERATOR_SELFTEST_SUPPORT_TRIAGED"],
  output_bindings: {
    OPERATOR_SELFTEST_SUPPORT_TRIAGED: {
      request_id: { output: "triage", path: "$.requestId" },
      category: { output: "triage", path: "$.category" },
    },
  },
  provider: "mock",
  model: "mock-model-v1",
  temperature: 0,
  max_tokens: 256,
  timeout_s: 30,
  retries: 0,
  observability: {
    trace_level: "debug",
    reasoning_summary: true,
    persist_rendered_prompts: true,
    retention_days: 30,
  },
  extensions: {
    operator_selftest: {
      owned: true,
      fixture_version: 1,
      scenario: "support-triage",
    },
  },
});

const contextProbeDefinition = AgentDefinitionV2Schema.parse({
  id: "operator-selftest-context-probe",
  name: "operatorSelftestContextProbe",
  title: "Operator Self-test · Runtime Context Probe",
  description:
    "A no-side-effect tool canary that verifies runtime and global-tool context wiring.",
  actor: ["Agent"],
  stage: 999,
  trigger: ["OPERATOR_SELFTEST_CONTEXT_REQUESTED"],
  trigger_bindings: {
    OPERATOR_SELFTEST_CONTEXT_REQUESTED: {
      prompt: {
        constant:
          "Inspect the runtime context and return the diagnostic result.",
      },
      probe_id: { path: "$.probe_id" },
    },
  },
  inputs: [
    {
      id: "prompt",
      label: "Request",
      kind: "prompt",
      required: true,
      schema: { type: "string", minLength: 1 },
      sensitivity: "none",
    },
    {
      id: "probe_id",
      label: "Probe ID",
      kind: "value",
      required: true,
      schema: { type: "string", minLength: 1 },
      sensitivity: "none",
    },
  ],
  ontology_instructions:
    "Return only the diagnostic supplied by the allow-listed context probe tool.",
  generated: true,
  tool_use: [{ name: "meta.ping" }],
  actions: [
    {
      id: "probe_runtime",
      order: "1",
      name: "probeRuntimeContext",
      description: "Inspect the runtime tool context.",
      type: "tool",
      tool: "meta.ping",
    },
  ],
  outputs: [
    {
      id: "diagnostic",
      label: "Runtime diagnostic",
      required: true,
      schema: {
        type: "object",
        required: [
          "pong",
          "agentName",
          "actionName",
          "tenantSlug",
          "subject",
          "seenEvent",
          "hasLastResult",
          "hasConfig",
          "ts",
        ],
        properties: {
          pong: { const: true },
          agentName: { type: "string" },
          actionName: { type: "string" },
          tenantSlug: { type: "string" },
          subject: { type: ["string", "null"] },
          seenEvent: { type: ["string", "null"] },
          hasLastResult: { type: "boolean" },
          hasConfig: { type: "boolean" },
          ts: { type: "string" },
        },
        additionalProperties: false,
      },
      sensitivity: "none",
    },
  ],
  output_config: {
    format: "json",
    strict: true,
    repair_attempts: 0,
    unwrap_single_output: true,
    artifact: {
      filename: "selftest-context-output.json",
      ...artifactPolicy,
      persist_raw_response: false,
    },
  },
  triggered_event: ["OPERATOR_SELFTEST_CONTEXT_COMPLETED"],
  output_bindings: {
    OPERATOR_SELFTEST_CONTEXT_COMPLETED: {
      probe_id: { input: "probe_id" },
      pong: { output: "diagnostic", path: "$.pong" },
      seen_event: { output: "diagnostic", path: "$.seenEvent" },
    },
  },
  provider: "mock",
  model: "mock-model-v1",
  temperature: 0,
  max_tokens: 256,
  timeout_s: 30,
  retries: 0,
  observability: {
    trace_level: "debug",
    reasoning_summary: true,
    persist_rendered_prompts: false,
    retention_days: 30,
  },
  extensions: {
    operator_selftest: {
      owned: true,
      fixture_version: 1,
      scenario: "context-probe",
    },
  },
});

export const OPERATOR_CHECK_SCENARIOS: readonly ScenarioFixture[] = [
  {
    id: "support-triage",
    title: "Support request triage",
    description: "Builds and runs a strict-JSON agent with the local mock LLM.",
    agentName: supportTriageDefinition.name,
    definition: supportTriageDefinition,
    event(executionId) {
      const requestId = `SUP-${executionId}`;
      return {
        subject: `selftest-support-${executionId}`,
        idempotencyKey: `operator-selftest:${executionId}:support`,
        body: {
          name: "OPERATOR_SELFTEST_SUPPORT_REQUESTED",
          subject: `selftest-support-${executionId}`,
          payload: {
            request_id: requestId,
            customer_message:
              "I was charged twice for order ORD-SELFTEST-42. Please review the duplicate charge.",
            priority_hint: "normal",
          },
          test: true,
          source: "operator",
          targetAgent: supportTriageDefinition.name,
        },
      };
    },
  },
  {
    id: "context-probe",
    title: "Runtime context probe",
    description:
      "Builds and runs a no-side-effect agent against the global meta.ping tool.",
    agentName: contextProbeDefinition.name,
    definition: contextProbeDefinition,
    event(executionId) {
      return {
        subject: `selftest-context-${executionId}`,
        idempotencyKey: `operator-selftest:${executionId}:context`,
        body: {
          name: "OPERATOR_SELFTEST_CONTEXT_REQUESTED",
          subject: `selftest-context-${executionId}`,
          payload: { probe_id: `probe-${executionId}` },
          test: true,
          source: "operator",
          targetAgent: contextProbeDefinition.name,
        },
      };
    },
  },
];

const scenarioPhases: OperatorCheckPhase[] = [
  "agent",
  "draft",
  "validate",
  "publish",
  "trigger",
  "discover-run",
  "await-run",
  "output",
  "trace",
  "logs",
  "artifacts",
  "complete",
];

function phaseLabel(phase: OperatorCheckPhase): string {
  const labels: Record<OperatorCheckPhase, string> = {
    preflight: "Check platform health",
    agent: "Create or find managed agent",
    draft: "Write the agent manifest draft",
    validate: "Validate the agent definition",
    publish: "Publish and deploy the agent",
    trigger: "Send a targeted test event",
    "discover-run": "Find the triggered run",
    "await-run": "Wait for the run to finish",
    output: "Verify JSON output",
    trace: "Verify execution trace",
    logs: "Verify run logs",
    artifacts: "Verify saved evidence files",
    complete: "Complete scenario",
  };
  return labels[phase];
}

export function plannedOperatorCheckStages(): OperatorCheckStage[] {
  const stages: OperatorCheckStage[] = [
    {
      id: "preflight",
      phase: "preflight",
      scenario: null,
      label: phaseLabel("preflight"),
      status: "queued",
      startedAt: null,
      endedAt: null,
      durationMs: null,
      message: null,
      details: null,
    },
  ];
  for (const scenario of OPERATOR_CHECK_SCENARIOS) {
    for (const phase of scenarioPhases) {
      stages.push({
        id: `${scenario.id}.${phase}`,
        phase,
        scenario: scenario.id,
        label: phaseLabel(phase),
        status: "queued",
        startedAt: null,
        endedAt: null,
        durationMs: null,
        message: null,
        details: null,
      });
    }
  }
  stages.push({
    id: "complete",
    phase: "complete",
    scenario: null,
    label: "Finish operator check",
    status: "queued",
    startedAt: null,
    endedAt: null,
    durationMs: null,
    message: null,
    details: null,
  });
  return stages;
}

type AuditRow = typeof auditLog.$inferSelect;

function auditMeta(row: AuditRow): Record<string, unknown> {
  return row.metaJson && typeof row.metaJson === "object"
    ? (row.metaJson as Record<string, unknown>)
    : {};
}

function emptyScenario(
  fixture: ScenarioFixture,
  stages: OperatorCheckStage[],
): OperatorCheckScenarioResult {
  return {
    id: fixture.id,
    title: fixture.title,
    description: fixture.description,
    status: "queued",
    agentId: null,
    agentName: fixture.agentName,
    draftId: null,
    deploymentId: null,
    workflowVersionId: null,
    agentVersionId: null,
    eventId: null,
    runId: null,
    output: null,
    assertions: [],
    stages: stages.filter((stage) => stage.scenario === fixture.id),
  };
}

export function reconstructOperatorCheck(
  rows: AuditRow[],
): OperatorCheckRecord {
  const started = rows.find((row) => row.action === "operator_check.started");
  if (!started || !started.targetId) {
    throw new Error("operator check start record is missing");
  }
  const startedMeta = auditMeta(started);
  const seeded = Array.isArray(startedMeta.plannedStages)
    ? startedMeta.plannedStages
    : plannedOperatorCheckStages();
  const stages = seeded.map((stage) =>
    OperatorCheckRecordSchema.shape.stages.element.parse(stage),
  );
  const byStage = new Map(stages.map((stage) => [stage.id, stage]));
  const scenarios = new Map(
    OPERATOR_CHECK_SCENARIOS.map((fixture) => [
      fixture.id,
      emptyScenario(fixture, stages),
    ]),
  );
  const sorted = [...rows].sort((left, right) => {
    const l = Number(auditMeta(left).sequence ?? 0);
    const r = Number(auditMeta(right).sequence ?? 0);
    return l - r || left.at.getTime() - right.at.getTime();
  });
  let status: OperatorCheckRecord["status"] = "queued";
  let endedAt: Date | null = null;
  let summary: string | null = null;
  let currentStage: string | null = null;

  for (const row of sorted) {
    const meta = auditMeta(row);
    const stageId = typeof meta.stageId === "string" ? meta.stageId : null;
    const stage = stageId ? byStage.get(stageId) : undefined;
    if (row.action === "operator_check.stage.started" && stage) {
      stage.status = "running";
      stage.startedAt = row.at;
      stage.message = typeof meta.message === "string" ? meta.message : null;
      stage.details =
        meta.details && typeof meta.details === "object"
          ? (meta.details as Record<string, unknown>)
          : null;
      status = "running";
      currentStage = stage.id;
    }
    if (
      (row.action === "operator_check.stage.passed" ||
        row.action === "operator_check.stage.failed") &&
      stage
    ) {
      stage.status = row.action.endsWith("passed") ? "passed" : "failed";
      stage.startedAt ??= row.at;
      stage.endedAt = row.at;
      stage.durationMs = Math.max(
        0,
        row.at.getTime() - stage.startedAt.getTime(),
      );
      stage.message = typeof meta.message === "string" ? meta.message : null;
      stage.details =
        meta.details && typeof meta.details === "object"
          ? (meta.details as Record<string, unknown>)
          : null;
      currentStage = stage.id;
      const scenarioId = stage.scenario;
      const scenario = scenarioId ? scenarios.get(scenarioId) : undefined;
      if (scenario) {
        scenario.status = stage.status === "failed" ? "failed" : "running";
        const details = stage.details ?? {};
        for (const key of [
          "agentId",
          "draftId",
          "deploymentId",
          "workflowVersionId",
          "agentVersionId",
          "eventId",
          "runId",
        ] as const) {
          if (typeof details[key] === "string") scenario[key] = details[key];
        }
        if (Object.hasOwn(details, "output")) scenario.output = details.output;
        if (Array.isArray(details.assertions)) {
          scenario.assertions = details.assertions as OperatorCheckAssertion[];
        }
      }
    }
    if (
      row.action === "operator_check.scenario.completed" ||
      row.action === "operator_check.scenario.failed"
    ) {
      const id = meta.scenario;
      const result = meta.result;
      if (
        (id === "support-triage" || id === "context-probe") &&
        result &&
        typeof result === "object"
      ) {
        const current = scenarios.get(id)!;
        Object.assign(current, result, {
          id,
          stages: stages.filter((stage) => stage.scenario === id),
        });
      }
    }
    if (
      row.action === "operator_check.completed" ||
      row.action === "operator_check.failed"
    ) {
      status = row.action.endsWith("completed") ? "passed" : "failed";
      endedAt = row.at;
      currentStage =
        status === "passed"
          ? null
          : typeof meta.failedStageId === "string"
            ? meta.failedStageId
            : currentStage;
      summary = typeof meta.summary === "string" ? meta.summary : null;
    }
  }

  for (const scenario of scenarios.values()) {
    scenario.stages = stages.filter((stage) => stage.scenario === scenario.id);
  }
  return OperatorCheckRecordSchema.parse({
    id: started.targetId,
    tenantId: started.tenantId,
    tenantSlug: String(startedMeta.tenantSlug ?? ""),
    status,
    startedAt: started.at,
    endedAt,
    durationMs: endedAt
      ? Math.max(0, endedAt.getTime() - started.at.getTime())
      : null,
    currentStage,
    summary,
    scenarios: [...scenarios.values()],
    stages,
  });
}

export class OperatorCheckNotFoundError extends Error {
  constructor() {
    super("operator check not found");
    this.name = "OperatorCheckNotFoundError";
  }
}

class OperatorCheckExecutionError extends Error {
  constructor(
    message: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "OperatorCheckExecutionError";
  }
}

class CheckRecorder {
  private sequence = 0;
  failedStageId: string | null = null;

  constructor(
    private readonly ctx: AuthedContext,
    readonly checkId: string,
  ) {}

  private write(action: string, meta: Record<string, unknown>): void {
    this.sequence += 1;
    writeAudit({
      tenantId: this.ctx.tenantId,
      action,
      targetType: CHECK_TARGET,
      targetId: this.checkId,
      meta: {
        schemaVersion: CHECK_SCHEMA_VERSION,
        tenantSlug: this.ctx.tenantSlug,
        sequence: this.sequence,
        ...meta,
      },
    });
  }

  async stage<T>(args: {
    phase: OperatorCheckPhase;
    scenario?: OperatorCheckScenarioId;
    message?: string;
    run: () => Promise<T> | T;
    details?: (value: T) => Record<string, unknown>;
  }): Promise<T> {
    const stageId = args.scenario
      ? `${args.scenario}.${args.phase}`
      : args.phase;
    this.write("operator_check.stage.started", {
      stageId,
      phase: args.phase,
      scenario: args.scenario ?? null,
      message: args.message ?? phaseLabel(args.phase),
    });
    try {
      const value = await args.run();
      this.write("operator_check.stage.passed", {
        stageId,
        phase: args.phase,
        scenario: args.scenario ?? null,
        message: args.message ?? `${phaseLabel(args.phase)} passed`,
        details: args.details?.(value) ?? {},
      });
      return value;
    } catch (error) {
      this.failedStageId = stageId;
      const details =
        error instanceof OperatorCheckExecutionError ? error.details : {};
      this.write("operator_check.stage.failed", {
        stageId,
        phase: args.phase,
        scenario: args.scenario ?? null,
        message: error instanceof Error ? error.message : String(error),
        details,
      });
      throw error;
    }
  }

  scenario(result: OperatorCheckScenarioResult): void {
    this.write(
      result.status === "passed"
        ? "operator_check.scenario.completed"
        : "operator_check.scenario.failed",
      { scenario: result.id, result },
    );
  }

  terminal(passed: boolean, summary: string): void {
    this.write(passed ? "operator_check.completed" : "operator_check.failed", {
      summary,
      failedStageId: passed ? null : this.failedStageId,
    });
  }
}

function ownedByHarness(definition: AgentDefinitionV2 | null | undefined) {
  const marker = definition?.extensions?.operator_selftest;
  return (
    marker !== null &&
    typeof marker === "object" &&
    !Array.isArray(marker) &&
    (marker as Record<string, unknown>).owned === true
  );
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new OperatorCheckExecutionError("The API returned invalid JSON.", {
      responsePreview: body.slice(0, 500),
    });
  }
}

async function requestData<T>(
  client: OperatorCheckHttpClient,
  request: OperatorCheckHttpRequest,
): Promise<T> {
  const response = await client(request);
  const parsed = parseJson(response.body) as {
    ok?: boolean;
    data?: T;
    error?: { code?: string; message?: string; details?: unknown };
  };
  if (
    response.statusCode < 200 ||
    response.statusCode >= 300 ||
    parsed.ok === false
  ) {
    throw new OperatorCheckExecutionError(
      parsed.error?.message ??
        `API request failed with status ${response.statusCode}.`,
      {
        statusCode: response.statusCode,
        code: parsed.error?.code ?? "request_failed",
        ...(parsed.error?.details === undefined
          ? {}
          : { apiDetails: parsed.error.details }),
      },
    );
  }
  if (parsed.data === undefined) {
    throw new OperatorCheckExecutionError("The API response had no data.", {
      statusCode: response.statusCode,
    });
  }
  return parsed.data;
}

async function requestRawJson<T>(
  client: OperatorCheckHttpClient,
  request: OperatorCheckHttpRequest,
): Promise<T> {
  const response = await client(request);
  const parsed = parseJson(response.body) as T;
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new OperatorCheckExecutionError(
      `Platform health check returned status ${response.statusCode}.`,
      { statusCode: response.statusCode },
    );
  }
  return parsed;
}

function assertion(
  name: string,
  passed: boolean,
  message: string,
  expected?: unknown,
  actual?: unknown,
): OperatorCheckAssertion {
  return {
    name,
    passed,
    message,
    ...(expected === undefined ? {} : { expected }),
    ...(actual === undefined ? {} : { actual }),
  };
}

function requireAssertions(
  assertions: OperatorCheckAssertion[],
  message: string,
): void {
  const failed = assertions.filter((item) => !item.passed);
  if (failed.length > 0) {
    throw new OperatorCheckExecutionError(message, { assertions });
  }
}

function scenarioResult(fixture: ScenarioFixture): OperatorCheckScenarioResult {
  return {
    id: fixture.id,
    title: fixture.title,
    description: fixture.description,
    status: "running",
    agentId: null,
    agentName: fixture.agentName,
    draftId: null,
    deploymentId: null,
    workflowVersionId: null,
    agentVersionId: null,
    eventId: null,
    runId: null,
    output: null,
    assertions: [],
    stages: [],
  };
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function discoverRun(
  client: OperatorCheckHttpClient,
  eventId: string,
  agentName: string,
): Promise<string> {
  const deadline = Date.now() + RUN_DISCOVERY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const causality = await requestData<{
      runs?: Array<{
        id: string;
        agentName: string | null;
        triggerEventId: string | null;
      }>;
    }>(client, {
      path: `/v1/events/recent?causality=1&seed=${encodeURIComponent(eventId)}`,
    });
    const run = causality.runs?.find(
      (candidate) =>
        candidate.triggerEventId === eventId &&
        candidate.agentName === agentName,
    );
    if (run) return run.id;
    await sleep(POLL_MS);
  }
  throw new OperatorCheckExecutionError(
    "The test event was accepted, but no agent run appeared within 30 seconds.",
    { eventId, agentName },
  );
}

async function awaitTerminalRun(
  client: OperatorCheckHttpClient,
  runId: string,
): Promise<{ run: Record<string, unknown>; steps: Record<string, unknown>[] }> {
  const deadline = Date.now() + RUN_COMPLETION_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const detail = await requestData<{
      run: Record<string, unknown>;
      steps: Record<string, unknown>[];
    }>(client, { path: `/v1/runs/${encodeURIComponent(runId)}` });
    if (["ok", "failed", "cancelled"].includes(String(detail.run.status))) {
      return detail;
    }
    await sleep(POLL_MS);
  }
  throw new OperatorCheckExecutionError(
    "The agent run did not finish within 60 seconds.",
    { runId },
  );
}

function outputAssertions(args: {
  fixture: ScenarioFixture;
  tenantSlug: string;
  executionId: string;
  subject: string;
  outputResponse: Record<string, unknown>;
}): OperatorCheckAssertion[] {
  const { fixture, tenantSlug, executionId, subject, outputResponse } = args;
  const value = outputResponse.output as Record<string, unknown> | null;
  const assertions: OperatorCheckAssertion[] = [
    assertion(
      "Run output is available",
      outputResponse.status === "ok" && value !== null,
      "The completed run returned its persisted JSON output.",
      "ok with output",
      outputResponse.status,
    ),
    assertion(
      "Output matches its schema",
      outputResponse.outputValid === true,
      "The runtime marked the authored JSON output as valid.",
      true,
      outputResponse.outputValid,
    ),
  ];
  if (fixture.id === "support-triage") {
    const requestId = `SUP-${executionId}`;
    assertions.push(
      assertion(
        "Request identity was preserved",
        value?.requestId === requestId,
        "The mapped output contains the synthetic request ID.",
        requestId,
        value?.requestId,
      ),
      assertion(
        "Support classification is deterministic",
        value?.category === "billing" &&
          value?.priority === "normal" &&
          value?.accepted === true,
        "The local mock-model result was wrapped in the strict authored shape.",
        { category: "billing", priority: "normal", accepted: true },
        value,
      ),
      assertion(
        "Local mock model answered",
        typeof value?.summary === "string" &&
          value.summary.startsWith(
            "Mock response from mock-model-v1: received Triage support request ",
          ) &&
          value.summary.includes(requestId),
        "The summary proves the mock LLM path executed without an external key.",
        "mock-model-v1 response containing the request ID",
        value?.summary,
      ),
    );
  } else {
    assertions.push(
      assertion(
        "Global context tool returned pong",
        value?.pong === true,
        "The global meta.ping tool executed successfully.",
        true,
        value?.pong,
      ),
      assertion(
        "Runtime context is tenant-scoped",
        value?.agentName === fixture.agentName &&
          value?.actionName === "probeRuntimeContext" &&
          value?.tenantSlug === tenantSlug &&
          value?.subject === subject &&
          value?.seenEvent ===
            `${tenantSlug}/OPERATOR_SELFTEST_CONTEXT_REQUESTED`,
        "The tool received the expected agent, action, tenant, subject, and event.",
        {
          agentName: fixture.agentName,
          actionName: "probeRuntimeContext",
          tenantSlug,
          subject,
          seenEvent: `${tenantSlug}/OPERATOR_SELFTEST_CONTEXT_REQUESTED`,
        },
        value,
      ),
      assertion(
        "Context starts clean",
        value?.hasLastResult === false && value?.hasConfig === false,
        "The first tool step did not inherit a prior result or hidden configuration.",
        { hasLastResult: false, hasConfig: false },
        value,
      ),
      assertion(
        "Diagnostic timestamp is valid",
        typeof value?.ts === "string" && Number.isFinite(Date.parse(value.ts)),
        "The tool returned a parseable ISO timestamp.",
        "ISO timestamp",
        value?.ts,
      ),
    );
  }
  return assertions;
}

function traceAssertions(
  fixture: ScenarioFixture,
  events: Record<string, unknown>[],
): OperatorCheckAssertion[] {
  const names = events.map((event) => String(event.name));
  const required =
    fixture.id === "support-triage"
      ? [
          "run.start",
          "input.validation",
          "prompt.compiled",
          "llm.call",
          "triageSupportRequest",
          "output.validation",
          "OPERATOR_SELFTEST_SUPPORT_TRIAGED",
          "terminal.artifacts",
          "run.end",
        ]
      : [
          "run.start",
          "input.validation",
          "probeRuntimeContext",
          "output.validation",
          "OPERATOR_SELFTEST_CONTEXT_COMPLETED",
          "terminal.artifacts",
          "run.end",
        ];
  const missing = required.filter((name) => !names.includes(name));
  const emittedName =
    fixture.id === "support-triage"
      ? "OPERATOR_SELFTEST_SUPPORT_TRIAGED"
      : "OPERATOR_SELFTEST_CONTEXT_COMPLETED";
  const suppressed = events.find((event) => event.name === emittedName);
  return [
    assertion(
      "Trace contains the complete sequence",
      missing.length === 0,
      "Structured trace evidence covers input, execution, validation, artifacts, and completion.",
      required,
      names,
    ),
    assertion(
      "Downstream event was safely suppressed",
      suppressed?.status === "skipped",
      "Test traffic did not fan out into another production workflow.",
      "skipped",
      suppressed?.status,
    ),
  ];
}

function logAssertions(
  fixture: ScenarioFixture,
  logs: string,
): OperatorCheckAssertion[] {
  const required =
    fixture.id === "support-triage"
      ? [
          "run.start",
          "action.start",
          "llm.call",
          "provider=mock",
          "model=mock-model-v1",
          "action.end",
          "step.ok",
          "event.suppressed",
          "run.end",
          "status=ok",
        ]
      : [
          "run.start",
          "action.start",
          "tool.call",
          "tool=meta.ping",
          "resolved_via=global",
          "tool.ok",
          "action.end",
          "step.ok",
          "event.suppressed",
          "run.end",
          "status=ok",
        ];
  const missing = required.filter((value) => !logs.includes(value));
  return [
    assertion(
      "Run log contains expected evidence",
      missing.length === 0,
      "The file log records dispatch, execution, safe event suppression, and success.",
      required,
      missing.length === 0 ? "all present" : { missing },
    ),
    assertion(
      "Run log has no error-level entry",
      !/\sERROR\s/.test(logs),
      "No error-level diagnostic was written during the test run.",
      "no ERROR entries",
      /\sERROR\s/.test(logs) ? "ERROR entry found" : "none",
    ),
  ];
}

function artifactAssertions(
  fixture: ScenarioFixture,
  artifacts: Record<string, unknown>[],
): OperatorCheckAssertion[] {
  const names = artifacts.map((artifact) => String(artifact.logicalName));
  const outputName = fixture.definition.output_config.artifact.filename;
  return [
    assertion(
      "Output file was saved",
      names.includes(outputName),
      "The agent's authored JSON output file is present in run artifacts.",
      outputName,
      names,
    ),
    assertion(
      "Run record was saved",
      names.includes("run-record.json"),
      "The terminal evidence envelope is present for replay and audit.",
      "run-record.json",
      names,
    ),
    assertion(
      "Artifacts are non-empty",
      artifacts
        .filter((artifact) =>
          [outputName, "run-record.json"].includes(
            String(artifact.logicalName),
          ),
        )
        .every((artifact) => Number(artifact.size) > 0),
      "Mandatory evidence files contain data.",
    ),
  ];
}

async function executeScenario(args: {
  ctx: AuthedContext;
  checkId: string;
  client: OperatorCheckHttpClient;
  recorder: CheckRecorder;
  fixture: ScenarioFixture;
  result: OperatorCheckScenarioResult;
}): Promise<OperatorCheckScenarioResult> {
  const { ctx, checkId, client, recorder, fixture, result } = args;
  const executionId = checkId.replace(/^chk-/, "");
  const event = fixture.event(executionId);

  const existing = await recorder.stage({
    phase: "agent",
    scenario: fixture.id,
    run: () => {
      const agent = findStudioAgent(ctx, fixture.definition.id);
      if (!agent) return null;
      const editor = getAgentEditor(ctx, agent.id);
      const definition = editor.draft?.definition ?? editor.live?.definition;
      if (!ownedByHarness(definition)) {
        throw new OperatorCheckExecutionError(
          `Agent id '${fixture.definition.id}' already exists and is not owned by the operator check.`,
          { agentId: agent.id, collision: true },
        );
      }
      return agent;
    },
    details: (agent) => ({
      agentId: agent?.id ?? null,
      reused: agent !== null,
    }),
  });

  const draft = await recorder.stage({
    phase: "draft",
    scenario: fixture.id,
    run: () => {
      let current = existing
        ? createAgentDraft(ctx, existing.id, {})
        : createNewAgentDraft(ctx, fixture.definition);
      if (
        definitionHash(current.definition) !==
        definitionHash(fixture.definition)
      ) {
        current = patchAgentDraft(
          ctx,
          current.id,
          current.revision,
          fixture.definition,
        );
      }
      return current;
    },
    details: (draftRecord) => ({
      agentId: draftRecord.agentId,
      draftId: draftRecord.id,
      revision: draftRecord.revision,
      definitionHash: draftRecord.definitionHash,
    }),
  });
  result.agentId = draft.agentId;
  result.draftId = draft.id;

  await recorder.stage({
    phase: "validate",
    scenario: fixture.id,
    run: () => {
      const validated = validateDraft(ctx, draft.id);
      if (validated.validation.status !== "valid") {
        throw new OperatorCheckExecutionError(
          "The managed agent definition did not pass validation.",
          { issues: validated.validation.issues },
        );
      }
      return validated;
    },
    details: (validated) => ({
      draftId: draft.id,
      validationStatus: validated.validation.status,
      issueCount: validated.validation.issues.length,
    }),
  });

  const published = await recorder.stage({
    phase: "publish",
    scenario: fixture.id,
    run: async () => {
      const value = await publishDraft(ctx, draft.id, {
        note: CHECK_NOTE,
        confirmImpact: true,
      });
      if (!value.runtime.registered) {
        throw new OperatorCheckExecutionError(
          "The manifest deployed, but its runtime function was not registered.",
          {
            deploymentId: value.deploymentId,
            functionId: value.runtime.functionId,
          },
        );
      }
      const deployment = getDb()
        .select({
          status: deployments.status,
          target: deployments.target,
          versionId: deployments.versionId,
          filePath: deployments.filePath,
        })
        .from(deployments)
        .where(
          and(
            eq(deployments.id, value.deploymentId),
            eq(deployments.tenantId, ctx.tenantId),
          ),
        )
        .limit(1)
        .all()[0];
      if (
        !deployment ||
        deployment.status !== "live" ||
        deployment.target !== "workflow" ||
        deployment.versionId !== value.workflowVersionId ||
        !deployment.filePath
      ) {
        throw new OperatorCheckExecutionError(
          "The published agent does not have a matching live workflow deployment.",
          { deploymentId: value.deploymentId, deployment: deployment ?? null },
        );
      }
      let manifest: unknown;
      try {
        manifest = JSON.parse(
          await readFile(deployment.filePath, "utf8"),
        ) as unknown;
      } catch (error) {
        throw new OperatorCheckExecutionError(
          "The live deployment manifest file could not be read.",
          {
            deploymentId: value.deploymentId,
            filePath: deployment.filePath,
            cause: error instanceof Error ? error.message : String(error),
          },
        );
      }
      const agents = Array.isArray(manifest)
        ? manifest
        : manifest &&
            typeof manifest === "object" &&
            Array.isArray((manifest as { agents?: unknown }).agents)
          ? (manifest as { agents: unknown[] }).agents
          : [];
      const requiredIds =
        fixture.id === "context-probe"
          ? OPERATOR_CHECK_SCENARIOS.map((candidate) => candidate.definition.id)
          : [fixture.definition.id];
      const missingIds = requiredIds.filter(
        (id) =>
          !agents.some(
            (candidate) =>
              candidate !== null &&
              typeof candidate === "object" &&
              (candidate as { id?: unknown }).id === id,
          ),
      );
      const deployedDefinition = agents.find(
        (candidate) =>
          candidate !== null &&
          typeof candidate === "object" &&
          (candidate as { id?: unknown }).id === fixture.definition.id,
      );
      let exactDefinition = false;
      try {
        exactDefinition =
          definitionHash(AgentDefinitionV2Schema.parse(deployedDefinition)) ===
          definitionHash(fixture.definition);
      } catch {
        exactDefinition = false;
      }
      if (missingIds.length > 0 || !exactDefinition) {
        throw new OperatorCheckExecutionError(
          "The live manifest file does not contain the expected managed agent definition.",
          {
            deploymentId: value.deploymentId,
            filePath: deployment.filePath,
            missingAgentIds: missingIds,
            exactDefinition,
          },
        );
      }
      return {
        ...value,
        deploymentFilePath: deployment.filePath,
        manifestAgentIds: requiredIds,
      };
    },
    details: (value) => ({
      agentId: draft.agentId,
      draftId: draft.id,
      deploymentId: value.deploymentId,
      workflowVersionId: value.workflowVersionId,
      agentVersionId: value.agentVersionId,
      functionId: value.runtime.functionId,
      runtimeRegistered: value.runtime.registered,
      deploymentFilePath: value.deploymentFilePath,
      manifestAgentIds: value.manifestAgentIds,
    }),
  });
  result.deploymentId = published.deploymentId;
  result.workflowVersionId = published.workflowVersionId;
  result.agentVersionId = published.agentVersionId;

  const triggered = await recorder.stage({
    phase: "trigger",
    scenario: fixture.id,
    run: async () => {
      await sleep(RUNTIME_REGISTRATION_SETTLE_MS);
      return requestData<{ event_id: string; name: string }>(client, {
        method: "POST",
        path: "/v1/events",
        headers: { "idempotency-key": event.idempotencyKey },
        body: event.body,
      });
    },
    details: (value) => ({ eventId: value.event_id, eventName: value.name }),
  });
  result.eventId = triggered.event_id;

  const runId = await recorder.stage({
    phase: "discover-run",
    scenario: fixture.id,
    run: () => discoverRun(client, triggered.event_id, fixture.agentName),
    details: (value) => ({ eventId: triggered.event_id, runId: value }),
  });
  result.runId = runId;

  const runDetail = await recorder.stage({
    phase: "await-run",
    scenario: fixture.id,
    run: async () => {
      const detail = await awaitTerminalRun(client, runId);
      const run = detail.run;
      const expectedStep =
        fixture.id === "support-triage"
          ? { name: "triageSupportRequest", type: "logic" }
          : { name: "probeRuntimeContext", type: "tool" };
      const assertions = [
        assertion(
          "Run completed successfully",
          run.status === "ok",
          "The targeted event run reached a successful terminal state.",
          "ok",
          run.status,
        ),
        assertion(
          "Run is isolated test traffic",
          run.testRun === true &&
            run.invocationSource === "event" &&
            run.sideEffectMode === "suppressed",
          "The run is marked as an event-driven test with downstream effects suppressed.",
          {
            testRun: true,
            invocationSource: "event",
            sideEffectMode: "suppressed",
          },
          run,
        ),
        assertion(
          "Expected agent step executed",
          detail.steps.some(
            (step) =>
              step.name === expectedStep.name &&
              step.type === expectedStep.type &&
              step.status === "ok",
          ),
          "The authored action appears as a successful persisted step.",
          { ...expectedStep, status: "ok" },
          detail.steps,
        ),
      ];
      requireAssertions(assertions, "The triggered run failed verification.");
      result.assertions.push(...assertions);
      return detail;
    },
    details: (detail) => ({
      runId,
      status: detail.run.status,
      assertions: result.assertions,
    }),
  });
  void runDetail;

  const outputResponse = await recorder.stage({
    phase: "output",
    scenario: fixture.id,
    run: async () => {
      const output = await requestData<Record<string, unknown>>(client, {
        path: `/v1/runs/${encodeURIComponent(runId)}/output`,
      });
      const assertions = outputAssertions({
        fixture,
        tenantSlug: ctx.tenantSlug,
        executionId,
        subject: event.subject,
        outputResponse: output,
      });
      requireAssertions(
        assertions,
        "The saved run output failed verification.",
      );
      result.assertions.push(...assertions);
      return output;
    },
    details: (output) => ({
      runId,
      output: output.output,
      outputValid: output.outputValid,
      assertions: result.assertions,
    }),
  });
  result.output = outputResponse.output ?? null;

  await recorder.stage({
    phase: "trace",
    scenario: fixture.id,
    run: async () => {
      const trace = await requestData<{
        events: Record<string, unknown>[];
      }>(client, {
        path: `/v1/runs/${encodeURIComponent(runId)}/trace?after=0&limit=1000`,
      });
      const assertions = traceAssertions(fixture, trace.events);
      requireAssertions(assertions, "The structured trace is incomplete.");
      result.assertions.push(...assertions);
      return trace;
    },
    details: (trace) => ({
      runId,
      traceEventCount: trace.events.length,
      assertions: result.assertions,
    }),
  });

  await recorder.stage({
    phase: "logs",
    scenario: fixture.id,
    run: async () => {
      const response = await client({
        path: `/v1/runs/${encodeURIComponent(runId)}/logs`,
      });
      if (response.statusCode < 200 || response.statusCode >= 300) {
        throw new OperatorCheckExecutionError(
          `Run logs returned status ${response.statusCode}.`,
          { runId, statusCode: response.statusCode },
        );
      }
      const assertions = logAssertions(fixture, response.body);
      requireAssertions(assertions, "The run log evidence is incomplete.");
      result.assertions.push(...assertions);
      return response.body;
    },
    details: (logs) => ({
      runId,
      logBytes: Buffer.byteLength(logs),
      assertions: result.assertions,
    }),
  });

  await recorder.stage({
    phase: "artifacts",
    scenario: fixture.id,
    run: async () => {
      const artifacts = await requestData<Record<string, unknown>[]>(client, {
        path: `/v1/runs/${encodeURIComponent(runId)}/artifacts`,
      });
      const assertions = artifactAssertions(fixture, artifacts);
      requireAssertions(
        assertions,
        "Mandatory run evidence files are missing.",
      );
      result.assertions.push(...assertions);
      return artifacts;
    },
    details: (artifacts) => ({
      runId,
      artifactCount: artifacts.length,
      assertions: result.assertions,
    }),
  });

  await recorder.stage({
    phase: "complete",
    scenario: fixture.id,
    run: () => true,
    details: () => ({
      agentId: result.agentId,
      draftId: result.draftId,
      deploymentId: result.deploymentId,
      workflowVersionId: result.workflowVersionId,
      agentVersionId: result.agentVersionId,
      eventId: result.eventId,
      runId: result.runId,
      output: result.output,
      assertions: result.assertions,
    }),
  });
  result.status = "passed";
  return result;
}

const activeChecks = new Map<string, string>();

export function activeOperatorCheckId(tenantId: string): string | null {
  return activeChecks.get(tenantId) ?? null;
}

export function startOperatorCheck(
  ctx: AuthedContext,
  client: OperatorCheckHttpClient,
): { checkId: string; resumed: boolean } {
  const active = activeChecks.get(ctx.tenantId);
  if (active) return { checkId: active, resumed: true };

  const checkId = makeId("chk");
  writeAudit({
    tenantId: ctx.tenantId,
    action: "operator_check.started",
    targetType: CHECK_TARGET,
    targetId: checkId,
    meta: {
      schemaVersion: CHECK_SCHEMA_VERSION,
      sequence: 0,
      tenantSlug: ctx.tenantSlug,
      plannedStages: plannedOperatorCheckStages(),
    },
  });
  activeChecks.set(ctx.tenantId, checkId);
  void executeOperatorCheck(ctx, checkId, client).finally(() => {
    if (activeChecks.get(ctx.tenantId) === checkId) {
      activeChecks.delete(ctx.tenantId);
    }
  });
  return { checkId, resumed: false };
}

export async function executeOperatorCheck(
  ctx: AuthedContext,
  checkId: string,
  client: OperatorCheckHttpClient,
): Promise<void> {
  const recorder = new CheckRecorder(ctx, checkId);
  const results: OperatorCheckScenarioResult[] = [];
  try {
    await recorder.stage({
      phase: "preflight",
      run: async () => {
        const health = await requestRawJson<{
          ok?: boolean;
          inngest?: { ok?: boolean };
          sqlite?: { ok?: boolean };
          disk?: { ok?: boolean };
          llmGateway?: { ok?: boolean };
          demoMode?: boolean;
        }>(client, { path: "/health" });
        if (
          health.ok !== true ||
          health.inngest?.ok !== true ||
          health.sqlite?.ok !== true ||
          health.disk?.ok !== true ||
          health.llmGateway?.ok !== true ||
          health.demoMode === true
        ) {
          throw new OperatorCheckExecutionError(
            health.demoMode === true
              ? "Operator checks require production mode; demo mode is enabled. Turn demo mode off and retry."
              : "One or more platform health checks are not ready.",
            { health },
          );
        }
        return health;
      },
      details: (health) => ({
        healthy: health.ok === true,
        demoMode: health.demoMode === true,
        // Informational only. The operator check never mutates demo mode.
        mockIsolation: "fixture-level provider override",
      }),
    });

    for (const fixture of OPERATOR_CHECK_SCENARIOS) {
      // Keep one mutable evidence record for the entire scenario. If a late
      // assertion fails, the UI still receives the agent, draft, deployment,
      // event, and run IDs collected by all earlier successful stages.
      const result = scenarioResult(fixture);
      try {
        await executeScenario({
          ctx,
          checkId,
          client,
          recorder,
          fixture,
          result,
        });
        results.push(result);
        recorder.scenario(result);
      } catch (error) {
        result.status = "failed";
        const details =
          error instanceof OperatorCheckExecutionError ? error.details : {};
        if (Array.isArray(details.assertions)) {
          result.assertions = details.assertions as OperatorCheckAssertion[];
        }
        result.assertions.push(
          assertion(
            "Scenario completed",
            false,
            error instanceof Error ? error.message : String(error),
          ),
        );
        results.push(result);
        recorder.scenario(result);
      }
    }

    const passed = results.every((result) => result.status === "passed");
    try {
      await recorder.stage({
        phase: "complete",
        run: () => {
          if (!passed) {
            throw new OperatorCheckExecutionError(
              "One or more agent scenarios failed.",
              {
                failedScenarios: results
                  .filter((result) => result.status === "failed")
                  .map((result) => result.id),
              },
            );
          }
          return true;
        },
        details: () => ({
          passedScenarios: results.length,
          totalScenarios: OPERATOR_CHECK_SCENARIOS.length,
        }),
      });
    } catch {
      // The failed terminal stage is already durable; terminal summary below
      // remains the single suite-level state transition.
    }
    recorder.terminal(
      passed,
      passed
        ? "Both managed agents were built, deployed, triggered, and verified successfully."
        : `${results.filter((result) => result.status === "failed").length} of ${results.length} agent scenarios failed.`,
    );
  } catch (error) {
    recorder.terminal(
      false,
      error instanceof Error ? error.message : String(error),
    );
  }
}

export function getOperatorCheck(
  ctx: Pick<AuthedContext, "tenantId">,
  checkId: string,
): OperatorCheckRecord {
  const rows = getDb()
    .select()
    .from(auditLog)
    .where(
      and(
        eq(auditLog.tenantId, ctx.tenantId),
        eq(auditLog.targetType, CHECK_TARGET),
        eq(auditLog.targetId, checkId),
      ),
    )
    .orderBy(asc(auditLog.at), asc(auditLog.id))
    .all();
  if (rows.length === 0) throw new OperatorCheckNotFoundError();
  return reconstructOperatorCheck(rows);
}

export function listOperatorChecks(
  ctx: Pick<AuthedContext, "tenantId">,
  input: { limit: number; cursor?: string },
): { checks: OperatorCheckSummary[]; nextCursor: string | null } {
  const conditions = [
    eq(auditLog.tenantId, ctx.tenantId),
    eq(auditLog.targetType, CHECK_TARGET),
    eq(auditLog.action, "operator_check.started"),
  ];
  if (input.cursor) {
    const cursor = Number(input.cursor);
    if (Number.isFinite(cursor))
      conditions.push(lt(auditLog.at, new Date(cursor)));
  }
  const starts = getDb()
    .select()
    .from(auditLog)
    .where(and(...conditions))
    .orderBy(desc(auditLog.at), desc(auditLog.id))
    .limit(input.limit + 1)
    .all();
  const page = starts.slice(0, input.limit);
  const checks = page.map((row) => {
    const record = getOperatorCheck(ctx, row.targetId!);
    return {
      id: record.id,
      tenantId: record.tenantId,
      tenantSlug: record.tenantSlug,
      status: record.status,
      startedAt: record.startedAt,
      endedAt: record.endedAt,
      durationMs: record.durationMs,
      currentStage: record.currentStage,
      summary: record.summary,
    };
  });
  return {
    checks,
    nextCursor:
      starts.length > input.limit && page.at(-1)
        ? String(page.at(-1)!.at.getTime())
        : null,
  };
}
