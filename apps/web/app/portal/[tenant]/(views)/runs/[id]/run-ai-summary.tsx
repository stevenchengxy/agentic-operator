"use client";

/**
 * W2 — AI run summary panel (the "AI 总结" tab in run detail).
 *
 * Lazily generates on first view (POST when the cache is empty) and caches, so
 * re-opening doesn't re-spend tokens. On success it shows the business details;
 * on failure it shows the problem + likely causes (guessed from the error) +
 * suggestions. Free-text narrative renders through the shared <Markdown>.
 */

import { useEffect, useRef, useState } from "react";
import { Badge, Button, Markdown } from "@/app/portal/components";
import { useI18n } from "@/app/portal/lib/preferences-context";
import {
  useRunSummary,
  useGenerateRunSummary,
  type RunSummary,
} from "@/lib/hooks/useRuns";

export function RunAiSummary({ runId }: { runId: string }) {
  const { t } = useI18n();
  const { data, isLoading } = useRunSummary(runId);
  const gen = useGenerateRunSummary();
  const attempted = useRef(false);

  // Lazy auto-generate the first time this tab is opened for a run that has no
  // cached summary yet. `attempted` guards against a re-fire on re-render.
  useEffect(() => {
    if (!data) return; // wait for the cache read
    if (data.summary) return; // already have one
    if (attempted.current || gen.isPending) return;
    attempted.current = true;
    gen.mutate(runId);
  }, [data, runId, gen]);

  const summary: RunSummary | null = data?.summary ?? gen.data?.summary ?? null;
  const busy = isLoading || gen.isPending;

  if (!summary && busy) {
    return (
      <div style={{ padding: "18px 16px", color: "var(--text-3)", fontSize: 13 }}>
        {t("runDetail.aiGenerating")}
      </div>
    );
  }

  if (!summary) {
    return (
      <div style={{ padding: "18px 16px" }}>
        <Button small icon="spark" onClick={() => gen.mutate(runId)} disabled={gen.isPending}>
          {t("runDetail.aiGenerate")}
        </Button>
      </div>
    );
  }

  const failed = Boolean(summary.problem);

  return (
    <div style={{ padding: "14px 16px", overflow: "auto", minHeight: 0 }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
        <span style={{ fontSize: 15, fontWeight: 600, color: "var(--text)" }}>
          {summary.headline}
        </span>
        <Badge tone={failed ? "red" : "signal"} style={{ fontSize: 9 }}>
          {summary.status}
        </Badge>
        <span style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
          {summary.scored && summary.model && (
            <span style={{ fontSize: 10.5, color: "var(--text-3)", fontFamily: "var(--mono)" }}>
              {summary.model}
            </span>
          )}
          <Button
            small
            icon="replay"
            tone="ghost"
            onClick={() => gen.mutate(runId)}
            disabled={gen.isPending}
          >
            {t("runDetail.aiRegenerate")}
          </Button>
        </span>
      </div>

      {!summary.scored && (
        <div
          style={{
            fontSize: 11.5,
            color: "var(--text-3)",
            marginBottom: 10,
            padding: "6px 10px",
            borderRadius: 6,
            background: "var(--panel-2)",
            border: "1px solid var(--border)",
          }}
        >
          {t("runDetail.aiDigestOnly")}
        </div>
      )}

      {/* Narrative */}
      {summary.narrative && (
        <div style={{ marginBottom: 12 }}>
          <Markdown>{summary.narrative}</Markdown>
        </div>
      )}

      {/* Success → business details */}
      {!failed && summary.businessDetails.length > 0 && (
        <SummaryList
          title={t("runDetail.aiBusinessDetails")}
          items={summary.businessDetails}
          accent="var(--signal)"
        />
      )}

      {/* Failure → problem + likely causes */}
      {failed && (
        <div
          style={{
            marginBottom: 12,
            padding: "8px 12px",
            borderRadius: 6,
            border: "1px solid color-mix(in srgb, var(--red) 30%, transparent)",
            background: "color-mix(in srgb, var(--red) 8%, transparent)",
          }}
        >
          <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--red)", marginBottom: 4 }}>
            {t("runDetail.aiProblem")}
          </div>
          <div style={{ fontSize: 13, color: "var(--text)", lineHeight: 1.5 }}>{summary.problem}</div>
        </div>
      )}
      {failed && summary.likelyCauses.length > 0 && (
        <SummaryList
          title={t("runDetail.aiLikelyCauses")}
          items={summary.likelyCauses}
          accent="var(--amber, #d09030)"
          ordered
        />
      )}

      {summary.suggestions.length > 0 && (
        <SummaryList
          title={t("runDetail.aiSuggestions")}
          items={summary.suggestions}
          accent="var(--text-2)"
        />
      )}

      {/* Raw activity digest (collapsible) */}
      {summary.digest && <DigestDetails digest={summary.digest} label={t("runDetail.aiDigest")} />}
    </div>
  );
}

function SummaryList({
  title,
  items,
  accent,
  ordered,
}: {
  title: string;
  items: string[];
  accent: string;
  ordered?: boolean;
}) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div
        style={{
          fontSize: 11,
          textTransform: "uppercase",
          letterSpacing: "0.06em",
          color: "var(--text-3)",
          marginBottom: 4,
        }}
      >
        {title}
      </div>
      <ul style={{ margin: 0, paddingLeft: 18, listStyle: ordered ? "decimal" : "disc" }}>
        {items.map((it, i) => (
          <li
            key={i}
            style={{
              fontSize: 13,
              color: "var(--text)",
              lineHeight: 1.55,
              marginBottom: 2,
              borderLeft: ordered ? undefined : `2px solid ${accent}`,
              paddingLeft: ordered ? undefined : 8,
              listStylePosition: "outside",
            }}
          >
            {it}
          </li>
        ))}
      </ul>
    </div>
  );
}

function DigestDetails({ digest, label }: { digest: string; label: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ marginTop: 8, borderTop: "1px solid var(--border)", paddingTop: 8 }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        style={{
          fontSize: 11,
          fontFamily: "var(--mono)",
          color: "var(--text-3)",
          background: "transparent",
          border: "none",
          cursor: "pointer",
          padding: 0,
        }}
      >
        {open ? "▾" : "▸"} {label}
      </button>
      {open && (
        <pre
          style={{
            marginTop: 6,
            fontSize: 11,
            fontFamily: "var(--mono)",
            color: "var(--text-2)",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            maxHeight: 320,
            overflow: "auto",
            background: "var(--panel-2)",
            border: "1px solid var(--border)",
            borderRadius: 6,
            padding: 10,
          }}
        >
          {digest}
        </pre>
      )}
    </div>
  );
}
