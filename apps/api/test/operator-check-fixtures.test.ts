import { describe, expect, it } from "vitest";
import {
  AgentDefinitionV2Schema,
  IngestEventBody,
  OperatorCheckRecordSchema,
} from "@agentic/contracts";
import { compileAgentOutputSchema } from "@agentic/runtime";
import { validateDefinition } from "../src/services/agent-drafts";
import {
  OPERATOR_CHECK_SCENARIOS,
  plannedOperatorCheckStages,
  reconstructOperatorCheck,
} from "../src/services/operator-checks";

const EXECUTION_ID = "opc-fixture-20260715";

type AuditRow = Parameters<typeof reconstructOperatorCheck>[0][number];

function auditRow(
  action: string,
  at: string,
  metaJson: Record<string, unknown>,
  targetId = "opc-reconstruction",
): AuditRow {
  return {
    id: `aud-${action}-${String(metaJson.sequence ?? "0")}`,
    tenantId: "ten-operator-check",
    actorUserId: null,
    action,
    targetType: "operator_check",
    targetId,
    at: new Date(at),
    metaJson,
  };
}

describe("operator check managed fixtures", () => {
  it("defines exactly two stable, semantically valid Agent Definition v2 fixtures", () => {
    expect(OPERATOR_CHECK_SCENARIOS.map((scenario) => scenario.id)).toEqual([
      "support-triage",
      "context-probe",
    ]);

    for (const fixture of OPERATOR_CHECK_SCENARIOS) {
      const definition = AgentDefinitionV2Schema.parse(fixture.definition);
      const validation = validateDefinition(definition);

      expect(validation.definition).not.toBeNull();
      expect(validation.issues).toEqual([]);
      expect(definition.id).toBe(`operator-selftest-${fixture.id}`);
      expect(definition.name).toBe(fixture.agentName);
      expect(definition.extensions?.operator_selftest).toEqual({
        owned: true,
        fixture_version: 1,
        scenario: fixture.id,
      });
      expect(definition.output_config).toMatchObject({
        format: "json",
        strict: true,
        repair_attempts: 0,
        unwrap_single_output: true,
        artifact: {
          persist_individual_outputs: false,
          persist_run_input: true,
          persist_run_record: true,
        },
      });
      expect(compileAgentOutputSchema(definition)).toEqual(
        definition.outputs[0]?.schema,
      );
      expect(
        definition.inputs.filter((input) => input.kind === "prompt"),
      ).toHaveLength(1);
      expect(definition.inputs[0]?.id).toBe("prompt");
      expect(Object.keys(definition.trigger_bindings ?? {})).toEqual(
        definition.trigger,
      );
    }
  });

  it("keeps support triage deterministic while exercising prompt and LLM wiring", () => {
    const fixture = OPERATOR_CHECK_SCENARIOS[0]!;
    const definition = fixture.definition;
    const event = fixture.event(EXECUTION_ID);

    expect(definition.id).toBe("operator-selftest-support-triage");
    expect(definition.provider).toBe("mock");
    expect(definition.model).toBe("mock-model-v1");
    expect(definition.temperature).toBe(0);
    expect(definition.tool_use).toEqual([]);
    expect(definition.actions).toEqual([
      expect.objectContaining({
        id: "triage_support",
        type: "logic",
        output_mapping: {
          requestId: "$.inputs.request_id",
          category: { constant: "billing" },
          priority: "$.inputs.priority_hint",
          accepted: { constant: true },
          summary: "$.result",
        },
      }),
    ]);
    expect(definition.output_config.artifact).toMatchObject({
      filename: "selftest-triage-output.json",
      persist_raw_response: true,
    });
    expect(definition.observability?.persist_rendered_prompts).toBe(true);

    expect(event).toEqual({
      subject: `selftest-support-${EXECUTION_ID}`,
      idempotencyKey: `operator-selftest:${EXECUTION_ID}:support`,
      body: {
        name: "OPERATOR_SELFTEST_SUPPORT_REQUESTED",
        subject: `selftest-support-${EXECUTION_ID}`,
        payload: {
          request_id: `SUP-${EXECUTION_ID}`,
          customer_message:
            "I was charged twice for order ORD-SELFTEST-42. Please review the duplicate charge.",
          priority_hint: "normal",
        },
        test: true,
        source: "operator",
        targetAgent: "operatorSelftestSupportTriage",
      },
    });
    expect(IngestEventBody.parse(event.body)).toEqual(event.body);
  });

  it("keeps the context probe on the allow-listed, no-side-effect tool path", () => {
    const fixture = OPERATOR_CHECK_SCENARIOS[1]!;
    const definition = fixture.definition;
    const event = fixture.event(EXECUTION_ID);

    expect(definition.id).toBe("operator-selftest-context-probe");
    expect(definition.tool_use).toEqual([{ name: "meta.ping" }]);
    expect(definition.actions).toEqual([
      expect.objectContaining({
        id: "probe_runtime",
        name: "probeRuntimeContext",
        type: "tool",
        tool: "meta.ping",
      }),
    ]);
    expect(definition.output_config.artifact).toMatchObject({
      filename: "selftest-context-output.json",
      persist_raw_response: false,
    });
    expect(definition.observability?.persist_rendered_prompts).toBe(false);

    expect(event).toEqual({
      subject: `selftest-context-${EXECUTION_ID}`,
      idempotencyKey: `operator-selftest:${EXECUTION_ID}:context`,
      body: {
        name: "OPERATOR_SELFTEST_CONTEXT_REQUESTED",
        subject: `selftest-context-${EXECUTION_ID}`,
        payload: { probe_id: `probe-${EXECUTION_ID}` },
        test: true,
        source: "operator",
        targetAgent: "operatorSelftestContextProbe",
      },
    });
    expect(IngestEventBody.parse(event.body)).toEqual(event.body);
  });
});

describe("operator check audit reconstruction", () => {
  it("plans one global preflight, twelve stages per scenario, and a final verdict", () => {
    const stages = plannedOperatorCheckStages();

    expect(stages).toHaveLength(26);
    expect(new Set(stages.map((stage) => stage.id)).size).toBe(stages.length);
    expect(stages[0]).toMatchObject({
      id: "preflight",
      phase: "preflight",
      scenario: null,
      status: "queued",
    });
    expect(stages.at(-1)).toMatchObject({
      id: "complete",
      phase: "complete",
      scenario: null,
      status: "queued",
    });
    for (const scenario of OPERATOR_CHECK_SCENARIOS) {
      expect(
        stages.filter((stage) => stage.scenario === scenario.id),
      ).toHaveLength(12);
    }
  });

  it("reconstructs ordered stages and terminal scenario evidence from audit rows", () => {
    const plannedStages = plannedOperatorCheckStages();
    const assertion = {
      name: "strict output",
      passed: true,
      message: "Output matched the fixture contract.",
    };
    const rows: AuditRow[] = [
      auditRow("operator_check.completed", "2026-07-15T09:00:04.000Z", {
        sequence: 8,
        summary: "Both managed agents passed.",
      }),
      auditRow(
        "operator_check.scenario.completed",
        "2026-07-15T09:00:03.500Z",
        {
          sequence: 7,
          scenario: "context-probe",
          result: {
            status: "passed",
            agentId: "agt-context",
            draftId: "agd-context",
            deploymentId: "dpl-context",
            workflowVersionId: "wfv-context",
            agentVersionId: "agv-context",
            eventId: "evt-context",
            runId: "run-context",
            output: { pong: true },
            assertions: [assertion],
          },
        },
      ),
      auditRow("operator_check.stage.passed", "2026-07-15T09:00:03.000Z", {
        sequence: 6,
        stageId: "context-probe.complete",
        message: "Context probe passed.",
        details: { runId: "run-context", assertions: [assertion] },
      }),
      auditRow("operator_check.stage.started", "2026-07-15T09:00:02.000Z", {
        sequence: 5,
        stageId: "context-probe.complete",
      }),
      auditRow(
        "operator_check.scenario.completed",
        "2026-07-15T09:00:01.500Z",
        {
          sequence: 4,
          scenario: "support-triage",
          result: {
            status: "passed",
            agentId: "agt-support",
            draftId: "agd-support",
            deploymentId: "dpl-support",
            workflowVersionId: "wfv-support",
            agentVersionId: "agv-support",
            eventId: "evt-support",
            runId: "run-support",
            output: { requestId: "SUP-opc-reconstruction" },
            assertions: [assertion],
          },
        },
      ),
      auditRow("operator_check.stage.passed", "2026-07-15T09:00:01.000Z", {
        sequence: 3,
        stageId: "support-triage.complete",
        details: {
          agentId: "agt-support",
          runId: "run-support",
          assertions: [assertion],
        },
      }),
      auditRow("operator_check.stage.started", "2026-07-15T09:00:00.500Z", {
        sequence: 2,
        stageId: "support-triage.complete",
      }),
      auditRow("operator_check.started", "2026-07-15T09:00:00.000Z", {
        sequence: 1,
        tenantSlug: "raas",
        plannedStages,
      }),
    ];

    const check = OperatorCheckRecordSchema.parse(
      reconstructOperatorCheck(rows),
    );

    expect(check).toMatchObject({
      id: "opc-reconstruction",
      tenantId: "ten-operator-check",
      tenantSlug: "raas",
      status: "passed",
      currentStage: null,
      summary: "Both managed agents passed.",
      durationMs: 4_000,
    });
    expect(check.scenarios).toEqual([
      expect.objectContaining({
        id: "support-triage",
        status: "passed",
        agentId: "agt-support",
        runId: "run-support",
        output: { requestId: "SUP-opc-reconstruction" },
        assertions: [assertion],
      }),
      expect.objectContaining({
        id: "context-probe",
        status: "passed",
        agentId: "agt-context",
        runId: "run-context",
        output: { pong: true },
        assertions: [assertion],
      }),
    ]);
    expect(
      check.stages.find((stage) => stage.id === "support-triage.complete"),
    ).toMatchObject({
      status: "passed",
      durationMs: 500,
    });
    expect(
      check.stages.find((stage) => stage.id === "context-probe.complete"),
    ).toMatchObject({
      status: "passed",
      durationMs: 1_000,
    });
  });

  it("fails reconstruction when the durable start audit is absent", () => {
    expect(() => reconstructOperatorCheck([])).toThrow(
      "operator check start record is missing",
    );
  });
});
