"use client";

import { useMemo, useState } from "react";
import { Button, ModalOverlay } from "@/app/portal/components";
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
  const [testCasesText, setTestCasesText] = useState(() => draftSandboxTestTemplate(contract));
  const [boundaryEventsText, setBoundaryEventsText] = useState("[]");
  const [review, setReview] = useState<DraftSandboxReview | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState<"prepare" | "finish" | null>(null);
  const [error, setError] = useState("");
  const parsed = useMemo(
    () => parseDraftSandboxSubmission(testCasesText, boundaryEventsText),
    [boundaryEventsText, testCasesText],
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
    <ModalOverlay onClose={() => { if (!busy) onClose(); }} ariaLabel="为 Agent 草稿重新运行隔离沙箱">
      <div style={{ width: "min(1020px, 95vw)", maxHeight: "94vh", display: "flex", flexDirection: "column", overflow: "hidden", border: "1px solid var(--border)", borderRadius: 12, background: "var(--panel)", boxShadow: "0 24px 70px rgba(0,0,0,.35)" }}>
        <header style={{ padding: "14px 16px", borderBottom: "1px solid var(--border)", display: "flex", gap: 12, alignItems: "flex-start" }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ color: "var(--text)", fontSize: 14, fontWeight: 700 }}>{review ? "确认一次性沙箱审查" : "填写真实沙箱测试输入"}</div>
            <div className="mono" style={{ marginTop: 4, color: "var(--text-3)", fontSize: 10.5, overflowWrap: "anywhere" }}>
              {contract.scope.tenantSlug} / {contract.scope.domain} / {contract.scope.slug} / {contract.scope.versionId}
            </div>
          </div>
          <Button small tone="ghost" icon="x" onClick={onClose} disabled={Boolean(busy)}>关闭</Button>
        </header>

        <div style={{ overflow: "auto", padding: 16, display: "grid", gap: 14 }}>
          <div role="note" style={{ padding: "10px 12px", border: "1px solid var(--amber)", borderRadius: 8, color: "var(--amber)", background: "var(--panel-2)", fontSize: 11.5, lineHeight: 1.6 }}>
            这会测试整个不可变版本里的 {contract.specsCount} 个 Agent，不只是当前这一张卡。每次确认都会创建一个全新的 Inngest 测试 App；成功、失败或中断都会进入删除和缺席验证。测试 App 不会变成正式部署。
          </div>

          {!review ? (
            <>
              <section style={{ display: "grid", gap: 7 }}>
                <div style={{ color: "var(--text)", fontSize: 12, fontWeight: 700 }}>Ontology 给出的外部入口</div>
                {contract.entryEvents.length ? contract.entryEvents.map((entry) => (
                  <div key={entry.event} style={{ border: "1px solid var(--border)", borderRadius: 7, padding: "8px 10px", fontSize: 10.5, lineHeight: 1.5 }}>
                    <div className="mono" style={{ color: "var(--signal)" }}>{entry.event}</div>
                    <div style={{ color: "var(--text-3)" }}>{entry.fields.length ? entry.fields.map((field) => `${field.name}:${field.type}${field.required === false ? "?" : ""}`).join(" · ") : "Ontology 没有声明 payload 字段；请按真实平台事件填写。"}</div>
                  </div>
                )) : <div role="alert" style={{ color: "var(--red)", fontSize: 11.5 }}>这版没有可识别的外部入口，不能自动开始测试。</div>}
                <div style={{ color: "var(--text-3)", fontSize: 10.5, lineHeight: 1.55 }}>{contract.note}</div>
              </section>

              <section style={{ display: "grid", gap: 7 }}>
                <label htmlFor="factory-draft-sandbox-tests" style={{ color: "var(--text-2)", fontSize: 11.5, fontWeight: 650 }}>测试用例 JSON</label>
                <textarea
                  id="factory-draft-sandbox-tests"
                  value={testCasesText}
                  onChange={(event) => { setTestCasesText(event.target.value); setError(""); }}
                  rows={18}
                  spellCheck={false}
                  disabled={Boolean(busy)}
                  style={{ width: "100%", boxSizing: "border-box", resize: "vertical", padding: 10, border: "1px solid var(--border)", borderRadius: 7, background: "var(--panel-2)", color: "var(--text)", fontFamily: "var(--mono)", fontSize: 11, lineHeight: 1.5 }}
                />
                <div style={{ color: "var(--text-3)", fontSize: 10.5, lineHeight: 1.5 }}>模板里的“请填写…”和 0/false 只是字段骨架，不是工厂猜出的业务数据。请换成你确认过的值，并按需要增加 reject、edge、fault 用例。</div>
              </section>

              <section style={{ display: "grid", gap: 7 }}>
                <label htmlFor="factory-draft-sandbox-boundaries" style={{ color: "var(--text-2)", fontSize: 11.5, fontWeight: 650 }}>边界事件 JSON</label>
                {contract.unresolvedBoundaries.length > 0 && (
                  <div role="status" style={{ color: "var(--amber)", fontSize: 10.5, lineHeight: 1.5 }}>
                    这些产出不在 Ontology 终态里，也没有内部消费者：{contract.unresolvedBoundaries.map((item) => `${item.event}（${item.producers.join("/")}）`).join("、")}。如果它们是外部交接或真实终态，请在下方明确写成 external/terminal；如果确实是断点，写 break 并先修代码。
                  </div>
                )}
                <textarea
                  id="factory-draft-sandbox-boundaries"
                  value={boundaryEventsText}
                  onChange={(event) => { setBoundaryEventsText(event.target.value); setError(""); }}
                  rows={7}
                  spellCheck={false}
                  disabled={Boolean(busy)}
                  placeholder='[{"event":"EVENT_NAME","kind":"external","consumer":"平台名称","payloadContract":"字段说明"}]'
                  style={{ width: "100%", boxSizing: "border-box", resize: "vertical", padding: 10, border: "1px solid var(--border)", borderRadius: 7, background: "var(--panel-2)", color: "var(--text)", fontFamily: "var(--mono)", fontSize: 11, lineHeight: 1.5 }}
                />
              </section>

              {!parsed.ok && <div role="alert" style={{ color: "var(--red)", fontSize: 11.5 }}>{parsed.message}</div>}
            </>
          ) : (
            <>
              <section style={{ display: "grid", gap: 8 }}>
                <div style={{ color: "var(--text)", fontSize: 12, fontWeight: 700 }}>服务端重算后的完整审查内容</div>
                <pre style={{ margin: 0, whiteSpace: "pre-wrap", overflowWrap: "anywhere", border: "1px solid var(--border)", borderRadius: 8, padding: 10, color: "var(--text-2)", fontSize: 10.5, lineHeight: 1.55 }}>{review.challenge.question}</pre>
                {review.testCoverage.backfilled.length > 0 && (
                  <div role="status" style={{ color: "var(--amber)", fontSize: 10.5, lineHeight: 1.5 }}>服务端按契约补了这些确定性覆盖项：{review.testCoverage.backfilled.join("、")}。它们已经显示在下面，必须和其他用例一起确认。</div>
                )}
                <details>
                  <summary style={{ cursor: "pointer", color: "var(--signal)", fontSize: 11.5 }}>查看将真正投递的完整测试 JSON</summary>
                  <pre style={{ maxHeight: 300, overflow: "auto", whiteSpace: "pre-wrap", overflowWrap: "anywhere", border: "1px solid var(--border)", borderRadius: 8, padding: 10, color: "var(--text-2)", fontSize: 10.5, lineHeight: 1.5 }}>{JSON.stringify({ testCases: review.testCases, boundaryEvents: review.boundaryEvents }, null, 2)}</pre>
                </details>
                <label style={{ display: "flex", gap: 9, alignItems: "flex-start", padding: 10, border: "1px solid var(--border)", borderRadius: 8, color: "var(--text-2)", fontSize: 11.5, lineHeight: 1.5 }}>
                  <input type="checkbox" checked={confirmed} disabled={Boolean(busy)} onChange={(event) => setConfirmed(event.target.checked)} style={{ marginTop: 2 }} />
                  我已核对这版代码、事件、工具、边界和上面的完整测试 payload；我明白需要推理时，这些测试数据会经内部代理发送给目标 tenant 配置的真实模型提供商。模型调用会单独记账，externalLiveCalls=0 只代表外部工具没有直连。我只批准创建这一次临时沙箱，不代表批准晋升或真实外部写操作。
                </label>
              </section>
              {busy === "finish" && <div role="status" style={{ color: "var(--signal)", fontSize: 11.5, lineHeight: 1.55 }}>正在创建独立 App、投递用例、观察整链并强制清理。这个过程可能需要几分钟，请不要重复提交。</div>}
            </>
          )}

          {error && <div role="alert" style={{ color: "var(--red)", fontSize: 11.5, lineHeight: 1.55 }}>{error}</div>}
        </div>

        <footer style={{ padding: "12px 16px", borderTop: "1px solid var(--border)", display: "flex", justifyContent: "space-between", gap: 8 }}>
          <div>{review && <Button tone="ghost" onClick={() => { setReview(null); setConfirmed(false); setError(""); }} disabled={Boolean(busy)}>返回修改测试输入</Button>}</div>
          <div style={{ display: "flex", gap: 8 }}>
            <Button tone="ghost" onClick={onClose} disabled={Boolean(busy)}>取消</Button>
            {!review ? (
              <Button tone="primary" onClick={() => void prepare()} disabled={!parsed.ok || Boolean(busy) || contract.entryEvents.length === 0}>{busy === "prepare" ? "正在重算审查…" : "准备沙箱审查"}</Button>
            ) : (
              <Button tone="primary" onClick={() => void finish()} disabled={!confirmed || Boolean(busy) || !confirmOption}>{busy === "finish" ? "正在运行并清理…" : (confirmOption?.label ?? "批准并运行一次沙箱")}</Button>
            )}
          </div>
        </footer>
      </div>
    </ModalOverlay>
  );
}
