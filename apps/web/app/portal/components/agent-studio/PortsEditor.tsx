"use client";

import { useMemo, useState } from "react";
import { Badge, Button, Icon } from "@/app/portal/components";
import {
  EmptySection,
  Field,
  JsonValueEditor,
  SelectInput,
  TextArea,
  TextInput,
  Toggle,
} from "./fields";
import type { StudioInputPort, StudioOutputPort } from "./model";

type Port = StudioInputPort | StudioOutputPort;

export function PortsEditor({
  kind,
  ports,
  onChange,
  disabled,
}: {
  kind: "input" | "output";
  ports: Port[];
  onChange: (ports: Port[]) => void;
  disabled?: boolean;
}) {
  const [selectedId, setSelectedId] = useState(ports[0]?.id ?? "");
  const selected = useMemo(
    () => ports.find((port) => port.id === selectedId) ?? ports[0],
    [ports, selectedId],
  );
  const selectedInput = kind === "input" && selected
    ? selected as StudioInputPort
    : null;
  const promptUsedByAnother = kind === "input" && ports.some(
    (port) => port !== selected && (port as StudioInputPort).kind === "prompt",
  );

  function update(patch: Partial<Port>) {
    if (!selected) return;
    if (typeof patch.id === "string" && selectedId === selected.id) {
      setSelectedId(patch.id);
    }
    onChange(ports.map((port) => (port === selected ? { ...port, ...patch } as Port : port)));
  }

  function add() {
    const base = kind === "input" ? "input" : "output";
    let index = ports.length + 1;
    let id = `${base}_${index}`;
    while (ports.some((port) => port.id === id)) id = `${base}_${++index}`;
    const next: Port =
      kind === "input"
        ? {
            id,
            label: `Input ${index}`,
            kind: "value",
            required: false,
            schema: { type: "string" },
            sensitivity: "none",
          }
        : {
            id,
            label: `Output ${index}`,
            required: true,
            schema: { type: "string" },
            sensitivity: "none",
          };
    onChange([...ports, next]);
    setSelectedId(id);
  }

  if (ports.length === 0) {
    return (
      <EmptySection
        title={`No ${kind}s yet`}
        hint={`Add a named ${kind} with a JSON Schema contract.`}
        actionLabel={`Add ${kind}`}
        onAction={add}
      />
    );
  }

  return (
    <div style={{ display: "grid", gridTemplateColumns: "210px minmax(0, 1fr)", minHeight: 430 }}>
      <div style={{ borderRight: "1px solid var(--border)", paddingRight: 12 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
          <span className="mono" style={{ color: "var(--text-3)", fontSize: 10.5 }}>
            {ports.length} {ports.length === 1 ? kind : `${kind}s`}
          </span>
          <Button small icon="plus" onClick={add} disabled={disabled}>Add</Button>
        </div>
        <div style={{ display: "grid", gap: 5 }}>
          {ports.map((port) => (
            <button
              type="button"
              key={port.id}
              onClick={() => setSelectedId(port.id)}
              style={{
                padding: "9px 10px",
                textAlign: "left",
                border: `1px solid ${port === selected ? "rgba(208,255,0,0.35)" : "var(--border)"}`,
                borderRadius: 5,
                background: port === selected ? "rgba(208,255,0,0.05)" : "var(--panel-2)",
                color: "var(--text)",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <Icon name={kind === "input" ? "chevron-right" : "external"} size={10} />
                <span className="mono" style={{ fontSize: 11, overflow: "hidden", textOverflow: "ellipsis" }}>
                  {port.id}
                </span>
              </div>
              <div style={{ marginTop: 4, fontSize: 10.5, color: "var(--text-3)" }}>
                {port.label} · {String(port.schema.type ?? "any")}
              </div>
            </button>
          ))}
        </div>
      </div>

      {selected && (
        <div style={{ paddingLeft: 16, display: "grid", gap: 14, alignContent: "start" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div style={{ display: "flex", gap: 7 }}>
              <Badge tone={selected.required ? "amber" : "muted"}>{selected.required ? "Required" : "Optional"}</Badge>
              {kind === "input" && <Badge tone="blue">{(selected as StudioInputPort).kind}</Badge>}
              <Badge tone={selected.sensitivity === "none" ? "muted" : "red"}>{selected.sensitivity}</Badge>
            </div>
            <Button
              small
              tone="danger"
              icon="x"
              disabled={disabled || (kind === "input" && ports.length === 1)}
              onClick={() => {
                const next = ports.filter((port) => port !== selected);
                onChange(next);
                setSelectedId(next[0]?.id ?? "");
              }}
            >
              Remove
            </Button>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <Field label="Variable ID" required hint={selectedInput?.kind === "prompt" ? 'Reserved as "prompt" so the runtime can bind the chat message safely.' : "Stable key used by templates, APIs, and output bindings."}>
              <TextInput
                value={selected.id}
                mono
                disabled={disabled || selectedInput?.kind === "prompt"}
                onChange={(id) => update({ id })}
              />
            </Field>
            <Field label="Display label" required>
              <TextInput value={selected.label} disabled={disabled} onChange={(label) => update({ label })} />
            </Field>
            {kind === "input" && (
              <Field label="Input behavior">
                <SelectInput
                  value={(selected as StudioInputPort).kind}
                  disabled={disabled}
                  onChange={(value) => {
                    const nextKind = value as StudioInputPort["kind"];
                    if (nextKind === "prompt") {
                      update({ kind: nextKind, id: "prompt", required: true });
                      return;
                    }
                    if (selectedInput?.kind === "prompt" && selected.id === "prompt") {
                      let index = ports.length + 1;
                      let id = `input_${index}`;
                      while (ports.some((port) => port !== selected && port.id === id)) {
                        id = `input_${++index}`;
                      }
                      update({ kind: nextKind, id });
                      return;
                    }
                    update({ kind: nextKind });
                  }}
                  options={[
                    { value: "prompt", label: "Prompt — sent as the user message", disabled: promptUsedByAnother },
                    { value: "value", label: "Value — structured variable" },
                    { value: "file", label: "File — uploaded attachment" },
                  ]}
                />
              </Field>
            )}
            <Field label="Data sensitivity" hint="Controls trace visibility and redaction policy.">
              <SelectInput
                value={selected.sensitivity}
                disabled={disabled}
                onChange={(value) => update({ sensitivity: value as Port["sensitivity"] })}
                options={[
                  { value: "none", label: "None" },
                  { value: "personal", label: "Personal data" },
                  { value: "confidential", label: "Confidential" },
                  { value: "secret", label: "Secret" },
                ]}
              />
            </Field>
          </div>
          <Field label="Description" hint="Explain what this value means; the Test Lab uses it as field help.">
            <TextArea value={selected.description ?? ""} disabled={disabled} rows={3} onChange={(description) => update({ description })} />
          </Field>
          <Toggle
            checked={selected.required}
            disabled={disabled}
            onChange={(required) => update({ required })}
            label={`Require this ${kind}`}
            hint={kind === "output" ? "A run fails output validation when this value is missing." : "A run cannot start until this value is supplied."}
          />
          <JsonValueEditor value={selected.schema} onChange={(schema) => update({ schema: schema as Record<string, unknown> })} height={205} label="JSON Schema 2020-12" readOnly={disabled} />
          {kind === "input" && (
            <JsonValueEditor value={(selected as StudioInputPort).default ?? null} onChange={(defaultValue) => update({ default: defaultValue })} height={120} label="Default / template value" readOnly={disabled} />
          )}
          <JsonValueEditor value={selected.example ?? null} onChange={(example) => update({ example })} height={120} label="Example value" readOnly={disabled} />
          {kind === "input" && (selected as StudioInputPort).kind === "file" && (
            <div style={{ padding: 12, border: "1px solid var(--border)", borderRadius: 5, display: "grid", gap: 10 }}>
              <div className="mono" style={{ color: "var(--text-3)", fontSize: 10 }}>FILE POLICY</div>
              <Field label="Allowed media types" hint="Comma-separated MIME types; empty allows any configured file type.">
                <TextInput value={Array.isArray(asFilePolicy(selected).media_types) ? (asFilePolicy(selected).media_types as string[]).join(", ") : ""} mono disabled={disabled} onChange={(value) => update({ file: { ...asFilePolicy(selected), media_types: value.split(",").map((item) => item.trim()).filter(Boolean) } })} />
              </Field>
              <Field label="Maximum bytes"><TextInput value={Number(asFilePolicy(selected).max_bytes ?? 10_000_000)} type="number" min={1} disabled={disabled} onChange={(max_bytes) => update({ file: { ...asFilePolicy(selected), max_bytes: Number(max_bytes) } })} /></Field>
              <Toggle checked={Boolean(asFilePolicy(selected).multiple)} disabled={disabled} onChange={(multiple) => update({ file: { ...asFilePolicy(selected), multiple } })} label="Allow multiple files" />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function asFilePolicy(port: Port): Record<string, unknown> {
  const value = port.file;
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
