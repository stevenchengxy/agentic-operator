"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, useToast } from "@/app/portal/components";
import { ModalOverlay } from "@/app/portal/components/Modal";
import {
  useI18n,
  type Translate,
} from "@/app/portal/lib/preferences-context";
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
  t: Translate,
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
    return await decodeFactoryResponse<T>(t, response);
  } catch (error) {
    return factoryNetworkFailure(t, error);
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
  const { t } = useI18n();
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
          ? t("runDetail.rework.error.domainReadFailed", {
              message: domainsQuery.error.message,
            })
          : t("runDetail.rework.error.ontologyNotConnected"),
      );
      return;
    }
    setPreparing(true);
    setError("");
    const result = await factoryRequest<unknown>(
      t,
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
      setError(
        t("runDetail.rework.error.seedFailed", { message: result.message }),
      );
      return;
    }
    const parsed = parseProductionReworkPreview(t, result.data, runId, {
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
      t,
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
      setError(
        t("runDetail.rework.error.startFailed", { message: result.message }),
      );
      return;
    }
    if (
      result.status !== 202 ||
      !isFactoryRunStartReceipt(result.data) ||
      result.data.mode !== "started"
    ) {
      setError(
        t("runDetail.rework.error.noStartReceipt"),
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
      title: t("runDetail.rework.toast.startedTitle"),
      description: savedLocally
        ? t("runDetail.rework.toast.startedSaved", {
            runId: result.data.runId,
          })
        : t("runDetail.rework.toast.startedNotSaved", {
            runId: result.data.runId,
          }),
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
        {preparing
          ? t("runDetail.rework.trigger.preparing")
          : t("runDetail.rework.trigger.label")}
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
          ariaLabel={t("runDetail.rework.modal.ariaLabel")}
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
                  {t("runDetail.rework.preview.heading", {
                    slug: preview.slug,
                  })}
                </div>
                <div
                  className="mono"
                  style={{ color: "var(--text-3)", fontSize: 10.5, marginTop: 2 }}
                >
                  {preview.seedId} · {preview.domain}
                </div>
              </div>
              <button
                aria-label={t("runDetail.rework.preview.closeAriaLabel")}
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
                {t("runDetail.rework.preview.evidenceNoticePrefix")}
                <code>started=false</code>
                {t("runDetail.rework.preview.evidenceNoticeSuffix")}
              </div>

              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
                  gap: 8,
                  fontSize: 11.5,
                }}
              >
                <PreviewField
                  label={t("runDetail.rework.field.selectedRun")}
                  value={preview.selectedRun.runId}
                />
                <PreviewField
                  label={t("runDetail.rework.field.immutableDraft")}
                  value={preview.draftVersionId}
                />
                <PreviewField
                  label={t("runDetail.rework.field.evidenceWindow")}
                  value={t("runDetail.rework.field.evidenceWindowValue", {
                    total: preview.evidenceTotal,
                    failed: preview.evidenceFailed,
                  })}
                />
                <PreviewField
                  label={t("runDetail.rework.field.windowFailureRate")}
                  value={percent(preview.failureRate)}
                />
                <PreviewField
                  label={t("runDetail.rework.field.codeRan")}
                  value={
                    preview.selectedRun.codeRan == null
                      ? t("runDetail.rework.value.noRuntimeReceipt")
                      : preview.selectedRun.codeRan
                        ? t("runDetail.rework.value.yes")
                        : t("runDetail.rework.value.no")
                  }
                />
                <PreviewField
                  label={t("runDetail.rework.field.duration")}
                  value={
                    preview.selectedRun.durationMs == null
                      ? "—"
                      : `${preview.selectedRun.durationMs} ms`
                  }
                />
              </div>

              <div>
                <div style={{ color: "var(--text-3)", fontSize: 10.5, marginBottom: 4 }}>
                  {t("runDetail.rework.preview.currentFailureLabel")}
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
                  {preview.selectedRun.error ??
                    t("runDetail.rework.preview.noErrorText")}
                </div>
              </div>

              {preview.selectedRun.failedSteps.length > 0 && (
                <div>
                  <div style={{ color: "var(--text-3)", fontSize: 10.5, marginBottom: 4 }}>
                    {t("runDetail.rework.preview.failedStepsLabel")}
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
                      <strong>{step.name}</strong> ·{" "}
                      {t("runDetail.rework.preview.stepAttempts", {
                        attempts: step.attempts,
                      })}
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
                {t("runDetail.rework.preview.confirmNotice")}
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
                {t("runDetail.rework.confirm.checkboxLabel")}
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
                  {t("runDetail.rework.confirm.cancel")}
                </Button>
                <Button
                  tone="primary"
                  disabled={!confirmed || starting || startAttempted}
                  onClick={() => void start()}
                >
                  {starting
                    ? t("runDetail.rework.confirm.creating")
                    : startAttempted
                      ? t("runDetail.rework.confirm.submitted")
                      : t("runDetail.rework.confirm.submit")}
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
