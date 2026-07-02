"use client";

/**
 * 业务领域 ↔ 知识域 同步面板。
 *
 * 「业务领域」页历史上只列租户（运行面，/v1/tenants）；工厂的「业务域」列的是本体源
 * （知识面，/v1/agent-factory/domains：uploaded > 本地 models/ > Allmeta live）。两者
 * 语义不同（知识域 ⊇ 运行租户），"同步"的正确形态是把对应关系摆出来并给打通动作：
 *   · 已打通 —— 域 id ≈ 租户 slug（lower 匹配）：知识 + 运行两面齐
 *   · 仅知识域 —— 工厂可生成，还没有承载运行的租户 → 「去工厂生成」
 *   · 仅租户 —— 有运行面但当前读不到本体（Allmeta 掉线 / 未配置）→ 标注原因
 */

import { useEffect, useState } from "react";
import { Icon, Panel } from "@/app/portal/components";
import { tenantHeader } from "@/lib/hooks/tenant-header";
import { useTenants } from "@/lib/hooks/useTenants";

interface DomainRow {
  id: string;
  name?: string;
  source?: string;
  counts?: { actions?: number; events?: number; rules?: number; objects?: number };
}

export function DomainSyncPanel({ activeTenant }: { activeTenant: string }) {
  const tenantsQuery = useTenants();
  const [domains, setDomains] = useState<DomainRow[] | null>(null);
  useEffect(() => {
    let alive = true;
    void fetch("/v1/agent-factory/domains", { credentials: "same-origin", headers: { Accept: "application/json", ...tenantHeader() } })
      .then((r) => r.json())
      .then((b) => { if (alive) setDomains(b?.ok ? (b.data.domains as DomainRow[]) : []); })
      .catch(() => { if (alive) setDomains([]); });
    return () => { alive = false; };
  }, []);

  const tenants = (tenantsQuery.data?.items ?? []).filter((t) => t.archivedAt == null && !t.slug.endsWith("-sb") && t.slug !== "__system");
  if (domains === null || tenantsQuery.isLoading) return null;

  const tBydSlug = new Map(tenants.map((t) => [t.slug.toLowerCase(), t]));
  const dById = new Map((domains ?? []).map((d) => [d.id.toLowerCase(), d]));
  const linked = (domains ?? []).filter((d) => tBydSlug.has(d.id.toLowerCase()));
  const knowledgeOnly = (domains ?? []).filter((d) => !tBydSlug.has(d.id.toLowerCase()));
  // 仅租户：只列有 agents 的（空租户对"领域同步"无意义——多为测试残留），其余计数折叠。
  const tenantOnlyAll = tenants.filter((t) => !dById.has(t.slug.toLowerCase()));
  const tenantOnly = tenantOnlyAll.filter((t) => (t.agentCount ?? 0) > 0);
  const emptyTenantOnly = tenantOnlyAll.length - tenantOnly.length;
  if (!knowledgeOnly.length && !tenantOnly.length) return null; // 全部打通 → 不打扰

  const cnt = (d: DomainRow) => (d.counts ? `${d.counts.actions ?? 0} 动作 · ${d.counts.events ?? 0} 事件` : "");
  const chip: React.CSSProperties = { display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11.5, padding: "4px 10px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--panel-2)", color: "var(--text-2)" };

  return (
    <Panel title={`知识域 ↔ 运行租户（已打通 ${linked.length}）`}>
      <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 10 }}>
        {knowledgeOnly.length > 0 && (
          <div>
            <div style={{ fontSize: 10.5, color: "var(--text-3)", fontFamily: "var(--mono)", marginBottom: 6 }}>仅知识域（工厂可生成，尚无运行租户）</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {knowledgeOnly.map((d) => (
                <a key={d.id} href={`/portal/${activeTenant}/factory?domain=${encodeURIComponent(d.id)}`} title={`在工厂中用「${d.name ?? d.id}」生成 functions`} style={{ ...chip, textDecoration: "none" }}>
                  📦 {d.name ?? d.id}
                  {cnt(d) && <span style={{ color: "var(--text-3)", fontSize: 10 }}>{cnt(d)}</span>}
                  <span style={{ color: "var(--signal)", display: "inline-flex", alignItems: "center", gap: 2 }}>去工厂生成 <Icon name="chevron-right" size={11} /></span>
                </a>
              ))}
            </div>
          </div>
        )}
        {tenantOnly.length > 0 && (
          <div>
            <div style={{ fontSize: 10.5, color: "var(--text-3)", fontFamily: "var(--mono)", marginBottom: 6 }}>仅运行租户（当前读不到本体：Allmeta 掉线或未配置本体源）</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {tenantOnly.map((t) => (
                <span key={t.slug} style={chip} title="工厂的业务域列表暂时看不到它的本体——检查 Allmeta 或在工厂上传本地本体">
                  ⚠ {t.name || t.slug}
                  <span style={{ color: "var(--text-3)", fontSize: 10 }}>{t.agentCount ?? 0} agents</span>
                </span>
              ))}
            </div>
            {emptyTenantOnly > 0 && <div style={{ fontSize: 10, color: "var(--text-4)", marginTop: 6 }}>另有 {emptyTenantOnly} 个无 agent 的租户未列出</div>}
          </div>
        )}
      </div>
    </Panel>
  );
}
