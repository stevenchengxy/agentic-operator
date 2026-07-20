"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, useToast } from "@/app/portal/components";
import { ModalOverlay } from "@/app/portal/components/Modal";
import { tenantHeader } from "@/lib/hooks/tenant-header";
import { useAgentFactoryDomains } from "@/lib/hooks/useAgentFactoryDomains";
import { activeRunKey } from "@/lib/hooks/useBrainStream";
import {
  decodeFactoryResponse,
  factoryNetworkFailure,
  type FactoryApiResult,
} from "../../factory/factory-api";
import { isFactoryRunStartReceipt } from "../../factory/factory-run-start";
import {
  factoryConversationStorageKey,
  parseProductionReworkPreview,
  type ProductionReworkPreview,
} from "./production-rework";

interface ProductionReworkControlProps {
  tenant: string;
  runId: string;
  agentSlug: string;
  runStatus: string;
  testRun: boolean;
}

async function factoryRequest<T>(
  tenant: string,
  path: string,
  init: RequestInit,
): Promise<FactoryApiResult<T>> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...tenantHeader(),
    "x-agentic-tenant": tenant,
    ...(init.headers as Record<string, string> | undefined),
  };
  try {
    const response = await fetch(path, {
      credentials: "same-origin",
      ...init,
      headers,
    });
    return await decodeFactoryResponse<T>(response);
  } catch (error) {
    return factoryNetworkFailure(error);
  }
}

const percent = (value: number): string =>
  `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`;

/** A two-stage production rework control: prepare/preview is read-only; only
 * the explicit confirmation inside the preview calls runs/start. */
export function ProductionReworkControl({
  tenant,
  runId,
  agentSlug,
  runStatus,
  testRun,
}: ProductionReworkControlProps) {
  const router = useRouter();
  const toast = useToast();
  const domainsQuery = useAgentFactoryDomains(tenant);
  const domain = domainsQuery.data?.boundDomain?.id ?? "";
  const [preparing, setPreparing] = useState(false);
  const [starting, setStarting] = useState(false);
  const [preview, setPreview] = useState<ProductionReworkPreview | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [startAttempted, setStartAttempted] = useState(false);
  const [error, setError] = useState("");

  if (testRun || runStatus !== "failed") return null;

  const prepare = async () => {
    if (!domain) {
      setError(
        domainsQuery.isError
          ? `无法读取 Agent 工厂的本体连接：${domainsQuery.error.message}`
          : "Agent 工厂尚未连接本体，不能判断这个线上 agent 属于哪个领域。",
      );
      return;
    }
    setPreparing(true);
    setError("");
    const result = await factoryRequest<unknown>(
      tenant,
      "/v1/agent-factory/rework-seed",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domain, slug: agentSlug, limit: 50 }),
      },
    );
    setPreparing(false);
    if (!result.ok) {
      setError(`准备返工证据失败：${result.message}`);
      return;
    }
    const parsed = parseProductionReworkPreview(result.data, runId, {
      domain,
      slug: agentSlug,
    });
    if (!parsed.ok) {
      setError(parsed.message);
      return;
    }
    setConfirmed(false);
    setStartAttempted(false);
    setPreview(parsed.preview);
  };

  const start = async () => {
    if (
      !preview ||
      !confirmed ||
      startAttempted ||
      preview.startRequest.started !== false
    ) return;
    // A lost HTTP response is ambiguous: the server may already have created
    // the run. Never let the same preview double-submit in that state.
    setStartAttempted(true);
    setStarting(true);
    setError("");
    const result = await factoryRequest<unknown>(
      tenant,
      "/v1/agent-factory/runs/start",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          domain: preview.startRequest.domain,
          goal: preview.startRequest.goal,
        }),
      },
    );
    setStarting(false);
    if (!result.ok) {
      setError(`启动返工会话失败：${result.message}`);
      return;
    }
    if (
      result.status !== 202 ||
      !isFactoryRunStartReceipt(result.data) ||
      result.data.mode !== "started"
    ) {
      setError(
        "服务端没有返回新的返工会话启动回执；请到 Agent 工厂历史运行核对，页面不会再次提交。",
      );
      return;
    }

    let savedLocally = true;
    try {
      localStorage.setItem(
        factoryConversationStorageKey(tenant, preview.domain),
        result.data.runId,
      );
      localStorage.setItem(activeRunKey(tenant), result.data.runId);
    } catch {
      savedLocally = false;
    }
    toast({
      tone: "signal",
      title: "返工会话已启动",
      description: savedLocally
        ? `会话 ${result.data.runId} 已创建；它会先询问你的人工诊断，不会自动晋升。`
        : `会话 ${result.data.runId} 已创建，但浏览器没能保存会话编号；请从 Agent 工厂历史运行打开。`,
    });
    setPreview(null);
    router.push(`/portal/${tenant}/factory` as never);
  };

  return (
    <>
      <Button
        small
        tone="ghost"
        disabled={preparing || domainsQuery.isLoading || !agentSlug}
        onClick={() => void prepare()}
      >
        {preparing ? "准备证据中…" : "用此失败运行准备返工"}
      </Button>
      {error && !preview && (
        <div
          role="alert"
          style={{
            flexBasis: "100%",
            color: "var(--red)",
            fontSize: 11,
            lineHeight: 1.45,
          }}
        >
          {error}
        </div>
      )}

      {preview && (
        <ModalOverlay
          ariaLabel="确认是否启动生产返工会话"
          onClose={() => {
            if (!starting) {
              setPreview(null);
              setConfirmed(false);
              setError("");
            }
          }}
        >
          <div
            style={{
              width: "min(680px, calc(100vw - 32px))",
              maxHeight: "min(760px, calc(100vh - 32px))",
              overflow: "auto",
              border: "1px solid var(--border)",
              borderRadius: 10,
              background: "var(--panel)",
              boxShadow: "0 18px 70px rgba(0,0,0,.45)",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "14px 16px",
                borderBottom: "1px solid var(--border)",
              }}
            >
              <div style={{ flex: 1 }}>
                <div style={{ color: "var(--text)", fontSize: 15, fontWeight: 700 }}>
                  返工预览 · {preview.slug}
                </div>
                <div
                  className="mono"
                  style={{ color: "var(--text-3)", fontSize: 10.5, marginTop: 2 }}
                >
                  {preview.seedId} · {preview.domain}
                </div>
              </div>
              <button
                aria-label="关闭返工预览"
                disabled={starting}
                onClick={() => setPreview(null)}
                style={{
                  border: "none",
                  background: "none",
                  color: "var(--text-3)",
                  cursor: starting ? "wait" : "pointer",
                  fontSize: 18,
                }}
              >
                ×
              </button>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 12, padding: 16 }}>
              <div
                style={{
                  padding: "10px 12px",
                  border: "1px solid var(--green)",
                  borderRadius: 8,
                  color: "var(--green)",
                  background: "var(--panel-2)",
                  fontSize: 12,
                  lineHeight: 1.55,
                }}
              >
                当前只是证据预览。服务端明确返回 <code>started=false</code>，尚未创建或运行返工会话。
              </div>

              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
                  gap: 8,
                  fontSize: 11.5,
                }}
              >
                <PreviewField label="当前失败运行" value={preview.selectedRun.runId} />
                <PreviewField label="immutable draft" value={preview.draftVersionId} />
                <PreviewField
                  label="证据窗口"
                  value={`${preview.evidenceTotal} 次生产运行 · ${preview.evidenceFailed} 次失败`}
                />
                <PreviewField label="窗口失败率" value={percent(preview.failureRate)} />
                <PreviewField
                  label="本次代码实际运行"
                  value={
                    preview.selectedRun.codeRan == null
                      ? "没有运行时回执"
                      : preview.selectedRun.codeRan
                        ? "是"
                        : "否"
                  }
                />
                <PreviewField
                  label="本次耗时"
                  value={
                    preview.selectedRun.durationMs == null
                      ? "—"
                      : `${preview.selectedRun.durationMs} ms`
                  }
                />
              </div>

              <div>
                <div style={{ color: "var(--text-3)", fontSize: 10.5, marginBottom: 4 }}>
                  当前失败
                </div>
                <div
                  className="mono"
                  style={{
                    padding: "8px 10px",
                    border: "1px solid var(--border)",
                    borderRadius: 7,
                    background: "var(--panel-2)",
                    color: "var(--red)",
                    fontSize: 11,
                    lineHeight: 1.5,
                    whiteSpace: "pre-wrap",
                    overflowWrap: "anywhere",
                  }}
                >
                  {preview.selectedRun.error ?? "运行失败，但没有错误文本。"}
                </div>
              </div>

              {preview.selectedRun.failedSteps.length > 0 && (
                <div>
                  <div style={{ color: "var(--text-3)", fontSize: 10.5, marginBottom: 4 }}>
                    失败步骤
                  </div>
                  {preview.selectedRun.failedSteps.map((step, index) => (
                    <div
                      key={`${step.name}-${index}`}
                      style={{
                        padding: "7px 9px",
                        borderTop: index ? "1px solid var(--border)" : undefined,
                        color: "var(--text-2)",
                        fontSize: 11,
                        lineHeight: 1.45,
                      }}
                    >
                      <strong>{step.name}</strong> · 尝试 {step.attempts} 次
                      {step.error ? ` · ${step.error}` : ""}
                    </div>
                  ))}
                </div>
              )}

              <div
                style={{
                  padding: "9px 11px",
                  border: "1px solid var(--border)",
                  borderRadius: 8,
                  background: "var(--panel-2)",
                  color: "var(--text-2)",
                  fontSize: 11.5,
                  lineHeight: 1.55,
                }}
              >
                确认后只会创建一个新的 Agent 工厂会话。它会先请你补充人工诊断；不会自动改线上 agent，也不会自动晋升。
              </div>

              <label
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 8,
                  color: "var(--text)",
                  fontSize: 11.5,
                  lineHeight: 1.5,
                  cursor: starting ? "wait" : "pointer",
                }}
              >
                <input
                  type="checkbox"
                  checked={confirmed}
                  disabled={starting}
                  onChange={(event) => setConfirmed(event.target.checked)}
                  style={{ marginTop: 2 }}
                />
                我确认：基于这次失败创建返工会话，并在会话里再次提供人工诊断；后续仍需测试、人工审查和显式晋升。
              </label>

              {error && (
                <div role="alert" style={{ color: "var(--red)", fontSize: 11.5 }}>
                  {error}
                </div>
              )}

              <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
                <Button
                  tone="ghost"
                  disabled={starting}
                  onClick={() => setPreview(null)}
                >
                  先不启动
                </Button>
                <Button
                  tone="primary"
                  disabled={!confirmed || starting || startAttempted}
                  onClick={() => void start()}
                >
                  {starting
                    ? "正在创建会话…"
                    : startAttempted
                      ? "已提交，请先核对历史运行"
                      : "确认并启动返工会话"}
                </Button>
              </div>
            </div>
          </div>
        </ModalOverlay>
      )}
    </>
  );
}

function PreviewField({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        padding: "8px 9px",
        border: "1px solid var(--border)",
        borderRadius: 7,
        background: "var(--panel-2)",
        minWidth: 0,
      }}
    >
      <div style={{ color: "var(--text-3)", fontSize: 9.5 }}>{label}</div>
      <div
        className="mono"
        style={{
          marginTop: 3,
          color: "var(--text)",
          overflowWrap: "anywhere",
        }}
      >
        {value}
      </div>
    </div>
  );
}
