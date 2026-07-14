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
import { runsLogsRoute } from "./routes/v1/runs-logs";
import { tasksRoutes } from "./routes/v1/tasks";
import { agentsRoutes } from "./routes/v1/agents";
import { agentAuthoringRoutes } from "./routes/v1/agent-authoring";
import { agentInvokeRoutes } from "./routes/v1/agent-invoke";
import { deploymentsRoutes } from "./routes/v1/deployments";
import { webhooksRoutes } from "./routes/v1/webhooks";
import { artifactsRoutes } from "./routes/v1/artifacts";
import { readsRoutes } from "./routes/v1/reads";
import { llmRoutes } from "./routes/v1/llm";
import { manifestImportRoutes } from "./routes/v1/manifest-import";
import { tenantsRoutes } from "./routes/v1/tenants";
import { usageRoutes } from "./routes/v1/usage";
import { budgetsRoutes } from "./routes/v1/budgets";
import { auditRoutes } from "./routes/v1/audit";
import { streamRoutes } from "./routes/v1/stream";
import { tenantCodeRoutes } from "./routes/v1/tenant-code";
import { workflowRoutes } from "./routes/v1/workflow";
import { demoRoutes } from "./routes/v1/demo";
import { toolsRoutes } from "./routes/v1/tools";
import { integrationsRoutes } from "./routes/v1/integrations";
import { agentStudioRoutes } from "./routes/v1/agent-studio";
import { stopDemoRunner } from "./services/demo-runner";
import { inngestRoute } from "./routes/inngest";
import { bootstrapRuntime } from "./bootstrap";

// Studio file controls encode uploads as data URLs in the run reservation
// request. Base64 adds roughly 33%, so the HTTP envelope must be larger than
// the default 10 MB per-file policy while still remaining globally bounded.
const MAX_BODY_BYTES = Number(
  process.env.AGENTIC_MAX_BODY_BYTES ?? 16 * 1024 * 1024,
);

const PORT = Number(process.env.PORT ?? 3501);
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
          ? {
              target: "pino-pretty",
              options: { translateTime: "HH:MM:ss.l", colorize: true },
            }
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
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "Accept",
      "Authorization",
      "Content-Type",
      "If-Match",
      "Idempotency-Key",
      "Last-Event-ID",
      "X-Agentic-Tenant",
      "X-Request-Id",
    ],
    // CORS-restricted browsers strip non-safelisted response headers
    // unless explicitly exposed — without this the `x-request-id` echo
    // above is invisible to the web app.
    exposedHeaders: ["etag", "x-request-id"],
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
  const { inngest, functions } = await bootstrapRuntime();
  await inngestRoute(app, { client: inngest, functions });

  // Demo-runner stops cleanly on Fastify drain (SIGTERM / SIGINT route here
  // through `installGracefulShutdown`). No-op when nothing is running.
  app.addHook("onClose", async () => {
    stopDemoRunner();
  });

  // /v1 REST surface
  await app.register(
    async (v1) => {
      await v1.register(eventsRoutes);
      await v1.register(runsRoutes);
      await v1.register(runsLogsRoute);
      await v1.register(tasksRoutes);
      await v1.register(agentsRoutes);
      await v1.register(agentAuthoringRoutes);
      await v1.register(agentInvokeRoutes);
      await v1.register(agentStudioRoutes);
      await v1.register(deploymentsRoutes);
      await v1.register(webhooksRoutes);
      await v1.register(artifactsRoutes);
      await v1.register(readsRoutes);
      await v1.register(llmRoutes);
      await v1.register(manifestImportRoutes);
      await v1.register(tenantsRoutes);
      // Settings → Usage / Audit / Budgets surfaces. Previously dead-on-
      // arrival files (P0-LOG-D1 / 03-logging-audit.md).
      await v1.register(usageRoutes);
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
      // External-service integrations (Settings → Integrations). GoHire ATS
      // base URL + encrypted API key, read by the GoHire tool family.
      await v1.register(integrationsRoutes);
    },
    { prefix: "/v1" },
  );

  return app;
}

// Auto-start only when this file is the main entrypoint, not when imported by tests.
const isMain = import.meta.url === `file://${process.argv[1]}`;
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
  } catch (err) {
    app.log.error({ err }, "failed to start");
    process.exit(1);
  }
}
