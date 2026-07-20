"use client";

/** Settings → Billing / cost caps, backed only by the tenant budget API. */

import { useEffect, useState } from "react";
import Link from "next/link";
import { Button, Empty, Panel } from "@/app/portal/components";
import { useTenant } from "@/app/portal/lib/use-tenant";
import { Field, TextIn } from "@/app/portal/components/settings/atoms";
import {
  parseTokenCap,
  parseUsdCap,
} from "@/app/portal/components/settings/values";
import { useBudget, useUpdateBudget } from "@/lib/hooks/useUsage";
import { fmtNum } from "@/app/portal/lib/format";
import { formatUsdNanos } from "@/lib/format-usd";

export function BillingSection() {
  const tenant = useTenant();
  const budget = useBudget();
  const update = useUpdateBudget();
  const [tokenCap, setTokenCap] = useState("");
  const [usdCap, setUsdCap] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    const row = budget.data;
    if (!row) return;
    setTokenCap(row.monthlyTokenCap?.toString() ?? "");
    setUsdCap(
      row.monthlyUsdCap == null ? "" : (row.monthlyUsdCap / 100).toFixed(2),
    );
  }, [budget.data]);

  async function saveCaps() {
    setError(null);
    setSaved(false);
    try {
      await update.mutateAsync({
        monthlyTokenCap: parseTokenCap(tokenCap),
        monthlyUsdCap: parseUsdCap(usdCap),
      });
      setSaved(true);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "The budget could not be saved.",
      );
    }
  }

  const row = budget.data;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <Panel
        title="Monthly cost caps"
        subtitle="Live limits for the current tenant. Blank means unlimited."
        padded
        action={
          <Link
            href={`/portal/${tenant}/settings/usage` as never}
            style={{ textDecoration: "none" }}
          >
            <Button small icon="dashboard" tone="ghost">
              Open usage details
            </Button>
          </Link>
        }
      >
        {budget.isLoading && (
          <div
            style={{ padding: "18px 0", color: "var(--text-3)", fontSize: 12 }}
          >
            Loading the tenant budget…
          </div>
        )}
        {budget.isError && (
          <Empty
            title="Budget data is unavailable"
            hint="The API did not return a tenant budget. No plan or spend figures are being inferred."
          />
        )}
        {row && (
          <>
            <Field
              label="Monthly token cap"
              hint="Whole tokens. Leave blank for no token cap."
            >
              <TextIn
                value={tokenCap}
                onChange={(value) => {
                  setTokenCap(value);
                  setSaved(false);
                }}
                placeholder="Unlimited"
                ariaLabel="Monthly token cap"
                mono
                suffix="tokens"
              />
            </Field>
            <Field
              label="Monthly USD cap"
              hint="Stored by the API in cents. Leave blank for no cost cap."
            >
              <TextIn
                value={usdCap}
                onChange={(value) => {
                  setUsdCap(value);
                  setSaved(false);
                }}
                placeholder="Unlimited"
                ariaLabel="Monthly USD cap"
                mono
                prefix="$"
              />
            </Field>
            {(error || saved) && (
              <div
                role={error ? "alert" : "status"}
                style={{
                  marginTop: 12,
                  fontSize: 12,
                  color: error ? "var(--red)" : "var(--green)",
                }}
              >
                {error ?? "Budget caps saved."}
              </div>
            )}
            <div
              style={{
                display: "flex",
                justifyContent: "flex-end",
                marginTop: 14,
              }}
            >
              <Button
                tone="primary"
                icon="check"
                onClick={() => void saveCaps()}
                disabled={update.isPending}
              >
                {update.isPending ? "Saving…" : "Save caps"}
              </Button>
            </div>
          </>
        )}
      </Panel>

      {row && (
        <Panel
          title="Current budget period"
          subtitle={`Started ${new Date(row.periodStart).toLocaleDateString()}. Usage is measured by the gateway ledger.`}
          padded
        >
          <BudgetProgress
            label="Tokens"
            usedLabel={fmtNum(row.usedTokensMonth)}
            capLabel={
              row.monthlyTokenCap == null
                ? "unlimited"
                : fmtNum(row.monthlyTokenCap)
            }
            percent={percentage(row.usedTokensMonth, row.monthlyTokenCap)}
          />
          <BudgetProgress
            label="Cost"
            usedLabel={formatUsdNanos(row.usedUsdNanos)}
            capLabel={
              row.monthlyUsdCap == null
                ? "unlimited"
                : `$${(row.monthlyUsdCap / 100).toFixed(2)}`
            }
            percent={percentage(
              row.usedUsdNanos,
              row.monthlyUsdCap == null ? null : row.monthlyUsdCap * 10_000_000,
            )}
          />
        </Panel>
      )}
    </div>
  );
}

function percentage(used: number, cap: number | null): number | null {
  if (cap == null) return null;
  if (cap === 0) return used > 0 ? 100 : 0;
  return Math.min(100, (used / cap) * 100);
}

function BudgetProgress({
  label,
  usedLabel,
  capLabel,
  percent,
}: {
  label: string;
  usedLabel: string;
  capLabel: string;
  percent: number | null;
}) {
  return (
    <div style={{ padding: "10px 0", borderBottom: "1px solid var(--border)" }}>
      <div style={{ display: "flex", gap: 8, marginBottom: 7, fontSize: 12 }}>
        <span style={{ color: "var(--text)" }}>{label}</span>
        <span
          className="mono"
          style={{ marginLeft: "auto", color: "var(--text-2)" }}
        >
          {usedLabel} / {capLabel}
        </span>
      </div>
      <div
        aria-label={`${label} budget usage`}
        aria-valuenow={percent ?? undefined}
        role={percent == null ? undefined : "progressbar"}
        style={{
          height: 6,
          background: "var(--panel-2)",
          border: "1px solid var(--border)",
          borderRadius: 3,
          overflow: "hidden",
        }}
      >
        {percent != null && (
          <div
            style={{
              width: `${percent}%`,
              height: "100%",
              background:
                percent >= 90
                  ? "var(--red)"
                  : percent >= 70
                    ? "var(--amber)"
                    : "var(--signal)",
            }}
          />
        )}
      </div>
    </div>
  );
}
