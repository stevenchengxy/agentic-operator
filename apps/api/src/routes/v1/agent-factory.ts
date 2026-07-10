/**
 * Agent Factory — SSE brain stream (background-run model).
 *
 *   GET  /v1/agent-factory/stream?domain&goal&conversation   — start a NEW run
 *   GET  /v1/agent-factory/stream?run=<runId>                 — RECONNECT to a live run
 *   POST /v1/agent-factory/stop      { runId }                — stop a running brain
 *   POST /v1/agent-factory/inject    { conversation, text }   — HITL message / decision
 *   GET  /v1/agent-factory/{domains,runs,runs/:id}            — pickers + history
 *
 * The brain runs DETACHED in the in-process run-registry, so closing the EventSource
 * (navigating away) only unsubscribes — the run keeps going server-side and a later
 * reconnect re-attaches (or replays from the durable factory_runs row). A stop button
 * aborts explicitly. EventSource is GET-only, so params ride the query string and the
 * web side reaches this through the unbuffered proxy (app/factory-stream/route.ts).
 */

import type { FastifyInstance } from "fastify";
import { isGatewayConfigured, analyzeRun, type BrainEvent, type GeneratedAgentSpec } from "@agentic/agent-factory";
import { requirePermission } from "../../plugins/rbac";
import { makeFactoryPorts, listRuns, getRun, deleteRun, restoreRun, deleteRunsByDomain, listAgentDrafts } from "../../services/agent-factory";
import { promoteDrafts } from "../../services/agent-factory/promote";
import { FsUploadedOntologyStore } from "../../services/agent-factory/uploaded-ontology-store";
import { FsAgentDraftStore } from "../../services/agent-factory/agent-draft-store";
import { pushHumanMessage, peekHumanMessages } from "../../services/agent-factory/mailbox";
import { startRun, subscribeRun, abortRun, readDurableRun, forceFinalizeAborted, sweepZombieRuns, isActiveRun } from "../../services/agent-factory/run-registry";
import { listReportJobs, startOntologyReportJob, deleteReportJob, type ReportFormat } from "../../services/agent-factory/report-jobs";
import { listDeclarativeTools, deleteDeclarativeTool } from "../../services/agent-factory/declarative-tool";

const frame = (data: unknown): string => `data: ${JSON.stringify(data)}\n\n`;

// DEV-ONLY live-runthrough fixtures. A 2-agent chain with an EXTERNAL handoff: ProcessResume waits
// on RESUME_DOWNLOADED, which no internal agent produces and we don't fire → the deployer must
// auto-synthesize a mock external-platform agent to produce it, closing the chain.
function demoRunthroughChain(domain: string): GeneratedAgentSpec[] {
  const mk = (name: string, trigger: string[], emit: string[]): GeneratedAgentSpec =>
    ({
      key: name, actionName: name, slug: `${domain.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 12)}-${name.toLowerCase()}`,
      short: name, domainId: domain, nameZh: name, kind: "llm", trigger, emit, tools: ["meta.ping"], unresolvedTools: [],
      objects: [], systemPrompt: `You are ${name}. Handle the trigger and emit the outcome event.`, userPrompt: "",
      steps: [], ruleRefs: [], retries: 1, hitl: false, confidence: 1, promptSource: "llm",
    }) as GeneratedAgentSpec;
  return [
    mk("CreateJd", ["RUNTHRU_START"], ["JD_GENERATED"]),
    mk("ProcessResume", ["RESUME_DOWNLOADED"], ["RESUME_PROCESSED"]),
  ];
}
const DEMO_RUNTHROUGH_CASES = [
  { entryEvent: "RUNTHRU_START", payload: { subject: "rt-pass" }, kind: "pass" as const },
  { entryEvent: "RUNTHRU_START", payload: { subject: "rt-reject", _force_reject: true }, kind: "reject" as const },
];

export async function agentFactoryRoutes(app: FastifyInstance) {
  app.get("/agent-factory/domains", async (req, reply) => {
    requirePermission(req, "agents.read");
    const domains = await makeFactoryPorts(req.auth?.tenantSlug).ontology.listDomains();
    // gatewayConfigured lets the UI warn "LLM 未配置" instead of the brain silently
    // dead-ending on its first turn when no streaming gateway key is present.
    return reply.ok({ domains, gatewayConfigured: isGatewayConfigured() });
  });

  app.get<{ Querystring: { domain?: string; limit?: string; deleted?: string } }>("/agent-factory/runs", async (req, reply) => {
    requirePermission(req, "agents.read");
    const domain = req.query.domain ? String(req.query.domain) : null;
    const limit = req.query.limit ? Math.min(100, Number(req.query.limit) || 30) : 30;
    const deleted = req.query.deleted === "true" || req.query.deleted === "1";
    const tenantId = req.auth?.tenantId;
    // Clear orphaned "运行中" rows (api/HMR restart left them with no live driver) so the
    // history list reflects reality, not zombies that can never reach a terminal state. Skip the
    // sweep for the recycle bin (deleted rows are already terminal/tombstoned).
    if (!deleted) sweepZombieRuns(domain, tenantId);
    return reply.ok({ runs: listRuns(domain, tenantId, limit, { deleted }) });
  });
  app.get<{ Params: { id: string } }>("/agent-factory/runs/:id", async (req, reply) => {
    requirePermission(req, "agents.read");
    const run = getRun(req.params.id, req.auth?.tenantId);
    if (!run || run.deletedAt) return reply.fail("not_found", "run not found", 404);
    return reply.ok({ run });
  });

  // #6: AI run review — load the run's saved transcript, have an LLM score it + surface problems.
  app.post<{ Params: { id: string } }>("/agent-factory/runs/:id/analyze", async (req, reply) => {
    requirePermission(req, "agents.read");
    const run = getRun(req.params.id, req.auth?.tenantId);
    if (!run || run.deletedAt) return reply.fail("not_found", "run not found", 404);
    const review = await analyzeRun((run.transcript as BrainEvent[]) ?? [], { domain: (run as { domain?: string }).domain });
    return reply.ok({ review });
  });

  // Soft-delete a run (历史运行 trash). Tenant-scoped; never deletes a live 'running' row. The
  // row is recoverable via /restore and a reconnect to it replays a tombstone, not the run.
  app.delete<{ Params: { id: string } }>("/agent-factory/runs/:id", async (req, reply) => {
    requirePermission(req, "agents.invoke");
    if (!req.auth) return reply.fail("unauthorized", "需要租户上下文", 401);
    return reply.ok({ deleted: deleteRun(req.params.id, req.auth.tenantId) });
  });

  // Restore a soft-deleted run.
  app.post<{ Params: { id: string } }>("/agent-factory/runs/:id/restore", async (req, reply) => {
    requirePermission(req, "agents.invoke");
    if (!req.auth) return reply.fail("unauthorized", "需要租户上下文", 401);
    return reply.ok({ restored: restoreRun(req.params.id, req.auth.tenantId) });
  });

  // Bulk-clear a domain's finished runs (清空已完成). Requires ?domain=; skips live runs.
  app.delete<{ Querystring: { domain?: string } }>("/agent-factory/runs", async (req, reply) => {
    requirePermission(req, "agents.invoke");
    if (!req.auth) return reply.fail("unauthorized", "需要租户上下文", 401);
    const domain = String(req.query.domain ?? "").trim();
    if (!domain) return reply.fail("bad_request", "domain 必填", 400);
    return reply.ok({ cleared: deleteRunsByDomain(domain, req.auth.tenantId) });
  });

  // Durable agent drafts a finished run produced (persisted by finish()).
  app.get<{ Querystring: { domain?: string } }>("/agent-factory/drafts", async (req, reply) => {
    requirePermission(req, "agents.read");
    const domain = req.query.domain ? String(req.query.domain) : "";
    if (!domain) return reply.fail("bad_request", "domain 必填", 400);
    return reply.ok({ drafts: await listAgentDrafts(domain) });
  });

  // #P1b — fetch the DEPLOYABLE ts_function_module code for one draft (the actual function code,
  // inngest.createFunction 形态, to download/copy). Rendered from the spec if not persisted yet.
  app.get<{ Querystring: { domain?: string; slug?: string } }>("/agent-factory/drafts/code", async (req, reply) => {
    requirePermission(req, "agents.read");
    const domain = String(req.query.domain ?? "").trim();
    const slug = String(req.query.slug ?? "").trim();
    if (!domain || !slug) return reply.fail("bad_request", "domain 和 slug 必填", 400);
    const code = await new FsAgentDraftStore().getCode(domain, slug);
    if (code == null) return reply.fail("not_found", "没有这个草稿。", 404);
    return reply.ok({ domain, slug, code, filename: `${slug}.ts` });
  });

  // Delete a single generated-function DRAFT before it's promoted (user declined it). File-based
  // draft store; never touches live agents. domain required to scope the delete.
  app.delete<{ Params: { slug: string }; Querystring: { domain?: string } }>("/agent-factory/drafts/:slug", async (req, reply) => {
    requirePermission(req, "agents.invoke");
    const domain = String(req.query.domain ?? "").trim();
    if (!domain) return reply.fail("bad_request", "domain 必填", 400);
    const removed = await new FsAgentDraftStore().delete(domain, decodeURIComponent(req.params.slug));
    if (!removed) return reply.fail("not_found", "没有这个草稿。", 404);
    return reply.ok({ deleted: true, slug: req.params.slug });
  });

  // Promote a domain's finished drafts → real running Fleet agents. EXPLICIT (never
  // auto) and ADDITIVE (merges into the tenant's live workflow, never clobbers it).
  app.post<{ Body: { domain?: string; slugs?: string[] } }>("/agent-factory/drafts/promote", async (req, reply) => {
    requirePermission(req, "agents.invoke");
    const domain = String(req.body?.domain ?? "").trim();
    if (!domain) return reply.fail("bad_request", "domain 必填", 400);
    if (!req.auth) return reply.fail("unauthorized", "需要租户上下文", 401);
    try {
      const result = await promoteDrafts(domain, req.body?.slugs, { tenantId: req.auth.tenantId, tenantSlug: req.auth.tenantSlug });
      return reply.ok(result);
    } catch (e) {
      return reply.fail("promote_failed", (e as Error).message ?? "晋升失败", 400);
    }
  });

  // ── Uploaded ontology bundles (本地本体) — upload actions/events/rules/dataObjects JSON; it
  // persists as a reusable LOCAL domain that shows up in the switcher and the factory reads instead
  // of the live Ontology. ────────────────────────────────────────────────────────────────────────
  app.get("/agent-factory/ontology-uploads", async (req, reply) => {
    requirePermission(req, "agents.read");
    if (!req.auth?.tenantSlug) return reply.ok({ uploads: [] });
    return reply.ok({ uploads: await new FsUploadedOntologyStore().list(req.auth.tenantSlug) });
  });

  app.post<{ Body: { name?: string; ontology?: unknown; domainId?: string } }>("/agent-factory/ontology-upload", async (req, reply) => {
    requirePermission(req, "agents.write");
    if (!req.auth?.tenantSlug) return reply.fail("unauthorized", "需要租户上下文", 401);
    const name = String(req.body?.name ?? "").trim();
    if (!name) return reply.fail("bad_request", "请给上传的本体起个名字。", 400);
    if (req.body?.ontology == null) return reply.fail("bad_request", "ontology（JSON 内容）不能为空。", 400);
    // Body-size guard: refuse an oversized bundle (DoS / memory) — well above any real ontology.
    if (JSON.stringify(req.body.ontology).length > 4_000_000) return reply.fail("too_large", "本体 JSON 过大（>4MB）。", 413);
    // Optional: ATTACH the ontology to an existing/selected 业务域 (store under its id) instead of
    // minting a new file-named domain. The store slugifies it, so a built-in/Allmeta domain gets a
    // tenant-scoped uploaded overlay that shadows it for this tenant.
    const domainId = String(req.body?.domainId ?? "").trim() || undefined;
    try {
      const meta = await new FsUploadedOntologyStore().save(req.auth.tenantSlug, name, req.body.ontology, domainId);
      return reply.ok({ uploaded: meta });
    } catch (e) {
      return reply.fail("invalid_ontology", (e as Error).message ?? "本体校验失败", 400);
    }
  });

  app.delete<{ Params: { id: string } }>("/agent-factory/ontology-uploads/:id", async (req, reply) => {
    requirePermission(req, "agents.write");
    if (!req.auth?.tenantSlug) return reply.fail("unauthorized", "需要租户上下文", 401);
    const removed = await new FsUploadedOntologyStore().delete(req.auth.tenantSlug, decodeURIComponent(req.params.id));
    if (!removed) return reply.fail("not_found", "没有这个上传的本体。", 404);
    return reply.ok({ deleted: true, id: req.params.id });
  });

  // ── Ops sidebar backend (任务 tab) ──────────────────────────────────────────────────────────────
  // Unified BACKGROUND snapshot across the tenant: factory runs (all domains, running first) with a
  // liveness flag, plus report jobs. One poll target for the Claude-desktop-style 后台 section.
  app.get("/agent-factory/background", async (req, reply) => {
    requirePermission(req, "agents.read");
    const tenantId = req.auth?.tenantId;
    sweepZombieRuns(null, tenantId);
    const runs = listRuns(null, tenantId, 12).map((r) => ({
      ...r,
      live: r.status === "running" && isActiveRun(r.id),
    }));
    return reply.ok({ runs, jobs: listReportJobs(tenantId) });
  });

  // 领域报告 — kick off an ontology-analysis report job (HTML / PDF / both). Detached like a
  // factory run: this returns immediately; progress + artifact links surface via /background.
  app.post<{ Body: { domain?: string; format?: string; focus?: string } }>("/agent-factory/report", async (req, reply) => {
    requirePermission(req, "agents.invoke");
    if (!req.auth) return reply.fail("unauthorized", "需要租户上下文", 401);
    const domain = String(req.body?.domain ?? "").trim();
    if (!domain) return reply.fail("bad_request", "domain 必填", 400);
    const format = String(req.body?.format ?? "html");
    if (!["html", "pdf", "both"].includes(format)) return reply.fail("bad_request", "format 须为 html | pdf | both", 400);
    if (!isGatewayConfigured()) return reply.fail("not_configured", "LLM 网关未配置——报告 agent 无法运行。", 503);
    const focus = req.body?.focus ? String(req.body.focus).slice(0, 500) : undefined;
    const job = startOntologyReportJob({
      tenantId: req.auth.tenantId,
      tenantSlug: req.auth.tenantSlug,
      domain,
      format: format as ReportFormat,
      focus,
    });
    return reply.ok({ job });
  });

  // Clear a finished report job from the background panel (running jobs are refused —
  // no abort path exists, so hiding an in-flight job would misreport reality).
  app.delete<{ Params: { id: string } }>("/agent-factory/report/:id", async (req, reply) => {
    requirePermission(req, "agents.invoke");
    const deleted = deleteReportJob(req.params.id, req.auth?.tenantId);
    if (!deleted) return reply.fail("not_found", "没有这个报告任务（或它仍在运行）。", 404);
    return reply.ok({ deleted: true, id: req.params.id });
  });

  // 生成的工具 — the brain's create_tool output is already persisted to factory_tools; these two
  // endpoints close the "存入工具库？" ask-user loop: list what exists (the sidebar cross-references
  // tool.created events from the live run) and delete what the user declines to keep.
  app.get("/agent-factory/generated-tools", async (req, reply) => {
    requirePermission(req, "agents.read");
    return reply.ok({ tools: listDeclarativeTools(req.auth?.tenantSlug) });
  });

  app.delete<{ Params: { name: string } }>("/agent-factory/generated-tools/:name", async (req, reply) => {
    // agents.invoke (not agents.write) — consistent with the rest of the factory mutation
    // surface (runs DELETE / drafts promote / stop / inject); an operator who can drive the
    // factory can also decline the tools it just created.
    requirePermission(req, "agents.invoke");
    const name = decodeURIComponent(req.params.name);
    const deleted = deleteDeclarativeTool(name, req.auth?.tenantSlug);
    if (!deleted) return reply.fail("not_found", "没有这个工具（或它属于其它租户）。", 404);
    return reply.ok({ deleted: true, name });
  });

  // 介入通道 peek — how many injected messages the brain hasn't drained yet, so the sidebar can
  // show "N 条介入待大脑读取" instead of leaving the user guessing whether their input landed.
  app.get<{ Querystring: { conversation?: string } }>("/agent-factory/mailbox", async (req, reply) => {
    requirePermission(req, "agents.read");
    const conversation = String(req.query.conversation ?? "").trim();
    if (!conversation) return reply.fail("bad_request", "conversation 必填", 400);
    // Tenant-scoped peek: a guessed foreign conversation id reads as empty, never as
    // another tenant's live-run metadata.
    return reply.ok(peekHumanMessages(conversation, req.auth?.tenantId));
  });

  // HITL: inject a human message / a test-case decision into a running brain.
  app.post<{ Body: { conversation?: string; text?: string } }>("/agent-factory/inject", async (req, reply) => {
    requirePermission(req, "agents.invoke");
    const conversation = String(req.body?.conversation ?? "").trim();
    const text = String(req.body?.text ?? "").trim();
    if (!conversation || !text) return reply.fail("bad_request", "conversation 和 text 必填", 400);
    // runId === conversationId by design, so isActiveRun tells us whether a live brain will drain
    // this now. Either way we queue it (a resumed conversation drains pending messages on its next
    // turn), but we report `active` so the UI can tell the user "delivered now" vs "saved for next
    // continue" instead of silently swallowing an inject into a mailbox no driver is reading.
    pushHumanMessage(conversation, text, req.auth?.tenantId);
    return reply.ok({ queued: true, active: isActiveRun(conversation) });
  });

  // Stop button — abort the detached background run.
  app.post<{ Body: { runId?: string } }>("/agent-factory/stop", async (req, reply) => {
    requirePermission(req, "agents.invoke");
    const runId = String(req.body?.runId ?? "").trim();
    if (!runId) return reply.fail("bad_request", "runId 必填", 400);
    // If it wasn't live in the registry it may be ORPHANED (api/HMR restart left the durable
    // row stuck 'running') — flip that row to 'aborted' so the stuck "运行中" actually clears.
    const aborted = abortRun(runId);
    const finalized = aborted ? false : forceFinalizeAborted(runId);
    return reply.ok({ aborted, finalized });
  });

  // DEV-ONLY live sandbox runthrough — drives the REAL ManifestSandboxDeployer against the live
  // Inngest dev server: registers an isolated `<domain>-sb` app + the generated functions (+ the
  // auto-synthesized mock external-platform agents), fires the test cases on DISTINCT subjects, and
  // observes real runs + the per-kind verdict. The reliable way to confirm the sandbox path
  // end-to-end ("跑通"). Guarded: refused in production unless AUTH_MODE=dev.
  app.post<{ Body: { domain?: string; specs?: GeneratedAgentSpec[]; testCases?: Array<{ entryEvent: string; payload?: Record<string, unknown>; kind?: "pass" | "reject" | "edge" }> } }>(
    "/agent-factory/sandbox-runthrough",
    async (req, reply) => {
      if (process.env.NODE_ENV === "production" && process.env.AUTH_MODE !== "dev") {
        return reply.fail("forbidden", "dev-only endpoint", 403);
      }
      requirePermission(req, "agents.invoke");
      const domain = String(req.body?.domain ?? "runthru").slice(0, 24);
      const specs = req.body?.specs?.length ? req.body.specs : demoRunthroughChain(domain);
      const testCases = (req.body?.testCases?.length ? req.body.testCases : DEMO_RUNTHROUGH_CASES).map((c) => ({ entryEvent: c.entryEvent, payload: c.payload ?? {}, kind: c.kind }));
      const { ManifestSandboxDeployer } = await import("../../services/agent-factory/sandbox-deployer");
      const deployer = new ManifestSandboxDeployer();
      const result = await deployer.deployAndObserve(domain, specs, { testCases });
      return reply.ok({
        domain,
        functionsRegistered: result.functionsRegistered,
        ran: result.ran,
        fullChainRan: result.fullChainRan,
        reachedSuccessTerminal: result.reachedSuccessTerminal,
        mockExternalAgents: result.mockExternalAgents,
        caseVerdicts: result.caseVerdicts,
        fires: result.fires,
        registeredIds: result.registeredIds,
        simulated: result.simulated,
      });
    },
  );

  app.get<{ Querystring: { domain?: string; goal?: string; conversation?: string; run?: string } }>(
    "/agent-factory/stream",
    async (req, reply) => {
      requirePermission(req, "agents.invoke");
      const reconnectId = req.query.run ? String(req.query.run) : "";
      const domain = String(req.query.domain ?? "").trim();
      const goal = String(req.query.goal ?? "").trim();
      const conversationId = req.query.conversation ? String(req.query.conversation) : undefined;
      if (!reconnectId && (!domain || !goal)) return reply.fail("bad_request", "domain 和 goal 必填（或传 run 重连）", 400);

      reply.hijack();
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      reply.raw.write(": open\n\n");

      let unsub: (() => void) | null = null;
      let ended = false;
      const keepalive = setInterval(() => {
        try {
          reply.raw.write(": ping\n\n");
        } catch {
          /* socket gone */
        }
      }, 15_000);
      const endStream = () => {
        if (ended) return;
        ended = true;
        clearInterval(keepalive);
        if (unsub) unsub();
        try {
          reply.raw.write("event: end\ndata: ok\n\n");
          reply.raw.end();
        } catch {
          /* socket gone */
        }
      };
      // Client disconnect → only UNSUBSCRIBE; the background run keeps going.
      req.raw.on("close", () => {
        ended = true;
        clearInterval(keepalive);
        if (unsub) unsub();
      });

      const send = (f: unknown) => {
        try {
          reply.raw.write(frame(f));
        } catch {
          /* socket gone */
        }
        // The run's `done` frame ends THIS connection (the run itself already finished).
        if (f && typeof f === "object" && (f as { t?: string }).t === "done") setTimeout(endStream, 50);
      };

      if (reconnectId) {
        // RECONNECT: re-attach to the live run, or replay from the durable row.
        unsub = subscribeRun(reconnectId, send);
        if (!unsub) {
          const durable = readDurableRun(reconnectId, req.auth?.tenantId);
          send({ t: "run.started", runId: reconnectId });
          if (durable && durable.deleted) {
            send({ t: "message", text: "该运行已被删除（在回收站中，可在历史里恢复后再查看）。" });
          } else if (durable) {
            for (const e of durable.transcript) send(e);
            send({ t: "message", text: "（已从存档回放该运行）" });
          } else {
            send({ t: "message", text: "该运行不在内存中且无存档——可能已被清理。" });
          }
          endStream();
        }
      } else {
        const run = startRun({ domain, goal, tenantId: req.auth?.tenantId, tenantSlug: req.auth?.tenantSlug, conversationId });
        send({ t: "run.started", runId: run.runId });
        unsub = subscribeRun(run.runId, send);
      }
      return reply;
    },
  );
}
