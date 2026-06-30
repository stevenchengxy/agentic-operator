/**
 * POST /v1/agents/:name/invoke — synchronously invoke a code-defined agent.
 *
 * Request body (JSON):
 *   {
 *     input?:    unknown,            // passed to BaseAgent.buildMessages()
 *     provider?: ProviderId,         // override gateway default
 *     model?:    string,             // override gateway default
 *     async?:    boolean             // if true, fires inngest event instead of running inline
 *   }
 *
 * Sync response: { ok: true, data: { runId, status:'ok', output, ... } }
 * Async response: { ok: true, data: { runId: <reserved>, status:'queued' } }
 *
 * Error envelope: { ok: false, error: { code, message, hint? } }
 *   - 400 bad_request — unknown provider, validation failed
 *   - 404 not_found   — agent not registered
 *   - 503 not_configured — provider lacks credentials
 *   - 500 internal_error — gateway provider_error or unexpected
 */

import type { FastifyInstance } from "fastify";
import { agentRegistry, RunCancelledError } from "@agentic/agents";
import { PROVIDER_IDS, type ProviderId } from "@agentic/contracts";
import { isLLMError } from "@agentic/llm-gateway";
import { appendToLedger, getTenantInngest } from "@agentic/runtime";
import { events, eventTypes, getDb } from "@agentic/db";
import { and, eq } from "drizzle-orm";
import { InvokeAgentBody } from "@agentic/contracts";
import { makeId } from "@agentic/shared";
import { getLLMGateway } from "../../services/llm";
import { metrics } from "../../services/metrics";
import { requireAuth } from "../../plugins/auth";
import { requirePermission } from "../../plugins/rbac";
import { findManifestAgentTrigger } from "../../queries/agents";
import {
  lookupIdempotency,
  readIdempotencyKey,
  storeIdempotency,
} from "../../services/idempotency";

function isProviderId(s: string): s is ProviderId {
  return (PROVIDER_IDS as readonly string[]).includes(s);
}

export async function agentInvokeRoutes(app: FastifyInstance): Promise<void> {
  app.post<{
    Params: { name: string };
    Querystring: { testRun?: string; async?: string };
  }>(
    "/agents/:name/invoke",
    async (req, reply) => {
      const agentName = req.params.name;
      const body = InvokeAgentBody.parse(req.body ?? {});
      // `?testRun=1` or `?testRun=true` flags the run as a test. Used by the
      // portal's "Test run" button to mark runs.is_test=true and the SSE
      // `run.started` payload's `testRun` field. Falls back to false when
      // the param is absent or any other value.
      const testRunQuery =
        req.query.testRun === "1" || req.query.testRun === "true";

      // UC-V11-32 / PF-GAP-10 — idempotency replay. Authenticate first so
      // the cache lookup is correctly scoped per-tenant; missing/invalid
      // auth still returns the same 401 it always did.
      const auth = requirePermission(req, "agents.invoke");
      const idemKey = readIdempotencyKey(req);
      if (idemKey) {
        const cached = lookupIdempotency(auth.tenantId, idemKey);
        if (cached) {
          return reply.code(cached.status).send(cached.body);
        }
      }

      // Validate provider exists in the gateway registry
      if (body.provider !== undefined) {
        if (!isProviderId(body.provider)) {
          return reply.fail("bad_request", `Unknown provider: ${body.provider}`, 400);
        }
        const gateway = getLLMGateway();
        if (!gateway.hasProvider(body.provider)) {
          return reply.fail(
            "bad_request",
            `Provider not registered: ${body.provider}`,
            400,
          );
        }
      }

      // P5-TEN-01 — `agentRegistry.get` gains an optional tenant-slug arg in
      // the agent-runtime package so tenants can override platform agents.
      // The canonical @agentic/agents registry on this branch only accepts a
      // name; we pass just `agentName` to stay compatible while the registry
      // refactor lands. When @agentic/agents adopts the same signature, swap
      // to `agentRegistry.get(agentName, req.auth?.tenantSlug)`.
      const agent = agentRegistry.get(agentName);
      if (!agent) {
        // Option B fallback — manifest agents aren't in the code registry but
        // they ARE invocable: emit their first declared trigger event into
        // Inngest and the manifest engine picks it up. This makes the
        // portal's "Test run" button work uniformly for both AgentKinds.
        // `auth` was already resolved at the top of the handler for the
        // idempotency lookup.
        const manifestAgent = await findManifestAgentTrigger(
          auth.tenantSlug,
          agentName,
        );
        if (!manifestAgent) {
          return reply.fail(
            "not_found",
            `Agent '${agentName}' not found in tenant '${auth.tenantSlug}' (neither as a code agent nor as a manifest agent).`,
            404,
          );
        }
        if (!manifestAgent.enabled) {
          return reply.fail(
            "agent_disabled",
            `Agent '${agentName}' is disabled`,
            409,
          );
        }
        if (manifestAgent.triggers.length === 0) {
          return reply.fail(
            "no_auto_trigger",
            `Agent '${agentName}' has no declared trigger event (actor=${manifestAgent.actor}). Emit an event manually via POST /v1/events to invoke it.`,
            409,
          );
        }

        const triggerEvent = manifestAgent.triggers[0]!;
        const eventId = makeId("evt");
        const correlationId = makeId("cor");

        // Determine the subject. Body.input may carry one (e.g. {subject: "REQ-2041"}
        // or {candidate_id, job_requisition_id}); fall back to a synthetic test
        // subject so the run doesn't surface a NULL subject in the UI.
        const inputObj =
          body.input && typeof body.input === "object"
            ? (body.input as Record<string, unknown>)
            : {};
        const subject =
          (typeof inputObj.subject === "string" && inputObj.subject) ||
          (typeof inputObj.candidate_id === "string" && inputObj.candidate_id) ||
          (typeof inputObj.job_requisition_id === "string" &&
            inputObj.job_requisition_id) ||
          `TEST-${eventId.slice(4, 12)}`;

        const inngestData: Record<string, unknown> = {
          ...inputObj,
          subject,
          __triggerEventId: eventId,
          __correlationId: correlationId,
          __invokedAgent: agentName,
        };
        if (testRunQuery) {
          inngestData.__test = true;
        }

        // Persist the synthetic trigger event so the manifest engine's
        // `runs.trigger_event_id` FK (packages/runtime/src/register.ts:223)
        // points at a real row. Without this insert the manifest engine
        // throws `SqliteError: FOREIGN KEY constraint failed` on its first
        // step.run() write, leaving the run invisible to the UI and
        // re-triggering Inngest retries until the per-fn cap is hit.
        try {
          const payloadRef = await appendToLedger(auth.tenantSlug, {
            id: eventId,
            name: triggerEvent,
            subject,
            data: inngestData,
            ts: Date.now(),
          });
          const db = getDb();
          const catalogRow = db
            .select({ category: eventTypes.category })
            .from(eventTypes)
            .where(
              and(
                eq(eventTypes.tenantId, auth.tenantId),
                eq(eventTypes.name, triggerEvent),
              ),
            )
            .all()[0];
          db.insert(events)
            .values({
              id: eventId,
              tenantId: auth.tenantId,
              name: triggerEvent,
              category: catalogRow?.category ?? null,
              subject,
              payloadRef,
            })
            .run();
        } catch (err) {
          req.log.warn(
            { err, eventId, triggerEvent },
            "manifest-invoke: failed to persist synthetic trigger event; the run row insert will likely fail",
          );
        }

        try {
          await getTenantInngest(auth.tenantSlug).send({
            name: `${auth.tenantSlug}/${triggerEvent}` as `${string}/${string}`,
            data: inngestData,
          });
        } catch (err) {
          req.log.error({ err }, "agent-invoke: inngest.send failed");
          return reply.fail(
            "internal_error",
            "Failed to enqueue invocation event",
            500,
          );
        }

        const manifestBody = {
          ok: true,
          data: {
            kind: "manifest",
            status: "queued",
            eventId,
            eventName: triggerEvent,
            subject,
            correlationId,
            note:
              "Manifest agent dispatched via Inngest. Watch /v1/runs (SSE) for the resulting run.",
          },
        };
        if (idemKey) {
          try {
            storeIdempotency(auth.tenantId, idemKey, {
              status: 202,
              body: manifestBody,
            });
          } catch (err) {
            req.log.warn(
              { err },
              "idempotency: cache write failed (agent-invoke manifest)",
            );
          }
        }
        return reply.code(202).send(manifestBody);
      }

      if (!agent.enabled) {
        return reply.fail(
          "agent_disabled",
          `Agent '${agentName}' is disabled`,
          409,
        );
      }

      const invocationId = makeId("inv");
      const correlationId = makeId("cor");

      // Async path → Inngest
      if (body.async) {
        // TODO(v2): wire inngest.send here. For v1 we surface async as 501 since
        // the Inngest function is registered but the API-side send/queue tracking
        // is not wired. Sync is the documented path for v1.
        return reply.fail(
          "not_implemented",
          "Async invocation via Inngest is reserved for v2; use sync (omit `async`).",
          501,
        );
      }

      // Sync path → BaseAgent.run()
      try {
        const result = await agent.run(body.input as never, {
          tenantSlug: "__system",
          correlationId,
          invocationId,
          provider: body.provider as ProviderId | undefined,
          model: body.model,
          // P2-FE-18 — propagate `?testRun=1` into the run engine so it can
          // flip `runs.is_test` and tag the broadcast `run.started` event.
          testRun: testRunQuery,
        });

        // Prometheus metrics — single sample per finished run. Labelled by
        // tenant/agent/model/status so the Grafana panels can break down by
        // any of those dimensions. tokens_total carries direction=in|out so
        // total consumption can be aggregated across providers.
        const tenantLabel = req.auth?.tenantSlug ?? "__system";
        metrics.runs.inc({
          tenant: tenantLabel,
          agent: agentName,
          model: result.model,
          status: result.status,
        });
        if (typeof result.tokensIn === "number") {
          metrics.tokens.inc(
            { tenant: tenantLabel, agent: agentName, model: result.model, direction: "in" },
            result.tokensIn,
          );
        }
        if (typeof result.tokensOut === "number") {
          metrics.tokens.inc(
            { tenant: tenantLabel, agent: agentName, model: result.model, direction: "out" },
            result.tokensOut,
          );
        }
        metrics.runDuration.observe(result.durationMs, {
          tenant: tenantLabel,
          agent: agentName,
        });

        const okData = {
          runId: result.runId,
          status: result.status,
          output: result.output,
          provider: result.provider,
          model: result.model,
          tokensIn: result.tokensIn,
          tokensOut: result.tokensOut,
          durationMs: result.durationMs,
          // P2-FE-18 — echo the test-run flag back so SPA callers don't have
          // to re-read the runs row to render the badge in their toast.
          testRun: result.testRun ?? testRunQuery,
        };
        if (idemKey) {
          try {
            storeIdempotency(auth.tenantId, idemKey, {
              status: 200,
              body: { ok: true, data: okData },
            });
          } catch (err) {
            req.log.warn(
              { err },
              "idempotency: cache write failed (agent-invoke code)",
            );
          }
        }
        return reply.ok(okData);
      } catch (err) {
        // Operator clicked Stop while the synchronous run was in flight.
        // Cancellation is a successful outcome — return 200 with the
        // cancelled status so the portal can render the cancel state
        // without a red error toast. The run row was already flipped to
        // `cancelled` by the cancel-route handler; the run engine recorded
        // the step as `skipped`. Bumping metrics here would double-count
        // (the cancel route already incremented the cancel counter), so
        // we skip the metric increment for this path.
        if (err instanceof RunCancelledError) {
          return reply.ok({
            runId: err.runId,
            status: "cancelled",
            cancelled: true,
          });
        }
        const tenantLabel = req.auth?.tenantSlug ?? "__system";
        metrics.runs.inc({
          tenant: tenantLabel,
          agent: agentName,
          model: body.model ?? "unknown",
          status: "failed",
        });
        if (isLLMError(err)) {
          metrics.llmErrors.inc({
            tenant: tenantLabel,
            provider: err.provider,
            model: body.model ?? "unknown",
            code: err.code,
          });
          const status = mapErrorStatus(err.code);
          return reply.fail(err.code, err.message, status);
        }
        throw err;
      }
    },
  );
}

function mapErrorStatus(code: string): number {
  switch (code) {
    case "auth":
      return 401;
    case "rate_limit":
      return 429;
    case "timeout":
      return 504;
    case "model_not_found":
    case "bad_request":
      return 400;
    case "not_configured":
      return 503;
    case "network":
    case "provider_error":
    default:
      return 502;
  }
}
