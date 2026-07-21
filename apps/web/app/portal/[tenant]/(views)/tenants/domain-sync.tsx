"use client";

/**
 * Shows the persisted relation for the runtime tenant currently being viewed.
 *
 * Runtime tenants and ontology domains are intentionally different identities:
 * this panel never joins them by slug, display name, aliases, or catalog order.
 * The only "connected" state comes from factory_domain_bindings via the API.
 */

import { Icon, Panel } from "@/app/portal/components";
import { useI18n } from "@/app/portal/lib/preferences-context";
import { domainLabel } from "@/lib/domain-display";
import { useAgentFactoryDomains } from "@/lib/hooks/useAgentFactoryDomains";

export function DomainSyncPanel({ activeTenant }: { activeTenant: string }) {
  const { t } = useI18n();
  const query = useAgentFactoryDomains(activeTenant);
  const binding = query.data?.binding ?? null;
  const boundDomain = query.data?.boundDomain ?? null;
  const factoryHref = `/portal/${encodeURIComponent(activeTenant)}/factory`;

  if (query.isLoading) return null;

  return (
    <Panel title={t("tenants.domainSync.panelTitle")}>
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
        <Identity
          label={t("tenants.domainSync.runtimeDomainLabel")}
          value={activeTenant}
        />
        <Icon name="chevron-right" size={13} />

        {query.isError ? (
          <span style={{ color: "var(--red)" }}>
            {t("tenants.domainSync.readError", {
              message: (query.error as Error).message,
            })}
          </span>
        ) : binding && boundDomain ? (
          <>
            <Identity
              label={t("tenants.domainSync.connectedLabel")}
              value={domainLabel(boundDomain)}
              detail={`${boundDomain.id} · ${t(`tenants.domainSync.source.${binding.source}`)}`}
            />
            <a href={factoryHref} style={linkStyle}>
              {t("tenants.domainSync.viewOrChange")}
            </a>
          </>
        ) : binding ? (
          <>
            <Identity
              label={t("tenants.domainSync.unavailableLabel")}
              value={binding.ontologyDomainName || binding.ontologyDomainId}
              detail={binding.ontologyDomainId}
              tone="red"
            />
            <span style={{ color: "var(--red)" }}>
              {t("tenants.domainSync.missingOntology")}
            </span>
            <a href={factoryHref} style={linkStyle}>
              {t("tenants.domainSync.reconnect")}
            </a>
          </>
        ) : (
          <>
            <span style={{ color: "var(--amber)" }}>
              {t("tenants.domainSync.notConnected")}
            </span>
            <a href={factoryHref} style={linkStyle}>
              {t("tenants.domainSync.goToFactory")}
            </a>
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
