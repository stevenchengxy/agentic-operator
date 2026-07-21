"use client";

/**
 * TenantCreateModal — 3-step wizard for `POST /v1/tenants`.
 *
 * Steps: Identity → Quotas → Review.
 *
 * Validates the slug client-side against the same regex and reserved-list
 * the server enforces (both exported from `@agentic/contracts`). On success
 * returns the unwrapped `TenantCreateResponse` envelope. The caller wires
 * the response into a token-reveal flow + navigates to the new tenant.
 *
 * Ported from `apps/web/public/portal/views/tenants.jsx` (TenantsCreateModal).
 */

import { useEffect, useState } from "react";
import type {
  TenantCreateBody,
  TenantCreateResponse,
} from "@agentic/contracts";
import { Button, Icon, ModalOverlay } from "@/app/portal/components";
import { useI18n } from "@/app/portal/lib/preferences-context";
import { readApiData } from "@/lib/api-response";
import { computeSlugIssues, deriveSlug, shouldShowSlugIssue } from "./tenant-slug";

const DEFAULT_COLORS = [
  "#d0ff00",
  "#7c9eff",
  "#f5c46b",
  "#65e0a3",
  "#b594ff",
  "#ff6470",
  "#5deeff",
  "#ffb547",
];

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

export interface TenantCreateModalProps {
  onClose: () => void;
  onCreated: (created: TenantCreateResponse) => void;
  existingSlugs: Set<string>;
}

export function TenantCreateModal({
  onClose,
  onCreated,
  existingSlugs,
}: TenantCreateModalProps) {
  const { t } = useI18n();
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugDirty, setSlugDirty] = useState(false);
  const [subtitle, setSubtitle] = useState("");
  const [color, setColor] = useState<string>(DEFAULT_COLORS[0]!);

  const [tokenCap, setTokenCap] = useState("");
  const [usdCap, setUsdCap] = useState("");
  const [mintToken, setMintToken] = useState(true);

  // Auto-derive slug from name until the user edits the slug field. A name with
  // no Latin letters (e.g. pure Chinese) derives to "" — the slug field then
  // shows a "required" hint (see shouldShowSlugIssue) so the wizard isn't a
  // silent dead-end.
  useEffect(() => {
    if (slugDirty) return;
    setSlug(deriveSlug(name));
  }, [name, slugDirty]);

  const slugIssueCodes = computeSlugIssues(slug, existingSlugs);
  const slugIssues = slugIssueCodes.map((code) =>
    t(`tenantCreateModal.slugIssue.${code}`),
  );
  const canNextFrom1 = name.trim().length > 0 && slugIssueCodes.length === 0;
  const canNextFrom2 = true;
  const colorValid = HEX_COLOR_RE.test(color);

  async function submit() {
    if (!colorValid) {
      setErr(t("tenantCreateModal.errColorHex"));
      return;
    }
    setSubmitting(true);
    setErr(null);

    const body: TenantCreateBody = {
      slug,
      name: name.trim(),
      subtitle: subtitle.trim() || undefined,
      color,
      starter: "empty",
      mintToken,
      budget: {
        monthlyTokenCap: tokenCap === "" ? null : Number(tokenCap),
        monthlyUsdCap: usdCap === "" ? null : Math.round(Number(usdCap) * 100),
      },
    };
    try {
      const idemKey = `ten-${slug}-${Date.now().toString(36)}`;
      const res = await fetch("/v1/tenants", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          "idempotency-key": idemKey,
        },
        body: JSON.stringify(body),
      });
      const data = await readApiData<TenantCreateResponse>(res, "/v1/tenants");
      onCreated(data);
    } catch (e) {
      setErr(e instanceof Error ? e.message : t("tenantCreateModal.errNetwork"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <ModalOverlay onClose={onClose} ariaLabel={t("tenantCreateModal.ariaWizard", { step })}>
      <div
        style={{
          width: 560,
          maxWidth: "92vw",
          maxHeight: "85vh",
          display: "flex",
          flexDirection: "column",
          background: "var(--panel)",
          border: "1px solid var(--border-2)",
          borderRadius: 6,
          boxShadow: "0 24px 60px rgba(0,0,0,0.6)",
          overflow: "hidden",
        }}
      >
        <header
          style={{
            padding: "14px 18px",
            borderBottom: "1px solid var(--border)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <div style={{ fontSize: 13, color: "var(--text)", fontWeight: 500 }}>
            {t("tenantCreateModal.headerTitle", { step })}
          </div>
          <button
            onClick={onClose}
            style={{ color: "var(--text-3)" }}
            aria-label={t("tenantCreateModal.close")}
          >
            <Icon name="x" size={12} />
          </button>
        </header>

        <div style={{ padding: "16px 18px", overflowY: "auto", flex: 1 }}>
          {err && (
            <div
              style={{
                padding: "8px 12px",
                marginBottom: 12,
                background: "color-mix(in srgb, var(--red) 8%, transparent)",
                border: "1px solid color-mix(in srgb, var(--red) 30%, transparent)",
                borderRadius: 4,
                color: "var(--red)",
                fontSize: 12,
              }}
            >
              {err}
            </div>
          )}

          {step === 1 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <Field
                label={t("tenantCreateModal.displayName")}
                hint={t("tenantCreateModal.displayNameHint")}
              >
                <input
                  autoFocus
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={t("tenantCreateModal.displayNamePlaceholder")}
                  style={inputStyle()}
                />
              </Field>
              <Field
                label={t("tenantCreateModal.slug")}
                hint={t("tenantCreateModal.slugHint")}
                error={
                  shouldShowSlugIssue({ slugDirty, name, issueCount: slugIssueCodes.length })
                    ? slugIssues.join("; ")
                    : null
                }
              >
                <input
                  value={slug}
                  onChange={(e) => {
                    setSlug(e.target.value.toLowerCase());
                    setSlugDirty(true);
                  }}
                  placeholder={t("tenantCreateModal.slugPlaceholder")}
                  style={{ ...inputStyle(), fontFamily: "var(--mono)" }}
                />
              </Field>
              <Field
                label={t("tenantCreateModal.subtitle")}
                hint={t("tenantCreateModal.subtitleHint")}
              >
                <input
                  value={subtitle}
                  onChange={(e) => setSubtitle(e.target.value)}
                  placeholder={t("tenantCreateModal.subtitlePlaceholder")}
                  style={inputStyle()}
                />
              </Field>
              <Field
                label={t("tenantCreateModal.accentColor")}
                hint={t("tenantCreateModal.accentColorHint")}
              >
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  {DEFAULT_COLORS.map((c) => (
                    <button
                      key={c}
                      onClick={() => setColor(c)}
                      style={{
                        width: 26,
                        height: 26,
                        borderRadius: 5,
                        background: c,
                        border:
                          color === c
                            ? "2px solid var(--text)"
                            : "1px solid var(--border-2)",
                        cursor: "pointer",
                      }}
                      title={c}
                      aria-label={t("tenantCreateModal.colorSwatchAria", { color: c })}
                    />
                  ))}
                  <input
                    value={color}
                    onChange={(e) => setColor(e.target.value)}
                    style={{
                      ...inputStyle(),
                      width: 110,
                      fontFamily: "var(--mono)",
                      fontSize: 11,
                    }}
                  />
                </div>
              </Field>
            </div>
          )}

          {step === 2 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <Field
                label={t("tenantCreateModal.tokenCap")}
                hint={t("tenantCreateModal.tokenCapHint")}
              >
                <input
                  value={tokenCap}
                  type="number"
                  min="0"
                  onChange={(e) => setTokenCap(e.target.value)}
                  placeholder={t("tenantCreateModal.tokenCapPlaceholder")}
                  style={{ ...inputStyle(), fontFamily: "var(--mono)" }}
                />
              </Field>
              <Field
                label={t("tenantCreateModal.usdCap")}
                hint={t("tenantCreateModal.usdCapHint")}
              >
                <input
                  value={usdCap}
                  type="number"
                  min="0"
                  step="0.01"
                  onChange={(e) => setUsdCap(e.target.value)}
                  placeholder={t("tenantCreateModal.usdCapPlaceholder")}
                  style={{ ...inputStyle(), fontFamily: "var(--mono)" }}
                />
              </Field>
              <Field
                label={t("tenantCreateModal.apiToken")}
                hint={t("tenantCreateModal.apiTokenHint")}
              >
                <label
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    fontSize: 12,
                    color: "var(--text-2)",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={mintToken}
                    onChange={(e) => setMintToken(e.target.checked)}
                  />
                  {t("tenantCreateModal.mintTokenLabel")}
                </label>
              </Field>
            </div>
          )}

          {step === 3 && (
            <div>
              <div
                style={{
                  fontSize: 11,
                  fontFamily: "var(--mono)",
                  color: "var(--text-3)",
                  marginBottom: 8,
                }}
              >
                {t("tenantCreateModal.reviewHeading")}
              </div>
              <div
                style={{
                  background: "var(--bg)",
                  border: "1px solid var(--border)",
                  borderRadius: 5,
                  padding: 14,
                  fontFamily: "var(--mono)",
                  fontSize: 12,
                  color: "var(--text-2)",
                  display: "flex",
                  flexDirection: "column",
                  gap: 6,
                }}
              >
                <KvRow k="name" v={name} />
                <KvRow k="slug" v={slug} />
                <KvRow k="subtitle" v={subtitle || t("tenantCreateModal.reviewNone")} />
                <KvRow k="color" v={color} />
                <KvRow
                  k="monthly_token_cap"
                  v={tokenCap === "" ? t("tenantCreateModal.reviewUnlimited") : tokenCap}
                />
                <KvRow
                  k="monthly_usd_cap"
                  v={usdCap === "" ? t("tenantCreateModal.reviewUnlimited") : `$${usdCap}`}
                />
                <KvRow
                  k="mint_bootstrap_token"
                  v={mintToken ? t("tenantCreateModal.reviewYes") : t("tenantCreateModal.reviewNo")}
                />
              </div>
              <div style={{ marginTop: 14, fontSize: 11.5, color: "var(--text-3)" }}>
                {t("tenantCreateModal.provisioningNote")}
              </div>
            </div>
          )}
        </div>

        <div style={{ padding: "12px 18px", borderTop: "1px solid var(--border)" }}>
          <div
            style={{
              display: "flex",
              gap: 8,
              justifyContent: "space-between",
              alignItems: "center",
            }}
          >
            <div style={{ fontSize: 11, color: "var(--text-3)" }}>
              {step === 1 && t("tenantCreateModal.stepIdentity")}
              {step === 2 && t("tenantCreateModal.stepQuotas")}
              {step === 3 && t("tenantCreateModal.stepReview")}
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              {step > 1 && (
                <Button tone="ghost" onClick={() => setStep((s) => (s - 1) as 1 | 2 | 3)}>
                  {t("tenantCreateModal.back")}
                </Button>
              )}
              {step < 3 && (
                <Button
                  tone="primary"
                  disabled={
                    (step === 1 && !canNextFrom1) ||
                    (step === 2 && !canNextFrom2)
                  }
                  onClick={() => setStep((s) => (s + 1) as 1 | 2 | 3)}
                >
                  {t("tenantCreateModal.next")}
                </Button>
              )}
              {step === 3 && (
                <Button
                  tone="primary"
                  onClick={submit}
                  disabled={submitting || !colorValid}
                >
                  {submitting
                    ? t("tenantCreateModal.provisioning")
                    : t("tenantCreateModal.createTenant")}
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>
    </ModalOverlay>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────
// computeSlugIssues / deriveSlug / shouldShowSlugIssue live in ./tenant-slug
// (pure + unit-tested in apps/api/test/tenant-slug.test.ts).

function inputStyle() {
  return {
    padding: "7px 10px",
    background: "var(--bg)",
    border: "1px solid var(--border-2)",
    borderRadius: 4,
    color: "var(--text)",
    fontSize: 13,
    fontFamily: "var(--sans)",
    width: "100%",
    outline: "none" as const,
  };
}

function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string | null;
  children: React.ReactNode;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
      <div
        style={{
          fontSize: 11,
          fontFamily: "var(--mono)",
          color: "var(--text-3)",
          textTransform: "uppercase",
          letterSpacing: "0.08em",
        }}
      >
        {label}
      </div>
      {children}
      {error && <div style={{ fontSize: 11, color: "var(--red)" }}>{error}</div>}
      {hint && !error && (
        <div style={{ fontSize: 11, color: "var(--text-3)", lineHeight: 1.4 }}>{hint}</div>
      )}
    </div>
  );
}

function KvRow({ k, v }: { k: string; v: string | number | boolean }) {
  return (
    <div style={{ display: "flex", gap: 12 }}>
      <div style={{ color: "var(--text-3)", width: 180, flexShrink: 0 }}>{k}</div>
      <div style={{ color: "var(--text)" }}>{String(v)}</div>
    </div>
  );
}
