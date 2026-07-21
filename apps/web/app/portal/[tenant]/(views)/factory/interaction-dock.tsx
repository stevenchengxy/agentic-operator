"use client";

/**
 * #W3-UI — UNIFIED InteractionDock: ONE pinned surface for every pending brain↔human interaction
 * (澄清 clarify / 测试用例批准 approval / 边界事件分类 boundary). Previously the three interactions
 * rendered only inline in the transcript with three separate UI shapes; a long transcript could
 * scroll the pending question out of view, and clarify answers were free-text only.
 *
 * Design (mirrors the backend's tag routing, conductor.ts #W2-HITL):
 *   - Derives the CURRENT pending interaction from blocks (latest awaiting=true wins; STOP-priority
 *     order matches the conductor: clarify > approval > boundary).
 *   - Clarify options render VALUE-IZED (radio-style buttons + explicit "其它" free-text) — no more
 *     loose free-text parsing for multiple-choice questions.
 *   - One consistent frame + kind chip, always visible above the composer.
 * The transcript keeps its inline rendering as history; this dock is the ACTION surface.
 */

import { useEffect, useMemo, useState } from "react";
import { useI18n } from "@/app/portal/lib/preferences-context";
import type { Block } from "./model";
import { TestFixtureEditor } from "./test-fixture-editor";
import type { BinaryFixtureFile, BinaryFixturePlacement, FixtureAssetReceipt } from "./test-fixtures";

type ClarifyBlock = Extract<Block, { kind: "clarify" }>;
type TestBlock = Extract<Block, { kind: "testcases" }>;
type BoundaryBlock = Extract<Block, { kind: "boundarycases" }>;

export interface InteractionDockProps {
  blocks: Block[];
  onClarify: (interactionId: string, answer: string) => void | Promise<void>;
  onDecide: (interactionId: string, decision: "approve" | "regenerate", note?: string) => void | Promise<void>;
  onBoundary: (interactionId: string, evs: Array<{ event: string; kind: string; consumer?: string; payloadContract?: string }>) => void | Promise<void>;
  runId: string | null;
  onReplaceTestPayload: (interactionId: string, caseId: string, payload: Record<string, unknown>) => Promise<void>;
  onUploadTestBinary: (interactionId: string, input: { caseId: string; path: string; placement: BinaryFixturePlacement; file: BinaryFixtureFile }) => Promise<FixtureAssetReceipt>;
}

const kindChip = (label: string, color: string) => (
  <span style={{ fontSize: 10.5, fontWeight: 700, fontFamily: "var(--mono)", color, border: `1px solid ${color}`, borderRadius: 6, padding: "1px 8px", flexShrink: 0 }}>{label}</span>
);

// Must stay byte-compatible with agent-factory/coverage-waiver.ts. Each cell is
// percent-encoded so commas and branch separators inside ontology names cannot
// turn one acknowledged cell into several.
const coverageWaiverTag = (cells: readonly string[]) =>
  `[覆盖豁免:${[...new Set(cells.map((cell) => cell.trim()).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b))
    .map((cell) => encodeURIComponent(cell))
    .join(",")}]`;

export function InteractionDock({ blocks, onClarify, onDecide, onBoundary, runId, onReplaceTestPayload, onUploadTestBinary }: InteractionDockProps) {
  // `tr` (not `t`) because the approval branch aliases `pending.test` as `t`.
  const { t: tr } = useI18n();
  // Latest pending interaction of each kind; priority mirrors the conductor's gate order.
  const pending = useMemo(() => {
    const rev = [...blocks].reverse();
    const clarify = rev.find((b): b is ClarifyBlock => b.kind === "clarify" && b.awaiting);
    if (clarify) return { kind: "clarify" as const, clarify };
    const test = rev.find((b): b is TestBlock => b.kind === "testcases" && b.awaiting);
    if (test) return { kind: "approval" as const, test };
    const boundary = rev.find((b): b is BoundaryBlock => b.kind === "boundarycases" && b.awaiting);
    if (boundary) return { kind: "boundary" as const, boundary };
    return null;
  }, [blocks]);

  const [otherText, setOtherText] = useState("");
  const [note, setNote] = useState("");
  const [boundaryPick, setBoundaryPick] = useState<Record<string, string>>({});
  const [sent, setSent] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [waiverConfirmed, setWaiverConfirmed] = useState(false);
  const [fixtureSubmitted, setFixtureSubmitted] = useState(false);

  const activeId = pending?.kind === "clarify"
    ? pending.clarify.interactionId ?? null
    : pending?.kind === "approval"
      ? pending.test.interactionId ?? null
      : pending?.boundary.interactionId ?? null;
  useEffect(() => {
    setOtherText("");
    setNote("");
    setBoundaryPick({});
    setSent(null);
    setSending(false);
    setSubmitError("");
    setWaiverConfirmed(false);
    setFixtureSubmitted(false);
  }, [activeId]);

  if (!pending) return null;
  const submitted = sent === activeId;
  const missingExactId = !activeId;

  const submit = async (operation: () => void | Promise<void>) => {
    if (sending || submitted || !activeId) return;
    setSending(true);
    setSubmitError("");
    try {
      await operation();
      setSent(activeId);
    } catch (error) {
      setSubmitError(error instanceof Error && error.message ? error.message : tr("factory.interactionDock.submitErrorRetry"));
    } finally {
      setSending(false);
    }
  };

  const frame = (title: string, chip: React.ReactNode, body: React.ReactNode) => (
    <div style={{ border: "1px solid var(--signal)", borderRadius: 10, padding: "10px 12px", margin: "0 12px 8px", background: "var(--panel-2)", boxShadow: "0 0 0 1px rgba(208,255,0,.08)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
        {chip}
        <span style={{ fontSize: 12.5, fontWeight: 700, color: "var(--text)" }}>{title}</span>
        <span style={{ marginLeft: "auto", fontSize: 10.5, color: "var(--text-3)", fontFamily: "var(--mono)" }}>{tr("factory.interactionDock.brainPaused")}</span>
      </div>
      {body}
      {missingExactId && <div role="alert" style={{ marginTop: 7, color: "var(--amber)", fontSize: 11.5 }}>{tr("factory.interactionDock.legacyCardError")}</div>}
      {sending && <div role="status" style={{ marginTop: 7, color: "var(--text-3)", fontSize: 11 }}>{tr("factory.interactionDock.submitting")}</div>}
      {submitted && <div role="status" style={{ marginTop: 7, color: "var(--green)", fontSize: 11 }}>{tr("factory.interactionDock.delivered")}</div>}
      {submitError && <div role="alert" style={{ marginTop: 7, color: "var(--red)", fontSize: 11.5 }}>{tr("factory.interactionDock.submitFailed", { error: submitError })}</div>}
    </div>
  );

  if (pending.kind === "clarify") {
    const c = pending.clarify;
    return frame(
      c.question,
      kindChip(tr("factory.interactionDock.chip.clarify"), "var(--blue)"),
      <div>
        {c.context && <div style={{ fontSize: 11.5, color: "var(--text-3)", marginBottom: 6 }}>{c.context}</div>}
        <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
          {(c.options ?? []).map((o) => (
            <button
              key={o.value}
              disabled={sending || submitted || missingExactId}
              onClick={() => void submit(() => onClarify(activeId!, o.value || o.label))}
              style={{ textAlign: "left", fontSize: 12.5, padding: "7px 10px", borderRadius: 8, cursor: sending ? "wait" : "pointer", opacity: sending ? 0.6 : 1, border: `1px solid ${o.recommended ? "var(--signal)" : "var(--border)"}`, background: "var(--panel)", color: "var(--text)" }}
            >
              {o.label}{o.recommended ? <span style={{ marginLeft: 8, fontSize: 10, color: "var(--signal)" }}>{tr("factory.interactionDock.recommended")}</span> : null}
            </button>
          ))}
          <div style={{ display: "flex", gap: 6 }}>
            <input
              value={otherText}
              onChange={(e) => setOtherText(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && otherText.trim() && !sending && !submitted && activeId) void submit(() => onClarify(activeId, otherText.trim())); }}
              placeholder={c.options?.length ? tr("factory.interactionDock.otherPlaceholder") : tr("factory.interactionDock.answerPlaceholder")}
              style={{ flex: 1, fontSize: 12.5, padding: "7px 10px", background: "var(--panel)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 8 }}
            />
            <button disabled={!otherText.trim() || sending || submitted || missingExactId} onClick={() => void submit(() => onClarify(activeId!, otherText.trim()))} style={{ fontSize: 12, padding: "7px 12px", borderRadius: 8, border: "1px solid var(--border-2)", background: "var(--panel-3)", color: "var(--text)", cursor: sending ? "wait" : "pointer", opacity: sending || submitted ? 0.6 : 1 }}>{tr("factory.interactionDock.answerButton")}</button>
          </div>
        </div>
      </div>,
    );
  }

  if (pending.kind === "approval") {
    const t = pending.test;
    const coverageGaps = t.coverage?.uncoveredNeedingData ?? [];
    return frame(
      fixtureSubmitted ? tr("factory.interactionDock.fixtureSubmittedTitle") : tr("factory.interactionDock.approvalTitle", { count: t.cases.length }),
      kindChip(tr("factory.interactionDock.chip.testData"), "var(--amber)"),
      <div>
        {!fixtureSubmitted && (
          <div style={{ fontSize: 11.5, color: "var(--text-2)", marginBottom: 7, lineHeight: 1.45 }}>
            {tr("factory.interactionDock.approvalHint")}
          </div>
        )}
        <div style={{ fontSize: 11.5, color: "var(--text-2)", marginBottom: 6, display: "flex", gap: 8, flexWrap: "wrap" }}>
          {t.cases.slice(0, 6).map((c, i) => <span key={`${c.id}:${i}`} style={{ fontFamily: "var(--mono)", fontSize: 10.5, border: "1px solid var(--border)", borderRadius: 6, padding: "1px 7px", color: "var(--text-2)" }}>{c.kind}·{c.name.slice(0, 24)}</span>)}
          {t.cases.length > 6 && <span style={{ fontSize: 10.5, color: "var(--text-3)" }}>+{t.cases.length - 6}</span>}
        </div>
        <div style={{ maxHeight: 330, overflow: "auto", margin: "7px 0", display: "flex", flexDirection: "column", gap: 6 }}>
          {t.cases.map((testCase, index) => (
            <div key={`${testCase.id}:${index}`} style={{ border: "1px solid var(--border)", borderRadius: 8, padding: "7px 9px", background: "var(--panel)" }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 7 }}>
                <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text)" }}>{testCase.name}</span>
                <span style={{ marginLeft: "auto", fontSize: 9.5, color: testCase.id ? "var(--text-3)" : "var(--red)", fontFamily: "var(--mono)" }}>{testCase.id || tr("factory.interactionDock.missingCaseId")}</span>
              </div>
              <TestFixtureEditor
                testCase={testCase}
                disabled={sending || submitted || missingExactId || fixtureSubmitted}
                binaryDisabledReason={!runId ? tr("factory.interactionDock.binaryDisabledNoRunId") : undefined}
                onReplacePayload={async (caseId, payload) => {
                  await onReplaceTestPayload(activeId!, caseId, payload);
                  setFixtureSubmitted(true);
                }}
                onUploadBinary={async (input) => {
                  const receipt = await onUploadTestBinary(activeId!, input);
                  setFixtureSubmitted(true);
                  return receipt;
                }}
              />
            </div>
          ))}
        </div>
        {fixtureSubmitted && (
          <div role="status" style={{ margin: "7px 0", padding: "7px 9px", border: "1px solid var(--blue)", borderRadius: 7, color: "var(--blue)", fontSize: 11.5, lineHeight: 1.45 }}>
            {tr("factory.interactionDock.fixtureSubmittedNotice")}
          </div>
        )}
        {coverageGaps.length > 0 && (
          <label style={{ display: "flex", alignItems: "flex-start", gap: 8, margin: "8px 0", padding: "8px 10px", border: "1px solid var(--amber)", borderRadius: 8, color: "var(--amber)", fontSize: 11.5, lineHeight: 1.45, cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={waiverConfirmed}
              disabled={sending || submitted || fixtureSubmitted}
              onChange={(event) => setWaiverConfirmed(event.target.checked)}
              style={{ marginTop: 2 }}
            />
            <span>
              {tr("factory.interactionDock.waiverConsent")}
              <span style={{ display: "block", marginTop: 3, fontFamily: "var(--mono)", color: "var(--text-2)" }}>{coverageGaps.join(" · ")}</span>
            </span>
          </label>
        )}
        <div style={{ display: "flex", gap: 6 }}>
          <button
            disabled={sending || submitted || missingExactId || fixtureSubmitted || (coverageGaps.length > 0 && !waiverConfirmed)}
            onClick={() => void submit(() => onDecide(activeId!, "approve", coverageGaps.length ? coverageWaiverTag(coverageGaps) : undefined))}
            title={coverageGaps.length > 0 && !waiverConfirmed ? tr("factory.interactionDock.waiverRequiredTitle") : undefined}
            style={{ fontSize: 12.5, fontWeight: 700, padding: "7px 14px", borderRadius: 8, border: "1px solid var(--green)", background: "rgba(66,211,146,.12)", color: "var(--green)", cursor: sending ? "wait" : "pointer", opacity: sending || submitted || fixtureSubmitted || (coverageGaps.length > 0 && !waiverConfirmed) ? 0.5 : 1 }}
          >{tr("factory.interactionDock.runTrialButton")}</button>
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder={tr("factory.interactionDock.reworkNotePlaceholder")} style={{ flex: 1, fontSize: 12, padding: "7px 10px", background: "var(--panel)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 8 }} />
          <button disabled={sending || submitted || missingExactId || fixtureSubmitted} onClick={() => void submit(() => onDecide(activeId!, "regenerate", note.trim() || undefined))} style={{ fontSize: 12.5, padding: "7px 12px", borderRadius: 8, border: "1px solid var(--amber)", background: "transparent", color: "var(--amber)", cursor: sending ? "wait" : "pointer", opacity: sending || submitted || fixtureSubmitted ? 0.6 : 1 }}>{tr("factory.interactionDock.regenerateButton")}</button>
        </div>
      </div>,
    );
  }

  const b = pending.boundary;
  const KINDS = [
    { v: "external", label: tr("factory.interactionDock.boundaryKind.external") },
    { v: "terminal", label: tr("factory.interactionDock.boundaryKind.terminal") },
    { v: "break", label: tr("factory.interactionDock.boundaryKind.break") },
  ];
  return frame(
    tr("factory.interactionDock.boundaryTitle", { count: b.proposals.length }),
    kindChip(tr("factory.interactionDock.chip.boundary"), "var(--violet)"),
    <div>
      <div style={{ display: "flex", flexDirection: "column", gap: 5, marginBottom: 8 }}>
        {b.proposals.map((p) => (
          <div key={p.event} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
            <span style={{ fontFamily: "var(--mono)", color: "var(--text)", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }} title={p.why}>{p.event}</span>
            <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
              {KINDS.map((k) => {
                const picked = (boundaryPick[p.event] ?? p.suggestedKind) === k.v;
                return (
                  <button key={k.v} disabled={missingExactId || sending || submitted} onClick={() => setBoundaryPick((m) => ({ ...m, [p.event]: k.v }))} style={{ fontSize: 10.5, padding: "3px 8px", borderRadius: 6, cursor: "pointer", border: `1px solid ${picked ? "var(--signal)" : "var(--border)"}`, background: picked ? "var(--panel-3)" : "transparent", color: picked ? "var(--text)" : "var(--text-3)" }}>
                    {k.label}{p.suggestedKind === k.v ? tr("factory.interactionDock.suggestedSuffix") : ""}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      <button
        disabled={sending || submitted || missingExactId}
        onClick={() => void submit(() => onBoundary(activeId!, b.proposals.map((p) => ({ event: p.event, kind: boundaryPick[p.event] ?? p.suggestedKind, consumer: p.consumer, payloadContract: p.payloadContract }))))}
        style={{ fontSize: 12.5, fontWeight: 700, padding: "7px 14px", borderRadius: 8, border: "1px solid var(--signal)", background: "rgba(208,255,0,.1)", color: "var(--signal)", cursor: sending ? "wait" : "pointer", opacity: sending || submitted ? 0.6 : 1 }}
      >
        {tr("factory.interactionDock.submitClassificationButton")}
      </button>
    </div>,
  );
}
