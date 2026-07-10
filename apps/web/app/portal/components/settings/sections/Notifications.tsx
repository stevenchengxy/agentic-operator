"use client";

import { Button, Icon, Panel } from "@/app/portal/components";
import { Field, SelectIn, TextIn, Toggle } from "@/app/portal/components/settings/atoms";
import { useI18n } from "@/app/portal/lib/preferences-context";

export function NotificationsSection() {
  const { t } = useI18n();
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <Panel
        title={t("notifications.routesTitle")}
        subtitle={t("notifications.routesSubtitle")}
        padded
      >
        <Field
          label={t("notifications.defaultRoute")}
          hint={t("notifications.defaultRouteHint")}
        >
          <SelectIn
            value="wechat:#ops-alerts"
            options={[
              "wechat:#ops-alerts",
              "wechat:#deploys",
              "email:operations@agentic.local",
              "pagerduty:raas-on-call",
              t("notifications.silentOff"),
            ]}
          />
        </Field>
        <Field
          label={t("notifications.pageOnFailure")}
          hint={t("notifications.pageOnFailureHint")}
        >
          <Toggle value onChange={() => {}} />
        </Field>
        <Field
          label={t("notifications.quietHours")}
          hint={t("notifications.quietHoursHint")}
        >
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <TextIn value="22:00" mono />
            <span style={{ color: "var(--text-3)" }}>—</span>
            <TextIn value="07:30" mono />
          </div>
        </Field>
      </Panel>

      <Panel title={t("notifications.eventChannelMapping")} padded={false}>
        {[
          { ev: "TASK_CREATED", ch: "wechat:#human-tasks" },
          { ev: "JD_PUBLISHED", ch: "wechat:#hiring" },
          { ev: "MATCH_FAILED", ch: "email:ops@agentic.local" },
          { ev: "DEPLOY_LIVE", ch: "wechat:#deploys" },
          { ev: "RUN_FAILED", ch: "pagerduty:raas-on-call" },
        ].map((r, i, arr) => (
          <div
            key={r.ev}
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr 80px",
              gap: 12,
              padding: "10px 14px",
              alignItems: "center",
              borderBottom: i < arr.length - 1 ? "1px solid var(--border)" : "none",
            }}
          >
            <span className="mono" style={{ fontSize: 12, color: "var(--text)" }}>{r.ev}</span>
            <span className="mono" style={{ fontSize: 11.5, color: "var(--text-2)" }}>
              {r.ch}
            </span>
            <Button small tone="ghost">
              <Icon name="x" size={10} /> {t("notifications.remove")}
            </Button>
          </div>
        ))}
        <div style={{ padding: "10px 14px", borderTop: "1px solid var(--border)" }}>
          <Button small icon="plus" tone="ghost">
            {t("notifications.addRoute")}
          </Button>
        </div>
      </Panel>
    </div>
  );
}
