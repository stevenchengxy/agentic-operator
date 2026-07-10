// Composition root for the Agent Factory ports — wires the brain (@agentic/agent-factory)
// to the new arch's concrete infrastructure (models/ ontology, dry-run sandbox,
// Drizzle stores). The SSE route constructs these and hands them to runBrain.

import type { FactoryPorts, OntologySource, SandboxDeployer } from "@agentic/agent-factory";
import { ManifestOntologySource } from "./ontology-source";
import { AllmetaOntologySource } from "./allmeta-ontology-source";
import { CompositeOntologySource } from "./composite-ontology-source";
import { DryRunSandboxDeployer, ManifestSandboxDeployer, ProbingSandboxDeployer } from "./sandbox-deployer";
import { DrizzleConversationStore, DrizzleReflectionWriter, DrizzleSkillStore, DrizzleToolStore, DrizzleAcceptanceRecorder, DrizzleToolStatsStore } from "./stores";
import { FsAgentDraftStore } from "./agent-draft-store";
import { FsPolicyStatsStore } from "./policy-stats-store";
import { UploadedOntologySource, UploadedFirstOntologySource } from "./uploaded-ontology-source";
import { listGlobalTools } from "@agentic/tools";

/** Deploy mode:
 *   FACTORY_REAL_DEPLOY=1 → always REAL (ManifestSandboxDeployer).
 *   FACTORY_REAL_DEPLOY=0 → always SIMULATE (DryRunSandboxDeployer).
 *   unset (DEFAULT)       → PROBE: real when the Inngest stack (pnpm dev) is reachable,
 *                            else the honest dry-run simulation (badged via result.simulated).
 *  So a finished run reflects a REAL deploy whenever the stack is up — no longer silently
 *  simulating by default — while still running standalone (simulated, clearly marked). */
function makeSandboxDeployer(): SandboxDeployer {
  const flag = process.env.FACTORY_REAL_DEPLOY;
  if (flag === "1") return new ManifestSandboxDeployer();
  if (flag === "0") return new DryRunSandboxDeployer();
  return new ProbingSandboxDeployer();
}

/** Local manifest domains + (when ALLMETA_BASE_URL is set) live AllmetaOntology
 *  domains. Without Allmeta configured this is exactly the old ManifestOntologySource,
 *  so nothing changes for repos that don't wire Allmeta. */
function makeOntologySource(tenantSlug?: string): OntologySource {
  const manifest = new ManifestOntologySource();
  const allmeta = new AllmetaOntologySource();
  const base = allmeta.configured ? new CompositeOntologySource(allmeta, manifest) : manifest;
  // UPLOADED ontology bundles (tenant-scoped) take priority — an uploaded domain, or an uploaded
  // override of an existing id, wins for THAT tenant; every other domain falls through to
  // manifest/Allmeta unchanged. Without a tenant the uploaded layer is empty (no cross-tenant leak).
  return new UploadedFirstOntologySource(new UploadedOntologySource(tenantSlug), base);
}

/** `tenantSlug` scopes the uploaded-ontology layer to the caller's tenant — pass it from the route
 *  (req.auth.tenantSlug) / the run (its tenant) so uploads stay tenant-private. */
export function makeFactoryPorts(tenantSlug?: string): FactoryPorts {
  return {
    ontology: makeOntologySource(tenantSlug),
    sandbox: makeSandboxDeployer(),
    conversation: new DrizzleConversationStore(),
    reflection: new DrizzleReflectionWriter(),
    skills: new DrizzleSkillStore(),
    tools: new DrizzleToolStore(),
    // #C: the REAL global tool registry → the brain can recommend real tools (parseResumeApi,
    // fs.*) by semantic rank + know what config to supply, even when the ontology declared none.
    toolRegistry: {
      // #SCALE-TOOLS — enrich each real tool with its empirical sandbox success rate so ranking can
      // demote tools that keep failing in practice (not just match semantically).
      list: async () => {
        const stats = await new DrizzleToolStatsStore().successRates();
        return listGlobalTools().map((t) => {
          const st = stats[t.name];
          return {
            name: t.name,
            summary: t.summary,
            aliases: t.aliases,
            category: t.category,
            configKeys: t.configSchema ? Object.keys(t.configSchema) : [],
            invoked: st?.invoked,
            successRate: st && st.invoked > 0 ? st.succeeded / st.invoked : undefined,
          };
        });
      },
    },
    // Persist a finished run's agents as durable, reviewable drafts (OLD syncDomainDrafts).
    drafts: new FsAgentDraftStore(),
    // #POLICY-LEARN — 前置路由 arm 统计（选路证据偏置 ← run 结果回喂）。
    policyStats: new FsPolicyStatsStore(),
    // #P1-6 — persist per-criterion acceptance verdicts for trend dashboards.
    acceptance: new DrizzleAcceptanceRecorder(),
    // #SCALE-TOOLS — per-tool sandbox effectiveness recording.
    toolStats: new DrizzleToolStatsStore(),
    // 领域分析报告管线（brain 的 generate_report 工具 → report-jobs → reportGenerator agent →
    // artifacts）。动态 import：report-jobs 反向 import 本模块的 makeFactoryPorts，静态互引会循环。
    report: tenantSlug
      ? {
          start: async (o) => {
            const [{ startOntologyReportJob }, { getDb, tenants, eq }] = await Promise.all([import("./report-jobs"), import("@agentic/db")]);
            const row = getDb().select().from(tenants).where(eq(tenants.slug, tenantSlug)).all()[0];
            if (!row) throw new Error(`租户「${tenantSlug}」不存在`);
            const job = startOntologyReportJob({ tenantId: row.id, tenantSlug, domain: o.domain, format: o.format, focus: o.focus });
            return { id: job.id };
          },
          status: async (id) => {
            const { getReportJob } = await import("./report-jobs");
            const j = getReportJob(id);
            return j ? { status: j.status, phase: j.phase, error: j.error, note: j.note, title: j.title, artifacts: j.artifacts } : null;
          },
        }
      : undefined,
    // G1 能力解析门的「复用面」——舰队目录：本租户已交付的 functions（agents 表 ⋈ workflows），
    // trigger/emit 取自各自最新 agent_version 的 manifest。capability_resolve 据此判「复用/组合/新造」。
    // G2 回流飞轮（系统 B → 系统 A）：附带近 14 天生产战绩（prodRuns/prodFailRate），并对
    // 反复翻车的 agent 落一条当日反思（幂等，靠 [生产回流:slug:日期] 标记去重）——大脑下次
    // 开局会读到「XX 在生产上连续失败」这条教训。全程 best-effort，绝不阻塞解析。
    fleet: tenantSlug
      ? {
          list: async () => {
            const { getDb, tenants, workflows, agents, agentVersions, runs, eq } = await import("@agentic/db");
            const { and, gte, inArray } = await import("drizzle-orm");
            const db = getDb();
            const t = db.select().from(tenants).where(eq(tenants.slug, tenantSlug)).all()[0];
            if (!t) return [];
            const asArr = (v: unknown): string[] => (Array.isArray(v) ? v.map(String).filter(Boolean) : typeof v === "string" && v ? [v] : []);
            const rows: Array<{ agentDbId: string; kebabId: string; name: string; title?: string; enabled: boolean; trigger: string[]; emit: string[] }> = [];
            for (const wf of db.select().from(workflows).where(eq(workflows.tenantId, t.id)).all()) {
              for (const a of db.select().from(agents).where(eq(agents.workflowId, wf.id)).all()) {
                const av = db.select().from(agentVersions).where(eq(agentVersions.agentId, a.id)).all().pop();
                const m = (av?.manifestJson ?? {}) as Record<string, unknown>;
                rows.push({ agentDbId: a.id, kebabId: a.kebabId, name: a.name, title: a.title ?? undefined, enabled: a.enabled !== false, trigger: asArr(m.trigger), emit: asArr(m.triggered_event ?? m.emit) });
              }
            }
            // 近 14 天生产战绩聚合（一次查询，JS 归并）。
            const stats = new Map<string, { total: number; failed: number }>();
            try {
              const since = new Date(Date.now() - 14 * 24 * 3600 * 1000);
              const ids = rows.map((r) => r.agentDbId);
              if (ids.length) {
                for (const r of db
                  .select({ agentId: runs.agentId, status: runs.status })
                  .from(runs)
                  .where(and(eq(runs.tenantId, t.id), gte(runs.startedAt, since), inArray(runs.agentId, ids)))
                  .all()) {
                  const s = stats.get(r.agentId) ?? { total: 0, failed: 0 };
                  s.total++;
                  const st = String(r.status); // schema 联合类型窄于实际写入面（failed/error 由引擎写入）
                  if (st === "failed" || st === "error") s.failed++;
                  stats.set(r.agentId, s);
                }
              }
            } catch {
              /* 战绩缺席不阻塞舰队目录 */
            }
            // 反复翻车 → 当日一条反思回流（domain 由 drafts 目录反查 slug 归属；找不到就跳过）。
            void (async () => {
              try {
                const bad = rows.filter((r) => {
                  const s = stats.get(r.agentDbId);
                  return s && s.total >= 3 && s.failed / s.total >= 0.5;
                });
                if (!bad.length) return;
                const { readdirSync, existsSync } = await import("node:fs");
                const path = await import("node:path");
                const dataRoot = process.env.AGENTIC_DATA_ROOT?.trim() || "./data";
                const draftsRoot = path.resolve(process.cwd(), dataRoot, "factory-drafts");
                const domains = existsSync(draftsRoot) ? readdirSync(draftsRoot) : [];
                const today = new Date().toISOString().slice(0, 10);
                const writer = new DrizzleReflectionWriter();
                for (const b of bad) {
                  const domain = domains.find((d) => existsSync(path.join(draftsRoot, d, `${b.kebabId}.json`)));
                  if (!domain) continue;
                  const marker = `[生产回流:${b.kebabId}:${today}]`;
                  const existing = await writer.list(domain).catch(() => []);
                  if (existing.some((r) => String((r as { lesson?: string }).lesson ?? "").includes(marker))) continue;
                  const s = stats.get(b.agentDbId)!;
                  await writer.record(domain, {
                    summary: `生产运行回流：「${b.name}」近 14 天 ${s.total} 次运行失败 ${s.failed} 次`,
                    lesson: `${marker} 已上线的「${b.name}」(${b.kebabId}) 生产失败率 ${Math.round((s.failed / s.total) * 100)}%（${s.failed}/${s.total}）。复用它前先查失败原因（运行记录/日志）；重生成该动作时优先修根因而不是换提示词。`,
                    failedStep: `production:${b.kebabId}`,
                    kind: "caveat",
                  }).catch(() => {});
                }
              } catch {
                /* 回流是增益，不是义务 */
              }
            })();
            return rows.map(({ agentDbId, ...r }) => {
              const s = stats.get(agentDbId);
              return { ...r, ...(s && s.total > 0 ? { prodRuns: s.total, prodFailRate: +(s.failed / s.total).toFixed(2) } : {}) };
            });
          },
        }
      : undefined,
    // web search intentionally omitted (no provider configured) → web_search no-ops honestly
  };
}

/** List the durable agent drafts a domain's finished runs produced (for the API + UI). */
export function listAgentDrafts(domain: string) {
  return new FsAgentDraftStore().list(domain);
}

export { ManifestOntologySource, AllmetaOntologySource, CompositeOntologySource, DryRunSandboxDeployer, ManifestSandboxDeployer, ProbingSandboxDeployer, DrizzleConversationStore, DrizzleReflectionWriter, DrizzleSkillStore, DrizzleToolStore };
export { recordRunStart, recordRunFinish, recordRunTranscript, listRuns, getRun, deleteRun, restoreRun, deleteRunsByDomain, markRunAborted, listRunningRuns, type RunRecord } from "./stores";
