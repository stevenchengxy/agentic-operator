"use client";

/**
 * Settings → Channels — job board / messaging routes.
 *
 * Skeleton implementation. The audit calls for at least skeleton content here
 * (per task brief); the cleanup engineer / channels engineer will fill in
 * full OAuth + posting + quota tracking.
 */

import { Button, Panel } from "@/app/portal/components";
import { Field, SelectIn, TextIn, Toggle } from "@/app/portal/components/settings/atoms";
import { SETTINGS_INTEGRATIONS } from "@/app/portal/components/settings/data";
import { useI18n } from "@/app/portal/lib/preferences-context";

export function ChannelsSection() {
  const { t } = useI18n();
  const channels = SETTINGS_INTEGRATIONS.filter((i) => i.kind.startsWith("Channel"));
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <Panel
        title={t("channels.connectedTitle", { n: channels.length })}
        subtitle={t("channels.connectedSubtitle")}
        padded={false}
        action={
          <Button small icon="plus" tone="primary">
            {t("channels.connectChannel")}
          </Button>
        }
      >
        {channels.map((c, i) => (
          <div
            key={c.id}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              padding: "12px 14px",
              borderBottom: i < channels.length - 1 ? "1px solid var(--border)" : "none",
            }}
          >
            <div
              style={{
                width: 28,
                height: 28,
                borderRadius: 4,
                background: "var(--panel-2)",
                border: "1px solid var(--border-2)",
              }}
            />
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13, color: "var(--text)" }}>{c.name}</div>
              <div style={{ fontSize: 11, color: "var(--text-3)" }}>{c.detail}</div>
            </div>
            <Button small tone="ghost">
              {t("channels.configure")}
            </Button>
          </div>
        ))}
      </Panel>

      <Panel title={t("channels.defaultRouting")} padded>
        <Field label={t("channels.primaryChannel")} hint={t("channels.primaryChannelHint")}>
          <SelectIn value="zhilian" options={channels.map((c) => ({ value: c.id, label: c.name }))} />
        </Field>
        <Field label={t("channels.fallbackChannel")} hint={t("channels.fallbackChannelHint")}>
          <SelectIn value="boss" options={channels.map((c) => ({ value: c.id, label: c.name }))} />
        </Field>
        <Field label={t("channels.dailyPostCap")} hint={t("channels.dailyPostCapHint")}>
          <TextIn value="20" mono suffix={t("channels.postsSuffix")} />
        </Field>
        <Field
          label={t("channels.throttleOnQuota")}
          hint={t("channels.throttleOnQuotaHint")}
        >
          <Toggle value onChange={() => {}} />
        </Field>
      </Panel>
    </div>
  );
}
