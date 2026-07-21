"use client";

import Link from "next/link";
import React, {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { Icon, ViewHeader } from "@/app/portal/components";
import { useI18n, type Translate } from "@/app/portal/lib/preferences-context";
import { useTenant } from "@/app/portal/lib/use-tenant";
import { ApiResponseError } from "@/lib/api-response";
import { useInvokeAgent } from "@/lib/hooks/useAgents";
import { reasoningAgentHref } from "@/lib/reasoning-workspace";
import {
  useReasoningAgentContext,
  useReasoningAgentRun,
  type ReasoningRunResponse,
  type ReasoningRunStep,
} from "@/lib/hooks/useReasoningAgentContext";
import {
  isActiveReasoningStatus,
  isReasoningRunStalled,
  isTerminalReasoningPollError,
  reasoningRunStallDeadlineMs,
} from "@/lib/hooks/reasoning-run-liveness";
import {
  parseReasoningOutput,
  type CompiledPrompt,
  type QualifiedAgentRunReceipt,
  type ReasoningHarnessPlan,
  type ReasoningOutput,
  type RetrievedRule,
  type RuleQueryExecution,
  type RuleSelectionToolData,
  type RuleAssessment,
  type RuntimeAgent,
  type RuntimeStatus,
} from "./contracts";
import {
  projectReasoningToolAudit,
  type ReasoningToolAudit,
} from "./audit-projection";
import {
  hasVerifiedSemanticLinkReceipt,
  humanizeMatchReason,
  projectPromptReceiptBinding,
  projectSelectionFunnel,
  projectVisibleEvidenceAnalysis,
  publicAuditPayload,
  type VisibleEvidenceAnalysis,
} from "./audit-view";
import {
  humanStepName,
  projectRuntimeAgents,
  RUNTIME_EDGES,
} from "./run-projection";
import { getReasoningTestExamples } from "./examples";
import styles from "./reasoning-agent.module.css";

interface ChatMessage {
  id: string;
  role: "assistant" | "user";
  text: string;
  output?: ReasoningOutput;
  runId?: string;
  error?: boolean;
}

const EMPTY_CONTEXT = {
  candidate: "",
  resume: "",
  jobRequisition: "",
  jd: "",
  genericInputs: "",
};

type BusinessContextKey = keyof typeof EMPTY_CONTEXT;
type InputStatus = "empty" | "ready" | "invalid";
type InspectorTab = "input" | "flow" | "rules" | "logs";

const BUSINESS_CONTEXT_KEYS = Object.keys(
  EMPTY_CONTEXT,
) as BusinessContextKey[];
const INSPECTOR_TAB_ORDER: InspectorTab[] = ["input", "flow", "rules", "logs"];

function inputStatus(key: BusinessContextKey, value: string): InputStatus {
  const trimmed = value.trim();
  if (!trimmed) return "empty";
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (
      key === "genericInputs" &&
      (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    ) {
      return "invalid";
    }
    return "ready";
  } catch {
    return "invalid";
  }
}

function parseOptionalJson(label: string, value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${label}: ${detail}`);
  }
}

function statusColor(status: RuntimeStatus | RuleAssessment["status"]): string {
  if (status === "completed" || status === "satisfied") return "var(--green)";
  if (status === "blocked" || status === "violated") return "var(--red)";
  if (status === "running") return "var(--signal)";
  if (
    status === "warning" ||
    status === "optional_unmet" ||
    status === "insufficient_evidence"
  ) {
    return "var(--amber)";
  }
  return "var(--text-3)";
}

function statusLabel(status: string, t: Translate): string {
  const keyByStatus: Record<string, string> = {
    completed: "reasoningAgent.page.status.completed",
    warning: "reasoningAgent.page.status.warning",
    blocked: "reasoningAgent.page.status.blocked",
    running: "reasoningAgent.page.status.running",
    waiting: "reasoningAgent.page.status.waiting",
    queued: "reasoningAgent.page.status.queued",
    ok: "reasoningAgent.page.status.ok",
    failed: "reasoningAgent.page.status.failed",
    cancelled: "reasoningAgent.page.status.cancelled",
    active: "reasoningAgent.page.status.active",
    satisfied: "reasoningAgent.page.status.satisfied",
    violated: "reasoningAgent.page.status.violated",
    optional_unmet: "reasoningAgent.page.status.optionalUnmet",
    not_applicable: "reasoningAgent.page.status.notApplicable",
    insufficient_evidence: "reasoningAgent.page.status.insufficientEvidence",
  };
  const key = keyByStatus[status];
  return key ? t(key) : status;
}

function tokenIoLabel(
  tokensIn: number | null | undefined,
  tokensOut: number | null | undefined,
  t: Translate,
): string {
  return t("reasoningAgent.page.format.tokenIo", {
    input: tokensIn ?? 0,
    output: tokensOut ?? 0,
  });
}

function decisionColor(decision: ReasoningOutput["decision"]): string {
  if (decision === "eligible") return "var(--green)";
  if (decision === "ineligible") return "var(--red)";
  return "var(--amber)";
}

function scopeSourceLabel(source: string | undefined, t: Translate): string {
  if (source === "job_requisition")
    return t("reasoningAgent.page.scopeSource.jobRequisition");
  if (source === "jd") return t("reasoningAgent.page.scopeSource.jd");
  if (source === "explicit_fallback")
    return t("reasoningAgent.page.scopeSource.explicitFallback");
  if (source === "generic_inputs_fallback")
    return t("reasoningAgent.page.scopeSource.genericInputsFallback");
  if (source === "missing") return t("reasoningAgent.page.scopeSource.missing");
  return t("reasoningAgent.page.scopeSource.unknown");
}

export default function ReasoningAgentPage() {
  const tenant = useTenant();
  const { language, t } = useI18n();
  const reasoningTestExamples = useMemo(() => getReasoningTestExamples(t), [t]);
  const invoke = useInvokeAgent();
  const reasoningContextQuery = useReasoningAgentContext(tenant);
  const [prompt, setPrompt] = useState("");
  const [action, setAction] = useState("");
  const [scenario, setScenario] = useState("");
  const [exampleId, setExampleId] = useState<string>(
    reasoningTestExamples[0]?.id ?? "",
  );
  const [context, setContext] = useState(EMPTY_CONTEXT);
  const [jsonError, setJsonError] = useState("");
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [activeInput, setActiveInput] = useState<Record<
    string,
    unknown
  > | null>(null);
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>("input");
  const [compactLayout, setCompactLayout] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [livenessNow, setLivenessNow] = useState(() => Date.now());
  const sidebarRef = useRef<HTMLElement>(null);
  const mobileSidebarTriggerRef = useRef<HTMLButtonElement>(null);
  const mobileSidebarCloseRef = useRef<HTMLButtonElement>(null);
  const domainId = reasoningContextQuery.data?.domainId ?? "";
  const actionOptions = reasoningContextQuery.data?.actions ?? [];
  const actionIsValid = actionOptions.some((option) => option.name === action);
  const reasoningConfigured = Boolean(reasoningContextQuery.data);
  const reasoningNotConfigured =
    reasoningContextQuery.error instanceof ApiResponseError &&
    reasoningContextQuery.error.code === "reasoning_not_configured";
  const reasoningWorkspaceHref = reasoningAgentHref(tenant);
  const reasoningRunQuery = useReasoningAgentRun(tenant, activeRunId);
  const [latest, setLatest] = useState<{
    output: ReasoningOutput;
    runId?: string;
    resultSchemaVersion: ReasoningRunResponse["resultSchemaVersion"];
  } | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: "intro",
      role: "assistant",
      text: "",
    },
  ]);

  const runStatus = reasoningRunQuery.data?.run.status ?? null;
  const stallDeadline = reasoningRunStallDeadlineMs(reasoningRunQuery.data);
  const runStalled = isReasoningRunStalled(reasoningRunQuery.data, livenessNow);
  const runPollingUnavailable = Boolean(
    activeRunId &&
    reasoningRunQuery.error &&
    (isTerminalReasoningPollError(reasoningRunQuery.error) ||
      reasoningRunQuery.failureCount >= 3),
  );
  const toolAudit = useMemo(
    () =>
      projectReasoningToolAudit(
        reasoningRunQuery.data?.steps ?? [],
        t,
        reasoningRunQuery.data?.children ?? [],
      ),
    [reasoningRunQuery.data?.children, reasoningRunQuery.data?.steps, t],
  );
  const visibleRuleCount =
    latest?.output.ruleCount ?? toolAudit.ruleSelection?.rules.length ?? 0;
  const runIsActive =
    invoke.isPending ||
    (isActiveReasoningStatus(runStatus) &&
      !runStalled &&
      !runPollingUnavailable);
  const contextStatuses = useMemo(
    () =>
      BUSINESS_CONTEXT_KEYS.reduce(
        (statuses, key) => {
          statuses[key] = inputStatus(key, context[key]);
          return statuses;
        },
        {} as Record<BusinessContextKey, InputStatus>,
      ),
    [context],
  );
  const readyInputCount = BUSINESS_CONTEXT_KEYS.filter(
    (key) => contextStatuses[key] === "ready",
  ).length;
  const invalidInputCount = BUSINESS_CONTEXT_KEYS.filter(
    (key) => contextStatuses[key] === "invalid",
  ).length;

  useEffect(() => {
    const media = window.matchMedia("(max-width: 820px)");
    const sync = () => setCompactLayout(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    const now = Date.now();
    setLivenessNow(now);
    if (stallDeadline === null || stallDeadline <= now) return;
    const timer = window.setTimeout(
      () => setLivenessNow(Date.now()),
      stallDeadline - now + 25,
    );
    return () => window.clearTimeout(timer);
  }, [activeRunId, stallDeadline]);

  useEffect(() => {
    const persistedRunId = new URLSearchParams(window.location.search).get(
      "run",
    );
    if (/^run-[A-Za-z0-9_-]{1,150}$/.test(persistedRunId ?? "")) {
      setActiveRunId(persistedRunId);
      setInspectorTab("flow");
      setMobileSidebarOpen(true);
    }
  }, []);

  useEffect(() => {
    if (!compactLayout || !mobileSidebarOpen) return;
    mobileSidebarCloseRef.current?.focus();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setMobileSidebarOpen(false);
      requestAnimationFrame(() => mobileSidebarTriggerRef.current?.focus());
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [compactLayout, mobileSidebarOpen]);

  useEffect(() => {
    if (action || actionOptions.length === 0) return;
    const preferred =
      actionOptions.find(
        (option) => option.name === "ruleCheckForMatchResume",
      ) ??
      actionOptions.find((option) => option.name === "matchResume") ??
      actionOptions[0];
    if (!preferred) return;
    setAction(preferred.name);
    setScenario(preferred.name);
  }, [action, actionOptions]);

  useEffect(() => {
    if (!activeRunId || !reasoningRunQuery.data) return;
    const { run, result, resultSchemaVersion } = reasoningRunQuery.data;
    if (result) {
      try {
        const output = parseReasoningOutput(result, resultSchemaVersion);
        setLatest({ output, runId: activeRunId, resultSchemaVersion });
        setMessages((previous) =>
          previous.some(
            (message) =>
              message.role === "assistant" && message.runId === activeRunId,
          )
            ? previous
            : [
                ...previous,
                {
                  id: crypto.randomUUID(),
                  role: "assistant",
                  text: output.answerSummary,
                  output,
                  runId: activeRunId,
                },
              ],
        );
      } catch (error) {
        setJsonError(error instanceof Error ? error.message : String(error));
      }
      return;
    }
    if (run.status === "failed" || run.status === "cancelled") {
      const detail =
        run.error ??
        run.errorMessage ??
        t("reasoningAgent.page.runEndedWith", {
          status: statusLabel(run.status, t),
        });
      setMessages((previous) =>
        previous.some(
          (message) =>
            message.role === "assistant" && message.runId === activeRunId,
        )
          ? previous
          : [
              ...previous,
              {
                id: crypto.randomUUID(),
                role: "assistant",
                text: `${t("reasoningAgent.failed")}: ${detail}`,
                runId: activeRunId,
                error: true,
              },
            ],
      );
    }
  }, [activeRunId, reasoningRunQuery.data, t]);

  const runtimeAgents = useMemo<RuntimeAgent[]>(
    () =>
      projectRuntimeAgents(
        invoke.isPending
          ? "queued"
          : runStalled || runPollingUnavailable
            ? "stalled"
            : runStatus,
        reasoningRunQuery.data?.steps ?? [],
        latest?.runId === activeRunId ? latest.output : null,
        t,
        reasoningRunQuery.data?.children ?? [],
      ),
    [
      activeRunId,
      invoke.isPending,
      latest,
      runPollingUnavailable,
      runStalled,
      reasoningRunQuery.data?.steps,
      reasoningRunQuery.data?.children,
      runStatus,
      t,
    ],
  );
  const runtimeEdges = runtimeAgents.length > 0 ? [...RUNTIME_EDGES] : [];

  function updateContext(key: keyof typeof EMPTY_CONTEXT, value: string) {
    setContext((previous) => ({ ...previous, [key]: value }));
  }

  function showInspectorTab(tab: InspectorTab) {
    setInspectorTab(tab);
    if (compactLayout) setMobileSidebarOpen(true);
  }

  function closeMobileSidebar() {
    setMobileSidebarOpen(false);
    requestAnimationFrame(() => mobileSidebarTriggerRef.current?.focus());
  }

  function onInspectorTabKeyDown(
    event: ReactKeyboardEvent<HTMLButtonElement>,
    current: InspectorTab,
  ) {
    const index = INSPECTOR_TAB_ORDER.indexOf(current);
    let nextIndex = index;
    if (event.key === "ArrowRight") {
      nextIndex = (index + 1) % INSPECTOR_TAB_ORDER.length;
    } else if (event.key === "ArrowLeft") {
      nextIndex =
        (index - 1 + INSPECTOR_TAB_ORDER.length) % INSPECTOR_TAB_ORDER.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = INSPECTOR_TAB_ORDER.length - 1;
    } else {
      return;
    }
    event.preventDefault();
    const next = INSPECTOR_TAB_ORDER[nextIndex]!;
    setInspectorTab(next);
    requestAnimationFrame(() =>
      document.getElementById(`reasoning-sidebar-tab-${next}`)?.focus(),
    );
  }

  function trapMobileSidebarFocus(event: ReactKeyboardEvent<HTMLElement>) {
    if (!compactLayout || event.key !== "Tab") return;
    const focusable = Array.from(
      sidebarRef.current?.querySelectorAll<HTMLElement>(
        "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], summary",
      ) ?? [],
    ).filter((element) => element.offsetParent !== null);
    if (focusable.length === 0) return;
    const first = focusable[0]!;
    const last = focusable.at(-1)!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function loadExample() {
    const example =
      reasoningTestExamples.find((item) => item.id === exampleId) ??
      reasoningTestExamples[0];
    if (!example) return;
    const preferred =
      actionOptions.find(
        (option) => option.name === "ruleCheckForMatchResume",
      ) ??
      actionOptions.find((option) => option.name === "matchResume") ??
      actionOptions[0];
    if (preferred) setAction(preferred.name);
    setScenario("pre_match_resume_rule_check");
    setContext({ ...example.context });
    setPrompt(example.prompt);
    setJsonError("");
    showInspectorTab("input");
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const nextPrompt = prompt.trim();
    if (!nextPrompt || runIsActive) return;
    setJsonError("");
    const targetAction = action.trim();
    if (!domainId) {
      setJsonError(t("reasoningAgent.domainRequired"));
      return;
    }
    if (!targetAction || !actionIsValid) {
      setJsonError(t("reasoningAgent.actionRequired"));
      return;
    }

    let structured: Record<string, unknown>;
    try {
      const genericInputs = parseOptionalJson(
        t("reasoningAgent.genericInputs"),
        context.genericInputs,
      );
      if (
        genericInputs !== undefined &&
        (!genericInputs ||
          typeof genericInputs !== "object" ||
          Array.isArray(genericInputs))
      ) {
        throw new Error(
          `${t("reasoningAgent.genericInputs")}: ${t("reasoningAgent.page.jsonObjectRequired")}`,
        );
      }
      structured = {
        inputs: genericInputs,
        candidate: parseOptionalJson(
          t("reasoningAgent.candidate"),
          context.candidate,
        ),
        resume: parseOptionalJson(t("reasoningAgent.resume"), context.resume),
        jobRequisition: parseOptionalJson(
          t("reasoningAgent.job"),
          context.jobRequisition,
        ),
        jd: parseOptionalJson(t("reasoningAgent.jd"), context.jd),
      };
    } catch (error) {
      setJsonError(
        `${t("reasoningAgent.invalidJson")}: ${error instanceof Error ? error.message : String(error)}`,
      );
      showInspectorTab("input");
      return;
    }

    const invocationInput: Record<string, unknown> = {
      prompt: nextPrompt,
      domainId,
      action: targetAction,
      scenario: scenario.trim() || targetAction,
      ruleLimit: 40,
      ...structured,
    };
    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      text: nextPrompt,
    };
    setMessages((previous) => [...previous, userMessage]);
    setPrompt("");
    setLatest(null);
    setActiveRunId(null);
    setActiveInput(invocationInput);
    showInspectorTab("flow");
    const pendingUrl = new URL(window.location.href);
    pendingUrl.searchParams.delete("run");
    window.history.replaceState(null, "", pendingUrl);

    try {
      const response = await invoke.mutateAsync({
        name: "reasoningAgent",
        input: invocationInput,
        async: true,
      });
      if (!response.runId) {
        throw new Error(t("reasoningAgent.page.noDurableRunId"));
      }
      setActiveRunId(response.runId);
      const auditUrl = new URL(window.location.href);
      auditUrl.searchParams.set("run", response.runId);
      window.history.replaceState(null, "", auditUrl);
    } catch (error) {
      setMessages((previous) => [
        ...previous,
        {
          id: crypto.randomUUID(),
          role: "assistant",
          text: `${t("reasoningAgent.failed")}: ${error instanceof Error ? error.message : String(error)}`,
          error: true,
        },
      ]);
    }
  }

  function downloadAuditLog() {
    if (!reasoningRunQuery.data) return;
    const blob = new Blob(
      [JSON.stringify(publicAuditPayload(reasoningRunQuery.data, t), null, 2)],
      {
        type: "application/json",
      },
    );
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${reasoningRunQuery.data.run.id}-reasoning-audit.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className={styles.page}>
      <ViewHeader
        title={t("reasoningAgent.title")}
        subtitle={t("reasoningAgent.subtitle")}
        action={
          <span className={styles.pill}>
            Allmeta · {domainId || "—"} · {t("reasoningAgent.page.readOnly")}
          </span>
        }
      />

      <div className={styles.workspace}>
        <main className={styles.chat}>
          <div className={styles.chatContextBar}>
            <div className={styles.chatContextIdentity}>
              <Icon name="library" size={14} />
              <div>
                <span>{domainId || "—"}</span>
                <strong>{action || t("reasoningAgent.actionRequired")}</strong>
              </div>
            </div>
            <span className={styles.chatScenario}>
              {scenario || action || "—"}
            </span>
            <button
              ref={mobileSidebarTriggerRef}
              type="button"
              className={styles.editInputsButton}
              onClick={() => showInspectorTab("input")}
              aria-controls="reasoning-agent-sidebar"
              aria-expanded={compactLayout ? mobileSidebarOpen : undefined}
            >
              {t("reasoningAgent.context")}
              <span
                className={`${styles.inputCount} ${invalidInputCount > 0 ? styles.inputCountInvalid : ""}`}
                aria-live="polite"
              >
                {invalidInputCount > 0
                  ? `${invalidInputCount} ${t("reasoningAgent.inputInvalid")}`
                  : `${readyInputCount}/5`}
              </span>
              <Icon name="chevron-right" size={12} />
            </button>
          </div>

          <div className={styles.messages} aria-live="polite">
            {messages.map((message) => (
              <div
                className={`${styles.message} ${message.role === "user" ? styles.messageUser : ""}`}
                key={message.id}
              >
                <div className={styles.avatar}>
                  <Icon
                    name={message.role === "user" ? "human" : "spark"}
                    size={14}
                  />
                </div>
                <div
                  className={`${styles.bubble} ${message.error ? styles.error : ""}`}
                >
                  {message.id === "intro"
                    ? t("reasoningAgent.intro")
                    : message.text}
                  {message.output ? (
                    <div className={styles.messageMeta}>
                      <span
                        className={styles.pill}
                        style={{
                          color: decisionColor(message.output.decision),
                        }}
                      >
                        {message.output.decision}
                      </span>
                      <span className={styles.pill}>
                        {t("reasoningAgent.page.rulesCount", {
                          count: message.output.ruleCount,
                        })}
                      </span>
                      <span className={styles.pill}>
                        {message.output.scenario}
                      </span>
                      {message.runId ? (
                        <Link
                          className={styles.runLink}
                          href={
                            `/portal/${tenant}/runs/${message.runId}` as never
                          }
                        >
                          {t("reasoningAgent.viewRun")} →
                        </Link>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </div>
            ))}
            {runIsActive ? (
              <div className={styles.message}>
                <div className={styles.avatar}>
                  <Icon name="spark" size={14} />
                </div>
                <div className={styles.bubble}>
                  <span
                    className={styles.typing}
                    aria-label={t("reasoningAgent.running")}
                  >
                    <span />
                    <span />
                    <span />
                  </span>{" "}
                  {t("reasoningAgent.running")}
                </div>
              </div>
            ) : null}
            {runStalled || runPollingUnavailable ? (
              <div
                className={styles.message}
                data-testid="reasoning-run-stalled"
              >
                <div className={styles.avatar}>
                  <Icon name="alert" size={14} />
                </div>
                <div className={styles.bubble}>
                  <strong>
                    {runStalled
                      ? t("reasoningAgent.stalled")
                      : t("reasoningAgent.pollingFailed")}
                  </strong>{" "}
                  {t("reasoningAgent.stalledHint")}{" "}
                  <button
                    type="button"
                    className={styles.inlineRetry}
                    onClick={() => void reasoningRunQuery.refetch()}
                  >
                    {t("reasoningAgent.retry")}
                  </button>
                </div>
              </div>
            ) : null}
          </div>

          <form className={styles.composer} onSubmit={submit}>
            <div className={styles.composerBox}>
              <textarea
                className={styles.composerInput}
                value={prompt}
                placeholder={t("reasoningAgent.prompt")}
                onChange={(event) => setPrompt(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    event.currentTarget.form?.requestSubmit();
                  }
                }}
              />
              <div className={styles.composerFooter}>
                <span className={styles.domainTag}>
                  {t("reasoningAgent.domain")}: {domainId || "—"} ·{" "}
                  {t("reasoningAgent.page.actionInline")}: {action || "—"}
                </span>
                {reasoningContextQuery.isError ? (
                  <span className={styles.error}>
                    {reasoningNotConfigured ? (
                      <>
                        {t("reasoningAgent.workspaceRequired")}
                        <Link
                          className={styles.inlineRecovery}
                          href={reasoningWorkspaceHref as never}
                        >
                          {t("reasoningAgent.openWorkspace")} →
                        </Link>
                      </>
                    ) : (
                      <>
                        {t("reasoningAgent.domainLoadFailed")}:{" "}
                        {reasoningContextQuery.error instanceof Error
                          ? reasoningContextQuery.error.message
                          : t("reasoningAgent.page.unknownError")}
                        <button
                          type="button"
                          className={styles.inlineRetry}
                          onClick={() => void reasoningContextQuery.refetch()}
                        >
                          {t("reasoningAgent.retry")}
                        </button>
                      </>
                    )}
                  </span>
                ) : null}
                {jsonError ? (
                  <span className={styles.error}>{jsonError}</span>
                ) : null}
                <button
                  className={styles.sendButton}
                  type="submit"
                  disabled={
                    !prompt.trim() ||
                    !actionIsValid ||
                    !domainId ||
                    !reasoningConfigured ||
                    runIsActive ||
                    reasoningContextQuery.isLoading ||
                    reasoningContextQuery.isError
                  }
                >
                  {runIsActive
                    ? t("reasoningAgent.running")
                    : t("reasoningAgent.send")}
                </button>
              </div>
            </div>
          </form>
        </main>

        {mobileSidebarOpen ? (
          <button
            type="button"
            className={styles.sidebarBackdrop}
            aria-label={t("reasoningAgent.closeSidebar")}
            onClick={closeMobileSidebar}
          />
        ) : null}

        <aside
          ref={sidebarRef}
          id="reasoning-agent-sidebar"
          className={`${styles.inspector} ${mobileSidebarOpen ? styles.inspectorOpen : ""}`}
          aria-label={
            inspectorTab === "input"
              ? t("reasoningAgent.context")
              : t("reasoningAgent.inspector")
          }
          aria-hidden={compactLayout && !mobileSidebarOpen ? true : undefined}
          aria-modal={compactLayout ? true : undefined}
          role={compactLayout ? "dialog" : undefined}
          inert={compactLayout && !mobileSidebarOpen ? true : undefined}
          onKeyDown={trapMobileSidebarFocus}
        >
          <div className={styles.inspectorHeader}>
            <div className={styles.inspectorHeaderRow}>
              <div>
                <div className={styles.inspectorTitle}>
                  {inspectorTab === "input"
                    ? t("reasoningAgent.context")
                    : t("reasoningAgent.inspector")}
                </div>
                <div className={styles.inspectorHint}>
                  {inspectorTab === "input"
                    ? t("reasoningAgent.contextHint")
                    : t("reasoningAgent.inspectorHint")}
                </div>
              </div>
              <div className={styles.inspectorHeaderActions}>
                {inspectorTab !== "input" && reasoningRunQuery.data ? (
                  <button
                    type="button"
                    className={styles.exportButton}
                    onClick={downloadAuditLog}
                  >
                    {t("reasoningAgent.exportJson")}
                  </button>
                ) : null}
                <button
                  ref={mobileSidebarCloseRef}
                  type="button"
                  className={styles.mobileSidebarClose}
                  onClick={closeMobileSidebar}
                  aria-label={t("reasoningAgent.closeSidebar")}
                >
                  <Icon name="x" size={14} />
                </button>
              </div>
            </div>
            <div
              className={styles.inspectorTabs}
              role="tablist"
              aria-label={t("reasoningAgent.sidebarTabs")}
            >
              {(
                [
                  ["input", t("reasoningAgent.context")],
                  ["flow", t("reasoningAgent.flowTab")],
                  [
                    "rules",
                    `${t("reasoningAgent.page.rulesTab")}${visibleRuleCount > 0 ? ` (${visibleRuleCount})` : ""}`,
                  ],
                  [
                    "logs",
                    `${t("reasoningAgent.page.logTab")}${
                      reasoningRunQuery.data
                        ? ` (${reasoningRunQuery.data.steps.length + reasoningRunQuery.data.children.reduce((count, child) => count + child.steps.length, 0)})`
                        : ""
                    }`,
                  ],
                ] as const
              ).map(([id, label]) => (
                <button
                  id={`reasoning-sidebar-tab-${id}`}
                  type="button"
                  role="tab"
                  aria-selected={inspectorTab === id}
                  aria-controls={`reasoning-sidebar-panel-${id}`}
                  tabIndex={inspectorTab === id ? 0 : -1}
                  className={`${styles.inspectorTab} ${inspectorTab === id ? styles.inspectorTabActive : ""}`}
                  onClick={() => setInspectorTab(id)}
                  onKeyDown={(event) => onInspectorTabKeyDown(event, id)}
                  key={id}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div
            id={`reasoning-sidebar-panel-${inspectorTab}`}
            className={styles.inspectorScroll}
            role="tabpanel"
            aria-labelledby={`reasoning-sidebar-tab-${inspectorTab}`}
            tabIndex={0}
          >
            {inspectorTab === "input" ? (
              <div className={styles.businessInputs}>
                <section className={styles.businessInputCard}>
                  <div className={styles.businessInputHeading}>
                    <div>
                      <strong>{t("reasoningAgent.runConfig")}</strong>
                      <span>{domainId || "—"}</span>
                    </div>
                    <span className={styles.pill}>
                      {t("reasoningAgent.page.readOnlyOntology")}
                    </span>
                  </div>
                  <div className={styles.sidebarFields}>
                    <label className={styles.field}>
                      <span className={styles.label}>
                        {t("reasoningAgent.domain")}
                      </span>
                      <input
                        className={styles.input}
                        value={domainId}
                        placeholder={
                          reasoningContextQuery.isLoading
                            ? t("reasoningAgent.domainLoading")
                            : t("reasoningAgent.domainRequired")
                        }
                        readOnly
                      />
                    </label>
                    <label className={styles.field}>
                      <span className={styles.label}>
                        {t("reasoningAgent.action")}
                      </span>
                      <select
                        className={styles.input}
                        value={action}
                        onChange={(event) => {
                          const nextAction = event.target.value;
                          setAction(nextAction);
                          setScenario((current) => current || nextAction);
                        }}
                        disabled={
                          !domainId ||
                          reasoningContextQuery.isLoading ||
                          reasoningContextQuery.isError
                        }
                      >
                        <option value="">
                          {t("reasoningAgent.chooseAction")}
                        </option>
                        {actionOptions.map((option) => (
                          <option key={option.id} value={option.name}>
                            {option.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className={styles.field}>
                      <span className={styles.label}>
                        {t("reasoningAgent.scenario")}
                      </span>
                      <input
                        className={styles.input}
                        value={scenario}
                        placeholder={action || "pre_match_resume_rule_check"}
                        onChange={(event) => setScenario(event.target.value)}
                      />
                    </label>
                    <label className={styles.field}>
                      <span className={styles.label}>
                        {t("reasoningAgent.testExample")}
                      </span>
                      <select
                        className={styles.input}
                        value={exampleId}
                        onChange={(event) => setExampleId(event.target.value)}
                      >
                        {reasoningTestExamples.map((example) => (
                          <option key={example.id} value={example.id}>
                            {example.label}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <div className={styles.inputActions}>
                    <button
                      type="button"
                      className={styles.loadButton}
                      onClick={loadExample}
                    >
                      <Icon name="upload" size={12} />
                      {t("reasoningAgent.loadExample")}
                    </button>
                    <button
                      type="button"
                      className={styles.clearButton}
                      onClick={() => {
                        setContext(EMPTY_CONTEXT);
                        setJsonError("");
                      }}
                    >
                      {t("reasoningAgent.clear")}
                    </button>
                  </div>
                </section>

                <section
                  className={styles.businessInputCard}
                  aria-labelledby="reasoning-input-data-title"
                >
                  <div className={styles.businessInputHeading}>
                    <div>
                      <strong id="reasoning-input-data-title">
                        {t("reasoningAgent.instanceData")}
                      </strong>
                      <span>{t("reasoningAgent.inputScopeHint")}</span>
                    </div>
                    <span
                      className={`${styles.inputCount} ${invalidInputCount > 0 ? styles.inputCountInvalid : ""}`}
                    >
                      {invalidInputCount > 0
                        ? `${invalidInputCount} ${t("reasoningAgent.inputInvalid")}`
                        : `${readyInputCount}/5`}
                    </span>
                  </div>
                  {jsonError ? (
                    <div className={styles.inputError} role="alert">
                      <Icon name="alert" size={13} />
                      {jsonError}
                    </div>
                  ) : null}
                  <div className={styles.inputAccordions}>
                    {(
                      [
                        ["candidate", t("reasoningAgent.candidate")],
                        ["resume", t("reasoningAgent.resume")],
                        ["jobRequisition", t("reasoningAgent.job")],
                        ["jd", t("reasoningAgent.jd")],
                        ["genericInputs", t("reasoningAgent.genericInputs")],
                      ] as const
                    ).map(([key, label]) => {
                      const status = contextStatuses[key];
                      const statusLabel =
                        status === "ready"
                          ? t("reasoningAgent.inputReady")
                          : status === "invalid"
                            ? t("reasoningAgent.inputInvalid")
                            : t("reasoningAgent.inputEmpty");
                      return (
                        <details className={styles.inputAccordion} key={key}>
                          <summary className={styles.inputAccordionSummary}>
                            <Icon name="code" size={12} />
                            <span>{label}</span>
                            <span
                              className={`${styles.inputStatus} ${styles[`inputStatus_${status}`]}`}
                            >
                              {statusLabel}
                            </span>
                            <Icon name="chevron-down" size={12} />
                          </summary>
                          <div className={styles.inputAccordionBody}>
                            <textarea
                              id={`reasoning-business-input-${key}`}
                              className={styles.sidebarJsonInput}
                              value={context[key]}
                              placeholder={'{"id":"…"}'}
                              aria-label={label}
                              aria-invalid={status === "invalid"}
                              aria-describedby={`reasoning-business-input-${key}-meta`}
                              onChange={(event) =>
                                updateContext(key, event.target.value)
                              }
                            />
                            <div
                              id={`reasoning-business-input-${key}-meta`}
                              className={styles.inputMeta}
                            >
                              {t("reasoningAgent.page.charsJson", {
                                count: context[key].length.toLocaleString(
                                  language === "zh" ? "zh-CN" : "en-US",
                                ),
                              })}
                            </div>
                          </div>
                        </details>
                      );
                    })}
                  </div>
                </section>
              </div>
            ) : null}

            {inspectorTab !== "input" && runtimeAgents.length === 0 ? (
              <div className={styles.emptyInspector}>
                {t("reasoningAgent.noRun")}
              </div>
            ) : null}

            {inspectorTab !== "input" && reasoningRunQuery.error ? (
              <div className={`${styles.auditCard} ${styles.error}`}>
                {t("reasoningAgent.page.runAuditReadFailed", {
                  detail:
                    reasoningRunQuery.error instanceof Error
                      ? reasoningRunQuery.error.message
                      : t("reasoningAgent.page.unknownError"),
                })}
              </div>
            ) : null}

            {inspectorTab === "flow" ? (
              <>
                <FlowCards
                  input={
                    latest?.output.audit.input ?? activeInput ?? toolAudit.input
                  }
                  output={latest?.output ?? null}
                  resultSchemaVersion={latest?.resultSchemaVersion ?? null}
                  toolAudit={toolAudit}
                  run={reasoningRunQuery.data?.run ?? null}
                  steps={reasoningRunQuery.data?.steps ?? []}
                  children={reasoningRunQuery.data?.children ?? []}
                  language={language}
                  t={t}
                />
                {runtimeAgents.length > 0 ? (
                  <details className={styles.graphCard}>
                    <summary className={styles.graphSummary}>
                      {t("reasoningAgent.page.viewDynamicAgentGraph")}
                    </summary>
                    <RuntimeGraph
                      agents={runtimeAgents}
                      edges={runtimeEdges}
                      t={t}
                    />
                  </details>
                ) : null}
              </>
            ) : null}
            {inspectorTab === "rules" ? (
              <RulesCards
                output={latest?.output ?? null}
                selection={toolAudit.ruleSelection}
                t={t}
              />
            ) : null}
            {inspectorTab === "logs" ? (
              <ExecutionLog
                run={reasoningRunQuery.data?.run ?? null}
                steps={reasoningRunQuery.data?.steps ?? []}
                children={reasoningRunQuery.data?.children ?? []}
                t={t}
              />
            ) : null}
          </div>
        </aside>
      </div>
    </div>
  );
}

type RuleScope = "csi_universal" | "client_general" | "client_department";

function ruleScope(rule: RetrievedRule): RuleScope {
  if (rule.applicabilityScope) return rule.applicabilityScope;
  const client = rule.applicableClient.trim().toLowerCase();
  const department = rule.applicableDepartment.trim().toLowerCase();
  const generic = new Set(["", "通用", "不限", "all", "any", "na", "n/a", "*"]);
  if (generic.has(client)) return "csi_universal";
  return generic.has(department) ? "client_general" : "client_department";
}

function scopeLabel(scope: RuleScope, t: Translate): string {
  if (scope === "csi_universal")
    return t("reasoningAgent.page.scope.csiUniversal");
  if (scope === "client_general")
    return t("reasoningAgent.page.scope.clientGeneral");
  return t("reasoningAgent.page.scope.clientDepartment");
}

function scopeCounts(
  rules: RetrievedRule[],
  diagnostics: Record<string, unknown> | null | undefined,
): Record<RuleScope, number> {
  const fromDiagnostics = diagnostics?.selectedScopeCounts;
  if (
    fromDiagnostics &&
    typeof fromDiagnostics === "object" &&
    !Array.isArray(fromDiagnostics)
  ) {
    const record = fromDiagnostics as Record<string, unknown>;
    if (
      typeof record.csi_universal === "number" &&
      typeof record.client_general === "number" &&
      typeof record.client_department === "number"
    ) {
      return {
        csi_universal: record.csi_universal,
        client_general: record.client_general,
        client_department: record.client_department,
      };
    }
  }
  const counts: Record<RuleScope, number> = {
    csi_universal: 0,
    client_general: 0,
    client_department: 0,
  };
  for (const rule of rules) counts[ruleScope(rule)] += 1;
  return counts;
}

function FlowCards({
  input,
  output,
  resultSchemaVersion,
  toolAudit,
  run,
  steps,
  children,
  language,
  t,
}: {
  input: unknown;
  output: ReasoningOutput | null;
  resultSchemaVersion: ReasoningRunResponse["resultSchemaVersion"];
  toolAudit: ReasoningToolAudit;
  run: ReasoningRunResponse["run"] | null;
  steps: ReasoningRunStep[];
  children: ReasoningRunResponse["children"];
  language: "en" | "zh";
  t: Translate;
}) {
  if (!input && !output && !run) return null;
  const selection = toolAudit.ruleSelection;
  const queryIr = output?.queryIr ?? selection?.queryIr;
  const selectedRules =
    output?.audit.ruleSelection.selectedRules ?? selection?.rules ?? [];
  const diagnostics =
    output?.audit.ruleSelection.diagnostics ??
    selection?.queryAgent.diagnostics ??
    null;
  const finalQueryAgent = output?.audit.ruleSelection.queryAgent;
  const receiptQueryAgent = selection?.queryAgent;
  const filters = finalQueryAgent?.filters ?? receiptQueryAgent?.filters;
  const harnessPlan =
    output?.harnessPlan ??
    output?.audit.harnessPlan ??
    finalQueryAgent?.harnessPlan ??
    selection?.harnessPlan ??
    receiptQueryAgent?.harnessPlan ??
    toolAudit.compiledPrompt?.harnessPlan ??
    null;
  const queryExecution =
    output?.audit.ruleSelection.queryExecution ??
    finalQueryAgent?.queryExecution ??
    selection?.queryExecution ??
    receiptQueryAgent?.queryExecution ??
    null;
  const queryExecutions =
    output?.audit.ruleSelection.queryExecutions ??
    finalQueryAgent?.queryExecutions ??
    selection?.queryExecutions ??
    receiptQueryAgent?.queryExecutions ??
    (queryExecution ? [queryExecution] : []);
  const legacyResult =
    output !== null && resultSchemaVersion !== "reasoning-result/v2";
  const semanticLinkContractVerified =
    !legacyResult && hasVerifiedSemanticLinkReceipt(queryExecution);
  const selectedScopeCounts = scopeCounts(selectedRules, diagnostics);
  const evidenceAnalysis = projectVisibleEvidenceAnalysis(
    output,
    selection,
    output?.audit.input ?? input,
    t,
    toolAudit.compiledPrompt,
  );
  const selectionFunnel = projectSelectionFunnel(
    diagnostics,
    selectedRules.length,
  );
  const selectionRationale =
    finalQueryAgent?.modelRationale ??
    receiptQueryAgent?.modelRationale ??
    receiptQueryAgent?.rationale ??
    output?.intentSummary ??
    t("reasoningAgent.page.generatingBoundedQueryIr");
  const selectionStrategy = legacyResult
    ? t("reasoningAgent.page.legacyReplay")
    : (finalQueryAgent?.selectionStrategy ??
      receiptQueryAgent?.selectionStrategy ??
      (queryExecution
        ? "semantic-link-traversal"
        : t("reasoningAgent.page.legacyReplay")));
  return (
    <div className={styles.cardStack}>
      {queryIr ? (
        <section
          className={`${styles.auditCard} ${styles.reasoningHero}`}
          data-testid="auditable-reasoning-card"
        >
          <CardHeading
            index="AI"
            title={t("reasoningAgent.page.card.auditableReasoning")}
            status={
              legacyResult ? "warning" : selection ? "completed" : "running"
            }
            t={t}
          />
          {legacyResult ? (
            <div
              className={styles.scopeWarning}
              data-testid="legacy-result-warning"
            >
              {t("reasoningAgent.page.legacyResultSchema", {
                version:
                  resultSchemaVersion ?? t("reasoningAgent.page.unversioned"),
              })}
            </div>
          ) : null}
          <div className={styles.callout}>{selectionRationale}</div>
          <p className={styles.cardText}>
            {t("reasoningAgent.page.showsIntentSummary")}
          </p>
          <div className={styles.chipRow}>
            <span className={styles.pill}>{selectionStrategy}</span>
            <span className={styles.pill}>
              {t("reasoningAgent.page.canonicalCapabilityBoundary")}
            </span>
            <span className={styles.pill}>
              {semanticLinkContractVerified
                ? t("reasoningAgent.page.semanticLinksOnly")
                : t("reasoningAgent.page.linkContractUnverified")}
            </span>
          </div>
          <div className={styles.scopeGrid}>
            <Metric
              label={t("reasoningAgent.page.scope.csiUniversal")}
              value={selectedScopeCounts.csi_universal}
              tone="green"
            />
            <Metric
              label={t("reasoningAgent.page.scope.clientGeneral")}
              value={selectedScopeCounts.client_general}
            />
            <Metric
              label={t("reasoningAgent.page.scope.clientDepartment")}
              value={selectedScopeCounts.client_department}
              tone="amber"
            />
          </div>
          <div className={styles.metaGrid}>
            <span>{t("reasoningAgent.page.canonicalCapabilityBoundary")}</span>
            <strong>
              {filters?.actionHint ?? filters?.action ?? queryIr.actionHint}
            </strong>
            <span>{t("reasoningAgent.page.meta.client")}</span>
            <strong>
              {filters?.client ||
                queryIr.applicableClient ||
                t("reasoningAgent.page.generic")}
            </strong>
            <span>{t("reasoningAgent.page.meta.clientSource")}</span>
            <strong>{scopeSourceLabel(filters?.clientSource, t)}</strong>
            <span>{t("reasoningAgent.page.meta.department")}</span>
            <strong>
              {filters?.department ||
                queryIr.applicableDepartment ||
                t("reasoningAgent.page.generic")}
            </strong>
            <span>{t("reasoningAgent.page.meta.departmentSource")}</span>
            <strong>{scopeSourceLabel(filters?.departmentSource, t)}</strong>
            <span>{t("reasoningAgent.page.meta.objects")}</span>
            <strong>{queryIr.objectTypes.join(", ") || "—"}</strong>
            <span>{t("reasoningAgent.page.meta.keywords")}</span>
            <strong>{queryIr.strongKeywords.join(", ") || "—"}</strong>
          </div>
          {(filters?.scopeConflicts?.length ?? 0) > 0 ? (
            <div className={styles.scopeWarning}>
              <strong>{t("reasoningAgent.page.scopeConflictIsolated")}</strong>
              {filters?.scopeConflicts?.map((conflict, index) => (
                <div key={`${conflict.field}-${index}`}>
                  {t("reasoningAgent.page.scopeConflictDetail", {
                    field: conflict.field,
                    selectedValue: conflict.selectedValue,
                    selectedSource: scopeSourceLabel(
                      conflict.selectedSource,
                      t,
                    ),
                    ignoredValue: conflict.ignoredValue,
                    ignoredSource: scopeSourceLabel(conflict.ignoredSource, t),
                  })}
                </div>
              ))}
            </div>
          ) : null}
        </section>
      ) : null}

      {run ? (
        <section className={styles.auditCard}>
          <CardHeading
            index="00"
            title={t("reasoningAgent.page.card.durableRun")}
            status={run.status}
            t={t}
          />
          <div className={styles.metaGrid}>
            <span>run_id</span>
            <strong>{run.id}</strong>
            <span>{t("reasoningAgent.page.meta.status")}</span>
            <strong
              title={t("reasoningAgent.page.rawStatusTitle", {
                status: run.status,
              })}
            >
              {statusLabel(run.status, t)}
            </strong>
            <span>{t("reasoningAgent.page.meta.model")}</span>
            <strong>
              {run.model ?? t("reasoningAgent.page.awaitingProvider")}
            </strong>
            <span>{t("reasoningAgent.page.meta.tokens")}</span>
            <strong>{tokenIoLabel(run.tokensIn, run.tokensOut, t)}</strong>
            <span>{t("reasoningAgent.page.meta.duration")}</span>
            <strong>
              {run.durationMs == null
                ? t("reasoningAgent.page.inProgress")
                : `${run.durationMs} ms`}
            </strong>
          </div>
        </section>
      ) : null}

      {children.map((child) => (
        <section className={styles.auditCard} key={child.run.id}>
          <CardHeading
            index="00Q"
            title={t("reasoningAgent.page.card.qualifiedAgentChildRun")}
            status={child.run.status}
            t={t}
          />
          <div className={styles.metaGrid}>
            <span>child_run_id</span>
            <strong>{child.run.id}</strong>
            <span>parent_run_id</span>
            <strong>{child.run.parentRunId ?? run?.id ?? "—"}</strong>
            <span>{t("reasoningAgent.page.meta.status")}</span>
            <strong
              title={t("reasoningAgent.page.rawStatusTitle", {
                status: child.run.status,
              })}
            >
              {statusLabel(child.run.status, t)}
            </strong>
            <span>{t("reasoningAgent.page.meta.model")}</span>
            <strong>
              {child.run.model ?? t("reasoningAgent.page.awaitingProvider")}
            </strong>
            <span>{t("reasoningAgent.page.meta.steps")}</span>
            <strong>{child.steps.length}</strong>
          </div>
        </section>
      ))}

      <section className={styles.auditCard}>
        <CardHeading
          index="01"
          title={t("reasoningAgent.page.card.instanceInputEvidence")}
          status="completed"
          t={t}
        />
        <p className={styles.cardText}>
          {t("reasoningAgent.page.instanceInputBody")}
        </p>
        <details className={styles.codeDetails}>
          <summary>{t("reasoningAgent.page.viewFullInstanceJson")}</summary>
          <JsonBlock value={output?.audit.input ?? input} />
        </details>
      </section>

      <EvidenceAnalysisCard analysis={evidenceAnalysis} t={t} />

      <ReasoningHarnessCard
        plan={harnessPlan}
        legacy={!harnessPlan && !!(output || selection)}
        t={t}
      />

      {!output && toolAudit.ruleSelection ? (
        <>
          <PartialRuleSelectionCards
            selection={toolAudit.ruleSelection}
            t={t}
          />
          <RulePoolCard
            rules={selectedRules}
            evidencePlan={evidenceAnalysis.ruleEvidencePlan}
            funnel={selectionFunnel}
            t={t}
          />
        </>
      ) : null}

      {!output &&
      (toolAudit.compiledPrompt ||
        toolAudit.compilerReceipt ||
        toolAudit.executedQualifiedPrompt) ? (
        <PromptCompilerCard
          prompt={toolAudit.compiledPrompt}
          receipt={toolAudit.compilerReceipt}
          qualifiedRun={toolAudit.compilerReceipt?.qualifiedRun ?? null}
          ruleBundleId={toolAudit.ruleSelection?.bundleId ?? null}
          executedPrompt={toolAudit.executedQualifiedPrompt}
          language={language}
          t={t}
        />
      ) : null}

      {output ? (
        <>
          <section className={styles.auditCard}>
            <CardHeading
              index="02C"
              title={t("reasoningAgent.page.card.intentReasoner")}
              status="completed"
              t={t}
            />
            <div className={styles.callout}>{output.intentSummary}</div>
            <div className={styles.metaLine}>
              {t("reasoningAgent.page.strategyPrefix")} · {output.strategy}
            </div>
            <p className={styles.cardText}>
              {t("reasoningAgent.page.intentReasonerBody")}
            </p>
          </section>

          <CypherExecutionCard
            executions={queryExecutions}
            queryIr={output.queryIr}
            diagnostics={output.audit.ruleSelection.diagnostics}
            ruleCount={output.ruleCount}
            legacyTemplateId={output.audit.ruleSelection.cypherTemplateId}
            resultSchemaVersion={resultSchemaVersion}
            t={t}
          />

          <RulePoolCard
            rules={selectedRules}
            evidencePlan={evidenceAnalysis.ruleEvidencePlan}
            funnel={selectionFunnel}
            t={t}
          />

          <PromptCompilerCard
            prompt={output.audit.compiledPrompt}
            receipt={toolAudit.compilerReceipt}
            qualifiedRun={output.audit.qualityCheck.run ?? null}
            ruleBundleId={output.ruleBundleId}
            executedPrompt={toolAudit.executedQualifiedPrompt}
            language={language}
            t={t}
          />

          <section className={styles.auditCard}>
            <CardHeading
              index="05"
              title={t("reasoningAgent.page.card.qualifiedAgentQualityCheck")}
              status={
                output.audit.qualityCheck.mandatoryBlocked > 0
                  ? "blocked"
                  : output.audit.qualityCheck.mandatoryPending > 0 ||
                      output.audit.qualityCheck.optionalFlagged > 0
                    ? "warning"
                    : "completed"
              }
              t={t}
            />
            {output.audit.qualityCheck.run ? (
              <div className={styles.metaGrid}>
                <span>{t("reasoningAgent.page.meta.childRun")}</span>
                <strong>{output.audit.qualityCheck.run.runId}</strong>
                <span>{t("reasoningAgent.page.meta.promptReceipt")}</span>
                <strong>{output.audit.qualityCheck.run.promptSha256}</strong>
                <span>{t("reasoningAgent.page.meta.providerModel")}</span>
                <strong>
                  {output.audit.qualityCheck.run.provider} /{" "}
                  {output.audit.qualityCheck.run.model}
                </strong>
                <span>{t("reasoningAgent.page.meta.tokens")}</span>
                <strong>
                  {tokenIoLabel(
                    output.audit.qualityCheck.run.tokensIn,
                    output.audit.qualityCheck.run.tokensOut,
                    t,
                  )}
                </strong>
              </div>
            ) : (
              <div className={styles.scopeWarning}>
                {t("reasoningAgent.page.legacyNoChildRun")}
              </div>
            )}
            <div className={styles.metricGrid}>
              <Metric
                label={t("reasoningAgent.page.metric.checked")}
                value={output.audit.qualityCheck.assessmentCount}
              />
              <Metric
                label={t("reasoningAgent.page.metric.satisfied")}
                value={output.audit.qualityCheck.statusCounts.satisfied}
                tone="green"
              />
              <Metric
                label={t("reasoningAgent.page.metric.violated")}
                value={output.audit.qualityCheck.statusCounts.violated}
                tone="red"
              />
              <Metric
                label={t("reasoningAgent.page.metric.optionalFlags")}
                value={output.audit.qualityCheck.optionalFlagged}
                tone="amber"
              />
              <Metric
                label={t("reasoningAgent.page.metric.mandatoryPending")}
                value={output.audit.qualityCheck.mandatoryPending}
                tone="amber"
              />
              <Metric
                label={t("reasoningAgent.page.metric.notApplicable")}
                value={output.audit.qualityCheck.statusCounts.not_applicable}
              />
            </div>
            <QualifiedAssessmentList assessments={output.assessments} t={t} />
          </section>

          <section className={styles.auditCard}>
            <CardHeading
              index="06"
              title={t("reasoningAgent.page.card.deterministicFold")}
              status={
                output.decision === "ineligible"
                  ? "blocked"
                  : output.decision === "eligible"
                    ? "completed"
                    : "warning"
              }
              t={t}
            />
            <div
              className={styles.decisionValue}
              style={{ color: decisionColor(output.decision) }}
            >
              {output.decision}
            </div>
            <p className={styles.cardText}>{output.answerSummary}</p>
            <div className={styles.metaLine}>
              {output.domainId} / {output.action} / {output.scenario}
            </div>
            <div className={styles.metaLine}>
              RuleBundle · {output.ruleBundleId}
            </div>
            {output.flags.length > 0 ? (
              <>
                <div className={styles.subLabel}>
                  {t("reasoningAgent.page.optionalFlagsLabel")}
                </div>
                <ul className={styles.missingList}>
                  {output.flags.map((flag) => (
                    <li key={flag}>{flag}</li>
                  ))}
                </ul>
              </>
            ) : null}
            {output.missingEvidence.length > 0 ? (
              <>
                <div className={styles.subLabel}>
                  {t("reasoningAgent.page.missingEvidenceLabel")}
                </div>
                <ul className={styles.missingList}>
                  {output.missingEvidence.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </>
            ) : null}
          </section>

          <section className={styles.auditCard}>
            <CardHeading
              index="07"
              title={t("reasoningAgent.page.card.auditTimeline")}
              status="completed"
              t={t}
            />
            <div className={styles.timeline}>
              {output.audit.trace.map((entry) => (
                <div
                  className={styles.timelineEntry}
                  key={`${entry.sequence}-${entry.event}`}
                >
                  <span
                    className={styles.timelineDot}
                    style={{ background: statusColor(entry.status) }}
                  />
                  <div>
                    <strong>
                      {String(entry.sequence).padStart(2, "0")} · {entry.event}
                    </strong>
                    <p>{entry.summary}</p>
                    <span>
                      {formatTimestamp(entry.at, language)}
                      {entry.durationMs == null
                        ? ""
                        : ` · ${entry.durationMs} ms`}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </section>
        </>
      ) : steps.length > 0 ? (
        <section className={styles.auditCard}>
          <CardHeading
            index="…"
            title={
              run?.status === "failed" || run?.status === "cancelled"
                ? t("reasoningAgent.page.card.realStepsTerminated")
                : run?.status === "ok"
                  ? t("reasoningAgent.page.card.realSteps")
                  : t("reasoningAgent.page.card.realStepsWriting")
            }
            status={
              run?.status === "failed" || run?.status === "cancelled"
                ? "blocked"
                : run?.status === "ok"
                  ? "completed"
                  : "running"
            }
            t={t}
          />
          <div className={styles.liveSteps}>
            {steps.map((step) => (
              <div key={step.id}>
                <span
                  style={{
                    color: statusColor(
                      step.status === "failed"
                        ? "blocked"
                        : step.status === "running"
                          ? "running"
                          : "completed",
                    ),
                  }}
                >
                  ●
                </span>{" "}
                {step.ord}. {humanStepName(step, t, steps)} ·{" "}
                <span
                  title={t("reasoningAgent.page.rawStatusTitle", {
                    status: step.status,
                  })}
                >
                  {statusLabel(step.status, t)}
                </span>
              </div>
            ))}
            {children.flatMap((child) =>
              child.steps.map((step) => (
                <div key={`${child.run.id}-${step.id}`}>
                  <span
                    style={{
                      color: statusColor(
                        step.status === "failed"
                          ? "blocked"
                          : step.status === "running"
                            ? "running"
                            : "completed",
                      ),
                    }}
                  >
                    ●
                  </span>{" "}
                  {t("reasoningAgent.page.meta.childStep", {
                    ordinal: step.ord,
                  })}{" "}
                  {humanStepName(step, t, child.steps, "qualified")} ·{" "}
                  <span
                    title={t("reasoningAgent.page.rawStatusTitle", {
                      status: step.status,
                    })}
                  >
                    {statusLabel(step.status, t)}
                  </span>
                </div>
              )),
            )}
          </div>
        </section>
      ) : null}
    </div>
  );
}

function EvidenceAnalysisCard({
  analysis,
  t,
}: {
  analysis: VisibleEvidenceAnalysis;
  t: Translate;
}) {
  const scopeFacts = analysis.facts.filter(
    (fact) => fact.purpose === "scope_selection",
  );
  const evaluationFacts = analysis.facts.filter(
    (fact) => fact.purpose !== "scope_selection",
  );
  return (
    <section
      className={styles.auditCard}
      data-testid="reasoning-evidence-analysis"
    >
      <CardHeading
        index="02A"
        title={t("reasoningAgent.page.card.evidenceAnalysis")}
        status={analysis.unverifiedCount > 0 ? "warning" : "completed"}
        t={t}
      />
      <div className={styles.chipRow}>
        <span className={styles.pill}>
          {analysis.source === "llm_path_verified"
            ? t("reasoningAgent.page.llmPathRuntimeValues")
            : t("reasoningAgent.page.legacyInputDeterministicReplay")}
        </span>
        <span className={styles.pill}>
          {t("reasoningAgent.page.verifiedCount", {
            count: analysis.verifiedCount,
          })}
        </span>
        {analysis.unverifiedCount > 0 ? (
          <span className={styles.warningPill}>
            {t("reasoningAgent.page.unverifiedCount", {
              count: analysis.unverifiedCount,
            })}
          </span>
        ) : null}
      </div>
      <p className={styles.cardText}>
        {t("reasoningAgent.page.evidenceAnalysisBody")}
      </p>
      {analysis.source === "legacy_input_projection" ? (
        <div className={styles.scopeWarning}>
          {t("reasoningAgent.page.legacyEvidenceReplayNote")}
        </div>
      ) : null}
      {scopeFacts.length > 0 ? (
        <>
          <div className={styles.subLabel}>
            {t("reasoningAgent.page.forRuleScope")}
          </div>
          <EvidenceFactList facts={scopeFacts} t={t} />
        </>
      ) : null}
      {evaluationFacts.length > 0 ? (
        <>
          <div className={styles.subLabel}>
            {t("reasoningAgent.page.forPerRuleAssessment")}
          </div>
          <EvidenceFactList facts={evaluationFacts} t={t} />
        </>
      ) : null}
      {analysis.facts.length === 0 ? (
        <p className={styles.cardText}>
          {t("reasoningAgent.page.awaitingIntentReasonerFacts")}
        </p>
      ) : null}
      {analysis.temporalFacts.length > 0 ? (
        <details className={styles.codeDetails}>
          <summary>
            {t("reasoningAgent.page.viewTemporalFacts", {
              count: analysis.temporalFacts.length,
            })}
          </summary>
          <div className={styles.temporalFacts}>
            {analysis.temporalFacts.slice(0, 24).map((fact) => (
              <div className={styles.temporalFact} key={fact.path}>
                <strong>{fact.path}</strong>
                <span>
                  {t("reasoningAgent.page.temporalFactDetail", {
                    value: fact.value,
                    relation: fact.relationToAsOf,
                    days: fact.calendarDays,
                    months: fact.completedCalendarMonths,
                  })}
                </span>
              </div>
            ))}
          </div>
        </details>
      ) : null}
    </section>
  );
}

function ReasoningHarnessCard({
  plan,
  legacy,
  t,
}: {
  plan: ReasoningHarnessPlan | null;
  legacy: boolean;
  t: Translate;
}) {
  if (!plan) {
    if (!legacy) return null;
    return (
      <section className={styles.auditCard}>
        <CardHeading
          index="02B"
          title={t("reasoningAgent.page.card.dynamicReasoningHarness")}
          status="warning"
          t={t}
        />
        <div className={styles.scopeWarning}>
          {t("reasoningAgent.page.harnessLegacyNote")}
        </div>
      </section>
    );
  }
  return (
    <section className={styles.auditCard} data-testid="reasoning-harness-card">
      <CardHeading
        index="02B"
        title={t("reasoningAgent.page.card.dynamicReasoningHarness")}
        status="completed"
        t={t}
      />
      <div className={styles.callout}>{plan.publicRationale}</div>
      <p className={styles.cardText}>{t("reasoningAgent.page.harnessBody")}</p>
      <div className={styles.chipRow}>
        {plan.methods.map((method) => (
          <span className={styles.pill} key={method}>
            {method}
          </span>
        ))}
      </div>
      <div className={styles.metaGrid}>
        <span>{t("reasoningAgent.page.meta.capabilities")}</span>
        <strong>{plan.capabilityAnchors.join(" · ") || "—"}</strong>
        <span>{t("reasoningAgent.page.meta.objects")}</span>
        <strong>{plan.objectAnchors.join(" · ") || "—"}</strong>
      </div>
      {plan.evidenceAnchors.length > 0 ? (
        <details className={styles.codeDetails}>
          <summary>
            {t("reasoningAgent.page.evidenceAnchorsGroups", {
              count: plan.evidenceAnchors.length,
            })}
          </summary>
          <JsonBlock value={plan.evidenceAnchors} />
        </details>
      ) : null}
      <div className={styles.subLabel}>
        {t("reasoningAgent.page.stopConditions")}
      </div>
      <ul className={styles.missingList}>
        {plan.stopConditions.map((condition) => (
          <li key={condition}>{condition}</li>
        ))}
      </ul>
    </section>
  );
}

function CypherExecutionCard({
  executions,
  queryIr,
  diagnostics,
  ruleCount,
  legacyTemplateId,
  resultSchemaVersion,
  t,
}: {
  executions: RuleQueryExecution[];
  queryIr: ReasoningOutput["queryIr"];
  diagnostics: Record<string, unknown> | null | undefined;
  ruleCount: number;
  legacyTemplateId?: string;
  resultSchemaVersion?: ReasoningRunResponse["resultSchemaVersion"];
  t: Translate;
}) {
  if (executions.length === 0) {
    return (
      <section className={styles.auditCard} data-testid="cypher-execution-card">
        <CardHeading
          index="03"
          title={t("reasoningAgent.page.card.ruleSelectorQueryAgent")}
          status="warning"
          t={t}
        />
        <div className={styles.scopeWarning}>
          {t("reasoningAgent.page.cypherLegacyNote", {
            source: legacyTemplateId
              ? t("reasoningAgent.page.templateId", { id: legacyTemplateId })
              : t("reasoningAgent.page.legacySelectionReceipt"),
          })}
        </div>
        <div className={styles.subLabel}>
          {t("reasoningAgent.page.queryIrReplay")}
        </div>
        <JsonBlock value={queryIr} />
      </section>
    );
  }
  const selectionExecution =
    executions.find(
      (execution) => execution.purpose === "semantic-rule-selection",
    ) ?? executions[0]!;
  const legacyResult = resultSchemaVersion === "reasoning-result/v1";
  const semanticLinkContractVerified =
    !legacyResult && executions.every(hasVerifiedSemanticLinkReceipt);
  return (
    <section className={styles.auditCard} data-testid="cypher-execution-card">
      <CardHeading
        index="03"
        title={t("reasoningAgent.page.card.generatedCypherQueryAgent")}
        status="completed"
        t={t}
      />
      {legacyResult ? (
        <div className={styles.scopeWarning}>
          {t("reasoningAgent.page.cypherLegacyV1Note")}
        </div>
      ) : null}
      <div className={styles.chipRow}>
        <span className={styles.pill}>{t("reasoningAgent.page.readOnly")}</span>
        <span className={styles.pill}>
          {t("reasoningAgent.page.domainLocked")}
        </span>
        <span className={styles.pill}>
          {semanticLinkContractVerified
            ? t("reasoningAgent.page.linkOnly")
            : t("reasoningAgent.page.linkContractUnverifiedShort")}
        </span>
        <span className={styles.pill}>
          {semanticLinkContractVerified
            ? t("reasoningAgent.page.fallbackFalse")
            : t("reasoningAgent.page.fallbackUnverified")}
        </span>
        <span className={styles.pill}>
          {t("reasoningAgent.page.queryReceiptsCount", {
            count: executions.length,
          })}
        </span>
        <span className={styles.pill}>
          {t("reasoningAgent.page.rulesCount", { count: ruleCount })}
        </span>
      </div>
      <div className={styles.metricGrid}>
        <Metric
          label={t("reasoningAgent.page.metric.selectionRows")}
          value={selectionExecution.rowCount}
          tone="green"
        />
        <Metric
          label={t("reasoningAgent.page.metric.totalDuration")}
          value={`${executions.reduce((sum, execution) => sum + execution.durationMs, 0)} ms`}
        />
        <Metric
          label={t("reasoningAgent.page.metric.maxHops")}
          value={queryIr.maxHops}
        />
      </div>
      {executions.map((execution, index) => (
        <div
          className={styles.cypherReceipt}
          data-testid={`cypher-receipt-${execution.purpose}`}
          key={`${execution.purpose}-${execution.fingerprint}`}
        >
          <div className={styles.subLabel}>
            {index + 1}. {executionPurposeLabel(execution.purpose, t)}
          </div>
          <div className={styles.chipRow}>
            <span className={styles.pill}>{execution.purpose}</span>
            <span className={styles.pill}>
              {t("reasoningAgent.page.rowsCount", {
                count: execution.rowCount,
              })}
            </span>
            <span className={styles.pill}>{execution.durationMs} ms</span>
          </div>
          <div className={styles.metaGrid}>
            <span>{t("reasoningAgent.page.meta.fingerprint")}</span>
            <strong>{execution.fingerprint}</strong>
            <span>{t("reasoningAgent.page.meta.pathPattern")}</span>
            <strong>{execution.pathPattern}</strong>
          </div>
          <div className={styles.subLabel}>
            {t("reasoningAgent.page.executedCypher")}
          </div>
          <pre className={styles.cypherBlock}>{execution.query}</pre>
          <div className={styles.subLabel}>
            {t("reasoningAgent.page.boundParameters")}
          </div>
          <JsonBlock value={execution.parameters} />
        </div>
      ))}
      <details className={styles.codeDetails}>
        <summary>{t("reasoningAgent.page.viewQueryIrDiagnostics")}</summary>
        <div className={styles.subLabel}>
          {t("reasoningAgent.page.queryIr")}
        </div>
        <JsonBlock value={queryIr} />
        <div className={styles.subLabel}>
          {t("reasoningAgent.page.allmetaDiagnostics")}
        </div>
        <JsonBlock
          value={
            diagnostics ?? { note: t("reasoningAgent.page.noDiagnostics") }
          }
        />
      </details>
    </section>
  );
}

function executionPurposeLabel(
  purpose: RuleQueryExecution["purpose"],
  t: Translate,
): string {
  return purpose === "mandatory-link-coverage"
    ? t("reasoningAgent.page.executionPurpose.mandatoryLinkCoverage")
    : t("reasoningAgent.page.executionPurpose.semanticRuleSelection");
}

function EvidenceFactList({
  facts,
  t,
}: {
  facts: VisibleEvidenceAnalysis["facts"];
  t: Translate;
}) {
  return (
    <div className={styles.factList}>
      {facts.map((fact, index) => (
        <article
          className={[styles.factItem, !fact.verified && styles.factUnverified]
            .filter(Boolean)
            .join(" ")}
          key={[fact.evidencePath, index].join("-")}
        >
          <div className={styles.factHeader}>
            <strong>{fact.label}</strong>
            <span
              style={{ color: fact.verified ? "var(--green)" : "var(--amber)" }}
            >
              {fact.verified
                ? t("reasoningAgent.page.verified")
                : t("reasoningAgent.page.unverified")}
            </span>
          </div>
          <div className={styles.factValue}>
            {fact.value ?? t("reasoningAgent.page.unparsed")}
          </div>
          <code>{fact.evidencePath}</code>
          <p>{fact.relevance}</p>
        </article>
      ))}
    </div>
  );
}

function RulePoolCard({
  rules,
  evidencePlan,
  funnel,
  t,
}: {
  rules: RetrievedRule[];
  evidencePlan: VisibleEvidenceAnalysis["ruleEvidencePlan"];
  funnel: { scanned: number | null; matched: number | null; selected: number };
  t: Translate;
}) {
  if (rules.length === 0) return null;
  const planByRule = new Map(
    evidencePlan.map((entry) => [entry.ruleId, entry]),
  );
  return (
    <section
      className={styles.auditCard}
      data-testid="reasoning-selected-rule-pool"
    >
      <CardHeading
        index="03B"
        title={t("reasoningAgent.page.card.ruleBundleSelected")}
        status="completed"
        t={t}
      />
      <div className={styles.metricGrid}>
        <Metric
          label={t("reasoningAgent.page.metric.allmetaScanned")}
          value={funnel.scanned ?? "—"}
        />
        <Metric
          label={t("reasoningAgent.page.metric.semanticMatched")}
          value={funnel.matched ?? "—"}
        />
        <Metric
          label={t("reasoningAgent.page.metric.selected")}
          value={funnel.selected}
          tone="green"
        />
      </div>
      <p className={styles.cardText}>{t("reasoningAgent.page.rulePoolBody")}</p>
      <div className={styles.selectionRuleList}>
        {rules.map((rule, index) => {
          const plan = planByRule.get(rule.id);
          return (
            <article className={styles.selectionRule} key={rule.id}>
              <div className={styles.selectionRuleHeader}>
                <span>{String(index + 1).padStart(2, "0")}</span>
                <strong>
                  {rule.id} · {rule.name}
                </strong>
              </div>
              <div className={styles.chipRow}>
                <span className={styles.pill}>{rule.enforcementLevel}</span>
                <span className={styles.pill}>
                  {scopeLabel(ruleScope(rule), t)}
                </span>
                <span className={styles.pill}>
                  {t("reasoningAgent.page.scoreLabel", {
                    score: rule.selectionScore,
                  })}
                </span>
                <span className={styles.pill}>
                  {t("reasoningAgent.page.linkTriplesCount", {
                    count: rule.linkPaths?.length ?? 0,
                  })}
                </span>
                {plan ? (
                  <span className={styles.pill}>
                    {t("reasoningAgent.page.meta.signal")} · {plan.relevance}
                  </span>
                ) : null}
              </div>
              <div className={styles.selectionReasonRow}>
                <span>{t("reasoningAgent.page.whyEnteredRuleBundle")}</span>
                <strong>
                  {rule.matchReasons
                    .map((reason) => humanizeMatchReason(reason, t))
                    .join(" · ") ||
                    rule.scopeReason ||
                    t("reasoningAgent.page.allmetaSemanticLinkMatch")}
                </strong>
              </div>
              {(rule.matchedAnchors?.length ?? 0) > 0 ? (
                <div className={styles.metaLine}>
                  {t("reasoningAgent.page.meta.matchedAnchors")} ·{" "}
                  {rule.matchedAnchors.join(" · ")}
                </div>
              ) : null}
              <SemanticLinkPaths
                paths={rule.linkPaths ?? []}
                ruleId={rule.id}
                t={t}
              />
              {plan ? (
                <div className={styles.ruleEvidencePlan}>
                  <strong>{t("reasoningAgent.page.llmFactLinkage")}</strong>
                  <p>{plan.summary}</p>
                  {plan.evidence.length > 0 ? (
                    <ul>
                      {plan.evidence.map((item) => (
                        <li key={item.path}>
                          <span
                            style={{
                              color: item.verified
                                ? "var(--green)"
                                : "var(--amber)",
                            }}
                          >
                            {item.verified ? "✓" : "?"}
                          </span>{" "}
                          {item.path}
                          {item.actualValue == null
                            ? ""
                            : " = " + item.actualValue}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <div className={styles.metaLine}>
                      {t("reasoningAgent.page.noDirectFactSignal")}
                    </div>
                  )}
                </div>
              ) : (
                <div className={styles.metaLine}>
                  {t("reasoningAgent.page.noStructuredFactRoute")}
                </div>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}

function SemanticLinkPaths({
  paths,
  ruleId,
  t,
}: {
  paths: RetrievedRule["linkPaths"];
  ruleId: string;
  t: Translate;
}) {
  if (paths.length === 0) {
    return (
      <div className={styles.scopeWarning}>
        {t("reasoningAgent.page.noSemanticLinkReceipt")}
      </div>
    );
  }
  return (
    <details className={styles.linkPathDetails}>
      <summary>
        {t("reasoningAgent.page.semanticLinkPaths")} · {paths.length}
      </summary>
      <div className={styles.linkPathList}>
        {paths.map((path, index) => (
          <article
            className={styles.linkPath}
            key={
              path.linkId ??
              `${ruleId}-${path.predicate}-${path.object.id}-${index}`
            }
          >
            <div className={styles.linkTriple}>
              <span title={`${path.subject.type}:${path.subject.id}`}>
                {path.subject.displayName}
              </span>
              <strong>-[:{path.predicate}]-&gt;</strong>
              <span title={`${path.object.type}:${path.object.id}`}>
                {path.object.displayName}
              </span>
            </div>
            <p>{path.semanticRelationship}</p>
            <div className={styles.metaLine}>
              link_id · {path.linkId ?? "—"} ·{" "}
              {t("reasoningAgent.page.meta.status")} ·{" "}
              {path.status ? (
                <span
                  title={t("reasoningAgent.page.rawStatusTitle", {
                    status: path.status,
                  })}
                >
                  {statusLabel(path.status, t)}
                </span>
              ) : (
                "—"
              )}
              {path.confidence == null
                ? ""
                : ` · ${t("reasoningAgent.page.meta.confidence")} · ${path.confidence.toFixed(3)}`}
            </div>
            {path.evidence.length > 0 ? (
              <details className={styles.linkEvidence}>
                <summary>
                  {t("reasoningAgent.page.linkEvidenceCount", {
                    count: path.evidence.length,
                  })}
                </summary>
                <JsonBlock value={path.evidence} />
              </details>
            ) : null}
          </article>
        ))}
      </div>
    </details>
  );
}

function QualifiedAssessmentList({
  assessments,
  t,
}: {
  assessments: RuleAssessment[];
  t: Translate;
}) {
  const priority: Record<RuleAssessment["status"], number> = {
    violated: 0,
    insufficient_evidence: 1,
    optional_unmet: 2,
    satisfied: 3,
    not_applicable: 4,
  };
  const ordered = [...assessments].sort(
    (left, right) => priority[left.status] - priority[right.status],
  );
  return (
    <div
      className={styles.qualificationList}
      data-testid="qualified-agent-assessments"
    >
      <div className={styles.subLabel}>
        {t("reasoningAgent.page.perRuleAssessmentEvidence")}
      </div>
      {ordered.map((assessment) => (
        <article
          className={styles.qualificationItem}
          key={assessment.ruleId}
          style={{
            borderLeftColor: statusColor(assessment.status),
          }}
        >
          <div className={styles.qualificationHeader}>
            <strong>
              {assessment.ruleId} · {assessment.ruleName}
            </strong>
            <span
              style={{ color: statusColor(assessment.status) }}
              title={t("reasoningAgent.page.rawStatusTitle", {
                status: assessment.status,
              })}
            >
              {statusLabel(assessment.status, t)}
            </span>
          </div>
          <div className={styles.chipRow}>
            <span className={styles.pill}>{assessment.enforcementLevel}</span>
            <span className={styles.pill}>{assessment.failurePolicy}</span>
          </div>
          <p>{assessment.reason}</p>
          {assessment.evidence.length > 0 ? (
            <ul>
              {assessment.evidence.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          ) : (
            <div className={styles.metaLine}>
              {t("reasoningAgent.page.noDirectEvidencePath")}
            </div>
          )}
        </article>
      ))}
    </div>
  );
}

function PartialRuleSelectionCards({
  selection,
  t,
}: {
  selection: RuleSelectionToolData;
  t: Translate;
}) {
  return (
    <>
      <section className={styles.auditCard}>
        <CardHeading
          index="02C"
          title={t("reasoningAgent.page.card.intentReasoner")}
          status="completed"
          t={t}
        />
        <div className={styles.callout}>
          {selection.queryAgent.rationale ||
            t("reasoningAgent.page.lockedScenarioAction", {
              scenario: selection.scenario,
              action: selection.action,
            })}
        </div>
        <p className={styles.cardText}>
          {t("reasoningAgent.page.toolAuditableSelectionSummary")}
        </p>
      </section>
      <CypherExecutionCard
        executions={
          selection.queryExecutions ??
          selection.queryAgent.queryExecutions ??
          (selection.queryExecution
            ? [selection.queryExecution]
            : selection.queryAgent.queryExecution
              ? [selection.queryAgent.queryExecution]
              : [])
        }
        queryIr={selection.queryIr}
        diagnostics={selection.queryAgent.diagnostics}
        ruleCount={selection.rules.length}
        t={t}
      />
    </>
  );
}

export function PromptCompilerCard({
  prompt,
  receipt,
  qualifiedRun,
  ruleBundleId,
  executedPrompt,
  language = "en",
  t,
}: {
  prompt: CompiledPrompt | null;
  receipt: ReasoningToolAudit["compilerReceipt"];
  qualifiedRun: QualifiedAgentRunReceipt | null;
  ruleBundleId: string | null;
  executedPrompt: ReasoningToolAudit["executedQualifiedPrompt"];
  language?: "en" | "zh";
  t: Translate;
}) {
  const compiler = prompt ?? receipt?.compilerReceipt ?? null;
  const child = qualifiedRun ?? receipt?.qualifiedRun ?? null;
  const binding = projectPromptReceiptBinding(compiler, child, ruleBundleId);
  const systemPrompt =
    prompt?.systemPrompt ?? executedPrompt?.systemPrompt ?? null;
  const userPrompt = prompt?.userPrompt ?? executedPrompt?.userPrompt ?? null;
  const executedContentMatches =
    prompt && executedPrompt
      ? prompt.systemPrompt === executedPrompt.systemPrompt &&
        prompt.userPrompt === executedPrompt.userPrompt
      : null;
  const receiptMismatch =
    binding.status === "mismatch" || executedContentMatches === false;
  const visibleStatus = receiptMismatch
    ? t("reasoningAgent.page.receiptMismatch")
    : binding.status === "verified"
      ? t("reasoningAgent.page.receiptVerified")
      : binding.status === "awaiting_child"
        ? t("reasoningAgent.page.awaitingChild")
        : t("reasoningAgent.page.legacyUnverified");
  const compilerVersion =
    compiler?.compilerVersion ?? t("reasoningAgent.page.unknownCompiler");
  const compilerId = compiler?.compilerId ?? "—";
  const promptSha256 = compiler?.promptSha256 ?? "—";
  const fullSemanticPathsSha256 =
    prompt?.fullSemanticPathsSha256 ??
    receipt?.compilerReceipt.fullSemanticPathsSha256 ??
    null;
  const ruleCount = prompt?.ruleIds.length ?? receipt?.ruleCount ?? 0;
  const assessmentCount =
    child?.assessmentCount ?? receipt?.assessmentCount ?? null;
  const promptSource = prompt
    ? t("reasoningAgent.page.promptSourceReasoningResult")
    : executedPrompt
      ? t("reasoningAgent.page.promptSourceVerifiedChild")
      : t("reasoningAgent.page.promptSourceCompactReceipt");

  return (
    <section
      className={`${styles.auditCard} ${receiptMismatch ? styles.receiptMismatch : ""}`}
      data-testid="prompt-compiler-card"
    >
      <CardHeading
        index="04"
        title={t("reasoningAgent.page.card.promptCompiler")}
        status={receiptMismatch ? "blocked" : visibleStatus}
        t={t}
      />
      <div className={styles.chipRow}>
        <span className={styles.pill}>{compilerVersion}</span>
        <span className={styles.pill}>
          {t("reasoningAgent.page.rulesCount", { count: ruleCount })}
        </span>
        <span className={styles.pill}>
          {t("reasoningAgent.page.evidenceKeysCount", {
            count: prompt?.evidenceKeys.length ?? "—",
          })}
        </span>
        <span className={styles.pill}>
          {t("reasoningAgent.page.semanticLinksCount", {
            count: prompt?.semanticLinkCount ?? "—",
          })}
        </span>
        <span className={styles.pill}>
          {t("reasoningAgent.page.evidenceRoutesCount", {
            count: prompt?.evidencePlan?.length ?? "—",
          })}
        </span>
      </div>
      <p className={styles.cardText}>
        {t("reasoningAgent.page.promptCompilerBody")}
      </p>
      <div className={styles.metaGrid}>
        <span>compiler id</span>
        <strong>{compilerId}</strong>
        <span>{t("reasoningAgent.page.meta.scenario")}</span>
        <strong>
          {prompt?.scenario ??
            t("reasoningAgent.page.compactReceiptSeeRuntime")}
        </strong>
        <span>{t("reasoningAgent.page.meta.harnessMethods")}</span>
        <strong>{prompt?.harnessPlan?.methods.join(" → ") || "—"}</strong>
        <span>RuleBundle</span>
        <strong>{ruleBundleId ?? child?.ruleBundleId ?? "—"}</strong>
        <span>{t("reasoningAgent.page.meta.promptSource")}</span>
        <strong>{promptSource}</strong>
        <span>{t("reasoningAgent.page.meta.promptCharacters")}</span>
        <strong>
          {t("reasoningAgent.page.format.promptCharacters", {
            system:
              systemPrompt == null
                ? "—"
                : systemPrompt.length.toLocaleString(
                    language === "zh" ? "zh-CN" : "en-US",
                  ),
            user:
              userPrompt == null
                ? "—"
                : userPrompt.length.toLocaleString(
                    language === "zh" ? "zh-CN" : "en-US",
                  ),
          })}
        </strong>
      </div>
      <div className={styles.subLabel} data-testid="prompt-compiler-receipt">
        {t("reasoningAgent.page.immutableReceipts")}
      </div>
      <div className={styles.metaGrid}>
        <span>prompt sha256</span>
        <strong>{promptSha256}</strong>
        <span>semantic paths sha256</span>
        <strong>
          {fullSemanticPathsSha256 ??
            t("reasoningAgent.page.legacyNotRecorded")}
        </strong>
        <span>{t("reasoningAgent.page.meta.compilerChild")}</span>
        <strong
          style={{
            color: receiptMismatch
              ? "var(--red)"
              : statusColor(
                  binding.status === "verified" ? "completed" : "warning",
                ),
          }}
        >
          {visibleStatus}
        </strong>
        <span>{t("reasoningAgent.page.meta.compiledChildMessages")}</span>
        <strong>
          {executedContentMatches == null
            ? executedPrompt
              ? t("reasoningAgent.page.childInputRecovered")
              : t("reasoningAgent.page.childMessagesNotLoaded")
            : executedContentMatches
              ? t("reasoningAgent.page.exactMatch")
              : t("reasoningAgent.page.mismatch")}
        </strong>
      </div>
      {child ? (
        <>
          <div className={styles.subLabel}>
            {t("reasoningAgent.page.qualifiedAgentExecutionReceipt")}
          </div>
          <div className={styles.metaGrid}>
            <span>{t("reasoningAgent.page.meta.childRun")}</span>
            <strong>{child.runId}</strong>
            <span>{t("reasoningAgent.page.meta.providerModel")}</span>
            <strong>
              {child.provider} / {child.model}
            </strong>
            <span>{t("reasoningAgent.page.meta.tokens")}</span>
            <strong>{tokenIoLabel(child.tokensIn, child.tokensOut, t)}</strong>
            <span>{t("reasoningAgent.page.meta.durationAssessments")}</span>
            <strong>
              {child.durationMs} ms / {assessmentCount ?? "—"}
            </strong>
          </div>
        </>
      ) : null}
      {receiptMismatch ? (
        <div className={styles.scopeWarning} role="alert">
          {t("reasoningAgent.page.receiptMismatchWarning")}
        </div>
      ) : null}
      {systemPrompt && userPrompt ? (
        <>
          <div className={styles.promptPrivacyNotice}>
            {t("reasoningAgent.page.promptPrivacyNotice")}
          </div>
          <details
            className={styles.codeDetails}
            data-testid="prompt-system-details"
          >
            <summary>{t("reasoningAgent.page.viewFullSystemPrompt")}</summary>
            <pre className={styles.promptBlock}>{systemPrompt}</pre>
          </details>
          <details
            className={styles.codeDetails}
            data-testid="prompt-user-details"
          >
            <summary>{t("reasoningAgent.page.viewFullUserPrompt")}</summary>
            <pre className={styles.promptBlock}>{userPrompt}</pre>
          </details>
          {prompt?.evidencePlan?.length ? (
            <details className={styles.codeDetails}>
              <summary>
                {t("reasoningAgent.page.viewFactRuleRoutes", {
                  count: prompt.evidencePlan.length,
                })}
              </summary>
              <JsonBlock value={prompt.evidencePlan} />
            </details>
          ) : null}
        </>
      ) : (
        <p className={styles.cardText}>
          {t("reasoningAgent.page.compactReceiptOnly")}
        </p>
      )}
    </section>
  );
}

function RulesCards({
  output,
  selection,
  t,
}: {
  output: ReasoningOutput | null;
  selection: RuleSelectionToolData | null;
  t: Translate;
}) {
  const rules = output?.audit.ruleSelection.selectedRules ?? selection?.rules;
  if (!rules || rules.length === 0) {
    return (
      <div className={styles.emptyInspector}>
        {t("reasoningAgent.page.rulesEmptyHint")}
      </div>
    );
  }
  const assessmentById = new Map(
    (output?.assessments ?? []).map((assessment) => [
      assessment.ruleId,
      assessment,
    ]),
  );
  const mandatoryCount =
    output?.audit.ruleSelection.mandatoryCount ??
    selection?.mandatoryCount ??
    rules.filter((rule) => rule.enforcementLevel === "mandatory").length;
  const optionalCount =
    output?.audit.ruleSelection.optionalCount ??
    selection?.optionalCount ??
    rules.length - mandatoryCount;
  const selectedScopeCounts = scopeCounts(
    rules,
    output?.audit.ruleSelection.diagnostics ??
      selection?.queryAgent.diagnostics,
  );
  return (
    <div className={styles.rulesCard}>
      <div className={styles.rulesHeader}>
        <span>{t("reasoningAgent.page.allmetaRuleBundle")}</span>
        <span className={styles.pill}>
          {t("reasoningAgent.page.mandatoryOptionalCount", {
            mandatory: mandatoryCount,
            optional: optionalCount,
          })}
        </span>
      </div>
      <div className={`${styles.scopeGrid} ${styles.rulesScopeGrid}`}>
        <Metric
          label={t("reasoningAgent.page.scope.csiUniversal")}
          value={selectedScopeCounts.csi_universal}
          tone="green"
        />
        <Metric
          label={t("reasoningAgent.page.scope.clientGeneral")}
          value={selectedScopeCounts.client_general}
        />
        <Metric
          label={t("reasoningAgent.page.scope.clientDepartment")}
          value={selectedScopeCounts.client_department}
          tone="amber"
        />
      </div>
      {!output ? (
        <div className={styles.metaLine}>
          {t("reasoningAgent.page.ruleSelectorDoneNoAssessment")}
        </div>
      ) : null}
      {rules.map((rule) => {
        const assessment = assessmentById.get(rule.id);
        return (
          <details
            className={styles.rule}
            key={rule.id}
            open={
              assessment?.status === "violated" ||
              assessment?.status === "optional_unmet" ||
              assessment?.status === "insufficient_evidence"
            }
          >
            <summary className={styles.ruleSummary}>
              <span
                className={styles.ruleDot}
                style={{
                  background: statusColor(assessment?.status ?? "waiting"),
                }}
              />
              <span className={styles.ruleName} title={rule.name}>
                {rule.id} · {rule.name}
              </span>
              <span className={styles.ruleLevel}>{rule.enforcementLevel}</span>
            </summary>
            <div className={styles.ruleBody}>
              <div className={styles.subLabel}>
                {t("reasoningAgent.page.selectionBasis")}
              </div>
              <div className={styles.chipRow}>
                <span className={styles.pill}>
                  {scopeLabel(ruleScope(rule), t)}
                </span>
                <span className={styles.pill}>{rule.failurePolicy}</span>
                <span className={styles.pill}>
                  {t("reasoningAgent.page.scoreLabel", {
                    score: rule.selectionScore,
                  })}
                </span>
                <span className={styles.pill}>
                  {t("reasoningAgent.page.linkTriplesCount", {
                    count: rule.linkPaths?.length ?? 0,
                  })}
                </span>
                {rule.matchReasons.map((reason) => (
                  <span className={styles.pill} key={reason}>
                    {reason}
                  </span>
                ))}
              </div>
              {rule.scopeReason ? (
                <RuleField
                  label={t("reasoningAgent.page.field.scopePath")}
                  value={rule.scopeReason}
                />
              ) : null}
              {(rule.matchedAnchors?.length ?? 0) > 0 ? (
                <RuleField
                  label={t("reasoningAgent.page.field.matchedAnchors")}
                  value={rule.matchedAnchors.join(" · ")}
                />
              ) : null}
              <SemanticLinkPaths
                paths={rule.linkPaths ?? []}
                ruleId={rule.id}
                t={t}
              />
              <RuleField
                label={t("reasoningAgent.page.field.ruleLogic")}
                value={rule.logic}
              />
              <RuleField
                label={t("reasoningAgent.page.field.submissionCriteria")}
                value={rule.submissionCriteria}
              />
              <RuleField
                label={t("reasoningAgent.page.field.businessReason")}
                value={rule.businessReason}
              />
              <RuleField
                label={t("reasoningAgent.page.field.applicableClientDept")}
                value={
                  [rule.applicableClient, rule.applicableDepartment]
                    .filter(Boolean)
                    .join(" / ") || t("reasoningAgent.page.generic")
                }
              />
              <RuleField
                label={t("reasoningAgent.page.field.relatedObjects")}
                value={
                  [...rule.relatedObjectTypes, ...rule.relatedEntities].join(
                    ", ",
                  ) || "—"
                }
              />
              {assessment ? (
                <div className={styles.assessmentBox}>
                  <div className={styles.subLabel}>
                    {t("reasoningAgent.page.qualifiedAgentAssessmentBasis")}
                  </div>
                  <strong
                    style={{ color: statusColor(assessment.status) }}
                    title={t("reasoningAgent.page.rawStatusTitle", {
                      status: assessment.status,
                    })}
                  >
                    QualifiedAgent · {statusLabel(assessment.status, t)}
                  </strong>
                  <p>{assessment.reason}</p>
                  {assessment.evidence.length > 0 ? (
                    <ul>
                      {assessment.evidence.map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ) : null}
            </div>
          </details>
        );
      })}
    </div>
  );
}

function ExecutionLog({
  run,
  steps,
  children,
  t,
}: {
  run: ReasoningRunResponse["run"] | null;
  steps: ReasoningRunStep[];
  children: ReasoningRunResponse["children"];
  t: Translate;
}) {
  if (!run)
    return (
      <div className={styles.emptyInspector}>
        {t("reasoningAgent.page.logEmptyHint")}
      </div>
    );
  return (
    <div className={styles.cardStack}>
      <section className={styles.auditCard}>
        <CardHeading
          index="LOG"
          title={t("reasoningAgent.page.card.fullPublicAuditLog")}
          status={run.status}
          t={t}
        />
        <p className={styles.cardText}>
          {t("reasoningAgent.page.auditLogBody")}
        </p>
        <JsonBlock value={publicAuditPayload(run, t)} />
      </section>
      {steps.map((step) => (
        <details
          className={styles.logStep}
          key={step.id}
          open={
            step.status === "running" ||
            step.status === "failed" ||
            step.name === "select_applicable_rules"
          }
        >
          <summary>
            <span className={styles.logOrd}>
              {String(step.ord).padStart(2, "0")}
            </span>
            <span className={styles.logName}>
              {humanStepName(step, t, steps)}
            </span>
            <span
              style={{
                color: statusColor(
                  step.status === "failed"
                    ? "blocked"
                    : step.status === "running"
                      ? "running"
                      : "completed",
                ),
              }}
            >
              <span
                title={t("reasoningAgent.page.rawStatusTitle", {
                  status: step.status,
                })}
              >
                {statusLabel(step.status, t)}
              </span>
            </span>
          </summary>
          <div className={styles.logBody}>
            <div className={styles.metaLine}>
              {step.type} · {step.provider ?? "local"}/{step.model ?? "tool"} ·{" "}
              {step.durationMs ?? 0} ms ·{" "}
              {tokenIoLabel(step.tokensIn, step.tokensOut, t)}
            </div>
            {step.error ? (
              <div className={styles.error}>{step.error}</div>
            ) : null}
            <div className={styles.subLabel}>
              {t("reasoningAgent.page.input")}
            </div>
            <JsonBlock value={publicAuditPayload(step.input, t)} />
            <div className={styles.subLabel}>
              {t("reasoningAgent.page.output")}
            </div>
            <JsonBlock value={publicAuditPayload(step.output, t)} />
          </div>
        </details>
      ))}
      {children.map((child) => (
        <section className={styles.auditCard} key={child.run.id}>
          <CardHeading
            index="CHILD"
            title={`QualifiedAgent · ${child.run.id}`}
            status={child.run.status}
            t={t}
          />
          <JsonBlock value={publicAuditPayload(child.run, t)} />
          {child.steps.map((step) => (
            <details
              className={styles.logStep}
              key={`${child.run.id}-${step.id}`}
              open={step.status === "running" || step.status === "failed"}
            >
              <summary>
                <span className={styles.logOrd}>
                  {String(step.ord).padStart(2, "0")}
                </span>
                <span className={styles.logName}>
                  {humanStepName(step, t, child.steps, "qualified")}
                </span>
                <span
                  title={t("reasoningAgent.page.rawStatusTitle", {
                    status: step.status,
                  })}
                >
                  {statusLabel(step.status, t)}
                </span>
              </summary>
              <div className={styles.logBody}>
                <div className={styles.metaLine}>
                  {t("reasoningAgent.page.meta.childRun")} ·{" "}
                  {step.provider ?? "local"}/{step.model ?? "tool"}
                  {" · "}
                  {step.durationMs ?? 0} ms ·{" "}
                  {tokenIoLabel(step.tokensIn, step.tokensOut, t)}
                </div>
                {step.error ? (
                  <div className={styles.error}>{step.error}</div>
                ) : null}
                <div className={styles.subLabel}>
                  {t("reasoningAgent.page.input")}
                </div>
                <JsonBlock value={publicAuditPayload(step.input, t)} />
                <div className={styles.subLabel}>
                  {t("reasoningAgent.page.output")}
                </div>
                <JsonBlock value={publicAuditPayload(step.output, t)} />
              </div>
            </details>
          ))}
        </section>
      ))}
    </div>
  );
}

function CardHeading({
  index,
  title,
  status,
  t,
}: {
  index: string;
  title: string;
  status: string;
  t: Translate;
}) {
  const mapped: RuntimeStatus =
    status === "failed" || status === "cancelled" || status === "blocked"
      ? "blocked"
      : status === "warning" || status === "waiting"
        ? "warning"
        : status === "running" || status === "queued"
          ? "running"
          : "completed";
  return (
    <div className={styles.cardHeading}>
      <span className={styles.cardIndex}>{index}</span>
      <strong>{title}</strong>
      <span
        className={styles.cardStatus}
        style={{ color: statusColor(mapped) }}
        title={t("reasoningAgent.page.rawStatusTitle", { status })}
      >
        {statusLabel(status, t)}
      </span>
    </div>
  );
}

function Metric({
  label,
  value,
  tone,
}: {
  label: string;
  value: number | string;
  tone?: "green" | "red" | "amber";
}) {
  const color =
    tone === "green"
      ? "var(--green)"
      : tone === "red"
        ? "var(--red)"
        : tone === "amber"
          ? "var(--amber)"
          : "var(--text)";
  return (
    <div className={styles.metric}>
      <strong style={{ color }}>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function RuleField({ label, value }: { label: string; value: string }) {
  if (!value) return null;
  return (
    <div className={styles.ruleField}>
      <span>{label}</span>
      <p>{value}</p>
    </div>
  );
}

function JsonBlock({ value }: { value: unknown }) {
  return (
    <pre className={styles.jsonBlock}>
      {JSON.stringify(value ?? null, null, 2)}
    </pre>
  );
}

function formatTimestamp(value: string, language: "en" | "zh"): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleTimeString(language === "zh" ? "zh-CN" : "en-US");
}

function RuntimeGraph({
  agents,
  edges,
  t,
}: {
  agents: RuntimeAgent[];
  edges: Array<{ from: string; to: string }>;
  t: Translate;
}) {
  const nodes = agents.slice(0, 8);
  const y = nodes.map((_, index) => 42 + index * 70);
  const viewHeight = Math.max(84, 84 + (nodes.length - 1) * 70);
  const positionById = new Map(
    nodes.map((node, index) => [node.id, y[index]!] as const),
  );
  return (
    <svg
      className={styles.graph}
      viewBox={`0 0 340 ${viewHeight}`}
      role="img"
      aria-label={t("reasoningAgent.page.runtimeGraphAriaLabel")}
    >
      <defs>
        <marker
          id="reasoning-agent-arrow"
          viewBox="0 0 10 10"
          refX="8"
          refY="5"
          markerWidth="5"
          markerHeight="5"
          orient="auto-start-reverse"
        >
          <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--text-3)" />
        </marker>
      </defs>
      {edges.map((edge) => {
        const from = positionById.get(edge.from);
        const to = positionById.get(edge.to);
        if (from == null || to == null) return null;
        return (
          <line
            key={`${edge.from}-${edge.to}`}
            x1="170"
            y1={from + 23}
            x2="170"
            y2={to - 23}
            stroke="var(--text-3)"
            strokeOpacity="0.55"
            markerEnd="url(#reasoning-agent-arrow)"
          />
        );
      })}
      {nodes.map((node, index) => {
        const color = statusColor(node.status);
        return (
          <g key={node.id} transform={`translate(24 ${y[index]! - 25})`}>
            <rect
              width="292"
              height="50"
              rx="9"
              fill="var(--panel-2)"
              stroke={color}
              strokeOpacity={node.status === "waiting" ? 0.35 : 0.85}
              className={
                node.status === "running" ? styles.nodeRunning : undefined
              }
            />
            <circle cx="18" cy="17" r="4" fill={color} />
            <text
              x="30"
              y="20"
              fill="var(--text)"
              fontSize="11.5"
              fontWeight="600"
            >
              {node.label}
            </text>
            <text x="275" y="20" textAnchor="end" fill={color} fontSize="9.5">
              <title>
                {t("reasoningAgent.page.rawStatusTitle", {
                  status: node.status,
                })}
              </title>
              {statusLabel(node.status, t)}
            </text>
            <text x="18" y="38" fill="var(--text-3)" fontSize="9.5">
              {node.detail.length > 47
                ? `${node.detail.slice(0, 47)}…`
                : node.detail}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
