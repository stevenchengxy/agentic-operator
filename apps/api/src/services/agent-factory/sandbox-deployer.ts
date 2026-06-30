// SandboxDeployer port impls.
//
// DryRunSandboxDeployer (default): statically computes whether the spec set forms a
// closed, reachable, success-terminating event chain WITHOUT registering real Inngest
// functions — an honest simulation, good enough to run + gate the factory standalone.
//
// ManifestSandboxDeployer (opt-in, FACTORY_REAL_DEPLOY=1): the REAL deploy — maps the
// generated specs to the runtime WorkflowManifest, commits them to an ISOLATED sandbox
// tenant via the manifest-import service (writes models/<sb>/workflow.json + DB +
// reregisters Inngest functions), fires the entry event, polls the runs table, then
// tears the sandbox back down. Needs the Inngest stack (pnpm dev) for execution to be
// observed; the deploy itself (functions registered) is verifiable from the commit.

import path from "node:path";
import type { SandboxDeployer, SandboxDeployResult, GeneratedAgentSpec, OntologyAction, AgentRunIO } from "@agentic/agent-factory";
import { compileGraph, verifyGraph, projectPlanToActions, verificationPolicy, synthesizeMockExternalAgents, caseOutcomeFromRuns, chainVerdictByKind } from "@agentic/agent-factory";
import { getDb, tenants, runs, agents, events, eq, and, desc } from "@agentic/db";
import { gt } from "drizzle-orm";
import { makeId } from "@agentic/shared";
import { getTenantInngest, appIdForTenant } from "@agentic/runtime";
import { validate as miValidate, commit as miCommit } from "../manifest-import";
import { syncTenantApp, probeApp } from "../inngest-sync";

const FAILISH = /FAIL|REJECT|ERROR|CONFLICT|DENIED|FAILED/i;
// A run-row STATUS that means the agent finished (runtime sets `ok`; the DryRun sim uses "Completed")
// vs failed/aborted. NB: this is the runtime RUN status, NOT the business event (an agent can finish
// `ok` while emitting a fail-BRANCH event — that's a successful execution reaching a fail terminal).
const RUN_DONE = /^ok$|complet/i;
const RUN_FAILED = /fail|cancel|abort|error/i;

// ── DryRun (default) ──────────────────────────────────────────────────────────
export class DryRunSandboxDeployer implements SandboxDeployer {
  async deployAndObserve(domain: string, specs: GeneratedAgentSpec[], opts?: { testCases?: Array<{ entryEvent: string; payload: Record<string, unknown>; kind?: "pass" | "reject" | "edge" }>; boundaryEvents?: Boundary }): Promise<SandboxDeployResult> {
    const actions = specsToActions(domain, specs);
    const graph = compileGraph(actions, { domainId: domain });
    // #D: boundary-aware verdict — external-handoff emits are legitimate terminals, externally
    // triggered agents are exempt from the run-count; only a real break / degrade fails the chain.
    const cv = chainVerdict(specs, graph, opts?.boundaryEvents, (opts?.testCases ?? []).map((c) => c.entryEvent));
    const reachable = cv.reachable;
    const ran = specs.filter((s) => reachable.has(s.actionName));
    const reachedSuccessTerminal = cv.successTerminals.length > 0;
    // Degraded check exempts externally-entered agents too (a forward-to-platform handoff with no
    // tools isn't degraded) — consistent with expectedToRun, so a complete chain isn't false-failed.
    const degradedAgents = cv.expectedToRun.filter((s) => !s.tools?.length && !s.hitl).map((s) => s.short);
    const fullChainRan = cv.v.ok && reachedSuccessTerminal && degradedAgents.length === 0 && cv.expectedToRun.every((s) => reachable.has(s.actionName));
    // Synthesize per-agent I/O from the graph + approved test cases (honest: simulated).
    const agentRuns: AgentRunIO[] = specs.map((s) => {
      const didRun = reachable.has(s.actionName);
      const tc = (opts?.testCases ?? []).find((c) => (s.trigger ?? []).includes(c.entryEvent));
      return {
        agentSlug: s.slug,
        agentShort: s.nameZh || s.short,
        status: didRun ? "Completed (simulated)" : "missed",
        degraded: !s.tools?.length && !s.hitl,
        triggerEvent: s.trigger?.[0] ?? null,
        inputPayload: tc?.payload ?? null,
        tools: s.tools ?? [],
        outputEvent: s.emit?.[0] ?? null,
        reasoning: didRun ? "(dry-run 图闭包模拟：按事件链推断会跑通)" : "(未被入口事件触达)",
        outputPayload: null,
        runId: s.slug,
      };
    });
    return {
      appId: `agentic-operator-sandbox-${domain} (simulated)`,
      functionsRegistered: specs.length,
      ran: ran.length,
      deployed: specs.length,
      reachedSuccessTerminal,
      fullChainRan,
      degradedAgents,
      runs: ran.map((s) => ({ id: s.slug, status: "Completed (simulated)" })),
      agentRuns,
      fingerprint: "",
      simulated: true, // graph-closure inference — NOT a real Inngest run
      internalChains: ran.length,
      externalTerminals: cv.externalTerminals,
    };
  }
  async teardown(): Promise<void> {
    /* nothing was really registered */
  }
}

// ── Real deploy (opt-in) ──────────────────────────────────────────────────────
function specsToActions(domain: string, specs: GeneratedAgentSpec[]): OntologyAction[] {
  return specs.map((s) => ({ id: s.slug, name: s.actionName, actor: s.hitl ? ["Human"] : ["Agent"], trigger: s.trigger ?? [], triggered_event: s.emit ?? [], target_objects: s.objects ?? [], tool_use: s.tools ?? [], system_prompt: s.systemPrompt, user_prompt: s.userPrompt }));
}

type Boundary = Array<{ event: string; kind: string }>;
/** #D — boundary-aware chain verdict (redefines 跑通). Threads the user's boundary classification
 *  into the closure check so an external-HANDOFF emit (consumed by an external platform) counts as
 *  a legitimate terminal — NOT a broken chain — and an agent that's only triggered by an externally
 *  sourced event (waiting for an external platform) is exempt from the "must run" count. Only a real
 *  break (kind:"break") or a degraded agent fails the chain. */
export function chainVerdict(specs: GeneratedAgentSpec[], graph: ReturnType<typeof compileGraph>, boundaryEvents?: Boundary, firedEntries?: string[]) {
  const nonBreak = (boundaryEvents ?? []).filter((b) => b.kind !== "break").map((b) => b.event);
  const external = new Set((boundaryEvents ?? []).filter((b) => b.kind === "external").map((b) => b.event));
  const v = verifyGraph(graph, { boundaryEvents: nonBreak });
  const reachable = new Set(v.reachable);
  const internallyProduced = new Set(specs.flatMap((s) => s.emit ?? []));
  // An agent is "externally entered" if EVERY one of its trigger events is sourced from OUTSIDE: not
  // produced by any internal agent AND not in the entry events we actually FIRE in the sandbox — i.e.
  // it waits for an external platform to send its trigger. A legitimate non-run, exempt from the
  // "must run" count. (Falls back to the graph's entry events when no fired set is given.)
  const fired = new Set(firedEntries && firedEntries.length ? firedEntries : graph.entryEvents);
  const externallyEntered = new Set(
    specs
      .filter((s) => (s.trigger ?? []).length > 0 && (s.trigger ?? []).every((t) => !internallyProduced.has(t) && !fired.has(t)))
      .map((s) => s.actionName),
  );
  const expectedToRun = specs.filter((s) => !externallyEntered.has(s.actionName));
  const successTerminals = [...new Set([...graph.terminalEvents, ...external])].filter((e) => !FAILISH.test(e));
  const externalTerminals = specs.filter((s) => (s.emit ?? []).some((e) => external.has(e) && !FAILISH.test(e))).length;
  return { v, reachable, externallyEntered, expectedToRun, successTerminals, externalTerminals };
}

const sbSlug = (domain: string) => `${domain.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24)}-sb`;

/** Map a GeneratedAgentSpec[] to the runtime WorkflowManifest agent array (the deploy
 *  shape manifest-import validates). Unresolved tools are dropped (they'd fail dispatch).
 *  Exported so draft PROMOTION reuses the exact same mapping the sandbox deploy uses. */
export function mapToManifest(specs: GeneratedAgentSpec[]): unknown[] {
  return specs.map((s) => {
    const tools = (s.tools ?? []).filter((t) => !(s.unresolvedTools ?? []).includes(t));
    return {
      id: s.slug,
      name: s.short || s.nameZh,
      title: s.nameZh,
      description: (s.designReasoning ?? "").slice(0, 200),
      actor: s.hitl ? ["Human"] : ["Agent"],
      trigger: s.trigger ?? [],
      triggered_event: s.emit ?? [],
      ontology_instructions: s.systemPrompt,
      // Generated agent: runtime supplies the default prompt + advertises GLOBAL tools, so it runs
      // without a hand-written tenant prompt package. THIS is what makes generated functions
      // actually execute on Inngest (not just register).
      generated: true,
      // #G — true CodeAct: when the brain hand-wrote AI code, EXECUTE it in the sandbox (gated by
      // FACTORY_EXEC_GENERATED, dry-run tools, falls back to the default prompt). Rendered code
      // (codeSource !== "ai") stays declarative.
      codeExecuted: s.codeSource === "ai",
      // R14: the runtime ontology.fetchActionRules tool needs the domain (+ action) to fetch the
      // executor=Agent rules for THIS action — attach it via tool_use config so it resolves live.
      tool_use: tools.map((t) => (t === "ontology.fetchActionRules" ? { name: t, config: { domain: s.domainId, action: s.actionName } } : { name: t })),
      typescript_code: s.generatedCode,
      // Phase 1 — project the spec's STRUCTURED plan[] into ordered manifest actions (one durable
      // step.run each: tool / condition / invoke / logic), giving the generated agent the per-step
      // durability + branching + soft-fail of a hand-written production agent. When the spec has no
      // plan, this falls back to the legacy single-logic action (a HITL agent still gets its
      // `manual` approval gate first so the runtime's human-approval path actually parks). The
      // descriptive prose `steps[]` remain on the spec for the UI.
      actions: projectPlanToActions(s),
    };
  });
}

export class ManifestSandboxDeployer implements SandboxDeployer {
  constructor() {
    // manifest-import requires AGENTIC_MODELS_DIR; default it to the repo models dir.
    if (!process.env.AGENTIC_MODELS_DIR) {
      for (const c of [path.resolve(process.cwd(), "models"), path.resolve(process.cwd(), "../../models")]) {
        try {
          process.env.AGENTIC_MODELS_DIR = c;
          break;
        } catch {
          /* keep trying */
        }
      }
    }
  }

  /** Ensure an isolated sandbox tenant row exists; returns {tenantId, tenantSlug}. */
  private ensureTenant(domain: string): { tenantId: string; tenantSlug: string } {
    const slug = sbSlug(domain);
    const db = getDb();
    const existing = db.select().from(tenants).where(eq(tenants.slug, slug)).all()[0];
    if (existing) return { tenantId: existing.id, tenantSlug: slug };
    const id = makeId("ten");
    const now = new Date();
    db.insert(tenants).values({ id, slug, name: `${domain} 沙箱`, subtitle: "Agent Factory sandbox", createdAt: now, updatedAt: now }).run();
    return { tenantId: id, tenantSlug: slug };
  }

  async deployAndObserve(domain: string, specs: GeneratedAgentSpec[], opts?: { testCases?: Array<{ entryEvent: string; payload: Record<string, unknown>; kind?: "pass" | "reject" | "edge" }>; boundaryEvents?: Boundary }): Promise<SandboxDeployResult> {
    const ctx = this.ensureTenant(domain);
    const appId = `sandbox-${ctx.tenantSlug}`;
    // Phase 3 — surface the verification posture (determinism + cost). Defaults are safe: mock
    // model + mock tools + advisory judge, so a sandbox run stays free, deterministic, and
    // side-effect-free. Real model / live tools / cassette replay require explicit env opt-in.
    const vpolicy = verificationPolicy();
    console.info(`[sandbox] verification policy — model=${vpolicy.realModel ? "real" : "mock"} tools=${vpolicy.toolMode} budgetTokens=${vpolicy.budgetTokens || "∞(mock)"} judgeBlocking=${vpolicy.judgeIsBlocking}`);
    // T2 — compute the event graph + the entries we'll fire, then AUTO-SYNTHESIZE mock external-
    // platform agents to close any external handoff (orphan trigger), so the chain runs end-to-end
    // in the isolated sandbox. Mock slugs contain "-mock-" (excluded from the real-deliverable count).
    const graph = compileGraph(specsToActions(domain, specs), { domainId: domain });
    const plannedEntries = (opts?.testCases?.length ? opts.testCases.map((c) => c.entryEvent) : graph.entryEvents).filter(Boolean);
    const mockAgents = synthesizeMockExternalAgents(specs, { domainId: domain, firedEntries: plannedEntries, terminals: graph.terminalEvents });
    if (mockAgents.length) console.info(`[sandbox] synthesized ${mockAgents.length} mock external-platform agent(s): ${mockAgents.map((m) => m.slug).join(", ")}`);
    const allSpecs = [...specs, ...mockAgents];
    const manifest = mapToManifest(allSpecs);
    const degradedAgents = specs.filter((s) => !s.tools?.length && !s.hitl).map((s) => s.short);

    // 1) validate → 2) commit (real registration). Block on hard issues.
    const preview = await miValidate({ mode: "validate", workflow: manifest, target: "production", confirm_overwrite: true, conflict_resolutions: [] }, ctx);
    const blocking = preview.issues.filter((i) => i.severity === "error");
    if (blocking.length) {
      return { appId, functionsRegistered: 0, ran: 0, deployed: 0, reachedSuccessTerminal: false, fullChainRan: false, degradedAgents: [...degradedAgents, ...blocking.map((i) => i.message ?? "lint error")], runs: [], fingerprint: "", simulated: false };
    }
    const committed = await miCommit({ mode: "commit", workflow: manifest, target: "production", confirm_overwrite: true, deployment_id: preview.deployment_id, conflict_resolutions: [] }, ctx);
    const functionsRegistered = committed.inngest_fns_registered ?? 0;
    if (functionsRegistered === 0) {
      return { appId, functionsRegistered: 0, ran: 0, deployed: specs.length, reachedSuccessTerminal: false, fullChainRan: false, degradedAgents, runs: [], fingerprint: committed.deployment_id ?? "", simulated: false };
    }

    // #1 FIX: register the sandbox app with the Inngest dev server. miCommit rebuilds the
    // in-process handler, but the dev server never DISCOVERS the sandbox app unless we PUT its
    // serve URL — without this, fired events route to an app Inngest never saw (silent ran:0).
    // Best-effort + no-op under NODE_ENV=test; then a brief wait so the dev server introspects it.
    await syncTenantApp(ctx.tenantSlug).catch(() => {});
    // Readiness poll (replaces a blind fixed sleep): wait until the Inngest dev server has actually
    // introspected the sandbox app and registered its functions, so the events we fire next route
    // to live triggers instead of an app Inngest hasn't finished discovering (the silent ran:0).
    await this.waitForAppReady(appIdForTenant(ctx.tenantSlug), functionsRegistered);

    // 3) fire the entry event(s) — the events consumed but produced by no agent.
    //    Registered functions trigger on `${tenantSlug}/${eventName}` (register.ts:139),
    //    so the fired event name MUST be namespaced to match (the bare name silently
    //    matches nothing → ran:0). Mirror the demo-runner's envelope (subject + ids).
    const since = new Date();
    // T1 — fire each test case on a DISTINCT subject so its chain is independently attributable
    // (same-event cases used to share `sandbox-${ev}` → collided, no per-case verdict). Carry the
    // case KIND so the outcome is judged per-kind (reject reaching FAIL = pass). Namespaced
    // `${slug}/${ev}` to match the registered triggers.
    const sbSubject = (ev: string) => ev.replace(/[^A-Za-z0-9]/g, "-").slice(0, 24);
    const fireList: Array<{ ev: string; payload: Record<string, unknown>; kind?: "pass" | "reject" | "edge"; subject: string }> =
      opts?.testCases && opts.testCases.length
        ? opts.testCases.slice(0, 4).map((c, i) => ({ ev: c.entryEvent, payload: c.payload, kind: c.kind, subject: `sb-${i}-${sbSubject(c.entryEvent)}` }))
        : graph.entryEvents.slice(0, 3).map((ev, i) => ({ ev, payload: {} as Record<string, unknown>, kind: undefined, subject: `sb-${i}-${sbSubject(ev)}` }));
    // R2: capture each fire result instead of swallowing it, so a failed send is visible.
    const fires: Array<{ event: string; ok: boolean; error?: string }> = [];
    try {
      const ig = getTenantInngest(ctx.tenantSlug);
      for (const f of fireList) {
        try {
          await ig.send({ name: `${ctx.tenantSlug}/${f.ev}`, data: { ...f.payload, _sandbox: true, _factory: true, subject: f.subject } });
          fires.push({ event: f.ev, ok: true });
        } catch (e) {
          fires.push({ event: f.ev, ok: false, error: (e as Error).message?.slice(0, 140) });
        }
      }
    } catch {
      for (const f of fireList) fires.push({ event: f.ev, ok: false, error: "Inngest client unavailable" });
    }

    // #D + review fixes: boundary-aware verdict. Externally-entered agents are exempt; the gate
    // keys on DISTINCT completed agents (not raw run-row count); externally-entered tool-less agents
    // are NOT counted as degraded; external-handoff emits count as success terminals.
    const cv = chainVerdict(specs, graph, opts?.boundaryEvents, fireList.map((f) => f.ev));
    // 4) poll the runs table for this sandbox tenant (bounded; best-effort).
    const observed = await this.pollRuns(ctx.tenantId, since, cv.expectedToRun.length);
    // T1 — per-case attribution: group each fired case's runs by its DISTINCT subject + the event
    // each run emitted (runs⋈events), then judge per kind via chainVerdictByKind. A reject case
    // reaching a FAIL terminal is a PASS — it no longer drags a success-only gate to false.
    const perSubject = await this.pollRunsBySubject(ctx.tenantId, since, fireList.map((f) => f.subject));
    const kinded = fireList.filter((f) => f.kind);
    const caseVerdicts = kinded.length
      ? chainVerdictByKind(kinded.map((f) => caseOutcomeFromRuns(f.kind!, perSubject.get(f.subject) ?? [], { successTerminals: cv.successTerminals })))
      : undefined;
    const haveSubjectData = [...perSubject.values()].some((arr) => arr.length > 0);
    const ranAgent = (s: GeneratedAgentSpec) => observed.completedAgents.has(s.short || s.nameZh); // manifest name = short||nameZh
    const distinctRan = cv.expectedToRun.filter(ranAgent).length;
    const verdictDegraded = cv.expectedToRun.filter((s) => !s.tools?.length && !s.hitl).map((s) => s.short);
    const reachedSuccessTerminal = cv.successTerminals.length > 0 && observed.completedAgents.size > 0;
    // T1 — when cases carried kinds AND we attributed real per-subject runs, the per-kind verdict
    // (reject→FAIL counts as pass) drives 跑通; else fall back to the proven aggregate gate.
    const aggregateChainRan = functionsRegistered > 0 && cv.expectedToRun.every(ranAgent) && observed.failed === 0 && verdictDegraded.length === 0;
    const fullChainRan = caseVerdicts && haveSubjectData ? functionsRegistered > 0 && caseVerdicts.allPass : aggregateChainRan;
    // 5) reconstruct per-agent REAL I/O from the runs (+ agent) rows.
    const agentRuns = this.collectAgentRuns(ctx.tenantId, since, specs, ctx.tenantSlug);

    return {
      appId,
      functionsRegistered,
      ran: observed.ran,
      deployed: specs.length,
      reachedSuccessTerminal,
      fullChainRan,
      degradedAgents: verdictDegraded,
      runs: observed.rows,
      agentRuns,
      fingerprint: committed.deployment_id ?? "",
      simulated: false, // real Inngest registration + run
      fires,
      // R2: the ids we registered this commit (id = spec.slug per mapToManifest) — proof, not a count.
      registeredIds: functionsRegistered > 0 ? allSpecs.map((s) => s.slug) : [],
      internalChains: distinctRan,
      externalTerminals: cv.externalTerminals,
      caseVerdicts,
      mockExternalAgents: mockAgents.map((m) => m.slug),
    };
  }

  /** T1 — group runs by their (distinct per-case) subject + the event each emitted (runs⋈events),
   *  so deployAndObserve can compute a per-case, per-kind verdict. Best-effort; never throws. */
  private async pollRunsBySubject(tenantId: string, since: Date, subjects: string[]): Promise<Map<string, Array<{ status: string; emittedEvent: string | null }>>> {
    const out = new Map<string, Array<{ status: string; emittedEvent: string | null }>>();
    for (const s of subjects) out.set(s, []);
    if (!subjects.length) return out;
    try {
      const rows = getDb()
        .select({ subject: runs.subject, status: runs.status, emittedEvent: events.name })
        .from(runs)
        .leftJoin(events, eq(events.id, runs.emittedEventId))
        .where(and(eq(runs.tenantId, tenantId), gt(runs.startedAt, since)))
        .orderBy(desc(runs.startedAt))
        .limit(100)
        .all();
      for (const r of rows) {
        const subj = r.subject ?? "";
        if (!out.has(subj)) continue;
        out.get(subj)!.push({ status: String(r.status), emittedEvent: r.emittedEvent ?? null });
      }
    } catch {
      /* best-effort — fall back to the aggregate verdict */
    }
    return out;
  }

  /** Reconstruct per-agent real I/O from the sandbox tenant's runs (joined to the
   *  agent for its name). Payload bodies live behind step artifact refs (not resolved
   *  here); status + trigger subject + real runId are the concrete evidence. */
  private collectAgentRuns(tenantId: string, since: Date, specs: GeneratedAgentSpec[], tenantSlug: string): AgentRunIO[] {
    let rows: Array<{ runId: string; status: string; subject: string | null; agentName: string | null }> = [];
    try {
      rows = getDb()
        .select({ runId: runs.id, status: runs.status, subject: runs.subject, agentName: agents.name })
        .from(runs)
        .leftJoin(agents, eq(agents.id, runs.agentId))
        .where(and(eq(runs.tenantId, tenantId), gt(runs.startedAt, since)))
        .orderBy(desc(runs.startedAt))
        .limit(50)
        .all();
    } catch {
      return [];
    }
    // P4: link to OUR run-record page, NOT the Inngest dashboard. Inngest's /run?runID expects a
    // ULID and chokes on our `run-<hex>` ids ("ulid: bad data size"). The portal run page is
    // tenant-scoped via the URL slug (tenant-header.ts derives x-agentic-tenant), so the sandbox
    // (`<domain>-sb`) run resolves correctly.
    return rows.map((r) => {
      const spec = specs.find((s) => s.short === r.agentName || s.slug === r.agentName);
      return {
        agentSlug: spec?.slug ?? r.agentName ?? r.runId,
        agentShort: spec?.nameZh ?? r.agentName ?? "agent",
        status: r.status,
        degraded: false,
        triggerEvent: r.subject,
        inputPayload: null,
        tools: spec?.tools ?? [],
        outputEvent: spec?.emit?.[0] ?? null,
        reasoning: "",
        outputPayload: null,
        runId: r.runId,
        url: `/portal/${encodeURIComponent(tenantSlug)}/runs/${encodeURIComponent(r.runId)}`,
      };
    });
  }

  /** Poll the Inngest dev server until the sandbox app is registered with its functions (or a
   *  deadline). Returns once functionCount >= expected (best-effort; never throws). Honest: if the
   *  app never appears we still proceed to fire — the run poll then reports the real ran:0. */
  private async waitForAppReady(appId: string, expected: number, maxMs = 8_000): Promise<boolean> {
    const deadline = Date.now() + Math.max(1500, Number(process.env.FACTORY_SANDBOX_READY_MS) || maxMs);
    while (Date.now() < deadline) {
      try {
        const p = await probeApp(appId);
        if (p.healthy && (p.functionCount ?? 0) >= Math.max(1, expected)) return true;
      } catch {
        /* keep polling */
      }
      await new Promise((r) => setTimeout(r, 600));
    }
    return false;
  }

  private async pollRuns(tenantId: string, since: Date, expected: number, maxMs = 12_000): Promise<{ ran: number; failed: number; rows: Array<{ id: string; status: string }>; completedAgents: Set<string> }> {
    const deadline = Date.now() + maxMs;
    let rows: Array<{ id: string; status: string; agentName: string | null }> = [];
    while (Date.now() < deadline) {
      try {
        // Join the agent so we can count DISTINCT completed agents (not raw run rows) — multiple
        // fired test cases / fan-out produce several rows per agent, which would inflate the verdict.
        const r = getDb().select({ id: runs.id, status: runs.status, agentName: agents.name }).from(runs).leftJoin(agents, eq(agents.id, runs.agentId)).where(and(eq(runs.tenantId, tenantId), gt(runs.startedAt, since))).orderBy(desc(runs.startedAt)).limit(50).all();
        rows = r.map((x) => ({ id: x.id, status: String(x.status), agentName: x.agentName ?? null }));
        // The runtime marks a finished run `ok` (register.ts), the DryRun sim uses "Completed".
        const settled = rows.filter((x) => RUN_DONE.test(x.status) || RUN_FAILED.test(x.status)).length;
        if (rows.length >= expected && settled >= rows.length) break;
      } catch {
        break;
      }
      await new Promise((res) => setTimeout(res, 1500));
    }
    const failed = rows.filter((x) => RUN_FAILED.test(x.status)).length;
    // TRUE completed count — `ok`/`Completed` (NOT a `|| rows.length` fallback that reads stuck rows as success).
    const ran = rows.filter((x) => RUN_DONE.test(x.status)).length;
    const completedAgents = new Set(rows.filter((x) => RUN_DONE.test(x.status) && x.agentName).map((x) => x.agentName as string));
    return { ran, failed, rows: rows.map((x) => ({ id: x.id, status: x.status })), completedAgents };
  }

  async teardown(domain: string): Promise<void> {
    try {
      const ctx = this.ensureTenant(domain);
      await miCommit({ mode: "commit", workflow: [], target: "production", confirm_overwrite: true, conflict_resolutions: [] }, ctx).catch(() => {});
      // #1: keep the dev server's view in sync after reverting to 0 functions.
      await syncTenantApp(ctx.tenantSlug).catch(() => {});
    } catch {
      /* best-effort revert to 0 functions */
    }
  }
}

// ── Probing wrapper (the DEFAULT) ───────────────────────────────────────────────
/** Picks the REAL deployer when the Inngest stack is reachable, else falls back to the
 *  honest DryRun simulation. So out-of-the-box the factory really deploys+runs when
 *  `pnpm dev` is up, and only SIMULATES (clearly badged via result.simulated, so a green
 *  is never mistaken for a real run) when the stack isn't reachable. The choice is made
 *  per deploy and remembered so the matching teardown hits the same deployer. */
export class ProbingSandboxDeployer implements SandboxDeployer {
  private real = new ManifestSandboxDeployer();
  private dry = new DryRunSandboxDeployer();
  private chosen: SandboxDeployer | null = null;
  async deployAndObserve(domain: string, specs: GeneratedAgentSpec[], opts?: { dryRun?: boolean; testCases?: Array<{ entryEvent: string; payload: Record<string, unknown> }>; boundaryEvents?: Boundary }): Promise<SandboxDeployResult> {
    this.chosen = (await inngestReachable()) ? this.real : this.dry;
    return this.chosen.deployAndObserve(domain, specs, opts);
  }
  async teardown(domain: string): Promise<void> {
    return (this.chosen ?? this.dry).teardown(domain);
  }
}

/** Quick liveness probe of the Inngest dev server — so we only attempt a real deploy when
 *  it can actually be observed. Short timeout; any reachable HTTP response counts. */
async function inngestReachable(): Promise<boolean> {
  const base = (process.env.INNGEST_BASE_URL ?? "http://localhost:8488").replace(/\/+$/, "");
  const ctrl = new AbortController();
  // R2: configurable so a slow CI/host doesn't false-negative into the DryRun simulation.
  const timeoutMs = Number(process.env.INNGEST_PROBE_TIMEOUT_MS) || 1200;
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}/health`, { signal: ctrl.signal });
    return res.ok;
  } catch {
    try {
      const r = await fetch(base, { signal: ctrl.signal });
      return r.status > 0;
    } catch {
      return false;
    }
  } finally {
    clearTimeout(timer);
  }
}
