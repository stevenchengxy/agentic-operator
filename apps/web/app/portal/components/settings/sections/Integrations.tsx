"use client";

import { Button, Icon, Panel } from "@/app/portal/components";
import { StatusPill } from "@/app/portal/components/settings/atoms";
import { SETTINGS_INTEGRATIONS } from "@/app/portal/components/settings/data";
import { useI18n } from "@/app/portal/lib/preferences-context";

export function IntegrationsSection() {
  const { t } = useI18n();
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <Panel
        title={t("integrations.title", { n: SETTINGS_INTEGRATIONS.length })}
        subtitle={t("integrations.subtitle")}
        padded={false}
        action={
          <Button small icon="plus" tone="primary">
            {t("integrations.newIntegration")}
          </Button>
        }
      >
        {SETTINGS_INTEGRATIONS.map((i, idx) => (
          <div
            key={i.id}
            style={{
              display: "grid",
              gridTemplateColumns: "32px 1fr 200px 140px 80px",
              alignItems: "center",
              gap: 14,
              padding: "12px 14px",
              borderBottom:
                idx < SETTINGS_INTEGRATIONS.length - 1 ? "1px solid var(--border)" : "none",
            }}
          >
            <div
              style={{
                width: 28,
                height: 28,
                borderRadius: 4,
                background: "var(--panel-2)",
                border: "1px solid var(--border-2)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Icon name="external" size={12} style={{ color: "var(--text-3)" }} />
            </div>
            <div>
              <div style={{ fontSize: 13, color: "var(--text)" }}>{i.name}</div>
              <div style={{ fontSize: 11, color: "var(--text-3)" }}>{i.kind}</div>
            </div>
            <div style={{ fontSize: 11.5, color: "var(--text-2)" }}>{i.detail}</div>
            <div style={{ fontSize: 11, color: "var(--text-3)", fontFamily: "var(--mono)" }}>
              {i.monthly}
            </div>
            <div>
              <StatusPill status={i.status} />
            </div>
          </div>
        ))}
      </Panel>
    </div>
  );
}
