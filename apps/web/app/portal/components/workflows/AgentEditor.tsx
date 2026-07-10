"use client";

/**
 * AgentEditor — inline node editor for the Workflow editor (P3-FE-01).
 *
 * Drops into the right inspector aside when `editing && selectedAgent`. The
 * operator changes title / triggers / triggered_event, those mutations go
 * into the draft, and the "Save & deploy" action in the top toolbar fires
 * `POST /v1/agents`.
 *
 * Triggers and triggered_event are managed as comma-or-newline-separated
 * lists; we trim + dedupe on commit.
 */

import { useState, useEffect } from "react";
import { ActorTag, Badge, Button } from "@/app/portal/components";
import { useI18n } from "@/app/portal/lib/preferences-context";
import type { DagAgent } from "@/lib/hooks/useAgents";
import { Section, type EventCatalogItem } from "./inspectors";
import type { DraftAgent } from "./draft";

export interface AgentEditorProps {
  agent: DagAgent;
  events: EventCatalogItem[];
  /** Current draft for this agent (so the editor stays controlled across re-renders). */
  draft: DraftAgent | undefined;
  onChange: (next: DraftAgent) => void;
  onRemove: () => void;
  onClose: () => void;
}

export function AgentEditor({
  agent,
  events,
  draft,
  onChange,
  onRemove,
  onClose,
}: AgentEditorProps) {
  const { t } = useI18n();
  const effective = mergeAgent(agent, draft);
  const [titleInput, setTitleInput] = useState(effective.title);
  const [triggerInput, setTriggerInput] = useState(effective.triggers.join(", "));
  const [emitInput, setEmitInput] = useState(effective.emits.join(", "));

  // When the agent changes (operator picks a different node), reset inputs.
  useEffect(() => {
    setTitleInput(effective.title);
    setTriggerInput(effective.triggers.join(", "));
    setEmitInput(effective.emits.join(", "));
    // We intentionally key off agent.kebabId so React's lint rule isn't quite
    // right; rerunning on every field change would clobber typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent.kebabId]);

  function commit(partial: Partial<DraftAgent>) {
    onChange({
      id: agent.kebabId,
      title: titleInput,
      triggers: parseList(triggerInput),
      emits: parseList(emitInput),
      ...partial,
    });
  }

  return (
    <div
      style={{
        flex: 1,
        overflow: "auto",
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
      }}
    >
      <header
        style={{
          padding: "14px 16px",
          borderBottom: "1px solid var(--border)",
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
        }}
      >
        <div>
          <div style={{ display: "flex", gap: 6, marginBottom: 6 }}>
            <ActorTag actor={agent.actor} />
            <Badge tone="muted">{agent.kebabId}</Badge>
            <Badge tone="amber">{t("agentEditor.editBadge")}</Badge>
          </div>
          <div style={{ fontSize: 11, color: "var(--text-3)" }}>
            {t("agentEditor.draftHint")}
          </div>
        </div>
        <Button small icon="x" tone="ghost" onClick={onClose} ariaLabel={t("agentEditor.close")} />
      </header>

      <Section title={t("agentEditor.titleSection")}>
        <input
          value={titleInput}
          onChange={(e) => {
            setTitleInput(e.target.value);
            commit({ title: e.target.value });
          }}
          placeholder={t("agentEditor.titlePlaceholder")}
          style={inputStyle}
        />
      </Section>

      <Section title={t("agentEditor.triggeredBySection")}>
        <textarea
          value={triggerInput}
          onChange={(e) => {
            setTriggerInput(e.target.value);
            commit({ triggers: parseList(e.target.value) });
          }}
          placeholder="EVENT_A, EVENT_B"
          rows={2}
          style={textareaStyle}
        />
        <EventDictHint events={events} prefix={t("agentEditor.available")} />
      </Section>

      <Section title={t("agentEditor.triggeredEventSection")}>
        <textarea
          value={emitInput}
          onChange={(e) => {
            setEmitInput(e.target.value);
            commit({ emits: parseList(e.target.value) });
          }}
          placeholder="EVENT_A, EVENT_B"
          rows={2}
          style={textareaStyle}
        />
        <EventDictHint events={events} prefix={t("agentEditor.available")} />
      </Section>

      <div
        style={{
          padding: 14,
          marginTop: "auto",
          display: "flex",
          gap: 8,
          borderTop: "1px solid var(--border)",
        }}
      >
        <Button icon="x" tone="danger" onClick={onRemove}>
          {t("agentEditor.removeNode")}
        </Button>
      </div>
    </div>
  );
}

function EventDictHint({
  events,
  prefix,
}: {
  events: EventCatalogItem[];
  prefix: string;
}) {
  const { t } = useI18n();
  if (events.length === 0) return null;
  return (
    <div style={{ marginTop: 6, fontSize: 10.5, color: "var(--text-3)" }}>
      {prefix}: {events.slice(0, 6).map((e) => e.name).join(", ")}
      {events.length > 6 ? t("agentEditor.moreCount", { count: events.length - 6 }) : ""}
    </div>
  );
}

/** Pure helper exposed for tests. */
export function parseList(s: string): string[] {
  const out = new Set<string>();
  for (const part of s.split(/[,\s]+/)) {
    const t = part.trim();
    if (t.length > 0) out.add(t);
  }
  return Array.from(out);
}

function mergeAgent(
  base: DagAgent,
  draft: DraftAgent | undefined,
): DagAgent {
  if (!draft) return base;
  return {
    ...base,
    title: draft.title ?? base.title,
    triggers: draft.triggers ?? base.triggers,
    emits: draft.emits ?? base.emits,
  };
}

const inputStyle = {
  width: "100%",
  padding: "6px 10px",
  fontSize: 12.5,
  fontFamily: "var(--sans)",
  background: "var(--bg-2)",
  color: "var(--text)",
  border: "1px solid var(--border-2)",
  borderRadius: 4,
};

const textareaStyle = {
  ...inputStyle,
  fontFamily: "var(--mono)",
  fontSize: 12,
  resize: "vertical" as const,
};
