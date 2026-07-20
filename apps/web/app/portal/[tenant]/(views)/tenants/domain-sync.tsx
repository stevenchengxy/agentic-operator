"use client";

/**
 * Shows the persisted relation for the runtime tenant currently being viewed.
 *
 * Runtime tenants and ontology domains are intentionally different identities:
 * this panel never joins them by slug, display name, aliases, or catalog order.
 * The only "connected" state comes from factory_domain_bindings via the API.
 */

import { Icon, Panel } from "@/app/portal/components";
import { domainLabel } from "@/lib/domain-display";
import { useAgentFactoryDomains } from "@/lib/hooks/useAgentFactoryDomains";

const SOURCE_LABEL = {
  explicit: "人工连接",
  auto: "迁移确认",
  upload: "上传本体",
} as const;

export function DomainSyncPanel({ activeTenant }: { activeTenant: string }) {
  const query = useAgentFactoryDomains(activeTenant);
  const binding = query.data?.binding ?? null;
  const boundDomain = query.data?.boundDomain ?? null;
  const factoryHref = `/portal/${encodeURIComponent(activeTenant)}/factory`;

  if (query.isLoading) return null;

  return (
    <Panel title="运行领域 ↔ 本体连接">
      <div
        style={{
          padding: 12,
          display: "flex",
          alignItems: "center",
          gap: 12,
          flexWrap: "wrap",
          fontSize: 12,
        }}
      >
        <Identity label="运行领域（租户）" value={activeTenant} />
        <Icon name="chevron-right" size={13} />

        {query.isError ? (
          <span style={{ color: "var(--red)" }}>无法读取本体连接：{(query.error as Error).message}</span>
        ) : binding && boundDomain ? (
          <>
            <Identity
              label="已连接本体"
              value={domainLabel(boundDomain)}
              detail={`${boundDomain.id} · ${SOURCE_LABEL[binding.source]}`}
            />
            <a href={factoryHref} style={linkStyle}>查看或更换连接</a>
          </>
        ) : binding ? (
          <>
            <Identity
              label="连接不可用"
              value={binding.ontologyDomainName || binding.ontologyDomainId}
              detail={binding.ontologyDomainId}
              tone="red"
            />
            <span style={{ color: "var(--red)" }}>目录中已找不到该本体，工厂已停止执行。</span>
            <a href={factoryHref} style={linkStyle}>重新连接</a>
          </>
        ) : (
          <>
            <span style={{ color: "var(--amber)" }}>尚未连接本体；该租户仍然有效，但 Agent 工厂不会猜测一个本体。</span>
            <a href={factoryHref} style={linkStyle}>去 Agent 工厂连接</a>
          </>
        )}
      </div>
    </Panel>
  );
}

function Identity({
  label,
  value,
  detail,
  tone = "default",
}: {
  label: string;
  value: string;
  detail?: string;
  tone?: "default" | "red";
}) {
  return (
    <span style={{ display: "inline-flex", flexDirection: "column", gap: 2 }}>
      <span style={{ color: "var(--text-3)", fontSize: 10.5 }}>{label}</span>
      <span style={{ color: tone === "red" ? "var(--red)" : "var(--text)", fontWeight: 600 }}>{value}</span>
      {detail && <span style={{ color: "var(--text-3)", fontFamily: "var(--mono)", fontSize: 10 }}>{detail}</span>}
    </span>
  );
}

const linkStyle: React.CSSProperties = {
  marginLeft: "auto",
  display: "inline-flex",
  alignItems: "center",
  padding: "5px 10px",
  border: "1px solid var(--border-2)",
  borderRadius: 6,
  color: "var(--signal)",
  textDecoration: "none",
  whiteSpace: "nowrap",
};
