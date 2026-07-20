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
  const selectedInput =
    kind === "input" && selected ? (selected as StudioInputPort) : null;
  const promptUsedByAnother =
    kind === "input" &&
    ports.some(
      (port) =>
        port !== selected && (port as StudioInputPort).kind === "prompt",
    );

  function update(patch: Partial<Port>) {
    if (!selected) return;
    if (typeof patch.id === "string" && selectedId === selected.id) {
      setSelectedId(patch.id);
    }
    onChange(
      ports.map((port) =>
        port === selected ? ({ ...port, ...patch } as Port) : port,
      ),
    );
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
        hint={`Add the first piece of information this agent will ${kind === "input" ? "receive" : "return"}.`}
        actionLabel={`Add ${kind}`}
        onAction={add}
      />
    );
  }

  return (
    <div
      className="agent-studio-port-grid"
      style={{
        display: "grid",
        gridTemplateColumns: "210px minmax(0, 1fr)",
        minHeight: 430,
      }}
    >
      <div
        className="agent-studio-port-list"
        style={{ borderRight: "1px solid var(--border)", paddingRight: 12 }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: 8,
          }}
        >
          <span
            className="mono"
            style={{
              color: "var(--text-2)",
              fontSize: 11.5,
              fontWeight: 600,
            }}
          >
            {ports.length} {ports.length === 1 ? kind : `${kind}s`}
          </span>
          <Button small icon="plus" onClick={add} disabled={disabled}>
            Add
          </Button>
        </div>
        <div style={{ display: "grid", gap: 5 }}>
          {ports.map((port) => (
            <button
              type="button"
              key={port.id}
              aria-pressed={port === selected}
              onClick={() => setSelectedId(port.id)}
              style={{
                padding: "9px 10px",
                textAlign: "left",
                border: `1px solid ${port === selected ? "rgba(208,255,0,0.35)" : "var(--border)"}`,
                borderRadius: 5,
                background:
                  port === selected ? "rgba(208,255,0,0.05)" : "var(--panel-2)",
                color: "var(--text)",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <Icon
                  name={kind === "input" ? "chevron-right" : "external"}
                  size={10}
                />
                <span
                  className="mono"
                  style={{
                    fontSize: 12,
                    fontWeight: 600,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {port.id}
                </span>
              </div>
              <div
                style={{
                  marginTop: 4,
                  fontSize: 11.5,
                  color: "var(--text-2)",
                  lineHeight: 1.4,
                }}
              >
                {port.label} · {String(port.schema.type ?? "any")}
              </div>
            </button>
          ))}
        </div>
      </div>

      {selected && (
        <div
          className="agent-studio-port-detail"
          style={{
            paddingLeft: 16,
            display: "grid",
            gap: 14,
            alignContent: "start",
          }}
        >
          <div
            className="agent-studio-port-detail-header"
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
            }}
          >
            <div style={{ display: "flex", gap: 7 }}>
              <Badge tone={selected.required ? "amber" : "muted"}>
                {selected.required ? "Required" : "Optional"}
              </Badge>
              {kind === "input" && (
                <Badge tone="blue">{(selected as StudioInputPort).kind}</Badge>
              )}
              <Badge tone={selected.sensitivity === "none" ? "muted" : "red"}>
                {selected.sensitivity}
              </Badge>
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
          <div
            className="agent-studio-port-fields-grid"
            style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}
          >
            <Field
              label="Internal field name"
              required
              hint={
                selectedInput?.kind === "prompt"
                  ? 'The chat request always uses the reserved name "prompt".'
                  : "A short permanent name used to connect this field to prompts and workflows. Use letters, numbers, and underscores; do not use spaces."
              }
              example={
                selectedInput?.kind === "prompt"
                  ? "prompt"
                  : kind === "input"
                    ? "customer_tier"
                    : "category"
              }
            >
              <TextInput
                value={selected.id}
                mono
                disabled={disabled || selectedInput?.kind === "prompt"}
                onChange={(id) => update({ id })}
              />
            </Field>
            <Field
              label="Question shown to users"
              required
              hint="The friendly label displayed in the Test Lab form."
              example={
                kind === "input" ? "Customer message" : "Suggested reply"
              }
            >
              <TextInput
                value={selected.label}
                disabled={disabled}
                onChange={(label) => update({ label })}
              />
            </Field>
            {kind === "input" && (
              <Field
                label="How this input is provided"
                hint="Choose Chat request for the main user message, Form value for a separate field, or File upload for an attachment."
              >
                <SelectInput
                  value={(selected as StudioInputPort).kind}
                  disabled={disabled}
                  onChange={(value) => {
                    const nextKind = value as StudioInputPort["kind"];
                    if (nextKind === "prompt") {
                      update({ kind: nextKind, id: "prompt", required: true });
                      return;
                    }
                    if (
                      selectedInput?.kind === "prompt" &&
                      selected.id === "prompt"
                    ) {
                      let index = ports.length + 1;
                      let id = `input_${index}`;
                      while (
                        ports.some(
                          (port) => port !== selected && port.id === id,
                        )
                      ) {
                        id = `input_${++index}`;
                      }
                      update({ kind: nextKind, id });
                      return;
                    }
                    update({ kind: nextKind });
                  }}
                  options={[
                    {
                      value: "prompt",
                      label: "Chat request — main user message",
                      disabled: promptUsedByAnother,
                    },
                    {
                      value: "value",
                      label: "Form value — separate input field",
                    },
                    { value: "file", label: "File upload — attachment" },
                  ]}
                />
              </Field>
            )}
            <Field
              label="Privacy level"
              hint="Choose the safest category that describes the value. Sensitive values are hidden or reduced in traces and logs."
            >
              <SelectInput
                value={selected.sensitivity}
                disabled={disabled}
                onChange={(value) =>
                  update({ sensitivity: value as Port["sensitivity"] })
                }
                options={[
                  { value: "none", label: "Normal — safe to show in traces" },
                  {
                    value: "personal",
                    label: "Personal — identifies a person",
                  },
                  {
                    value: "confidential",
                    label: "Confidential — business-sensitive",
                  },
                  {
                    value: "secret",
                    label: "Secret — credentials or restricted data",
                  },
                ]}
              />
            </Field>
          </div>
          <Field
            label="Help text for this field"
            hint="Tell the person running the agent exactly what to enter. This appears below the field in the Test Lab."
            example={
              kind === "input"
                ? "Paste the full customer email, including the subject line."
                : "A short answer ready to send to the customer."
            }
          >
            <TextArea
              value={selected.description ?? ""}
              disabled={disabled}
              rows={3}
              onChange={(description) => update({ description })}
            />
          </Field>
          <Toggle
            checked={selected.required}
            disabled={disabled}
            onChange={(required) => update({ required })}
            label={`Require this ${kind}`}
            hint={
              kind === "output"
                ? "A run fails output validation when this value is missing."
                : "A run cannot start until this value is supplied."
            }
          />
          <Field
            label="Type of information"
            hint="Pick the simple format users should provide or receive. Most fields only need one of these choices."
          >
            <SelectInput
              value={String(selected.schema.type ?? "string")}
              disabled={disabled}
              onChange={(type) => update({ schema: { type } })}
              options={[
                { value: "string", label: "Text" },
                { value: "number", label: "Number (may include decimals)" },
                { value: "integer", label: "Whole number" },
                { value: "boolean", label: "Yes / No" },
                { value: "array", label: "List of values" },
                { value: "object", label: "Group of named values" },
              ]}
            />
          </Field>
          <details
            style={{
              border: "1px solid var(--border)",
              borderRadius: 5,
              padding: "9px 10px",
              background: "var(--bg-2)",
            }}
          >
            <summary
              style={{
                cursor: "pointer",
                color: "var(--text-2)",
                fontSize: 12,
                fontWeight: 600,
              }}
            >
              Advanced validation rules
            </summary>
            <div style={{ marginTop: 10 }}>
              <JsonValueEditor
                value={selected.schema}
                onChange={(schema) =>
                  update({ schema: schema as Record<string, unknown> })
                }
                height={205}
                label="JSON Schema"
                hint="Optional expert settings for limits, allowed values, or nested objects. The basic type above is enough for most agents."
                example={
                  '{"type":"string","enum":["billing","technical","other"]}'
                }
                readOnly={disabled}
              />
            </div>
          </details>
          {kind === "input" && (
            <JsonValueEditor
              value={(selected as StudioInputPort).default ?? null}
              onChange={(defaultValue) => update({ default: defaultValue })}
              height={120}
              label="Pre-filled value"
              hint="Optional value used when the runner does not enter anything. Leave null when the user must decide."
              example={
                selected.schema.type === "string" ? '"standard"' : "null"
              }
              readOnly={disabled}
            />
          )}
          <JsonValueEditor
            value={selected.example ?? null}
            onChange={(example) => update({ example })}
            height={120}
            label="Example shown to builders"
            hint="A realistic sample that helps people understand the expected value. It is not automatically used in production."
            example={
              selected.schema.type === "string"
                ? '"My invoice shows the wrong amount."'
                : "Use the same shape as the selected type."
            }
            readOnly={disabled}
          />
          {kind === "input" &&
            (selected as StudioInputPort).kind === "file" && (
              <div
                style={{
                  padding: 12,
                  border: "1px solid var(--border)",
                  borderRadius: 5,
                  display: "grid",
                  gap: 10,
                }}
              >
                <div
                  className="mono"
                  style={{
                    color: "var(--text-2)",
                    fontSize: 11.5,
                    fontWeight: 600,
                  }}
                >
                  FILE POLICY
                </div>
                <Field
                  label="Allowed file types"
                  hint="Enter standard media types separated by commas. Leave empty to use the workspace file policy."
                  example="application/pdf, image/png"
                >
                  <TextInput
                    value={
                      Array.isArray(asFilePolicy(selected).media_types)
                        ? (asFilePolicy(selected).media_types as string[]).join(
                            ", ",
                          )
                        : ""
                    }
                    mono
                    disabled={disabled}
                    onChange={(value) =>
                      update({
                        file: {
                          ...asFilePolicy(selected),
                          media_types: value
                            .split(",")
                            .map((item) => item.trim())
                            .filter(Boolean),
                        },
                      })
                    }
                  />
                </Field>
                <Field
                  label="Maximum file size"
                  hint="Size limit in bytes for each upload."
                  example="10000000 is about 10 MB"
                >
                  <TextInput
                    value={Number(
                      asFilePolicy(selected).max_bytes ?? 10_000_000,
                    )}
                    type="number"
                    min={1}
                    disabled={disabled}
                    onChange={(max_bytes) =>
                      update({
                        file: {
                          ...asFilePolicy(selected),
                          max_bytes: Number(max_bytes),
                        },
                      })
                    }
                  />
                </Field>
                <Toggle
                  checked={Boolean(asFilePolicy(selected).multiple)}
                  disabled={disabled}
                  onChange={(multiple) =>
                    update({ file: { ...asFilePolicy(selected), multiple } })
                  }
                  label="Allow more than one file"
                  hint="Turn this on only when the agent is designed to process a group of files in one run."
                />
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
    ? (value as Record<string, unknown>)
    : {};
}
