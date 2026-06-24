"use client";

/**
 * DeployAgentModal — 6-step wizard for adding a new agent to the workflow.
 *
 * Live data via canonical TanStack hooks (useEvents for event-name
 * autocomplete + useDag for the workflow stage list). Models are passed
 * in from the page (audit 01 D-11).
 */

import { useMemo, useState } from "react";
import { useI18n } from "@/app/portal/lib/preferences-context";
import {
  ActorTag,
  Badge,
  Button,
  CodeBlock,
  Icon,
  ModalOverlay,
  Panel,
} from "@/app/portal/components";
import { useDag } from "@/lib/hooks/useAgents";
import { useEvents } from "@/lib/hooks/useEvents";
import {
  AGENT_SAMPLE_TOOL_USE,
  AGENT_SAMPLE_TS_CODE,
  type ToolUseSchema,
} from "@/app/portal/components/agent-code/samples";
import {
  AgentCodeEditPanel,
  AgentToolUseEditPanel,
} from "@/app/portal/components/agent-code/EditPanels";

// Static workflow ontology labels — mirrors the dashboard funnel.
const STAGE_LABELS: Record<number, string> = {
  0: "Intake",
  1: "Analyze",
  2: "JD",
  3: "Publish",
  4: "Resume",
  5: "Match & Interview",
  6: "Package",
  7: "Submit",
};

interface ModelInfo {
  id: string;
  name: string;
}

const AGENT_TEMPLATES = [
  { id: "blank", actor: "Agent" as const, name: "Blank agent", desc: "Empty handler. Bring your own steps + prompt.", color: "var(--text-3)" },
  { id: "classify", actor: "Agent" as const, name: "Classifier", desc: "Single LLM call, returns one of N labels. Cheap and fast.", color: "var(--blue)" },
  { id: "extract", actor: "Agent" as const, name: "Extractor", desc: "Pulls structured JSON from unstructured input. JSON schema enforced.", color: "var(--blue)" },
  { id: "rag", actor: "Agent" as const, name: "RAG retriever", desc: "Embeds question, fetches top-k chunks, answers with citations.", color: "var(--violet)" },
  { id: "loop", actor: "Agent" as const, name: "Tool-loop agent", desc: "Iterates tool calls until done. Use for research, browsing, data lookups.", color: "var(--signal)" },
  { id: "human", actor: "Human" as const, name: "Human approval", desc: "Pauses the workflow for an operator to approve, reject, or supplement.", color: "var(--violet)" },
];

const COMMON_TOOLS = [
  { id: "db.query", kind: "Data", hint: "Read from the run-state DB" },
  { id: "db.upsert", kind: "Data", hint: "Write/update rows" },
  { id: "db.lock", kind: "Data", hint: "Acquire a distributed lock" },
  { id: "http.fetch", kind: "Network", hint: "HTTP GET/POST with retry" },
  { id: "llm.generate", kind: "Model", hint: "Direct LLM call (escape hatch)" },
  { id: "llm.evaluate", kind: "Model", hint: "LLM-as-judge rubric scoring" },
  { id: "ocr.parse", kind: "Document", hint: "PDF → text + structure" },
  { id: "nlp.extract", kind: "Document", hint: "Entity / field extraction" },
  { id: "pdf.compose", kind: "Document", hint: "Render markdown → PDF" },
  { id: "scoring.match", kind: "Domain", hint: "Resume↔JD matcher (RAAS)" },
  { id: "email.send", kind: "Notify", hint: "Transactional email" },
  { id: "wechat.notify", kind: "Notify", hint: "WeChat Work bot" },
  { id: "ats.adapter", kind: "Integration", hint: "Client ATS submit" },
];

type Template = (typeof AGENT_TEMPLATES)[number];

export function DeployAgentModal({
  onClose,
  models,
}: {
  onClose: () => void;
  models: ModelInfo[];
}) {
  const { t } = useI18n();
  const { data: dag } = useDag();
  const { data: liveEvents = [] } = useEvents({ limit: 100 });
  // Derive stages from the live DAG (set of stage indices in use).
  const stages = useMemo(() => {
    const used = new Set<number>();
    for (const a of dag?.agents ?? []) used.add(a.stage);
    return Array.from(used)
      .sort((a, b) => a - b)
      .map((id) => ({
        id,
        label: STAGE_LABELS[id]
          ? t(`deployAgentModal.stage_${id}`)
          : t("deployAgentModal.stageFallback", { id }),
      }));
  }, [dag, t]);
  // Event-name catalog combines names seen on the live stream + every name
  // declared by an agent in the DAG.
  const events = useMemo(() => {
    const set = new Set<string>();
    for (const e of liveEvents) set.add(e.name);
    for (const a of dag?.agents ?? []) {
      for (const n of a.triggers) set.add(n);
      for (const n of a.emits) set.add(n);
    }
    return Array.from(set).sort().map((name) => ({ name }));
  }, [liveEvents, dag]);
  const [step, setStep] = useState(0);
  const [template, setTemplate] = useState<Template | null>(null);
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [desc, setDesc] = useState("");
  const [stage, setStage] = useState(5);
  const [model, setModel] = useState(models[0]?.name ?? "");
  const [tools, setTools] = useState<string[]>([]);
  const [triggers, setTriggers] = useState<string[]>([]);
  const [emits, setEmits] = useState<string[]>([]);
  const [retries, setRetries] = useState(3);
  const [timeout, setTimeoutVal] = useState(120);
  const [concurrency, setConcurrency] = useState(8);
  const [implTab, setImplTab] = useState<"prompt" | "code" | "tools" | "bind">("prompt");
  const [tsCode, setTsCode] = useState(AGENT_SAMPLE_TS_CODE);
  const [toolUse, setToolUse] = useState<ToolUseSchema[]>(AGENT_SAMPLE_TOOL_USE);

  const steps = [
    t("deployAgentModal.stepTemplate"),
    t("deployAgentModal.stepIdentity"),
    t("deployAgentModal.stepEvents"),
    t("deployAgentModal.stepImplementation"),
    t("deployAgentModal.stepBehavior"),
    t("deployAgentModal.stepReview"),
  ];

  function pickTemplate(t: Template) {
    setTemplate(t);
    if (t.id === "classify") setTools(["llm.generate"]);
    if (t.id === "extract") setTools(["llm.generate", "db.upsert"]);
    if (t.id === "rag") setTools(["http.fetch", "llm.generate"]);
    if (t.id === "loop") setTools(["http.fetch", "db.query", "llm.generate"]);
    setStep(1);
  }
  function next() {
    setStep((s) => Math.min(steps.length - 1, s + 1));
  }
  function back() {
    setStep((s) => Math.max(0, s - 1));
  }
  function toggleTool(id: string) {
    setTools((ts) => (ts.includes(id) ? ts.filter((t) => t !== id) : [...ts, id]));
  }
  function addEvent(set: React.Dispatch<React.SetStateAction<string[]>>, val: string) {
    const v = val.trim().toUpperCase().replace(/[^A-Z0-9_]/g, "_");
    if (v) set((arr) => (arr.includes(v) ? arr : [...arr, v]));
  }
  function removeEvent(set: React.Dispatch<React.SetStateAction<string[]>>, v: string) {
    set((arr) => arr.filter((x) => x !== v));
  }

  return (
    <ModalOverlay onClose={onClose}>
      <div
        style={{
          width: 1080,
          maxHeight: "88vh",
          background: "var(--panel)",
          border: "1px solid var(--border-2)",
          borderRadius: 8,
          overflow: "hidden",
          boxShadow: "0 24px 60px -20px rgba(0,0,0,0.6)",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <header style={{ display: "flex", alignItems: "center", gap: 10, padding: "14px 18px", borderBottom: "1px solid var(--border)" }}>
          <Icon name="agent" size={14} style={{ color: "var(--accent-text)" }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 14, color: "var(--text)", fontWeight: 500 }}>{t("deployAgentModal.title")}</div>
            <div style={{ fontSize: 11, color: "var(--text-3)" }}>
              {t("deployAgentModal.draftHintPart1")} <span className="mono">raas</span>. {t("deployAgentModal.draftHintPart2")}
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label={t("deployAgentModal.closeAria")}
            style={{ color: "var(--text-3)" }}
          >
            <Icon name="x" size={13} />
          </button>
        </header>

        <div
          style={{
            display: "flex",
            gap: 6,
            padding: "10px 18px",
            borderBottom: "1px solid var(--border)",
            background: "var(--bg-2)",
          }}
        >
          {steps.map((s, i) => (
            <div
              key={s}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                opacity: i === step ? 1 : i < step ? 0.85 : 0.45,
              }}
            >
              <span
                style={{
                  width: 18,
                  height: 18,
                  borderRadius: "50%",
                  background: i < step ? "var(--signal)" : "transparent",
                  border: `1px solid ${i <= step ? "var(--signal)" : "var(--border-2)"}`,
                  color: i < step ? "var(--on-signal)" : i === step ? "var(--accent-text)" : "var(--text-3)",
                  fontSize: 10,
                  fontFamily: "var(--mono)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                {i < step ? "✓" : i + 1}
              </span>
              <span
                style={{
                  fontSize: 11,
                  fontFamily: "var(--mono)",
                  textTransform: "uppercase",
                  letterSpacing: "0.06em",
                  color: i === step ? "var(--text)" : "var(--text-3)",
                }}
              >
                {s}
              </span>
              {i < steps.length - 1 && (
                <span style={{ width: 14, height: 1, background: "var(--border)", marginLeft: 4 }} />
              )}
            </div>
          ))}
        </div>

        <div style={{ padding: 20, overflow: "auto", flex: 1, minHeight: 0 }}>
          {step === 0 && (
            <div>
              <SectionLabel>{t("deployAgentModal.pickTemplate")}</SectionLabel>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10 }}>
                {AGENT_TEMPLATES.map((tpl) => (
                  <button
                    key={tpl.id}
                    onClick={() => pickTemplate(tpl)}
                    style={{
                      padding: "12px 14px",
                      background: "var(--panel-2)",
                      border: "1px solid var(--border)",
                      borderLeft: `3px solid ${tpl.color}`,
                      borderRadius: 5,
                      textAlign: "left",
                      cursor: "pointer",
                      transition: "background 0.12s, border-color 0.12s",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
                      <ActorTag actor={tpl.actor} />
                    </div>
                    <div style={{ fontSize: 13, color: "var(--text)", fontWeight: 500, marginBottom: 3 }}>{t(`deployAgentModal.tpl_${tpl.id}_name`)}</div>
                    <div style={{ fontSize: 11.5, color: "var(--text-2)", lineHeight: 1.5 }}>{t(`deployAgentModal.tpl_${tpl.id}_desc`)}</div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {step === 1 && template && (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, maxWidth: 760 }}>
              <EditField label={t("deployAgentModal.nameLabel")} hint={t("deployAgentModal.nameHint")}>
                <EditText value={name} onChange={setName} mono />
              </EditField>
              <EditField label={t("deployAgentModal.titleLabel")} hint={t("deployAgentModal.titleHint")}>
                <EditText value={title} onChange={setTitle} />
              </EditField>
              <div style={{ gridColumn: "1 / -1" }}>
                <EditField label={t("deployAgentModal.descLabel")} hint={t("deployAgentModal.descHint")}>
                  <EditTextarea value={desc} onChange={setDesc} rows={3} />
                </EditField>
              </div>
              <EditField label={t("deployAgentModal.stageLabel")} hint={t("deployAgentModal.stageHint")}>
                <select
                  value={stage}
                  onChange={(e) => setStage(parseInt(e.target.value, 10))}
                  style={editSelectStyle}
                >
                  {stages.map((s) => (
                    <option key={s.id} value={s.id}>
                      {String(s.id).padStart(2, "0")} · {s.label}
                    </option>
                  ))}
                </select>
              </EditField>
              <EditField label={t("deployAgentModal.actorLabel")} hint={template.actor === "Human" ? t("deployAgentModal.actorHintHuman") : t("deployAgentModal.actorHintAgent")}>
                <Seg
                  value={template.actor}
                  onChange={() => {}}
                  options={[
                    { value: "Agent", label: t("deployAgentModal.actorAgent") },
                    { value: "Human", label: t("deployAgentModal.actorHumanTask") },
                  ]}
                />
              </EditField>
            </div>
          )}

          {step === 2 && (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, maxWidth: 760 }}>
              <EditField label={t("deployAgentModal.triggersLabel")} hint={t("deployAgentModal.triggersHint")}>
                <EventPicker
                  selected={triggers}
                  onAdd={(v) => addEvent(setTriggers, v)}
                  onRemove={(v) => removeEvent(setTriggers, v)}
                  tone="blue"
                  all={events.map((e) => e.name)}
                />
              </EditField>
              <EditField label={t("deployAgentModal.emitsLabel")} hint={t("deployAgentModal.emitsHint")}>
                <EventPicker
                  selected={emits}
                  onAdd={(v) => addEvent(setEmits, v)}
                  onRemove={(v) => removeEvent(setEmits, v)}
                  tone="green"
                  all={events.map((e) => e.name)}
                />
              </EditField>
            </div>
          )}

          {step === 3 && (
            <div>
              <div
                style={{
                  display: "flex",
                  gap: 0,
                  borderBottom: "1px solid var(--border)",
                  marginBottom: 14,
                }}
              >
                {([
                  { id: "prompt", label: t("deployAgentModal.tabPrompt"), icon: "logs" as const },
                  { id: "code", label: t("deployAgentModal.tabCode"), icon: "code" as const },
                  { id: "tools", label: "tool_use", icon: "spark" as const },
                  { id: "bind", label: t("deployAgentModal.tabBind"), icon: "git" as const },
                ] as const).map((tab) => (
                  <button
                    key={tab.id}
                    onClick={() => setImplTab(tab.id)}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      padding: "8px 14px",
                      fontSize: 11.5,
                      fontFamily: "var(--mono)",
                      textTransform: "uppercase",
                      letterSpacing: "0.06em",
                      color: implTab === tab.id ? "var(--text)" : "var(--text-3)",
                      borderBottom: `2px solid ${implTab === tab.id ? "var(--signal)" : "transparent"}`,
                      marginBottom: -1,
                    }}
                  >
                    <Icon name={tab.icon} size={11} />
                    {tab.label}
                    {tab.id === "tools" && (
                      <span
                        style={{
                          marginLeft: 4,
                          padding: "0 5px",
                          background: "var(--panel-2)",
                          border: "1px solid var(--border)",
                          borderRadius: 8,
                          fontSize: 9.5,
                          color: "var(--text-3)",
                        }}
                      >
                        {toolUse.length}
                      </span>
                    )}
                    {tab.id === "bind" && (
                      <span
                        style={{
                          marginLeft: 4,
                          padding: "0 5px",
                          background: "var(--panel-2)",
                          border: "1px solid var(--border)",
                          borderRadius: 8,
                          fontSize: 9.5,
                          color: "var(--text-3)",
                        }}
                      >
                        {tools.length}
                      </span>
                    )}
                  </button>
                ))}
                <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8, padding: "4px 0" }}>
                  <span style={{ fontSize: 11, color: "var(--text-3)" }}>{t("deployAgentModal.model")}</span>
                  <select
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                    style={{
                      background: "var(--panel-2)",
                      border: "1px solid var(--border-2)",
                      borderRadius: 4,
                      padding: "4px 8px",
                      color: "var(--text)",
                      fontFamily: "var(--mono)",
                      fontSize: 11.5,
                      outline: "none",
                    }}
                  >
                    {models.length === 0 ? (
                      <option value="">{t("deployAgentModal.noModels")}</option>
                    ) : (
                      models.map((m) => (
                        <option key={m.id} value={m.name}>{m.name}</option>
                      ))
                    )}
                  </select>
                </div>
              </div>

              {implTab === "prompt" && (
                <EditField
                  label={t("deployAgentModal.systemPromptLabel")}
                  hint={t("deployAgentModal.systemPromptHint")}
                >
                  <EditTextarea
                    value={`You are an automated agent named ${name || "<name>"} in the RAAS workflow.\nGoal: ${title || "<title>"}.\n\nFollow these rules:\n- Emit one structured progress event per step.\n- Never block on human input — emit a HUMAN_TASK event if needed.\n- Be conservative; if uncertain, fall through to manual review.`}
                    onChange={() => {}}
                    rows={14}
                    mono
                  />
                </EditField>
              )}

              {implTab === "code" && (
                <AgentCodeEditPanel value={tsCode} onChange={setTsCode} height={480} />
              )}
              {implTab === "tools" && (
                <AgentToolUseEditPanel tools={toolUse} onChange={setToolUse} />
              )}

              {implTab === "bind" && (
                <EditField
                  label={t("deployAgentModal.toolBindingsLabel", { n: tools.length })}
                  hint={t("deployAgentModal.toolBindingsHint")}
                >
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "1fr 1fr",
                      gap: 4,
                      maxHeight: 420,
                      overflow: "auto",
                      padding: 2,
                    }}
                  >
                    {COMMON_TOOLS.map((tool) => {
                      const on = tools.includes(tool.id);
                      return (
                        <button
                          key={tool.id}
                          onClick={() => toggleTool(tool.id)}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 8,
                            padding: "7px 9px",
                            background: on ? "color-mix(in srgb, var(--signal) 6%, transparent)" : "var(--panel-2)",
                            border: `1px solid ${on ? "var(--signal)" : "var(--border)"}`,
                            borderRadius: 4,
                            textAlign: "left",
                          }}
                        >
                          <span
                            style={{
                              width: 12,
                              height: 12,
                              borderRadius: 2,
                              background: on ? "var(--signal)" : "transparent",
                              border: `1px solid ${on ? "var(--signal)" : "var(--border-3)"}`,
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "center",
                            }}
                          >
                            {on && <Icon name="check" size={9} style={{ color: "var(--on-signal)" }} />}
                          </span>
                          <span className="mono" style={{ fontSize: 11.5, color: "var(--text)" }}>{tool.id}</span>
                          <Badge tone="muted" style={{ marginLeft: "auto" }}>{t(`deployAgentModal.toolKind_${tool.kind}`)}</Badge>
                        </button>
                      );
                    })}
                  </div>
                </EditField>
              )}
            </div>
          )}

          {step === 4 && (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, maxWidth: 760 }}>
              <EditField label={t("deployAgentModal.retriesLabel")} hint={t("deployAgentModal.retriesHint")}>
                <EditText
                  value={String(retries)}
                  onChange={(v) => setRetries(parseInt(v, 10) || 0)}
                  mono
                  suffix={t("deployAgentModal.suffixAttempts")}
                />
              </EditField>
              <EditField label={t("deployAgentModal.timeoutLabel")}>
                <EditText
                  value={String(timeout)}
                  onChange={(v) => setTimeoutVal(parseInt(v, 10) || 0)}
                  mono
                  suffix={t("deployAgentModal.suffixSeconds")}
                />
              </EditField>
              <EditField label={t("deployAgentModal.concurrencyLabel")} hint={t("deployAgentModal.concurrencyHint")}>
                <EditText
                  value={String(concurrency)}
                  onChange={(v) => setConcurrency(parseInt(v, 10) || 0)}
                  mono
                  suffix={t("deployAgentModal.suffixRuns")}
                />
              </EditField>
              <EditField label={t("deployAgentModal.concurrencyKeyLabel")} hint={t("deployAgentModal.concurrencyKeyHint")}>
                <EditText value="${event.payload.candidate_id}" mono onChange={() => {}} />
              </EditField>
              <div style={{ gridColumn: "1 / -1" }}>
                <EditField label={t("deployAgentModal.dlqLabel")} hint={t("deployAgentModal.dlqHint")}>
                  <Seg
                    value="audit"
                    onChange={() => {}}
                    options={[
                      { value: "audit", label: t("deployAgentModal.dlqAudit") },
                      { value: "queue", label: t("deployAgentModal.dlqQueue") },
                      { value: "human", label: t("deployAgentModal.dlqHuman") },
                    ]}
                  />
                </EditField>
              </div>
            </div>
          )}

          {step === 5 && (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
              <Panel title={t("deployAgentModal.manifestPanel")} padded={false}>
                <CodeBlock>
                  {JSON.stringify(
                    {
                      id: `${stage}-new`,
                      name: name || "newAgent",
                      title: title || "New agent",
                      actor: template?.actor || "Agent",
                      stage,
                      template: template?.id,
                      triggers,
                      emits,
                      tools,
                      model,
                      retries: { max: retries, backoff: "exponential" },
                      concurrency: { limit: concurrency, key: "${event.payload.candidate_id}" },
                      timeout_s: timeout,
                      typescript_code:
                        template?.actor === "Human"
                          ? null
                          : `<inline · ${tsCode.split("\n").length} lines>`,
                      tool_use:
                        template?.actor === "Human"
                          ? []
                          : toolUse.map((t) => ({
                              name: t.name,
                              description: t.description,
                              params: Object.keys(
                                (t.input_schema && t.input_schema.properties) || {},
                              ),
                            })),
                    },
                    null,
                    2,
                  )}
                </CodeBlock>
              </Panel>
              <div>
                <Panel title={t("deployAgentModal.preflightPanel")} padded>
                  <ValidationLine ok={!!name} warn={!name} label={t("deployAgentModal.identityValid")} hint={name ? "✓" : t("deployAgentModal.nameRequired")} />
                  <ValidationLine ok={triggers.length > 0} warn={triggers.length === 0} label={t("deployAgentModal.triggerEvents", { n: triggers.length })} />
                  <ValidationLine ok={emits.length > 0} warn={emits.length === 0} label={t("deployAgentModal.emitEvents", { n: emits.length })} />
                  <ValidationLine ok label={t("deployAgentModal.toolBindingsCount", { n: tools.length })} />
                  {template?.actor !== "Human" && (
                    <ValidationLine ok label={t("deployAgentModal.tsLines", { n: tsCode.split("\n").length })} hint={t("deployAgentModal.compiles")} />
                  )}
                  {template?.actor !== "Human" && (
                    <ValidationLine
                      ok={toolUse.length > 0}
                      warn={toolUse.length === 0}
                      label={t("deployAgentModal.toolUseDefined", { n: toolUse.length })}
                      hint={t("deployAgentModal.schemasValid")}
                    />
                  )}
                  <ValidationLine ok label={t("deployAgentModal.modelAccessible")} hint={model} />
                </Panel>
                <Panel title={t("deployAgentModal.deployTargetPanel")} padded style={{ marginTop: 12 }}>
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    <DeployTargetRow on label={t("deployAgentModal.stagingLabel")} sub={t("deployAgentModal.stagingSub")} />
                    <DeployTargetRow label={t("deployAgentModal.productionLabel")} sub={t("deployAgentModal.productionSub")} warn />
                  </div>
                  <div
                    style={{
                      marginTop: 10,
                      padding: "8px 10px",
                      background: "var(--bg-2)",
                      border: "1px solid var(--border)",
                      borderRadius: 4,
                      fontSize: 11,
                      color: "var(--text-3)",
                      lineHeight: 1.55,
                    }}
                  >
                    {t("deployAgentModal.willSaveAs")} <span className="mono" style={{ color: "var(--text-2)" }}>raas@2026.05.18-draft</span>. {t("deployAgentModal.rollForward")}
                  </div>
                </Panel>
              </div>
            </div>
          )}
        </div>

        <footer
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "12px 18px",
            borderTop: "1px solid var(--border)",
            background: "var(--panel-2)",
          }}
        >
          {step > 0 && (
            <Button tone="ghost" icon="chevron-left" onClick={back}>
              {t("deployAgentModal.back")}
            </Button>
          )}
          <span style={{ fontSize: 11, color: "var(--text-3)" }}>
            {t("deployAgentModal.stepOf", { n: step + 1, total: steps.length })}
          </span>
          <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
            <Button tone="ghost" onClick={onClose}>{t("deployAgentModal.cancel")}</Button>
            {step < steps.length - 1 ? (
              <Button tone="primary" onClick={next}>
                {t("deployAgentModal.continue")}
              </Button>
            ) : (
              <Button tone="primary" icon="deploy" onClick={onClose}>
                {t("deployAgentModal.deployToStaging")}
              </Button>
            )}
          </div>
        </footer>
      </div>
    </ModalOverlay>
  );
}

// ---- small atoms (settings-local pattern) ----

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: 11,
        fontFamily: "var(--mono)",
        textTransform: "uppercase",
        color: "var(--text-3)",
        letterSpacing: "0.08em",
        marginBottom: 10,
      }}
    >
      {children}
    </div>
  );
}

function EditField({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ padding: "10px 0", borderBottom: "1px solid var(--border)" }}>
      <div style={{ fontSize: 11, color: "var(--text)", marginBottom: 3, fontWeight: 500 }}>{label}</div>
      {hint && <div style={{ fontSize: 11, color: "var(--text-3)", marginBottom: 6, lineHeight: 1.5 }}>{hint}</div>}
      {children}
    </div>
  );
}

function EditText({
  value,
  onChange,
  mono,
  suffix,
}: {
  value: string;
  onChange: (v: string) => void;
  mono?: boolean;
  suffix?: string;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        background: "var(--panel-2)",
        border: "1px solid var(--border-2)",
        borderRadius: 4,
        padding: "5px 8px",
      }}
    >
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{
          flex: 1,
          background: "transparent",
          border: "none",
          outline: "none",
          color: "var(--text)",
          fontFamily: mono ? "var(--mono)" : "var(--sans)",
          fontSize: mono ? 11.5 : 12,
        }}
      />
      {suffix && (
        <span style={{ fontSize: 10.5, color: "var(--text-3)", fontFamily: "var(--mono)" }}>{suffix}</span>
      )}
    </div>
  );
}

function EditTextarea({
  value,
  onChange,
  rows = 3,
  mono,
}: {
  value: string;
  onChange: (v: string) => void;
  rows?: number;
  mono?: boolean;
}) {
  return (
    <textarea
      value={value}
      onChange={(e) => onChange(e.target.value)}
      rows={rows}
      style={{
        width: "100%",
        background: "var(--panel-2)",
        border: "1px solid var(--border-2)",
        borderRadius: 4,
        padding: "6px 8px",
        color: "var(--text)",
        fontFamily: mono ? "var(--mono)" : "var(--sans)",
        fontSize: mono ? 11.5 : 12,
        outline: "none",
        resize: "vertical",
        lineHeight: 1.55,
      }}
    />
  );
}

function Seg({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <div
      style={{
        display: "inline-flex",
        border: "1px solid var(--border-2)",
        borderRadius: 4,
        overflow: "hidden",
      }}
    >
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          style={{
            padding: "5px 12px",
            fontSize: 11.5,
            background: value === o.value ? "var(--panel-3)" : "var(--panel-2)",
            color: value === o.value ? "var(--text)" : "var(--text-3)",
            borderRight: "1px solid var(--border-2)",
            borderBottom: value === o.value ? "2px solid var(--signal)" : "2px solid transparent",
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function EventPicker({
  selected,
  onAdd,
  onRemove,
  tone,
  all,
}: {
  selected: string[];
  onAdd: (v: string) => void;
  onRemove: (v: string) => void;
  tone: "blue" | "green";
  all: string[];
}) {
  const { t } = useI18n();
  const [input, setInput] = useState("");
  const colorMap = {
    blue: { fg: "var(--blue)", bg: "color-mix(in srgb, var(--blue) 10%, transparent)", bd: "color-mix(in srgb, var(--blue) 32%, transparent)" },
    green: { fg: "var(--green)", bg: "color-mix(in srgb, var(--green) 8%, transparent)", bd: "color-mix(in srgb, var(--green) 30%, transparent)" },
  } as const;
  const c = colorMap[tone] ?? colorMap.blue;
  const suggestions = input
    ? all.filter((e) => e.toLowerCase().includes(input.toLowerCase()) && !selected.includes(e)).slice(0, 6)
    : [];

  return (
    <div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 6, minHeight: 22 }}>
        {selected.length === 0 && (
          <span style={{ fontSize: 11, color: "var(--text-3)" }}>{t("deployAgentModal.eventPickerEmpty")}</span>
        )}
        {selected.map((ev) => (
          <span
            key={ev}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              padding: "2px 4px 2px 7px",
              fontSize: 10.5,
              fontFamily: "var(--mono)",
              textTransform: "uppercase",
              color: c.fg,
              background: c.bg,
              border: `1px solid ${c.bd}`,
              borderRadius: 3,
            }}
          >
            {ev}
            <button
              onClick={() => onRemove(ev)}
              aria-label={t("deployAgentModal.removeEvent", { name: ev })}
              style={{ color: "currentColor", opacity: 0.6, padding: 1 }}
            >
              <Icon name="x" size={8} />
            </button>
          </span>
        ))}
      </div>
      <div style={{ position: "relative" }}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && input.trim()) {
              onAdd(input);
              setInput("");
            }
          }}
          placeholder={t("deployAgentModal.eventPickerPlaceholder")}
          style={{
            width: "100%",
            background: "var(--panel-2)",
            border: "1px solid var(--border-2)",
            borderRadius: 4,
            padding: "5px 8px",
            color: "var(--text)",
            fontFamily: "var(--mono)",
            fontSize: 11.5,
            outline: "none",
          }}
        />
        {suggestions.length > 0 && (
          <div
            style={{
              position: "absolute",
              top: "100%",
              left: 0,
              right: 0,
              marginTop: 2,
              background: "var(--panel)",
              border: "1px solid var(--border-2)",
              borderRadius: 4,
              boxShadow: "0 8px 20px rgba(0,0,0,0.4)",
              zIndex: "var(--z-overlay)" as unknown as number,
              maxHeight: 180,
              overflow: "auto",
            }}
          >
            {suggestions.map((s) => (
              <button
                key={s}
                onClick={() => {
                  onAdd(s);
                  setInput("");
                }}
                style={{
                  display: "flex",
                  width: "100%",
                  padding: "5px 8px",
                  fontSize: 11.5,
                  fontFamily: "var(--mono)",
                  color: "var(--text-2)",
                  textAlign: "left",
                }}
              >
                {s}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ValidationLine({
  ok,
  warn,
  label,
  hint,
}: {
  ok?: boolean;
  warn?: boolean;
  label: string;
  hint?: string;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 0", fontSize: 11.5 }}>
      <Icon
        name={ok ? "check" : warn ? "alert" : "x"}
        size={11}
        style={{ color: ok ? "var(--green)" : warn ? "var(--amber)" : "var(--red)" }}
      />
      <span style={{ color: "var(--text-2)" }}>{label}</span>
      {hint && (
        <span
          style={{
            marginLeft: "auto",
            color: "var(--text-3)",
            fontFamily: "var(--mono)",
            fontSize: 10.5,
          }}
        >
          {hint}
        </span>
      )}
    </div>
  );
}

function DeployTargetRow({
  label,
  sub,
  on,
  warn,
}: {
  label: string;
  sub: string;
  on?: boolean;
  warn?: boolean;
}) {
  const { t } = useI18n();
  return (
    <label
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "8px 10px",
        background: "var(--panel-2)",
        border: "1px solid var(--border)",
        borderRadius: 4,
        cursor: "pointer",
      }}
    >
      <input type="checkbox" defaultChecked={on} style={{ accentColor: "var(--signal)" }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12, color: "var(--text)" }}>{label}</div>
        <div style={{ fontSize: 10.5, color: "var(--text-3)" }}>{sub}</div>
      </div>
      {warn && <Badge tone="amber">{t("deployAgentModal.requiresApproval")}</Badge>}
    </label>
  );
}

const editSelectStyle = {
  background: "var(--panel-2)",
  border: "1px solid var(--border-2)",
  borderRadius: 4,
  padding: "5px 8px",
  color: "var(--text)",
  fontFamily: "var(--mono)",
  fontSize: 12,
  outline: "none",
  width: "100%",
} as const;
