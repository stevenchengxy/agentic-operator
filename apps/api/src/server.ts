import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import cors from "@fastify/cors";
import { registerEnvelope } from "./plugins/error";
import { registerAuth } from "./plugins/auth";
import { registerSecurity } from "./plugins/security";
import { installGracefulShutdown } from "./plugins/shutdown";
import { healthRoute } from "./routes/health";
import { metricsRoute } from "./routes/metrics";
import { eventsRoutes } from "./routes/v1/events";
import { runsRoutes } from "./routes/v1/runs";
import { reasoningRoutes } from "./routes/v1/reasoning";
import { runsLogsRoute } from "./routes/v1/runs-logs";
import { tasksRoutes } from "./routes/v1/tasks";
import { agentsRoutes } from "./routes/v1/agents";
import { agentInvokeRoutes } from "./routes/v1/agent-invoke";
import { agentFactoryRoutes } from "./routes/v1/agent-factory";
import { deploymentsRoutes } from "./routes/v1/deployments";
import { webhooksRoutes } from "./routes/v1/webhooks";
import { artifactsRoutes } from "./routes/v1/artifacts";
import { recordsRoutes } from "./routes/v1/records";
import { readsRoutes } from "./routes/v1/reads";
import { llmRoutes } from "./routes/v1/llm";
import { manifestImportRoutes } from "./routes/v1/manifest-import";
import { tenantsRoutes } from "./routes/v1/tenants";
import { usageRoutes } from "./routes/v1/usage";
import { observabilityRoutes } from "./routes/v1/observability";
import { budgetsRoutes } from "./routes/v1/budgets";
import { auditRoutes } from "./routes/v1/audit";
import { streamRoutes } from "./routes/v1/stream";
import { tenantCodeRoutes } from "./routes/v1/tenant-code";
import { workflowRoutes } from "./routes/v1/workflow";
import { demoRoutes } from "./routes/v1/demo";
import { toolsRoutes } from "./routes/v1/tools";
import { authRoutes } from "./routes/v1/auth";
import { membersRoutes } from "./routes/v1/members";
import { adminUsersRoutes } from "./routes/v1/admin-users";
import { stopDemoRunner } from "./services/demo-runner";
import {
  startAppReconciler,
  stopAppReconciler,
  syncAllAppsWithRetry,
} from "./services/inngest-sync";
import { startRunReconciler, stopRunReconciler } from "./services/reconcile-runs";
import { inngestRoute } from "./routes/inngest";
import { bootstrapRuntime } from "./bootstrap";

const MAX_BODY_BYTES = Number(process.env.AGENTIC_MAX_BODY_BYTES ?? 10 * 1024 * 1024);

const PORT = Number(process.env.PORT ?? 3540);
const HOST = process.env.HOST ?? "0.0.0.0";
const WEB_ORIGIN = process.env.WEB_ORIGIN ?? "http://localhost:3599";

export async function build() {
  const app = Fastify({
    // Honour any client-supplied `x-request-id` (so the web tier can stitch
    // its own trace ids together with ours), else mint a fresh UUID. The
    // value is mirrored back on every response via the `onSend` hook below
    // and is also the value pino emits as `reqId` on every log line.
    genReqId: () => randomUUID(),
    requestIdHeader: "x-request-id",
    requestIdLogLabel: "reqId",
    bodyLimit: MAX_BODY_BYTES,
    logger: {
      level: process.env.LOG_LEVEL ?? "info",
      transport:
        process.env.NODE_ENV !== "production" && process.env.NODE_ENV !== "test"
          ? { target: "pino-pretty", options: { translateTime: "HH:MM:ss.l", colorize: true } }
          : undefined,
    },
  });

  // Mirror the request id back to the caller on every response so the
  // browser devtools / e2e tests can grab it from response headers.
  // Skipped once the reply is already sent (e.g. SSE streams that flush
  // headers eagerly via `raw.writeHead`) — writing again would trip
  // `ERR_HTTP_HEADERS_SENT` and crash the process.
  app.addHook("onSend", async (req, reply) => {
    if (reply.sent || reply.raw.headersSent) return;
    reply.header("x-request-id", req.id);
  });

  await app.register(cors, {
    origin: WEB_ORIGIN,
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    // CORS-restricted browsers strip non-safelisted response headers
    // unless explicitly exposed — without this the `x-request-id` echo
    // above is invisible to the web app.
    exposedHeaders: ["x-request-id"],
  });

  await registerEnvelope(app);
  await registerAuth(app);
  await registerSecurity(app);

  // Health + Prometheus metrics — both unauthenticated; metrics is
  // top-level (no /v1 prefix) per Prometheus convention so scrapers don't
  // need to know about the API versioning.
  await app.register(healthRoute);
  await app.register(metricsRoute);

  // Inngest webhook — needs bootstrap result. We deliberately ignore
  // `result.stopDemoRunner` here: that closure is only populated when the
  // env flag boot-starts the runner, so a runner started later via
  // `POST /v1/demo/start` would NOT be drained on SIGTERM. The imported
  // `stopDemoRunner` from the demo-runner module reads the live
  // `_activeRunner` singleton, so it works for both code paths.
  // Runs boot: builds per-tenant Inngest apps + seeds the per-app registry that
  // the `/inngest[/:slug]` routes delegate to. The route reads the registry per
  // request, so it needs no bootstrap result handed in.
  await bootstrapRuntime();
  await inngestRoute(app);

  // Demo-runner stops cleanly on Fastify drain (SIGTERM / SIGINT route here
  // through `installGracefulShutdown`). No-op when nothing is running.
  app.addHook("onClose", async () => {
    stopDemoRunner();
    // #P7-infra — stop the governance sweep timer on shutdown (no-op if it never started).
    try {
      const { stopGovernanceRunner } = await import("./services/agent-factory/fleet-governance-runner");
      stopGovernanceRunner();
    } catch { /* best-effort */ }
    // #SCALE-FANOUT — quit Redis fanout clients so SIGTERM drains instead of hanging on sockets.
    try {
      const { stopRedisFanout } = await import("./services/fanout-redis");
      await stopRedisFanout();
    } catch { /* inert when never wired */ }
    // #SCALE-PGVECTOR — drain the pgvector pool.
    try {
      const { stopPgVectorMemory } = await import("./services/memory-pgvector");
      await stopPgVectorMemory();
    } catch { /* inert when never wired */ }
    stopAppReconciler();
    stopRunReconciler();
  });

  // /v1 REST surface
  await app.register(
    async (v1) => {
      await v1.register(eventsRoutes);
      await v1.register(runsRoutes);
      await v1.register(reasoningRoutes);
      await v1.register(runsLogsRoute);
      await v1.register(tasksRoutes);
      await v1.register(agentsRoutes);
      await v1.register(agentInvokeRoutes);
      // Agent Factory — autonomous brain SSE stream (generates business agents from
      // a domain's models/ ontology, streamed live to the portal factory tab).
      await v1.register(agentFactoryRoutes);
      await v1.register(deploymentsRoutes);
      await v1.register(webhooksRoutes);
      await v1.register(artifactsRoutes);
      await v1.register(recordsRoutes);
      await v1.register(readsRoutes);
      await v1.register(llmRoutes);
      await v1.register(manifestImportRoutes);
      await v1.register(tenantsRoutes);
      // Settings → Usage / Audit / Budgets surfaces. Previously dead-on-
      // arrival files (P0-LOG-D1 / 03-logging-audit.md).
      await v1.register(usageRoutes);
      await v1.register(observabilityRoutes);
      await v1.register(budgetsRoutes);
      await v1.register(auditRoutes);
      // Sprint 1 Phase 3 + Sprint 2 Obs: live SSE event stream, tenant
      // code-agent management, and workflow CRUD. These were registered
      // out-of-band by earlier sprints; restored here after a stash-pop
      // regression dropped them (REG-S2-03).
      await v1.register(streamRoutes);
      await v1.register(tenantCodeRoutes);
      await v1.register(workflowRoutes);
      // Demo-mode runtime toggle — POST /v1/demo/start | /v1/demo/stop |
      // GET /v1/demo/status. Lets the operator flip the synthetic-traffic
      // loop on/off without an api restart.
      await v1.register(demoRoutes);
      // Global tool catalog — drives the Tools view in the portal so
      // manifest authors can browse what's available without spelunking.
      await v1.register(toolsRoutes);
      // P6-AUTH — login + identity, tenant-scoped membership management, and
      // platform-wide user administration (the Access tab + sign-in/up flows).
      await v1.register(authRoutes);
      await v1.register(membersRoutes);
      await v1.register(adminUsersRoutes);
    },
    { prefix: "/v1" },
  );

  return app;
}

// Auto-start only when this file is the main entrypoint, not when imported by tests.
// Compare normalized file URLs so a project path containing spaces (which
// import.meta.url percent-encodes but a raw `file://` + argv concat does not)
// still matches.
const isMain =
  !!process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const app = await build();
  // Install signal handlers BEFORE listen() so a SIGTERM during a slow boot
  // (e.g. orchestrator yanking the pod during inngest registration) is still
  // observed — otherwise the default Node behavior would `exit(143)` and the
  // close() drain never runs.
  installGracefulShutdown(app);
  try {
    await app.listen({ port: PORT, host: HOST });
    app.log.info(`api listening on http://${HOST}:${PORT}`);
    void syncAllAppsWithRetry({
      info: (msg) => app.log.info(msg),
      warn: (msg) => app.log.warn(msg),
    }).catch((err) => app.log.warn({ err }, "initial inngest app sync failed"));
    startAppReconciler({
      info: (msg) => app.log.info(msg),
      warn: (msg) => app.log.warn(msg),
    });
    startRunReconciler({
      info: (msg) => app.log.info(msg),
      warn: (msg) => app.log.warn(msg),
    });
  } catch (err) {
    app.log.error({ err }, "failed to start");
    process.exit(1);
  }
}
