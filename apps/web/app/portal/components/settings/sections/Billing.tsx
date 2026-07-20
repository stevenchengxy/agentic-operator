"use client";

/** Settings → Billing / cost caps, backed by the current tenant's durable
 * `/v1/budgets` row. Cap editing lives on the detailed usage route so this
 * summary never mixes live spend with fixture invoices or sample tenants. */

import { useRouter } from "next/navigation";
import { Badge, Button, Empty, Panel } from "@/app/portal/components";
import { useI18n } from "@/app/portal/lib/preferences-context";
import { useTenant } from "@/app/portal/lib/use-tenant";
import { fmtNum } from "@/app/portal/lib/format";
import { useBudget } from "@/lib/hooks/useUsage";

function fmtUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function percent(used: number, cap: number | null): number | null {
  return cap != null && cap > 0 ? Math.min(100, (used / cap) * 100) : null;
}

export function BillingSection() {
  const { t } = useI18n();
  const tenant = useTenant();
  const router = useRouter();
  const budget = useBudget();

  if (budget.isLoading && !budget.data) {
    return <Empty title={t("billing.loading")} hint="" />;
  }
  if (budget.isError || !budget.data) {
    return (
      <Empty
        title={t("billing.loadFailed")}
        hint={budget.error instanceof Error ? budget.error.message : ""}
      />
    );
  }

  const row = budget.data;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <Panel
        title={t("billing.costCaps")}
        subtitle={t("billing.costCapsSubtitle")}
        padded={false}
        action={
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Badge tone="green">{t("billing.liveSource")}</Badge>
            <Button
              small
              icon="external"
              tone="ghost"
              onClick={() =>
                router.push(`/portal/${tenant}/settings/usage` as never)
              }
            >
              {t("billing.openUsage")}
            </Button>
          </div>
        }
      >
        {!row.costComplete ? (
          <div
            role="note"
            style={{
              margin: "12px 16px 0",
              padding: "8px 10px",
              border:
                "1px solid color-mix(in srgb, var(--amber) 35%, var(--border))",
              borderRadius: 6,
              color: "var(--amber)",
              background:
                "color-mix(in srgb, var(--amber) 7%, transparent)",
              fontSize: 11,
            }}
          >
            {t("billing.costIncomplete", {
              n: fmtNum(row.unpricedTokens),
            })}
          </div>
        ) : null}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))",
            borderBottom: "1px solid var(--border)",
          }}
        >
          <BudgetCell label={t("billing.tenant")} value={tenant} mono />
          <BudgetCell
            label={t("billing.tokensUsed")}
            value={fmtNum(row.usedTokensMonth)}
            mono
          />
          <BudgetCell
            label={t("billing.tokensReserved")}
            value={fmtNum(row.reservedTokens)}
            mono
          />
          <BudgetCell
            label={t("billing.estimatedSpend")}
            value={`${row.costComplete ? "" : "≥"}${fmtUsd(row.usedUsdMonth)}`}
            mono
          />
          <BudgetCell
            label={t("billing.spendReserved")}
            value={fmtUsd(row.reservedUsdCents)}
            mono
          />
          <BudgetCell
            label={t("billing.activeReservations")}
            value={fmtNum(row.activeReservations)}
            mono
          />
          <BudgetCell
            label={t("billing.periodStart")}
            value={new Date(row.periodStart).toLocaleDateString()}
            mono
          />
        </div>
        <div style={{ padding: "14px 16px", display: "grid", gap: 14 }}>
          <BudgetProgress
            label={t("billing.tokenCap")}
            used={row.usedTokensMonth}
            reserved={row.reservedTokens}
            cap={row.monthlyTokenCap}
            format={fmtNum}
            unlimited={t("billing.unlimited")}
          />
          <BudgetProgress
            label={t("billing.usdCap")}
            used={row.usedUsdMonth}
            reserved={row.reservedUsdCents}
            cap={row.monthlyUsdCap}
            format={fmtUsd}
            unlimited={t("billing.unlimited")}
            minimum={!row.costComplete}
          />
        </div>
      </Panel>
    </div>
  );
}

function BudgetCell({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div style={{ padding: "13px 16px", borderRight: "1px solid var(--border)" }}>
      <div
        style={{
          fontSize: 10,
          fontFamily: "var(--mono)",
          textTransform: "uppercase",
          letterSpacing: "0.08em",
          color: "var(--text-3)",
        }}
      >
        {label}
      </div>
      <div
        style={{
          marginTop: 5,
          fontSize: 18,
          fontFamily: mono ? "var(--mono)" : "var(--sans)",
          color: "var(--text)",
        }}
      >
        {value}
      </div>
    </div>
  );
}

function BudgetProgress({
  label,
  used,
  reserved,
  cap,
  format,
  unlimited,
  minimum = false,
}: {
  label: string;
  used: number;
  reserved: number;
  cap: number | null;
  format: (value: number) => string;
  unlimited: string;
  minimum?: boolean;
}) {
  const { t } = useI18n();
  const committed = used + reserved;
  const pct = percent(committed, cap);
  return (
    <div style={{ display: "grid", gridTemplateColumns: "150px 1fr auto", gap: 12, alignItems: "center" }}>
      <span style={{ fontSize: 11.5, color: "var(--text-2)" }}>{label}</span>
      <div style={{ height: 7, borderRadius: 99, overflow: "hidden", background: "var(--bg-2)" }}>
        <div
          style={{
            width: pct == null ? 0 : `${pct}%`,
            height: "100%",
            background:
              pct != null && pct >= 90
                ? "var(--red)"
                : pct != null && pct >= 70
                  ? "var(--amber)"
                  : "var(--signal)",
          }}
        />
      </div>
      <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--text-2)" }}>
        {minimum ? "≥" : ""}{format(used)}{reserved > 0 ? ` + ${format(reserved)} ${t("billing.reservedSuffix")}` : ""} / {cap == null ? unlimited : format(cap)}
        {pct == null ? "" : ` · ${minimum ? "≥" : ""}${pct.toFixed(0)}%`}
      </span>
    </div>
  );
}
