"use client";

/**
 * Read-only and edit tabs in the Agents detail view.
 *
 * Consumes a normalized `ViewAgent` shape that the page constructs from
 * the live AgentDetail + AgentListRow. Manifest fields the api doesn't
 * yet surface (tool_use, ontology_instructions, model, etc.) come through
 * as empty values — no mock fallback (2026-05-26 production rule).
 */

import { useState } from "react";
import {
  Badge,
  Button,
  CodeBlock,
  Empty,
  Icon,
  Panel,
  StatusDot,
  Th,
  Td,
} from "@/app/portal/components";
import { fmtAgo, fmtDur } from "@/lib/format";
import { useDeployments } from "@/lib/hooks/useDeployments";
import { AGENT_SAMPLE_TOOL_USE } from "@/app/portal/components/agent-code/samples";
import {
  AgentCodeEditPanel,
  AgentToolUseEditPanel,
} from "@/app/portal/components/agent-code/EditPanels";
import type { ToolUseSchema } from "@/app/portal/components/agent-code/samples";
import { AGENT_SAMPLE_TS_CODE } from "@/app/portal/components/agent-code/samples";

/**
 * Normalized view of an agent the tabs render. Matches the legacy SpaAgent
 * shape so the heavy code/io/versions tab markup didn't need rewriting.
 */
export interface ViewAgent {
  id: string;
  name: string;
  title: string;
  description: string;
  actor: "Agent" | "Human";
  stage: number;
  triggers: string[];
  emits: string[];
  steps: string[];
  tools: string[];
  model: string;
  input_data: Record<string, unknown>;
  ontology_instructions: string;
  tool_use: unknown;
  typescript_code: string;
}

/**
 * Row shape for `RunsTab`. Wider than `AgentDetail.recentRuns` so the live
 * `RunListRow` from `/v1/runs` can be passed directly — only the small set
 * of fields the table renders is required.
 */
export interface RunRow {
  id: string;
  status: string;
  subject: string | null;
  triggerEvent: string | null;
  durationMs: number | null;
  startedAt: string | null;
  testRun?: boolean;
}

interface ModelInfo {
  id: string;
  name: string;
}

// ────────────────────────────────────────────────────────────────────────────

export function ConfigTab({ agent }: { agent: ViewAgent }) {
  const hasCode = agent.actor === "Agent";
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
      <Panel
        title="Manifest"
        padded={false}
        action={<Button small icon="external" tone="ghost">Edit</Button>}
      >
        <CodeBlock>
          {JSON.stringify(
            {
              id: agent.id,
              name: agent.name,
              title: agent.title,
              actor: agent.actor,
              version: "raas@2026.05.16-a",
              triggers: agent.triggers,
              emits: agent.emits,
              steps: agent.steps,
              tools: agent.tools,
              model: agent.model,
              retries: { max: 3, backoff: "exponential" },
              concurrency: { limit: 8, key: "${event.payload.candidate_id}" },
              timeout_s: 120,
              typescript_code: hasCode ? `<inline · ${agent.name}.ts · see Code tab>` : null,
              tool_use: hasCode ? AGENT_SAMPLE_TOOL_USE.map((t) => t.name) : [],
            },
            null,
            2,
          )}
        </CodeBlock>
      </Panel>

      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <Panel title="Triggers" padded>
          {agent.triggers.length === 0 ? (
            <span style={{ fontSize: 12, color: "var(--text-3)" }}>Manual — operator-initiated.</span>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {agent.triggers.map((t) => (
                <div
                  key={t}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "6px 8px",
                    background: "var(--panel-2)",
                    border: "1px solid var(--border)",
                    borderRadius: 4,
                  }}
                >
                  <Badge tone="blue">{t}</Badge>
                  <span
                    style={{
                      marginLeft: "auto",
                      fontSize: 10.5,
                      color: "var(--text-3)",
                      fontFamily: "var(--mono)",
                    }}
                  >
                    ↓ inbound
                  </span>
                </div>
              ))}
            </div>
          )}
        </Panel>
        <Panel title="Emits" padded>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {agent.emits.map((t) => (
              <div
                key={t}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "6px 8px",
                  background: "var(--panel-2)",
                  border: "1px solid var(--border)",
                  borderRadius: 4,
                }}
              >
                <Badge tone="green">{t}</Badge>
                <span
                  style={{
                    marginLeft: "auto",
                    fontSize: 10.5,
                    color: "var(--text-3)",
                    fontFamily: "var(--mono)",
                  }}
                >
                  ↑ outbound
                </span>
              </div>
            ))}
          </div>
        </Panel>
        {agent.tools && agent.tools.length > 0 && (
          <Panel title="Tool bindings" padded>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {agent.tools.map((t) => (
                <div
                  key={t}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "6px 8px",
                    background: "var(--panel-2)",
                    border: "1px solid var(--border)",
                    borderRadius: 4,
                  }}
                >
                  <Icon name="code" size={11} style={{ color: "var(--text-3)" }} />
                  <span className="mono" style={{ fontSize: 11.5, color: "var(--text)" }}>{t}</span>
                  <span
                    style={{
                      marginLeft: "auto",
                      fontSize: 10,
                      color: "var(--text-3)",
                      fontFamily: "var(--mono)",
                    }}
                  >
                    bound
                  </span>
                </div>
              ))}
            </div>
          </Panel>
        )}
      </div>
    </div>
  );
}

export function IOConfigTab({ agent }: { agent: ViewAgent }) {
  return (
    <Panel title="Schema" padded>
      <CodeBlock>{`// inputs
{
  ${agent.triggers.length > 0 ? `trigger_event: ${JSON.stringify(agent.triggers)},` : "trigger: 'manual',"}
  subject_type: "Job_Requisition | Candidate",
  payload: {
    job_requisition_id?: string,
    candidate_id?: string,
    client_id: string,
  },
  context: {
    tenant: "raas",
    agent_version: string,
    correlation_id: string,
  }
}

// outputs
{
  emit_event: ${JSON.stringify(agent.emits)},
  result: { ... },          // see step outputs
  artifacts: ["files/..."], // any file paths written
  metrics: { tokens_in, tokens_out, duration_ms }
}`}</CodeBlock>
    </Panel>
  );
}

export function VersionsTab({ agent }: { agent: ViewAgent }) {
  // /v1/deployments returns workflow-level deployments only — there is no
  // per-agent version history endpoint yet. We show the workflow deploys
  // (best correlate) and surface an empty-state when the api hasn't
  // recorded any. The legacy `{ agent: agent.name }` filter is gone —
  // it was a synthetic field from the bootstrap mock that never matched
  // real deploys.
  void agent;
  const deploymentsQuery = useDeployments();
  const versions = deploymentsQuery.data?.list ?? [];
  return (
    <Panel title="Versions" padded={false}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
        <thead>
          <tr style={{ borderBottom: "1px solid var(--border)" }}>
            <Th>Version</Th>
            <Th>Status</Th>
            <Th>Deployed by</Th>
            <Th>When</Th>
            <Th>Notes</Th>
            <Th />
          </tr>
        </thead>
        <tbody>
          {deploymentsQuery.isError ? (
            <tr>
              <Td colSpan={6} style={{ padding: 24, textAlign: "center", color: "var(--text-3)" }}>
                Failed to load deployments: {deploymentsQuery.error?.message ?? "api unreachable"}
              </Td>
            </tr>
          ) : deploymentsQuery.isLoading ? (
            <tr>
              <Td colSpan={6} style={{ padding: 24, textAlign: "center", color: "var(--text-3)" }}>
                Loading deployments…
              </Td>
            </tr>
          ) : versions.length === 0 ? (
            <tr>
              <Td colSpan={6} style={{ padding: 24, textAlign: "center", color: "var(--text-3)" }}>
                No workflow deployments recorded yet.
              </Td>
            </tr>
          ) : (
            versions.map((v) => {
              const at = v.deployedAt ? new Date(v.deployedAt).getTime() : 0;
              return (
                <tr key={v.id} style={{ borderBottom: "1px solid var(--border)" }}>
                  <Td>
                    <span className="mono">{v.versionString}</span>
                  </Td>
                  <Td>
                    {v.status === "live" ? (
                      <Badge tone="signal">LIVE</Badge>
                    ) : v.status === "rolled_back" || v.status === "rolled-back" ? (
                      <Badge tone="muted">ROLLED BACK</Badge>
                    ) : (
                      <Badge tone="muted">{v.status}</Badge>
                    )}
                  </Td>
                  <Td>
                    <span style={{ color: "var(--text-2)" }}>{v.deployedBy ?? "—"}</span>
                  </Td>
                  <Td>
                    <span style={{ color: "var(--text-3)" }}>{at > 0 ? fmtAgo(at) : "—"}</span>
                  </Td>
                  <Td>
                    <span style={{ color: "var(--text-2)" }}>{v.note ?? ""}</span>
                  </Td>
                  <Td>
                    <Button small tone="ghost">Rollback</Button>
                  </Td>
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </Panel>
  );
}

export function RunsTab({
  runs,
  onOpenRun,
}: {
  runs: RunRow[];
  onOpenRun: (id: string) => void;
}) {
  if (runs.length === 0) return <Empty title="No recent runs" />;
  const testCount = runs.filter((r) => r.testRun).length;
  return (
    <Panel
      title={`Recent runs · ${runs.length}`}
      subtitle={testCount > 0 ? `${testCount} test` : undefined}
      padded={false}
    >
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
        <thead>
          <tr>
            <Th />
            <Th>Run</Th>
            <Th>Subject</Th>
            <Th>Trigger</Th>
            <Th>Duration</Th>
            <Th>When</Th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => (
            <tr
              key={r.id}
              onClick={() => onOpenRun(r.id)}
              style={{ cursor: "pointer", borderBottom: "1px solid var(--border)" }}
            >
              <Td>
                <StatusDot status={(r.status as never) ?? "idle"} />
              </Td>
              <Td>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span className="mono" style={{ color: "var(--text-2)" }}>{r.id}</span>
                  {r.testRun && <Badge tone="signal" style={{ fontSize: 9 }}>TEST</Badge>}
                </div>
              </Td>
              <Td>
                <span className="mono" style={{ color: "var(--text-2)" }}>{r.subject}</span>
              </Td>
              <Td>
                <Badge tone="muted">{r.triggerEvent}</Badge>
              </Td>
              <Td>
                <span className="mono" style={{ color: "var(--text-2)" }}>{fmtDur(r.durationMs)}</span>
              </Td>
              <Td>
                <span style={{ color: "var(--text-3)" }}>
                  {r.startedAt ? fmtAgo(Date.parse(r.startedAt)) : "—"}
                </span>
              </Td>
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// EditConfigTab — form-based editor for an existing agent.
// ────────────────────────────────────────────────────────────────────────────

export function EditConfigTab({ agent, models }: { agent: ViewAgent; models: ModelInfo[] }) {
  const [name, setName] = useState(agent.name);
  const [title, setTitle] = useState(agent.title);
  const [desc, setDesc] = useState(agent.description);
  const [model, setModel] = useState(agent.model || models[0]?.name || "");
  const [retries, setRetries] = useState(3);
  const [timeout, setTimeoutVal] = useState(120);
  const [concurrency, setConcurrency] = useState(8);
  const [tsCode, setTsCode] = useState(AGENT_SAMPLE_TS_CODE);
  const [toolUse, setToolUse] = useState<ToolUseSchema[]>(AGENT_SAMPLE_TOOL_USE);

  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 360px", gap: 12 }}>
      {/* Left: form */}
      <div style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
        <Panel title="Identity" padded>
          <EditField label="Name (id)" hint="Lowercase camelCase. Used in event payloads and logs.">
            <EditText value={name} onChange={setName} mono />
          </EditField>
          <EditField label="Title" hint="Human-readable label shown across the operator.">
            <EditText value={title} onChange={setTitle} />
          </EditField>
          <EditField
            label="Description"
            hint="One-paragraph summary of what this agent does. Shown in the graph inspector."
          >
            <EditTextarea value={desc} onChange={setDesc} rows={3} />
          </EditField>
          <EditField label="Actor type" hint="Agent runs code automatically; Human pauses for operator input.">
            <Seg
              value={agent.actor}
              onChange={() => {}}
              options={[
                { value: "Agent", label: "Agent" },
                { value: "Human", label: "Human task" },
              ]}
            />
          </EditField>
        </Panel>

        <Panel title="Events" padded>
          <EditField label="Listens to (triggers)" hint="Inbound events. Pick existing or type a new EVENT_NAME.">
            <EditableEventList items={agent.triggers} tone="blue" />
          </EditField>
          <EditField
            label="Emits (outbound)"
            hint="Events this agent publishes. Downstream agents subscribe to these."
          >
            <EditableEventList items={agent.emits} tone="green" />
          </EditField>
        </Panel>

        {agent.actor === "Agent" && (
          <>
            <Panel title="Implementation" padded>
              <EditField
                label="Steps"
                hint="Ordered sub-procedures. Drag to reorder; the agent runs them in sequence."
              >
                {agent.steps && agent.steps.length > 0 ? (
                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    {agent.steps.map((s, i) => (
                      <div
                        key={s}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 8,
                          padding: "6px 8px",
                          background: "var(--panel-2)",
                          border: "1px solid var(--border)",
                          borderRadius: 3,
                        }}
                      >
                        <Icon name="filter" size={10} style={{ color: "var(--text-3)", cursor: "grab" }} />
                        <span
                          style={{
                            fontSize: 11,
                            fontFamily: "var(--mono)",
                            color: "var(--text-3)",
                            width: 18,
                          }}
                        >
                          {i + 1}.
                        </span>
                        <input
                          defaultValue={s}
                          style={{
                            flex: 1,
                            background: "transparent",
                            border: "none",
                            outline: "none",
                            color: "var(--text)",
                            fontFamily: "var(--mono)",
                            fontSize: 11.5,
                          }}
                        />
                        <button style={{ color: "var(--text-3)" }}>
                          <Icon name="x" size={10} />
                        </button>
                      </div>
                    ))}
                  </div>
                ) : (
                  <span style={{ fontSize: 11.5, color: "var(--text-3)" }}>No steps defined.</span>
                )}
                <div style={{ marginTop: 6 }}>
                  <Button small icon="plus" tone="ghost">
                    Add step
                  </Button>
                </div>
              </EditField>

              <EditField
                label="Tools"
                hint="Bindings this agent may call. Permissions inherited from the workspace tool catalog."
              >
                <EditableEventList items={agent.tools || []} tone="muted" placeholder="tool.name" />
              </EditField>

              <EditField label="Model" hint="Pick a model from the fleet, or leave to use the workflow default.">
                <select value={model} onChange={(e) => setModel(e.target.value)} style={editSelectStyle}>
                  {models.length === 0 ? (
                    <option value="">No models configured in Settings</option>
                  ) : (
                    models.map((m) => (
                      <option key={m.id} value={m.name}>
                        {m.name}
                      </option>
                    ))
                  )}
                </select>
              </EditField>

              <EditField
                label="System prompt"
                hint="Prepended to every request. Use {{template}} variables to interpolate run context."
              >
                <EditTextarea
                  value={`You are an automated agent in the RAAS workflow.\nGoal: ${agent.title}.\n\nFollow the steps in order. After each step, emit a structured progress event. Never block on human input — emit a HUMAN_TASK event if needed.\n\nContext variables available: {{requisition}}, {{candidate}}, {{client}}.`}
                  onChange={() => {}}
                  rows={6}
                  mono
                />
              </EditField>
            </Panel>

            <AgentCodeEditPanel value={tsCode} onChange={setTsCode} />
            <AgentToolUseEditPanel tools={toolUse} onChange={setToolUse} />

            <Panel title="Behavior" padded>
              <EditField label="Retries" hint="Maximum immediate retry attempts for a failed model action.">
                <EditText
                  value={String(retries)}
                  onChange={(v) => setRetries(parseInt(v) || 0)}
                  mono
                  suffix="attempts"
                />
              </EditField>
              <EditField label="Per-call timeout" hint="Maximum duration of each model gateway call; a multi-step run may take longer.">
                <EditText
                  value={String(timeout)}
                  onChange={(v) => setTimeoutVal(parseInt(v) || 0)}
                  mono
                  suffix="seconds"
                />
              </EditField>
              <EditField label="Concurrency" hint="Maximum simultaneous runs of this agent. Beyond this, runs queue.">
                <EditText
                  value={String(concurrency)}
                  onChange={(v) => setConcurrency(parseInt(v) || 0)}
                  mono
                  suffix="runs"
                />
              </EditField>
              <EditField
                label="Concurrency key"
                hint="Partition concurrency by a payload field. e.g. one run per candidate."
              >
                <EditText value="${event.payload.candidate_id}" mono onChange={() => {}} />
              </EditField>
            </Panel>
          </>
        )}
      </div>

      {/* Right: preview */}
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <Panel
          title="Preview manifest"
          subtitle="Live · updates as you edit"
          padded={false}
          action={<Button small icon="external" tone="ghost">Copy</Button>}
        >
          <CodeBlock>
            {JSON.stringify(
              {
                id: agent.id,
                name,
                title,
                actor: agent.actor,
                version: "raas@2026.05.18-draft",
                triggers: agent.triggers,
                emits: agent.emits,
                steps: agent.steps,
                tools: agent.tools,
                model,
                retries: { max: retries, backoff: "exponential" },
                concurrency: { limit: concurrency, key: "${event.payload.candidate_id}" },
                timeout_s: timeout,
                typescript_code:
                  agent.actor === "Agent"
                    ? `<inline · ${tsCode.split("\n").length} lines · ${tsCode.length} chars>`
                    : null,
                tool_use:
                  agent.actor === "Agent"
                    ? toolUse.map((t) => ({
                        name: t.name,
                        params: Object.keys((t.input_schema && t.input_schema.properties) || {}),
                      }))
                    : [],
              },
              null,
              2,
            )}
          </CodeBlock>
        </Panel>

        <Panel title="Validation" padded>
          <ValidationLine ok label="Graph reachable" hint="2 inbound · 2 outbound" />
          <ValidationLine ok label="No cycles" />
          <ValidationLine ok label="All emitted events have listeners" />
          <ValidationLine warn label="Tools updated" hint="Will regenerate type bindings on save" />
          <ValidationLine ok label="Model accessible" hint="claude-sonnet-4-5 · primary" />
        </Panel>

        <Panel title="Impact" subtitle="What changes on save" padded>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 5,
              fontSize: 11.5,
              color: "var(--text-2)",
            }}
          >
            <ImpactLine label="In-flight runs" value="finish on old version" muted />
            <ImpactLine label="New runs" value="use draft" />
            <ImpactLine label="Listening agents" value="3" />
            <ImpactLine label="Downstream agents" value="2" />
            <ImpactLine label="Estimated rollout" value="< 5 s" />
          </div>
        </Panel>
      </div>
    </div>
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
      {hint && (
        <div style={{ fontSize: 11, color: "var(--text-3)", marginBottom: 6, lineHeight: 1.5 }}>{hint}</div>
      )}
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
        <span
          style={{
            fontSize: 10.5,
            color: "var(--text-3)",
            fontFamily: "var(--mono)",
          }}
        >
          {suffix}
        </span>
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

function EditableEventList({
  items,
  tone,
  placeholder = "EVENT_NAME",
}: {
  items: string[];
  tone: "blue" | "green" | "muted";
  placeholder?: string;
}) {
  const colorMap = {
    blue: { fg: "var(--blue)", bg: "rgba(132,169,255,0.10)", bd: "rgba(132,169,255,0.32)" },
    green: { fg: "var(--green)", bg: "rgba(101,224,163,0.08)", bd: "rgba(101,224,163,0.30)" },
    muted: { fg: "var(--text-2)", bg: "var(--panel-2)", bd: "var(--border)" },
  } as const;
  const c = colorMap[tone] ?? colorMap.muted;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
      {items.map((t) => (
        <span
          key={t}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            padding: "2px 4px 2px 7px",
            fontSize: 10.5,
            fontFamily: "var(--mono)",
            textTransform: "uppercase",
            letterSpacing: "0.04em",
            color: c.fg,
            background: c.bg,
            border: `1px solid ${c.bd}`,
            borderRadius: 3,
          }}
        >
          {t}
          <button style={{ color: "currentColor", opacity: 0.6, padding: 1 }}>
            <Icon name="x" size={8} />
          </button>
        </span>
      ))}
      <button
        style={{
          padding: "3px 7px",
          fontSize: 10.5,
          fontFamily: "var(--mono)",
          color: "var(--text-3)",
          border: "1px dashed var(--border-2)",
          borderRadius: 3,
        }}
      >
        + {placeholder}
      </button>
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

function ImpactLine({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", padding: "3px 0" }}>
      <span style={{ color: "var(--text-3)" }}>{label}</span>
      <span
        style={{
          color: muted ? "var(--text-3)" : "var(--text)",
          fontFamily: "var(--mono)",
        }}
      >
        {value}
      </span>
    </div>
  );
}
