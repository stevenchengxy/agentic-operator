"use client";

/**
 * Domain ↔ 知识域同步面板。
 *
 * 「业务领域」页历史上只列运行面（/v1/tenants）；工厂的「业务域」列的是本体源
 * （知识面，/v1/agent-factory/domains：uploaded > 本地 models/ > Allmeta live）。两者
 * 语义不同（知识域 ⊇ 运行 Domain），"同步"的正确形态是把对应关系摆出来并给打通动作：
 *   · 已连接 —— 域 id ≈ 运行 slug（RAAS-v1 -> raas）：知识 + 运行两面齐
 *   · 仅知识域 —— 工厂可生成，还没有承载运行的 Domain → 「去工厂生成」
 *   · 仅运行 Domain —— 有运行面但当前读不到本体（Allmeta 掉线 / 未配置）→ 标注原因
 */

import { Icon, Panel } from "@/app/portal/components";
import {
  buildRuntimeDomainNameMap,
  domainLabel,
  isInternalRuntimeDomain,
  runtimeDomainSlug,
  type AgentFactoryDomain,
} from "@/lib/domain-display";
import { useAgentFactoryDomains } from "@/lib/hooks/useAgentFactoryDomains";
import { useTenants } from "@/lib/hooks/useTenants";

export function DomainSyncPanel({ activeTenant }: { activeTenant: string }) {
  const tenantsQuery = useTenants();
  const domainsQuery = useAgentFactoryDomains();

  const rawDomains = domainsQuery.data?.domains ?? [];
  const domainNames = buildRuntimeDomainNameMap(rawDomains);
  const domainBySlug = new Map<string, AgentFactoryDomain>();
  for (const d of rawDomains) {
    const slug = runtimeDomainSlug(d.id);
    const current = domainBySlug.get(slug);
    if (!current || (!current.counts && d.counts)) domainBySlug.set(slug, d);
  }
  const domains = Array.from(domainBySlug.entries()).map(([slug, d]) => ({
    ...d,
    name: domainNames.get(slug) ?? domainLabel(d),
  }));

  const tenants = (tenantsQuery.data?.items ?? []).filter(
    (t) => t.archivedAt == null && !isInternalRuntimeDomain(t.slug),
  );
  if (domainsQuery.isLoading || tenantsQuery.isLoading) return null;

  const tBySlug = new Map(tenants.map((t) => [t.slug.toLowerCase(), t]));
  const dBySlug = new Map(domains.map((d) => [runtimeDomainSlug(d.id), d]));
  const linked = domains.filter((d) => tBySlug.has(runtimeDomainSlug(d.id)));
  const knowledgeOnly = domains.filter((d) => !tBySlug.has(runtimeDomainSlug(d.id)));
  // 仅运行 Domain：只列有 agents 或知识域来源的（空测试残留对领域同步无意义），其余计数折叠。
  const tenantOnlyAll = tenants.filter((t) => !dBySlug.has(t.slug.toLowerCase()));
  const tenantOnly = tenantOnlyAll.filter((t) => (t.agentCount ?? 0) > 0);
  const emptyTenantOnly = tenantOnlyAll.length - tenantOnly.length;
  if (!knowledgeOnly.length && !tenantOnly.length) return null; // 全部打通 → 不打扰

  const cnt = (d: AgentFactoryDomain) => (d.counts ? `${d.counts.actions ?? 0} 动作 · ${d.counts.events ?? 0} 事件` : "");
  const chip: React.CSSProperties = { display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11.5, padding: "4px 10px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--panel-2)", color: "var(--text-2)" };

  return (
    <Panel title={`知识域 ↔ 运行 Domain（已连接 ${linked.length}）`}>
      <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 10 }}>
        {knowledgeOnly.length > 0 && (
          <div>
            <div style={{ fontSize: 10.5, color: "var(--text-3)", fontFamily: "var(--mono)", marginBottom: 6 }}>仅知识域（工厂可生成，尚无运行 Domain）</div>
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
            <div style={{ fontSize: 10.5, color: "var(--text-3)", fontFamily: "var(--mono)", marginBottom: 6 }}>仅运行 Domain（当前读不到本体：Allmeta 掉线或未配置本体源）</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {tenantOnly.map((t) => (
                <span key={t.slug} style={chip} title="工厂的业务域列表暂时看不到它的本体——检查 Allmeta 或在工厂上传本地本体">
                  ⚠ {t.name || t.slug}
                  <span style={{ color: "var(--text-3)", fontSize: 10 }}>{t.agentCount ?? 0} agents</span>
                </span>
              ))}
            </div>
            {emptyTenantOnly > 0 && <div style={{ fontSize: 10, color: "var(--text-4)", marginTop: 6 }}>另有 {emptyTenantOnly} 个无 agent 的 Domain 未列出</div>}
          </div>
        )}
      </div>
    </Panel>
  );
}
