"use client";

import { useState } from "react";
import { Button, ModalOverlay } from "@/app/portal/components";
import { CodeBox } from "./atoms";

export interface PromotionPreviewData {
  versionId: string;
  slugs: string[];
  reviewChallenge: string;
  previewHash: string;
  liveManifestHash: string;
  candidateManifestHash: string;
  delta: {
    agents: { added: string[]; modified: string[]; unchanged: string[]; removed: string[] };
    events: { added: string[]; removed: string[] };
    tools: { added: string[]; removed: string[] };
    config: Array<{
      key: string;
      agentId: string;
      tool: string;
      change: "added" | "removed" | "modified";
      before?: unknown;
      after?: unknown;
    }>;
    contracts: Array<{
      agentId: string;
      change: "added" | "modified" | "unchanged";
      before?: unknown;
      after: unknown;
    }>;
  };
  evidence: {
    regressionPointersPresent: boolean;
    replayReady: boolean;
    promotionGateAdmission: boolean;
    promotionEligible: boolean;
    promotionEvidenceReady: boolean;
    promotionBlockers: string[];
    evidenceQualification: {
      schema: "agent-factory-regression-evidence-qualification/v1";
      replay: "sandbox_verified" | "blocked";
      promotion: "candidate" | "blocked";
      blockers: Array<{ code: string; detail: string }>;
    };
    regressionReplayRequiredAtPromotion: true;
    humanCodeAndDesignSignoffRequired: true;
  };
}

export interface PromotionCodeArtifact {
  slug: string;
  filename: string;
  code: string;
}

export interface PromotionApprovalResult {
  ok: boolean;
  message?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string");

/** Fail closed when the preview API omits any review surface or hash. */
export function isPromotionPreviewData(value: unknown): value is PromotionPreviewData {
  if (!isRecord(value) || !isRecord(value.delta) || !isRecord(value.evidence)) return false;
  const { agents, events, tools, config, contracts } = value.delta;
  if (!isRecord(agents) || !isRecord(events) || !isRecord(tools)) return false;
  return typeof value.versionId === "string" && value.versionId.length > 0
    && isStringArray(value.slugs) && value.slugs.length > 0
    && typeof value.reviewChallenge === "string" && value.reviewChallenge.length > 0
    && typeof value.previewHash === "string" && value.previewHash.length > 0
    && typeof value.liveManifestHash === "string" && value.liveManifestHash.length > 0
    && typeof value.candidateManifestHash === "string" && value.candidateManifestHash.length > 0
    && isStringArray(agents.added) && isStringArray(agents.modified)
    && isStringArray(agents.unchanged) && isStringArray(agents.removed)
    && isStringArray(events.added) && isStringArray(events.removed)
    && isStringArray(tools.added) && isStringArray(tools.removed)
    && Array.isArray(config) && Array.isArray(contracts)
    && typeof value.evidence.regressionPointersPresent === "boolean"
    && typeof value.evidence.replayReady === "boolean"
    && typeof value.evidence.promotionGateAdmission === "boolean"
    && typeof value.evidence.promotionEligible === "boolean"
    && typeof value.evidence.promotionEvidenceReady === "boolean"
    && isStringArray(value.evidence.promotionBlockers)
    && isRecord(value.evidence.evidenceQualification)
    && value.evidence.evidenceQualification.schema === "agent-factory-regression-evidence-qualification/v1"
    && (value.evidence.evidenceQualification.replay === "sandbox_verified" || value.evidence.evidenceQualification.replay === "blocked")
    && (value.evidence.evidenceQualification.promotion === "candidate" || value.evidence.evidenceQualification.promotion === "blocked")
    && Array.isArray(value.evidence.evidenceQualification.blockers)
    && value.evidence.regressionReplayRequiredAtPromotion === true
    && value.evidence.humanCodeAndDesignSignoffRequired === true;
}

const json = (value: unknown): string => JSON.stringify(value ?? null, null, 2);

function ChangeList({ title, added, removed }: { title: string; added: string[]; removed: string[] }) {
  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 10 }}>
      <div style={{ fontSize: 11, fontWeight: 650, color: "var(--text)", marginBottom: 6 }}>{title}</div>
      {added.length === 0 && removed.length === 0 ? (
        <div style={{ color: "var(--text-4)", fontSize: 10.5 }}>无变更</div>
      ) : (
        <div className="mono" style={{ display: "grid", gap: 3, fontSize: 10.5 }}>
          {added.map((item) => <div key={`add:${item}`} style={{ color: "var(--green)" }}>+ {item}</div>)}
          {removed.map((item) => <div key={`remove:${item}`} style={{ color: "var(--red)" }}>− {item}</div>)}
        </div>
      )}
    </div>
  );
}

export function PromotionReviewModal({
  preview,
  codeArtifacts,
  onClose,
  onApprove,
}: {
  preview: PromotionPreviewData;
  codeArtifacts: PromotionCodeArtifact[];
  onClose: () => void;
  onApprove: () => Promise<PromotionApprovalResult>;
}) {
  const [codeReviewed, setCodeReviewed] = useState(false);
  const [designReviewed, setDesignReviewed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const codeComplete = codeArtifacts.length === preview.slugs.length
    && codeArtifacts.every((artifact) => artifact.code.trim().length > 0);
  const canApprove = codeReviewed
    && designReviewed
    && codeComplete
    && preview.evidence.regressionPointersPresent
    && preview.evidence.replayReady
    && preview.evidence.promotionGateAdmission
    && preview.evidence.promotionEligible
    && preview.evidence.promotionEvidenceReady
    && preview.evidence.evidenceQualification.promotion === "candidate"
    && !submitting;

  async function approve() {
    if (!canApprove) return;
    setSubmitting(true);
    setError("");
    try {
      const result = await onApprove();
      if (!result.ok) {
        setError(result.message || "签核或晋升失败");
        return;
      }
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSubmitting(false);
    }
  }

  const changedContracts = preview.delta.contracts.filter((entry) => entry.change !== "unchanged");
  return (
    <ModalOverlay onClose={() => { if (!submitting) onClose(); }} ariaLabel="人工审阅并晋升智能体草稿">
      <div style={{ width: "min(1120px, 94vw)", maxHeight: "90vh", display: "flex", flexDirection: "column", overflow: "hidden", border: "1px solid var(--border)", borderRadius: 12, background: "var(--panel)", boxShadow: "0 24px 70px rgba(0,0,0,.35)" }}>
        <div style={{ padding: "14px 16px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "flex-start", gap: 12 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ color: "var(--text)", fontSize: 14, fontWeight: 700 }}>人工审阅 · 签核后晋升</div>
            <div className="mono" style={{ marginTop: 4, color: "var(--text-3)", fontSize: 10.5 }}>
              不可变版本 {preview.versionId} · {preview.slugs.length} 个草稿 · preview {preview.previewHash.slice(0, 12)}
            </div>
          </div>
          <Button small tone="ghost" icon="x" onClick={onClose} disabled={submitting}>关闭</Button>
        </div>

        <div style={{ overflow: "auto", padding: 16, display: "grid", gap: 14 }}>
          <div role="status" style={{ display: "flex", flexWrap: "wrap", gap: 7, fontSize: 10.5 }}>
            <span style={{ color: preview.evidence.replayReady ? "var(--green)" : "var(--red)" }}>
              {preview.evidence.replayReady ? "✓" : "⛔"} 回归重放
            </span>
            <span style={{ color: preview.evidence.promotionGateAdmission ? "var(--green)" : "var(--amber)" }}>
              {preview.evidence.promotionGateAdmission ? "✓" : "⛔"} 可进入 production commit gate
            </span>
            <span style={{ color: preview.evidence.promotionEligible ? "var(--green)" : "var(--amber)" }}>
              {preview.evidence.promotionEligible ? "✓ 当前生产证据就绪" : "⛔ 当前不能上线"}
            </span>
          </div>
          {!preview.evidence.regressionPointersPresent && (
            <div role="alert" style={{ padding: "9px 11px", border: "1px solid var(--red)", borderRadius: 8, color: "var(--red)", fontSize: 11.5 }}>
              当前版本没有不可变回归证据，服务端会拒绝晋升。请重新运行真实沙箱并完成交付。
            </div>
          )}
          {preview.evidence.replayReady && !preview.evidence.promotionEligible && (
            <div role="alert" style={{ padding: "9px 11px", border: "1px solid var(--amber)", borderRadius: 8, color: "var(--amber)", fontSize: 11.5 }}>
              沙箱编排已验证，当前不能上线。signed fixture 只证明回放与业务编排；最终资格还要通过当前 production profile、live probe 和写探针门禁。
              {preview.evidence.promotionBlockers.length > 0 && (
                <div style={{ marginTop: 5 }}>{preview.evidence.promotionBlockers.slice(0, 4).join("；")}</div>
              )}
            </div>
          )}

          <section aria-labelledby="promotion-design-heading" style={{ display: "grid", gap: 10 }}>
            <div id="promotion-design-heading" style={{ color: "var(--text)", fontSize: 12.5, fontWeight: 700 }}>1. 设计与运行清单差异</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 8 }}>
              <ChangeList title="Agent" added={[...preview.delta.agents.added, ...preview.delta.agents.modified.map((item) => `${item}（修改）`)]} removed={preview.delta.agents.removed} />
              <ChangeList title="事件" added={preview.delta.events.added} removed={preview.delta.events.removed} />
              <ChangeList title="工具" added={preview.delta.tools.added} removed={preview.delta.tools.removed} />
            </div>

            <details open style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 10 }}>
              <summary style={{ cursor: "pointer", color: "var(--text)", fontSize: 11.5, fontWeight: 650 }}>
                配置变更 · {preview.delta.config.length}
              </summary>
              <div style={{ display: "grid", gap: 8, marginTop: 9 }}>
                {preview.delta.config.length === 0 ? <div style={{ color: "var(--text-4)", fontSize: 10.5 }}>无配置变更</div> : preview.delta.config.map((entry) => (
                  <div key={`${entry.key}:${entry.change}`} style={{ borderTop: "1px solid var(--border)", paddingTop: 8 }}>
                    <div className="mono" style={{ color: "var(--text-2)", fontSize: 10.5 }}>{entry.change} · {entry.agentId} · {entry.tool}</div>
                    <pre style={{ margin: "6px 0 0", padding: 8, overflow: "auto", borderRadius: 6, background: "var(--panel-3)", color: "var(--text-2)", fontSize: 10, lineHeight: 1.5 }}>{json({ before: entry.before, after: entry.after })}</pre>
                  </div>
                ))}
              </div>
            </details>

            <details open style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 10 }}>
              <summary style={{ cursor: "pointer", color: "var(--text)", fontSize: 11.5, fontWeight: 650 }}>
                输入/输出与业务契约变更 · {changedContracts.length}
              </summary>
              <div style={{ display: "grid", gap: 8, marginTop: 9 }}>
                {changedContracts.length === 0 ? <div style={{ color: "var(--text-4)", fontSize: 10.5 }}>没有新增或修改的契约</div> : changedContracts.map((entry) => (
                  <div key={`${entry.agentId}:${entry.change}`} style={{ borderTop: "1px solid var(--border)", paddingTop: 8 }}>
                    <div className="mono" style={{ color: "var(--text-2)", fontSize: 10.5 }}>{entry.change} · {entry.agentId}</div>
                    <pre style={{ margin: "6px 0 0", padding: 8, overflow: "auto", borderRadius: 6, background: "var(--panel-3)", color: "var(--text-2)", fontSize: 10, lineHeight: 1.5 }}>{json({ before: entry.before, after: entry.after })}</pre>
                  </div>
                ))}
              </div>
            </details>
          </section>

          <section aria-labelledby="promotion-code-heading" style={{ display: "grid", gap: 10 }}>
            <div id="promotion-code-heading" style={{ color: "var(--text)", fontSize: 12.5, fontWeight: 700 }}>2. 此版本的实际可部署代码</div>
            {!codeComplete && (
              <div role="alert" style={{ color: "var(--red)", fontSize: 11.5 }}>未能读取所选版本的全部代码，签核已禁用。</div>
            )}
            {codeArtifacts.map((artifact) => (
              <details key={artifact.slug} open style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 10 }}>
                <summary className="mono" style={{ cursor: "pointer", color: "var(--text)", fontSize: 11 }}>{artifact.filename}</summary>
                <CodeBox code={artifact.code} />
              </details>
            ))}
          </section>

          <section style={{ display: "grid", gap: 8, padding: 12, border: "1px solid var(--border-2)", borderRadius: 8, background: "var(--panel-2)" }}>
            <label style={{ display: "flex", gap: 9, alignItems: "flex-start", color: "var(--text-2)", fontSize: 11.5, lineHeight: 1.5 }}>
              <input type="checkbox" checked={codeReviewed} onChange={(event) => setCodeReviewed(event.target.checked)} disabled={!codeComplete || submitting} style={{ marginTop: 2 }} />
              我已逐一审阅上方所选不可变版本的全部实际可部署代码。
            </label>
            <label style={{ display: "flex", gap: 9, alignItems: "flex-start", color: "var(--text-2)", fontSize: 11.5, lineHeight: 1.5 }}>
              <input type="checkbox" checked={designReviewed} onChange={(event) => setDesignReviewed(event.target.checked)} disabled={submitting} style={{ marginTop: 2 }} />
              我已审阅 live → candidate 的 Agent、事件、工具、配置和业务契约差异。
            </label>
            <div className="mono" style={{ color: "var(--text-4)", fontSize: 9.5 }}>
              当前线上 {preview.liveManifestHash.slice(0, 12)} → 候选 {preview.candidateManifestHash.slice(0, 12)}；晋升时服务端会再次校验哈希并重放回归。
            </div>
          </section>

          {error && <div role="alert" style={{ color: "var(--red)", fontSize: 11.5 }}>{error}</div>}
        </div>

        <div style={{ padding: "12px 16px", borderTop: "1px solid var(--border)", display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <Button tone="ghost" onClick={onClose} disabled={submitting}>取消</Button>
          <Button tone="primary" icon="check" onClick={() => void approve()} disabled={!canApprove}>
            {submitting ? "服务端签核并晋升中…" : "签核并晋升"}
          </Button>
        </div>
      </div>
    </ModalOverlay>
  );
}
