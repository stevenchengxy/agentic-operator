"use client";

import { useMemo, useState } from "react";
import { Button, ModalOverlay } from "@/app/portal/components";
import { useI18n } from "@/app/portal/lib/preferences-context";
import {
  draftSandboxTestTemplate,
  parseDraftSandboxSubmission,
  type DraftSandboxFinishReceipt,
  type DraftSandboxInputContract,
  type DraftSandboxReview,
} from "./draft-sandbox";

export function DraftSandboxModal({
  contract,
  onClose,
  onPrepare,
  onFinish,
  onComplete,
}: {
  contract: DraftSandboxInputContract;
  onClose: () => void;
  onPrepare: (input: { testCases: unknown[]; boundaryEvents: unknown[] }) => Promise<{ ok: true; review: DraftSandboxReview } | { ok: false; message: string }>;
  onFinish: (review: DraftSandboxReview) => Promise<{ ok: true; receipt: DraftSandboxFinishReceipt } | { ok: false; message: string }>;
  onComplete: (receipt: DraftSandboxFinishReceipt) => void;
}) {
  const { t } = useI18n();
  const [testCasesText, setTestCasesText] = useState(() => draftSandboxTestTemplate(t, contract));
  const [boundaryEventsText, setBoundaryEventsText] = useState("[]");
  const [review, setReview] = useState<DraftSandboxReview | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState<"prepare" | "finish" | null>(null);
  const [error, setError] = useState("");
  const parsed = useMemo(
    () => parseDraftSandboxSubmission(t, testCasesText, boundaryEventsText),
    [boundaryEventsText, t, testCasesText],
  );

  async function prepare() {
    if (!parsed.ok || busy) return;
    setBusy("prepare");
    setError("");
    try {
      const result = await onPrepare(parsed.data);
      if (!result.ok) setError(result.message);
      else {
        setReview(result.review);
        setConfirmed(false);
      }
    } finally {
      setBusy(null);
    }
  }

  async function finish() {
    if (!review || !confirmed || busy) return;
    setBusy("finish");
    setError("");
    try {
      const result = await onFinish(review);
      if (!result.ok) setError(result.message);
      else onComplete(result.receipt);
    } finally {
      setBusy(null);
    }
  }

  const confirmOption = review?.challenge.options.find((option) => option.value === review.challenge.token);

  return (
    <ModalOverlay onClose={() => { if (!busy) onClose(); }} ariaLabel={t("factory.draftSandbox.ariaLabel")}>
      <div style={{ width: "min(1020px, 95vw)", maxHeight: "94vh", display: "flex", flexDirection: "column", overflow: "hidden", border: "1px solid var(--border)", borderRadius: 12, background: "var(--panel)", boxShadow: "0 24px 70px rgba(0,0,0,.35)" }}>
        <header style={{ padding: "14px 16px", borderBottom: "1px solid var(--border)", display: "flex", gap: 12, alignItems: "flex-start" }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ color: "var(--text)", fontSize: 14, fontWeight: 700 }}>{review ? t("factory.draftSandbox.header.confirmTitle") : t("factory.draftSandbox.header.inputTitle")}</div>
            <div className="mono" style={{ marginTop: 4, color: "var(--text-3)", fontSize: 10.5, overflowWrap: "anywhere" }}>
              {contract.scope.tenantSlug} / {contract.scope.domain} / {contract.scope.slug} / {contract.scope.versionId}
            </div>
          </div>
          <Button small tone="ghost" icon="x" onClick={onClose} disabled={Boolean(busy)}>{t("factory.draftSandbox.close")}</Button>
        </header>

        <div style={{ overflow: "auto", padding: 16, display: "grid", gap: 14 }}>
          <div role="note" style={{ padding: "10px 12px", border: "1px solid var(--amber)", borderRadius: 8, color: "var(--amber)", background: "var(--panel-2)", fontSize: 11.5, lineHeight: 1.6 }}>
            {t("factory.draftSandbox.warning", { count: contract.specsCount })}
          </div>

          {!review ? (
            <>
              <section style={{ display: "grid", gap: 7 }}>
                <div style={{ color: "var(--text)", fontSize: 12, fontWeight: 700 }}>{t("factory.draftSandbox.entry.heading")}</div>
                {contract.entryEvents.length ? contract.entryEvents.map((entry) => (
                  <div key={entry.event} style={{ border: "1px solid var(--border)", borderRadius: 7, padding: "8px 10px", fontSize: 10.5, lineHeight: 1.5 }}>
                    <div className="mono" style={{ color: "var(--signal)" }}>{entry.event}</div>
                    <div style={{ color: "var(--text-3)" }}>{entry.fields.length ? entry.fields.map((field) => `${field.name}:${field.type}${field.required === false ? "?" : ""}`).join(" · ") : t("factory.draftSandbox.entry.noFields")}</div>
                  </div>
                )) : <div role="alert" style={{ color: "var(--red)", fontSize: 11.5 }}>{t("factory.draftSandbox.entry.none")}</div>}
                <div style={{ color: "var(--text-3)", fontSize: 10.5, lineHeight: 1.55 }}>{contract.note}</div>
              </section>

              <section style={{ display: "grid", gap: 7 }}>
                <label htmlFor="factory-draft-sandbox-tests" style={{ color: "var(--text-2)", fontSize: 11.5, fontWeight: 650 }}>{t("factory.draftSandbox.tests.label")}</label>
                <textarea
                  id="factory-draft-sandbox-tests"
                  value={testCasesText}
                  onChange={(event) => { setTestCasesText(event.target.value); setError(""); }}
                  rows={18}
                  spellCheck={false}
                  disabled={Boolean(busy)}
                  style={{ width: "100%", boxSizing: "border-box", resize: "vertical", padding: 10, border: "1px solid var(--border)", borderRadius: 7, background: "var(--panel-2)", color: "var(--text)", fontFamily: "var(--mono)", fontSize: 11, lineHeight: 1.5 }}
                />
                <div style={{ color: "var(--text-3)", fontSize: 10.5, lineHeight: 1.5 }}>{t("factory.draftSandbox.tests.hint")}</div>
              </section>

              <section style={{ display: "grid", gap: 7 }}>
                <label htmlFor="factory-draft-sandbox-boundaries" style={{ color: "var(--text-2)", fontSize: 11.5, fontWeight: 650 }}>{t("factory.draftSandbox.boundaries.label")}</label>
                {contract.unresolvedBoundaries.length > 0 && (
                  <div role="status" style={{ color: "var(--amber)", fontSize: 10.5, lineHeight: 1.5 }}>
                    {t("factory.draftSandbox.boundaries.unresolved", { items: contract.unresolvedBoundaries.map((item) => `${item.event} (${item.producers.join("/")})`).join(", ") })}
                  </div>
                )}
                <textarea
                  id="factory-draft-sandbox-boundaries"
                  value={boundaryEventsText}
                  onChange={(event) => { setBoundaryEventsText(event.target.value); setError(""); }}
                  rows={7}
                  spellCheck={false}
                  disabled={Boolean(busy)}
                  placeholder={t("factory.draftSandbox.boundaries.placeholder")}
                  style={{ width: "100%", boxSizing: "border-box", resize: "vertical", padding: 10, border: "1px solid var(--border)", borderRadius: 7, background: "var(--panel-2)", color: "var(--text)", fontFamily: "var(--mono)", fontSize: 11, lineHeight: 1.5 }}
                />
              </section>

              {!parsed.ok && <div role="alert" style={{ color: "var(--red)", fontSize: 11.5 }}>{parsed.message}</div>}
            </>
          ) : (
            <>
              <section style={{ display: "grid", gap: 8 }}>
                <div style={{ color: "var(--text)", fontSize: 12, fontWeight: 700 }}>{t("factory.draftSandbox.review.heading")}</div>
                <pre style={{ margin: 0, whiteSpace: "pre-wrap", overflowWrap: "anywhere", border: "1px solid var(--border)", borderRadius: 8, padding: 10, color: "var(--text-2)", fontSize: 10.5, lineHeight: 1.55 }}>{review.challenge.question}</pre>
                {review.testCoverage.backfilled.length > 0 && (
                  <div role="status" style={{ color: "var(--amber)", fontSize: 10.5, lineHeight: 1.5 }}>{t("factory.draftSandbox.review.backfilled", { items: review.testCoverage.backfilled.join(", ") })}</div>
                )}
                <details>
                  <summary style={{ cursor: "pointer", color: "var(--signal)", fontSize: 11.5 }}>{t("factory.draftSandbox.review.viewJson")}</summary>
                  <pre style={{ maxHeight: 300, overflow: "auto", whiteSpace: "pre-wrap", overflowWrap: "anywhere", border: "1px solid var(--border)", borderRadius: 8, padding: 10, color: "var(--text-2)", fontSize: 10.5, lineHeight: 1.5 }}>{JSON.stringify({ testCases: review.testCases, boundaryEvents: review.boundaryEvents }, null, 2)}</pre>
                </details>
                <label style={{ display: "flex", gap: 9, alignItems: "flex-start", padding: 10, border: "1px solid var(--border)", borderRadius: 8, color: "var(--text-2)", fontSize: 11.5, lineHeight: 1.5 }}>
                  <input type="checkbox" checked={confirmed} disabled={Boolean(busy)} onChange={(event) => setConfirmed(event.target.checked)} style={{ marginTop: 2 }} />
                  {t("factory.draftSandbox.review.consent")}
                </label>
              </section>
              {busy === "finish" && <div role="status" style={{ color: "var(--signal)", fontSize: 11.5, lineHeight: 1.55 }}>{t("factory.draftSandbox.review.finishing")}</div>}
            </>
          )}

          {error && <div role="alert" style={{ color: "var(--red)", fontSize: 11.5, lineHeight: 1.55 }}>{error}</div>}
        </div>

        <footer style={{ padding: "12px 16px", borderTop: "1px solid var(--border)", display: "flex", justifyContent: "space-between", gap: 8 }}>
          <div>{review && <Button tone="ghost" onClick={() => { setReview(null); setConfirmed(false); setError(""); }} disabled={Boolean(busy)}>{t("factory.draftSandbox.back")}</Button>}</div>
          <div style={{ display: "flex", gap: 8 }}>
            <Button tone="ghost" onClick={onClose} disabled={Boolean(busy)}>{t("factory.draftSandbox.cancel")}</Button>
            {!review ? (
              <Button tone="primary" onClick={() => void prepare()} disabled={!parsed.ok || Boolean(busy) || contract.entryEvents.length === 0}>{busy === "prepare" ? t("factory.draftSandbox.prepare.busy") : t("factory.draftSandbox.prepare.idle")}</Button>
            ) : (
              <Button tone="primary" onClick={() => void finish()} disabled={!confirmed || Boolean(busy) || !confirmOption}>{busy === "finish" ? t("factory.draftSandbox.finish.busy") : (confirmOption?.label ?? t("factory.draftSandbox.finish.idle"))}</Button>
            )}
          </div>
        </footer>
      </div>
    </ModalOverlay>
  );
}
