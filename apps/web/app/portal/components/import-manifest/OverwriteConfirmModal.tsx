"use client";

/**
 * OverwriteConfirmModal — second-level confirmation for the Import Manifest
 * wizard's Deploy step.
 *
 * Rendered when `POST /v1/tenants/:slug/manifest-import` (mode: commit) responds
 * with status 409 and a flat body of shape `ManifestImportOverwriteRequired`
 * (note: 409 is NOT enveloped by `apps/api/src/plugins/error.ts`). Clicking
 * "Overwrite and deploy" re-submits the commit with `confirm_overwrite: true`.
 *
 * zIndex sits above the wizard via `var(--z-modal)` (already used by every
 * other portal modal) — Modal layers stack by mount order at the same token,
 * which is correct here because we want this confirm to capture clicks on top
 * of the wizard.
 *
 * Ported from `apps/web/public/portal/components/overwrite-confirm-modal.jsx`.
 */

import { useEffect, useMemo } from "react";
import type { ManifestImportOverwriteRequired } from "@agentic/contracts";
import { Button, Icon } from "@/app/portal/components";
import { useI18n } from "@/app/portal/lib/preferences-context";

/** The flat 409 payload may carry an optional `prior` block the wizard knows
 *  about even though it's not part of the strict contract type — make it a
 *  superset so we can render the live-version label when available. */
export interface OverwriteConfirmPayload extends ManifestImportOverwriteRequired {
  prior?: {
    version_label?: string | null;
    deployed_at?: number | null;
    agents?: number | null;
  };
}

export interface OverwriteConfirmModalProps {
  payload: OverwriteConfirmPayload;
  onConfirm: () => void;
  onCancel: () => void;
  committing: boolean;
}

export function OverwriteConfirmModal({
  payload,
  onConfirm,
  onCancel,
  committing,
}: OverwriteConfirmModalProps) {
  const { t } = useI18n();
  const diff = payload.diff;
  const prior = payload.prior ?? {};
  const conflicts = payload.conflicts ?? [];
  const reason = payload.reason;

  const counts = useMemo(
    () => ({
      added: (diff.added ?? []).length,
      removed: (diff.removed ?? []).length,
      modified: (diff.modified ?? []).length,
    }),
    [diff],
  );

  // Escape closes (unless we're mid-commit and need to wait for the network).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !committing) onCancel();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel, committing]);

  return (
    <div
      onClick={committing ? undefined : onCancel}
      role="dialog"
      aria-modal="true"
      aria-label={t("overwriteConfirmModal.dialogAria")}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: "var(--z-modal)" as unknown as number,
        background: "rgba(0,0,0,0.62)",
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        backdropFilter: "blur(2px)",
        animation: "fadein 0.14s ease",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 560,
          maxHeight: "82vh",
          background: "var(--panel)",
          border: "1px solid color-mix(in srgb, var(--red) 45%, transparent)",
          borderRadius: 8,
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
          boxShadow: "0 24px 60px -20px rgba(0,0,0,0.7)",
        }}
      >
        <header
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "14px 18px",
            borderBottom: "1px solid var(--border)",
            background: "color-mix(in srgb, var(--red) 6%, transparent)",
          }}
        >
          <Icon name="alert" size={14} style={{ color: "var(--red)" }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 14, color: "var(--text)", fontWeight: 500 }}>
              {t("overwriteConfirmModal.title")}
            </div>
            <div style={{ fontSize: 11, color: "var(--text-3)", marginTop: 2 }}>
              {prior.version_label ? (
                <>
                  {t("overwriteConfirmModal.replacingLabeled")}{" "}
                  <span className="mono" style={{ color: "var(--text-2)" }}>
                    {prior.version_label}
                  </span>
                  {prior.deployed_at
                    ? ` ${t("overwriteConfirmModal.deployedAt", { time: humanTime(prior.deployed_at) })}`
                    : ""}
                </>
              ) : (
                <>{t("overwriteConfirmModal.replacingCurrent")}</>
              )}
            </div>
          </div>
          <button
            onClick={committing ? undefined : onCancel}
            disabled={committing}
            aria-label={t("overwriteConfirmModal.close")}
            style={{ color: "var(--text-3)" }}
          >
            <Icon name="x" size={13} />
          </button>
        </header>

        <div style={{ padding: "16px 18px", overflow: "auto", flex: 1, minHeight: 0 }}>
          <div style={{ marginBottom: 12 }}>
            <ReasonChip reason={reason} />
          </div>

          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: 14,
              padding: "10px 12px",
              background: "var(--panel-2)",
              border: "1px solid var(--border)",
              borderRadius: 5,
              fontSize: 12,
              fontFamily: "var(--mono)",
              color: "var(--text-2)",
              marginBottom: 14,
            }}
          >
            <span>
              {t("overwriteConfirmModal.willAdd")}{" "}
              <span style={{ color: "var(--green)" }}>{counts.added}</span>
            </span>
            <span style={{ color: "var(--text-4)" }}>·</span>
            <span>
              {t("overwriteConfirmModal.remove")}{" "}
              <span style={{ color: "var(--red)" }}>{counts.removed}</span>
            </span>
            <span style={{ color: "var(--text-4)" }}>·</span>
            <span>
              {t("overwriteConfirmModal.modify")}{" "}
              <span style={{ color: "var(--amber)" }}>{counts.modified}</span>
            </span>
            {typeof prior.agents === "number" && (
              <>
                <span style={{ color: "var(--text-4)" }}>·</span>
                <span style={{ color: "var(--text-3)" }}>
                  {t("overwriteConfirmModal.priorHadAgents", { count: prior.agents })}
                </span>
              </>
            )}
          </div>

          {counts.removed > 0 && (
            <DiffSection
              label={t("overwriteConfirmModal.removedSection", { count: counts.removed })}
              color="var(--red)"
              ids={diff.removed}
              tone="red"
            />
          )}

          {counts.modified > 0 && (
            <DiffSection
              label={t("overwriteConfirmModal.modifiedSection", { count: counts.modified })}
              color="var(--amber)"
              ids={diff.modified}
              tone="amber"
            />
          )}

          {counts.added > 0 && (
            <DiffSection
              label={t("overwriteConfirmModal.addedSection", { count: counts.added })}
              color="var(--green)"
              ids={diff.added}
              tone="green"
            />
          )}

          {conflicts.length > 0 && (
            <div
              style={{
                marginTop: 10,
                padding: "10px 12px",
                background: "var(--panel-2)",
                border: "1px solid var(--border)",
                borderRadius: 5,
              }}
            >
              <div
                style={{
                  fontSize: 10.5,
                  fontFamily: "var(--mono)",
                  textTransform: "uppercase",
                  letterSpacing: "0.08em",
                  color: "var(--text-3)",
                  marginBottom: 8,
                }}
              >
                {t("overwriteConfirmModal.conflictsSection", { count: conflicts.length })}
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {conflicts.map((c, i) => (
                  <div
                    key={`${c.path}-${i}`}
                    style={{
                      display: "flex",
                      alignItems: "flex-start",
                      gap: 8,
                      fontSize: 11.5,
                    }}
                  >
                    <SeverityChip severity={c.severity ?? "warn"} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ color: "var(--text)" }}>{c.detail || c.type}</div>
                      {c.path && (
                        <div
                          style={{
                            fontSize: 10.5,
                            fontFamily: "var(--mono)",
                            color: "var(--text-3)",
                            marginTop: 2,
                          }}
                        >
                          {c.path}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div
            style={{
              marginTop: 14,
              padding: "10px 12px",
              background: "color-mix(in srgb, var(--red) 4%, transparent)",
              border: "1px solid color-mix(in srgb, var(--red) 20%, transparent)",
              borderRadius: 4,
              fontSize: 11.5,
              color: "var(--text-2)",
              lineHeight: 1.5,
            }}
          >
            {t("overwriteConfirmModal.demotionPrefix")}{" "}
            <span className="mono" style={{ color: "var(--text)" }}>
              rolled_back
            </span>{" "}
            {t("overwriteConfirmModal.demotionSuffix")}
          </div>
        </div>

        <footer
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "12px 18px",
            borderTop: "1px solid var(--border)",
            background: "var(--panel-2)",
          }}
        >
          <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
            <Button
              tone="ghost"
              onClick={committing ? undefined : onCancel}
              disabled={committing}
            >
              {t("overwriteConfirmModal.cancel")}
            </Button>
            <button
              onClick={committing ? undefined : onConfirm}
              disabled={committing}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                padding: "5px 11px",
                fontSize: 12,
                fontFamily: "var(--sans)",
                fontWeight: 500,
                color: "#fff",
                background: committing ? "color-mix(in srgb, var(--red) 50%, transparent)" : "var(--red)",
                border: `1px solid ${committing ? "color-mix(in srgb, var(--red) 50%, transparent)" : "var(--red)"}`,
                borderRadius: 5,
                cursor: committing ? "not-allowed" : "pointer",
                opacity: committing ? 0.8 : 1,
                transition: "background 0.12s",
              }}
            >
              <Icon name="alert" size={11} />
              {committing
                ? t("overwriteConfirmModal.deploying")
                : t("overwriteConfirmModal.overwriteAndDeploy")}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

// ── Helpers ─────────────────────────────────────────────────────────────

function humanTime(ms: number | null | undefined): string {
  if (!ms || typeof ms !== "number") return "—";
  try {
    const diff = Date.now() - ms;
    if (diff < 60_000) return `${Math.max(1, Math.floor(diff / 1000))}s ago`;
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
    return new Date(ms).toISOString().slice(0, 10);
  } catch {
    return "—";
  }
}

function ReasonChip({
  reason,
}: {
  reason: ManifestImportOverwriteRequired["reason"];
}) {
  const { t } = useI18n();
  const text =
    reason === "removes_agents"
      ? t("overwriteConfirmModal.reasonRemovesAgents")
      : reason === "modifies_threshold"
        ? t("overwriteConfirmModal.reasonModifiesThreshold")
        : t("overwriteConfirmModal.reasonSignificant");
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        padding: "2px 7px",
        fontSize: 10.5,
        fontFamily: "var(--mono)",
        fontWeight: 500,
        letterSpacing: "0.04em",
        textTransform: "uppercase",
        color: "var(--red)",
        background: "color-mix(in srgb, var(--red) 10%, transparent)",
        border: "1px solid color-mix(in srgb, var(--red) 32%, transparent)",
        borderRadius: 3,
        lineHeight: 1.4,
        whiteSpace: "nowrap",
      }}
    >
      {text}
    </span>
  );
}

function DiffSection({
  label,
  color,
  ids,
  tone,
}: {
  label: string;
  color: string;
  ids: readonly string[];
  tone: "red" | "amber" | "green";
}) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div
        style={{
          fontSize: 10.5,
          fontFamily: "var(--mono)",
          textTransform: "uppercase",
          letterSpacing: "0.08em",
          color,
          marginBottom: 6,
        }}
      >
        {label}
      </div>
      <IdList ids={ids} tone={tone} />
    </div>
  );
}

function IdList({
  ids,
  tone,
}: {
  ids: readonly string[];
  tone: "red" | "amber" | "green";
}) {
  if (!ids || ids.length === 0) return null;
  const dotColor =
    tone === "red"
      ? "var(--red)"
      : tone === "amber"
        ? "var(--amber)"
        : "var(--green)";
  return (
    <ul
      style={{
        margin: 0,
        padding: "0 0 0 4px",
        listStyle: "none",
        display: "flex",
        flexDirection: "column",
        gap: 4,
      }}
    >
      {ids.map((id, i) => (
        <li
          key={`${id}-${i}`}
          style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}
        >
          <span
            style={{
              display: "inline-block",
              width: 6,
              height: 6,
              borderRadius: "50%",
              background: dotColor,
              flexShrink: 0,
            }}
          />
          <span className="mono" style={{ color: "var(--text)" }}>
            {String(id)}
          </span>
        </li>
      ))}
    </ul>
  );
}

function SeverityChip({ severity }: { severity: "block" | "warn" }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        padding: "1px 6px",
        fontSize: 9.5,
        fontFamily: "var(--mono)",
        letterSpacing: "0.04em",
        textTransform: "uppercase",
        color: severity === "block" ? "var(--red)" : "var(--amber)",
        background:
          severity === "block"
            ? "color-mix(in srgb, var(--red) 10%, transparent)"
            : "color-mix(in srgb, var(--amber) 10%, transparent)",
        border: `1px solid ${
          severity === "block"
            ? "color-mix(in srgb, var(--red) 32%, transparent)"
            : "color-mix(in srgb, var(--amber) 32%, transparent)"
        }`,
        borderRadius: 3,
        flexShrink: 0,
      }}
    >
      {severity}
    </span>
  );
}
