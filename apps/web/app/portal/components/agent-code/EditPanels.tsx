"use client";

/**
 * Edit panels for the EditConfigTab and DeployAgentModal.
 * Verbatim port of `apps/web/public/portal/views/agent-code.jsx:397-655`.
 *
 * - AgentCodeEditPanel  → TypeScript code editor
 * - AgentOntologyEditPanel → markdown ontology editor
 * - AgentInputDataEditPanel → JSON sample input editor
 * - AgentToolUseEditPanel → card-list editor for tool_use[]
 */

import type { CSSProperties } from "react";
import { useState } from "react";
import {
  Badge,
  Button,
  Empty,
  Icon,
  MonacoEditor,
  Panel,
} from "@/app/portal/components";
import { AGENT_SAMPLE_TS_CODE, AGENT_SAMPLE_TOOL_USE, type ToolUseSchema } from "./samples";

export function AgentCodeEditPanel({
  value,
  onChange,
  height = 460,
}: {
  value?: string;
  onChange?: (v: string) => void;
  height?: number | string;
}) {
  const [val, setVal] = useState(value ?? AGENT_SAMPLE_TS_CODE);
  function handle(v: string) {
    setVal(v);
    onChange?.(v);
  }
  const lines = (val || "").split("\n").length;
  return (
    <Panel
      title="typescript_code"
      subtitle={
        <>
          Compiled with the workspace&apos;s{" "}
          <span className="mono" style={{ color: "var(--text-2)" }}>@agentic/runtime</span> typings.
        </>
      }
      padded={false}
      action={
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <span style={{ fontSize: 10.5, fontFamily: "var(--mono)", color: "var(--text-3)" }}>{lines} lines</span>
          <Button small tone="ghost" icon="replay" onClick={() => handle(AGENT_SAMPLE_TS_CODE)}>
            Reset
          </Button>
          <Button small tone="ghost" icon="check">
            Format
          </Button>
        </div>
      }
    >
      <MonacoEditor value={val} onChange={handle} language="typescript" height={height} />
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 14,
          padding: "8px 14px",
          borderTop: "1px solid var(--border)",
          fontSize: 11,
          fontFamily: "var(--mono)",
          color: "var(--text-3)",
        }}
      >
        <span>
          <Icon name="check" size={10} style={{ color: "var(--green)" }} /> 0 errors
        </span>
        <span>
          <Icon name="alert" size={10} style={{ color: "var(--amber)" }} /> 0 warnings
        </span>
        <span style={{ marginLeft: "auto" }}>TypeScript 5.6 · ESNext · NodeJs resolution</span>
      </div>
    </Panel>
  );
}

export function AgentOntologyEditPanel({
  value,
  onChange,
  height = 220,
}: {
  value?: string;
  onChange?: (v: string) => void;
  height?: number | string;
}) {
  const [val, setVal] = useState(value ?? "");
  function handle(v: string) {
    setVal(v);
    onChange?.(v);
  }
  const lines = (val || "").split("\n").length;
  return (
    <Panel
      title="ontology_instructions"
      subtitle="Domain vocabulary, business rules, and guardrails. Prepended to every prompt."
      padded={false}
      action={
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <span style={{ fontSize: 10.5, fontFamily: "var(--mono)", color: "var(--text-3)" }}>{lines} lines</span>
          <Button small tone="ghost" icon="external">Templates</Button>
        </div>
      }
    >
      <MonacoEditor value={val} onChange={handle} language="markdown" height={height} />
      <div
        style={{
          padding: "8px 14px",
          borderTop: "1px solid var(--border)",
          fontSize: 11,
          color: "var(--text-3)",
          lineHeight: 1.5,
        }}
      >
        Plain markdown. Reference entity names, list hard rules, define vocabulary. The LLM sees this verbatim as a system-prompt prefix on every call this agent makes.
      </div>
    </Panel>
  );
}

export function AgentInputDataEditPanel({
  value,
  onChange,
  height = 200,
}: {
  value?: Record<string, unknown>;
  onChange?: (v: Record<string, unknown>) => void;
  height?: number | string;
}) {
  const [raw, setRaw] = useState(JSON.stringify(value ?? {}, null, 2));
  const [err, setErr] = useState<string | null>(null);

  function handle(v: string) {
    setRaw(v);
    try {
      const parsed = JSON.parse(v);
      setErr(null);
      onChange?.(parsed);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Invalid JSON");
    }
  }
  return (
    <Panel
      title="input_data"
      subtitle="Sample input payload. Used for test runs and to auto-generate the IO docs."
      padded={false}
      action={
        err ? <Badge tone="red">JSON ERR</Badge> : <Button small tone="ghost" icon="run">Run with this</Button>
      }
    >
      <MonacoEditor value={raw} onChange={handle} language="json" height={height} />
      {err && (
        <div
          style={{
            padding: "6px 14px",
            borderTop: "1px solid var(--border)",
            fontSize: 11,
            color: "var(--red)",
            fontFamily: "var(--mono)",
          }}
        >
          <Icon name="alert" size={10} style={{ marginRight: 4 }} /> {err}
        </div>
      )}
    </Panel>
  );
}

const inputBoxStyle: CSSProperties = {
  background: "var(--panel-2)",
  border: "1px solid var(--border-2)",
  borderRadius: 4,
  padding: "5px 8px",
  color: "var(--text)",
  fontFamily: "var(--mono)",
  fontSize: 11.5,
  outline: "none",
};

interface ToolUseInternal extends ToolUseSchema {
  __schemaRaw?: string;
  __schemaError?: string | null;
}

export function AgentToolUseEditPanel({
  tools,
  onChange,
}: {
  tools?: ToolUseSchema[];
  onChange?: (next: ToolUseSchema[]) => void;
}) {
  const [items, setItems] = useState<ToolUseInternal[]>(
    tools && tools.length ? tools : AGENT_SAMPLE_TOOL_USE,
  );
  const [openId, setOpenId] = useState<number>(0);

  function commit(next: ToolUseInternal[]) {
    setItems(next);
    onChange?.(next.map(({ __schemaRaw: _r, __schemaError: _e, ...rest }) => rest));
  }
  function update(i: number, patch: Partial<ToolUseInternal>) {
    const next = items.map((t, idx) => (idx === i ? { ...t, ...patch } : t));
    commit(next);
  }
  function updateSchema(i: number, raw: string) {
    try {
      const parsed = JSON.parse(raw);
      update(i, { input_schema: parsed, __schemaError: null });
    } catch (e) {
      update(i, {
        __schemaRaw: raw,
        __schemaError: e instanceof Error ? e.message : "Invalid JSON",
      });
    }
  }
  function add() {
    const next: ToolUseInternal[] = [
      ...items,
      {
        name: `new_tool_${items.length + 1}`,
        description: "Describe what this tool does and when the LLM should call it.",
        input_schema: {
          type: "object",
          properties: { input: { type: "string" } },
          required: ["input"],
        },
      },
    ];
    commit(next);
    setOpenId(next.length - 1);
  }
  function remove(i: number) {
    const next = items.filter((_, idx) => idx !== i);
    commit(next);
    if (openId >= next.length) setOpenId(Math.max(0, next.length - 1));
  }

  return (
    <Panel
      title={`tool_use · ${items.length}`}
      subtitle="Tool definitions handed to the LLM at request time. Each tool's input_schema is a JSON Schema."
      padded={false}
      action={
        <Button small icon="plus" tone="ghost" onClick={add}>
          Add tool
        </Button>
      }
    >
      {items.length === 0 ? (
        <Empty title="No tools defined" hint="Click Add tool to expose an API to the LLM." />
      ) : (
        <div>
          {items.map((t, i) => (
            <ToolUseCard
              key={i}
              tool={t}
              open={openId === i}
              onToggle={() => setOpenId(openId === i ? -1 : i)}
              onUpdate={(patch) => update(i, patch)}
              onUpdateSchema={(raw) => updateSchema(i, raw)}
              onRemove={() => remove(i)}
            />
          ))}
        </div>
      )}
    </Panel>
  );
}

function ToolUseCard({
  tool,
  open,
  onToggle,
  onUpdate,
  onUpdateSchema,
  onRemove,
}: {
  tool: ToolUseInternal;
  open: boolean;
  onToggle: () => void;
  onUpdate: (patch: Partial<ToolUseInternal>) => void;
  onUpdateSchema: (raw: string) => void;
  onRemove: () => void;
}) {
  const paramCount =
    tool.input_schema && tool.input_schema.properties
      ? Object.keys(tool.input_schema.properties).length
      : 0;

  return (
    <div style={{ borderBottom: "1px solid var(--border)" }}>
      <div
        onClick={onToggle}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "10px 14px",
          cursor: "pointer",
          background: open ? "var(--panel-2)" : "transparent",
          transition: "background 0.1s",
        }}
      >
        <Icon name={open ? "chevron-down" : "chevron-right"} size={11} style={{ color: "var(--text-3)" }} />
        <Icon name="code" size={11} style={{ color: open ? "var(--signal)" : "var(--text-3)" }} />
        <span className="mono" style={{ fontSize: 12.5, color: "var(--text)" }}>{tool.name}</span>
        <span
          style={{
            flex: 1,
            fontSize: 11.5,
            color: "var(--text-3)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            marginLeft: 8,
          }}
        >
          {tool.description}
        </span>
        <span style={{ fontSize: 10, fontFamily: "var(--mono)", color: "var(--text-3)" }}>
          {paramCount} params
        </span>
        {tool.__schemaError && <Badge tone="red">SCHEMA ERR</Badge>}
        <button
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          style={{ color: "var(--text-3)", padding: 2 }}
        >
          <Icon name="x" size={11} />
        </button>
      </div>

      {open && (
        <div
          style={{
            padding: "10px 14px 14px 36px",
            background: "var(--bg-2)",
            borderTop: "1px solid var(--border)",
          }}
        >
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
            <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <Label>name</Label>
              <input
                value={tool.name}
                onChange={(e) => onUpdate({ name: e.target.value.replace(/[^a-z0-9_]/gi, "_") })}
                style={inputBoxStyle}
              />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <Label>required by</Label>
              <select defaultValue="llm" style={{ ...inputBoxStyle, appearance: "none" }}>
                <option value="llm">LLM tool-use (Anthropic / OpenAI)</option>
                <option value="code">Imperative code only</option>
              </select>
            </label>
          </div>

          <label style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: 10 }}>
            <Label>description</Label>
            <textarea
              value={tool.description}
              onChange={(e) => onUpdate({ description: e.target.value })}
              rows={2}
              style={{ ...inputBoxStyle, resize: "vertical", lineHeight: 1.5 }}
            />
            <span style={{ fontSize: 10.5, color: "var(--text-3)" }}>
              The LLM uses this to decide when to call. Be specific about inputs, side effects, and when NOT to use it.
            </span>
          </label>

          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <Label>input_schema · JSON Schema</Label>
            <MonacoEditor
              value={JSON.stringify(tool.input_schema, null, 2)}
              onChange={onUpdateSchema}
              language="json"
              height={180}
            />
            {tool.__schemaError && (
              <div
                style={{
                  marginTop: 4,
                  fontSize: 11,
                  color: "var(--red)",
                  fontFamily: "var(--mono)",
                }}
              >
                <Icon name="alert" size={10} style={{ marginRight: 4 }} /> {tool.__schemaError}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <span
      style={{
        fontSize: 10.5,
        fontFamily: "var(--mono)",
        color: "var(--text-3)",
        textTransform: "uppercase",
        letterSpacing: "0.06em",
      }}
    >
      {children}
    </span>
  );
}
