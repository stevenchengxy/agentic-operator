import type { FastifyInstance } from "fastify";
import { requirePermission } from "../../plugins/rbac";
import { getRun, listRecentRuns, listSteps } from "../../queries/runs";
import { getTenantReasoningConfig } from "../../services/reasoning/tenant-config";
import { loadTenantReasoningContext } from "../../services/reasoning/context";
import { readReasoningRunResult } from "../../services/reasoning/run-result";
import { reconcileRestartedReasoningRun } from "../../services/reasoning/run-recovery";

// Reasoning tool receipts contain the selected RuleBundle and compiled prompt.
// Keep the general run-detail endpoint compact, while allowing this dedicated,
// permission-checked audit endpoint to return those receipts without silently
// reducing them to a 4 KB preview.
const MAX_REASONING_STEP_PAYLOAD_BYTES = 4 * 1024 * 1024;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * parentRunId alone describes topology, not the child's runtime role. Only a
 * signed-by-runtime step input artifact or the parent's persisted final
 * QualifiedAgent receipt may promote a child into the dedicated audit lane.
 */
export function isVerifiedQualifiedReasoningChild(input: {
  childRunId: string;
  parentRunId: string;
  steps: ReadonlyArray<{ input?: unknown }>;
  persistedOutput?: unknown;
}): boolean {
  const audit = record(record(input.persistedOutput).audit);
  const qualityCheck = record(audit.qualityCheck);
  const receipt = record(qualityCheck.run);
  const hasFinalReceipt =
    qualityCheck.agent === "QualifiedAgent" &&
    qualityCheck.executionMode === "isolated-child-run" &&
    receipt.role === "qualified" &&
    receipt.executionMode === "isolated-child-run" &&
    typeof receipt.runId === "string" &&
    typeof receipt.parentRunId === "string";
  if (hasFinalReceipt) {
    return (
      receipt.runId === input.childRunId &&
      receipt.parentRunId === input.parentRunId
    );
  }

  return input.steps.some((step) => {
    const artifact = record(step.input);
    return (
      artifact.agent === "reasoningAgent" &&
      artifact.runtimeRole === "qualified" &&
      artifact.parentRunId === input.parentRunId
    );
  });
}

/** Standalone Reasoning control surface. Deliberately independent of Agent Factory. */
export async function reasoningAgentRoutes(
  app: FastifyInstance,
): Promise<void> {
  app.get("/reasoning-agent/context", async (req, reply) => {
    const auth = requirePermission(req, "agents.read");
    if (!getTenantReasoningConfig(auth.tenantSlug)) {
      return reply.fail(
        "reasoning_not_configured",
        "This tenant has no standalone Reasoning ontology configuration",
        409,
      );
    }
    try {
      return reply.ok(await loadTenantReasoningContext(auth.tenantSlug));
    } catch (error) {
      req.log.error(
        { err: error, tenantSlug: auth.tenantSlug },
        "standalone reasoning context unavailable",
      );
      return reply.fail(
        "reasoning_ontology_unavailable",
        "The configured Reasoning ontology could not be read from Allmeta",
        503,
      );
    }
  });

  app.get<{ Params: { id: string } }>(
    "/reasoning-agent/runs/:id",
    async (req, reply) => {
      const auth = requirePermission(req, "runs.read");
      let run = await getRun(auth.tenantSlug, req.params.id);
      if (!run || run.agentName !== "reasoningAgent") {
        return reply.fail("not_found", "reasoning run not found", 404);
      }
      const recovery = reconcileRestartedReasoningRun({
        tenantId: auth.tenantId,
        runId: run.id,
        status: run.status,
        startedAt: run.startedAt,
      });
      if (recovery.reconciled) {
        req.log.warn(
          { runId: run.id, recoveredRunIds: recovery.runIds },
          "terminalized Reasoning run interrupted by an API runtime restart",
        );
        run = await getRun(auth.tenantSlug, req.params.id);
        if (!run || run.agentName !== "reasoningAgent") {
          return reply.fail("not_found", "reasoning run not found", 404);
        }
      }
      try {
        const [steps, persisted, childRuns] = await Promise.all([
          listSteps(run.id, MAX_REASONING_STEP_PAYLOAD_BYTES),
          readReasoningRunResult(run.id),
          listRecentRuns(auth.tenantSlug, {
            parentRunId: run.id,
            agentName: "reasoningAgent",
            limit: 10,
          }),
        ]);
        if (run.status === "ok" && !persisted) {
          return reply.fail(
            "reasoning_result_missing",
            "The reasoning run completed without its auditable result artifact",
            409,
          );
        }
        const childCandidates = await Promise.all(
          childRuns.map(async (child) => ({
            child,
            steps: await listSteps(child.id, MAX_REASONING_STEP_PAYLOAD_BYTES),
          })),
        );
        const verifiedChildCandidates = childCandidates.filter(
          ({ child, steps: childSteps }) =>
            child.correlationId === run.correlationId &&
            isVerifiedQualifiedReasoningChild({
              childRunId: child.id,
              parentRunId: run.id,
              steps: childSteps,
              persistedOutput: persisted?.output,
            }),
        );
        if (verifiedChildCandidates.length > 1) {
          throw new Error(
            `Reasoning run ${run.id} has multiple verified QualifiedAgent children; refusing an ambiguous audit projection`,
          );
        }
        const children = verifiedChildCandidates.map(
          ({ child, steps: childSteps }) => ({
            role: "qualified" as const,
            runtimeRole: "qualified" as const,
            run: child,
            steps: childSteps,
          }),
        );
        return reply.ok({
          run,
          steps,
          children,
          result: persisted?.output ?? null,
          resultSchemaVersion: persisted?.schemaVersion ?? null,
        });
      } catch (error) {
        req.log.error(
          { err: error, runId: run.id },
          "reasoning run audit artifact unavailable",
        );
        return reply.fail(
          "reasoning_audit_unavailable",
          "The persisted reasoning audit could not be read",
          500,
        );
      }
    },
  );
}
