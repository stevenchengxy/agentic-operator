"use client";

/**
 * RunWithInputModal — operator-facing "Run agent with custom input" dialog.
 *
 * The headline "Test run" button on the agent detail page sends
 * `agent.input_data ?? {}` — convenient for smoke tests but useless for
 * workflows whose `logic` step requires payload fields the manifest can't
 * declare (e.g. plain-text `resume` + `jd` for the live RoboHire
 * matchResumeApi call). This modal closes that gap: paste / edit a JSON
 * body in a textarea, hit Run, and the same `useInvokeAgent` mutation
 * fires with the typed input.
 *
 * Intentionally NOT Monaco — a plain textarea keeps the bundle small and
 * the modal feels instant. JSON parsing happens on submit; a parse error
 * surfaces inline so the operator can fix the body without losing it.
 */

import { useEffect, useMemo, useState } from "react";
import { z } from "zod";

import { Button } from "@/app/portal/components";
import { ModalOverlay } from "@/app/portal/components/Modal";
import { useI18n } from "@/app/portal/lib/preferences-context";
import { useInvokeAgent } from "@/lib/hooks/useAgents";

const CodeInvokeSuccess = z.object({
  kind: z.literal("code").optional(),
  runId: z.string().min(1),
  status: z.enum(["ok", "failed", "queued", "cancelled"]),
});

const ManifestInvokeSuccess = z.object({
  kind: z.literal("manifest"),
  status: z.literal("queued"),
  eventId: z.string().min(1),
  eventName: z.string().min(1),
  correlationId: z.string().min(1),
  subject: z.string().min(1),
});

const InvokeSuccess = z.union([ManifestInvokeSuccess, CodeInvokeSuccess]);

interface RunWithInputModalProps {
  /** Manifest agent's `name` (e.g. "matcherAgent"). */
  agentName: string;
  /** Pretty agent label for the modal title. */
  agentTitle: string;
  /** Default body — usually `agent.input_data` or a small recipe snapshot. */
  defaultInput?: unknown;
  /** Comma-separated list of fields the LLM-side tools require, surfaced as a hint above the editor. Optional. */
  requiredFieldsHint?: string;
  /** Called when the user dismisses without running. */
  onClose: () => void;
  /** Called with the new runId once the api responds with one. */
  onSubmitted?: (runId: string) => void;
}

export function RunWithInputModal({
  agentName,
  agentTitle,
  defaultInput,
  requiredFieldsHint,
  onClose,
  onSubmitted,
}: RunWithInputModalProps) {
  const { t } = useI18n();
  const invoke = useInvokeAgent();

  // Seed the textarea once on open. Re-opening with a different agent
  // recreates the component (the parent toggles `open` to remount), so a
  // fresh defaultInput always wins.
  const initialJson = useMemo(() => {
    const seed =
      defaultInput && typeof defaultInput === "object"
        ? defaultInput
        : defaultInput
          ? { value: defaultInput }
          : {};
    try {
      return JSON.stringify(seed, null, 2);
    } catch {
      return "{}";
    }
  }, [defaultInput]);

  const [bodyText, setBodyText] = useState(initialJson);
  // The route returns ONE of two response shapes — `runId` for sync
  // code-agent invokes, or `eventId+correlationId+kind=manifest` for the
  // async manifest path. Track both so the envelope makes sense regardless.
  const [submitted, setSubmitted] = useState<
    | { kind: "code"; runId: string; submittedAt: number }
    | {
        kind: "manifest";
        eventId: string;
        correlationId: string;
        submittedAt: number;
      }
    | null
  >(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);

  // Mirror the textarea — clear errors as soon as the operator edits.
  useEffect(() => {
    setParseError(null);
    setServerError(null);
  }, [bodyText]);

  async function handleRun() {
    let parsed: unknown;
    try {
      parsed = bodyText.trim() === "" ? {} : JSON.parse(bodyText);
    } catch (err) {
      setParseError(
        t("runWithInputModal.parseErrorPrefix", {
          msg: err instanceof Error ? err.message : String(err),
        }),
      );
      return;
    }
    setServerError(null);
    try {
      const res = await invoke.mutateAsync({
        name: agentName,
        testRun: true,
        input: parsed,
      });
      const result = InvokeSuccess.safeParse(res);
      if (!result.success) {
        const first = result.error.issues[0];
        setServerError(
          t("runWithInputModal.protocolError", {
            detail: first
              ? `${first.path.join(".") || "response"}: ${first.message}`
              : "invalid response",
          }),
        );
        return;
      }
      const now = Date.now();
      if (result.data.kind === "manifest") {
        setSubmitted({
          kind: "manifest",
          eventId: result.data.eventId,
          correlationId: result.data.correlationId,
          submittedAt: now,
        });
      } else {
        setSubmitted({
          kind: "code",
          runId: result.data.runId,
          submittedAt: now,
        });
        onSubmitted?.(result.data.runId);
      }
    } catch (err) {
      setServerError(
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  return (
    <ModalOverlay
      onClose={onClose}
      ariaLabel={t("runWithInputModal.ariaLabel", { agentTitle })}
    >
      <div
        style={{
          width: "min(640px, 92vw)",
          background: "var(--panel)",
          border: "1px solid var(--border)",
          borderRadius: 6,
          padding: 20,
          display: "flex",
          flexDirection: "column",
          gap: 14,
        }}
      >
        <header style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
          <h3
            style={{
              margin: 0,
              fontSize: 16,
              fontFamily: "var(--display)",
              fontWeight: 500,
            }}
          >
            {t("runWithInputModal.heading")}
          </h3>
          <span
            className="mono"
            style={{ fontSize: 11.5, color: "var(--text-3)" }}
          >
            · {agentName}
          </span>
        </header>

        <p style={{ margin: 0, fontSize: 12.5, color: "var(--text-2)" }}>
          {t("runWithInputModal.descBeforeBodyInput")}{" "}
          <code className="mono">body.input</code>{" "}
          {t("runWithInputModal.descBeforeEndpoint")}{" "}
          <code className="mono">
            POST /v1/agents/{agentName}/invoke?testRun=1
          </code>
          {t("runWithInputModal.descAfterEndpoint")}
        </p>

        {requiredFieldsHint && (
          <div
            style={{
              fontSize: 12,
              color: "var(--text-2)",
              background: "var(--panel-2)",
              border: "1px solid var(--border)",
              borderRadius: 4,
              padding: "8px 10px",
            }}
          >
            {t("runWithInputModal.requiredFields")}{" "}
            <strong className="mono">{requiredFieldsHint}</strong>
          </div>
        )}

        <label
          htmlFor="run-input-textarea"
          style={{
            fontSize: 11,
            textTransform: "uppercase",
            letterSpacing: 0.4,
            color: "var(--text-3)",
          }}
        >
          {t("runWithInputModal.jsonBody")}
        </label>
        <textarea
          id="run-input-textarea"
          value={bodyText}
          onChange={(e) => setBodyText(e.target.value)}
          spellCheck={false}
          autoFocus
          style={{
            width: "100%",
            minHeight: 220,
            maxHeight: 360,
            padding: 10,
            fontFamily: "var(--mono)",
            fontSize: 12.5,
            lineHeight: 1.5,
            background: "var(--panel-2)",
            color: "var(--text)",
            border: `1px solid ${parseError ? "var(--red)" : "var(--border)"}`,
            borderRadius: 4,
            resize: "vertical",
            outline: "none",
          }}
        />

        {parseError && (
          <p style={{ margin: 0, fontSize: 12, color: "var(--red)" }}>
            {parseError}
          </p>
        )}
        {serverError && (
          <p style={{ margin: 0, fontSize: 12, color: "var(--red)" }}>
            {t("runWithInputModal.serverError")} {serverError}
          </p>
        )}

        {submitted && (
          <div
            style={{
              fontSize: 12.5,
              color: "var(--text-2)",
              background: "color-mix(in srgb, var(--signal) 6%, transparent)",
              border: "1px solid color-mix(in srgb, var(--signal) 32%, transparent)",
              borderRadius: 4,
              padding: "10px 12px",
              display: "flex",
              flexDirection: "column",
              gap: 6,
            }}
          >
            {submitted.kind === "code" ? (
              <span>
                ✓ {t("runWithInputModal.runCompleted")} ·{" "}
                <span className="mono" style={{ color: "var(--text)" }}>
                  {submitted.runId}
                </span>
                <span className="mono" style={{ fontSize: 11, color: "var(--text-3)", marginLeft: 8 }}>
                  ({new Date(submitted.submittedAt).toLocaleTimeString()})
                </span>
              </span>
            ) : (
              <>
                <span>
                  ✓ {t("runWithInputModal.manifestQueued")} ·{" "}
                  {t("runWithInputModal.eventLabel")}{" "}
                  <span className="mono" style={{ color: "var(--text)" }}>
                    {submitted.eventId}
                  </span>
                  <span className="mono" style={{ fontSize: 11, color: "var(--text-3)", marginLeft: 8 }}>
                    ({new Date(submitted.submittedAt).toLocaleTimeString()})
                  </span>
                </span>
                <span style={{ fontSize: 11.5, color: "var(--text-3)" }}>
                  correlationId ={" "}
                  <span className="mono">{submitted.correlationId}</span>
                </span>
                <span style={{ fontSize: 11.5, color: "var(--text-3)" }}>
                  {t("runWithInputModal.inngestHint")}
                </span>
              </>
            )}
          </div>
        )}

        <footer
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
            marginTop: 4,
          }}
        >
          <Button small tone="ghost" onClick={onClose} disabled={invoke.isPending}>
            {submitted ? t("runWithInputModal.close") : t("runWithInputModal.cancel")}
          </Button>
          <Button
            small
            icon="run"
            tone="primary"
            onClick={handleRun}
            disabled={invoke.isPending}
          >
            {invoke.isPending
              ? t("runWithInputModal.running")
              : submitted
                ? t("runWithInputModal.runAgain")
                : t("runWithInputModal.run")}
          </Button>
        </footer>
      </div>
    </ModalOverlay>
  );
}
