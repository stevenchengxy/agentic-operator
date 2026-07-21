"use client";

import { useMemo, useState } from "react";
import { Badge, Button, Icon } from "@/app/portal/components";
import { useI18n } from "@/app/portal/lib/preferences-context";
import { studioUi } from "./copy";
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
  const { t } = useI18n();
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
            label: studioUi(t, "Input {index}", { index }),
            kind: "value",
            required: false,
            schema: { type: "string" },
            sensitivity: "none",
          }
        : {
            id,
            label: studioUi(t, "Output {index}", { index }),
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
        title={
          kind === "input"
            ? studioUi(t, "No inputs yet")
            : studioUi(t, "No outputs yet")
        }
        hint={
          kind === "input"
            ? studioUi(
                t,
                "Add the first piece of information this agent will receive.",
              )
            : studioUi(
                t,
                "Add the first piece of information this agent will return.",
              )
        }
        actionLabel={
          kind === "input"
            ? studioUi(t, "Add input")
            : studioUi(t, "Add output")
        }
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
            {ports.length}{" "}
            {kind === "input"
              ? ports.length === 1
                ? studioUi(t, "input")
                : studioUi(t, "inputs")
              : ports.length === 1
                ? studioUi(t, "output")
                : studioUi(t, "outputs")}
          </span>
          <Button small icon="plus" onClick={add} disabled={disabled}>
            {studioUi(t, "Add")}
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
                {port.label} · {studioUi(t, String(port.schema.type ?? "any"))}
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
                {selected.required
                  ? studioUi(t, "Required")
                  : studioUi(t, "Optional")}
              </Badge>
              {kind === "input" && (
                <Badge tone="blue">
                  {studioUi(t, (selected as StudioInputPort).kind)}
                </Badge>
              )}
              <Badge tone={selected.sensitivity === "none" ? "muted" : "red"}>
                {studioUi(t, selected.sensitivity)}
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
              {studioUi(t, "Remove")}
            </Button>
          </div>
          <div
            className="agent-studio-port-fields-grid"
            style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}
          >
            <Field
              label={studioUi(t, "Internal field name")}
              required
              hint={
                selectedInput?.kind === "prompt"
                  ? studioUi(
                      t,
                      'The chat request always uses the reserved name "prompt".',
                    )
                  : studioUi(
                      t,
                      "A short permanent name used to connect this field to prompts and workflows. Use letters, numbers, and underscores; do not use spaces.",
                    )
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
              label={studioUi(t, "Question shown to users")}
              required
              hint={studioUi(
                t,
                "The friendly label displayed in the Test Lab form.",
              )}
              example={
                kind === "input"
                  ? studioUi(t, "Customer message")
                  : studioUi(t, "Suggested reply")
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
                label={studioUi(t, "How this input is provided")}
                hint={studioUi(
                  t,
                  "Choose Chat request for the main user message, Form value for a separate field, or File upload for an attachment.",
                )}
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
                      label: studioUi(t, "Chat request — main user message"),
                      disabled: promptUsedByAnother,
                    },
                    {
                      value: "value",
                      label: studioUi(t, "Form value — separate input field"),
                    },
                    {
                      value: "file",
                      label: studioUi(t, "File upload — attachment"),
                    },
                  ]}
                />
              </Field>
            )}
            <Field
              label={studioUi(t, "Privacy level")}
              hint={studioUi(
                t,
                "Choose the safest category that describes the value. Sensitive values are hidden or reduced in traces and logs.",
              )}
            >
              <SelectInput
                value={selected.sensitivity}
                disabled={disabled}
                onChange={(value) =>
                  update({ sensitivity: value as Port["sensitivity"] })
                }
                options={[
                  {
                    value: "none",
                    label: studioUi(t, "Normal — safe to show in traces"),
                  },
                  {
                    value: "personal",
                    label: studioUi(t, "Personal — identifies a person"),
                  },
                  {
                    value: "confidential",
                    label: studioUi(t, "Confidential — business-sensitive"),
                  },
                  {
                    value: "secret",
                    label: studioUi(
                      t,
                      "Secret — credentials or restricted data",
                    ),
                  },
                ]}
              />
            </Field>
          </div>
          <Field
            label={studioUi(t, "Help text for this field")}
            hint={studioUi(
              t,
              "Tell the person running the agent exactly what to enter. This appears below the field in the Test Lab.",
            )}
            example={
              kind === "input"
                ? studioUi(
                    t,
                    "Paste the full customer email, including the subject line.",
                  )
                : studioUi(t, "A short answer ready to send to the customer.")
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
            label={
              kind === "input"
                ? studioUi(t, "Require this input")
                : studioUi(t, "Require this output")
            }
            hint={
              kind === "output"
                ? studioUi(
                    t,
                    "A run fails output validation when this value is missing.",
                  )
                : studioUi(
                    t,
                    "A run cannot start until this value is supplied.",
                  )
            }
          />
          <Field
            label={studioUi(t, "Type of information")}
            hint={studioUi(
              t,
              "Pick the simple format users should provide or receive. Most fields only need one of these choices.",
            )}
          >
            <SelectInput
              value={String(selected.schema.type ?? "string")}
              disabled={disabled}
              onChange={(type) => update({ schema: { type } })}
              options={[
                { value: "string", label: studioUi(t, "Text") },
                {
                  value: "number",
                  label: studioUi(t, "Number (may include decimals)"),
                },
                { value: "integer", label: studioUi(t, "Whole number") },
                { value: "boolean", label: studioUi(t, "Yes / No") },
                { value: "array", label: studioUi(t, "List of values") },
                {
                  value: "object",
                  label: studioUi(t, "Group of named values"),
                },
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
              {studioUi(t, "Advanced validation rules")}
            </summary>
            <div style={{ marginTop: 10 }}>
              <JsonValueEditor
                value={selected.schema}
                onChange={(schema) =>
                  update({ schema: schema as Record<string, unknown> })
                }
                height={205}
                label="JSON Schema"
                hint={studioUi(
                  t,
                  "Optional expert settings for limits, allowed values, or nested objects. The basic type above is enough for most agents.",
                )}
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
              label={studioUi(t, "Pre-filled value")}
              hint={studioUi(
                t,
                "Optional value used when the runner does not enter anything. Leave null when the user must decide.",
              )}
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
            label={studioUi(t, "Example shown to builders")}
            hint={studioUi(
              t,
              "A realistic sample that helps people understand the expected value. It is not automatically used in production.",
            )}
            example={
              selected.schema.type === "string"
                ? '"My invoice shows the wrong amount."'
                : studioUi(t, "Use the same shape as the selected type.")
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
                  {studioUi(t, "FILE POLICY")}
                </div>
                <Field
                  label={studioUi(t, "Allowed file types")}
                  hint={studioUi(
                    t,
                    "Enter standard media types separated by commas. Leave empty to use the workspace file policy.",
                  )}
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
                  label={studioUi(t, "Maximum file size")}
                  hint={studioUi(t, "Size limit in bytes for each upload.")}
                  example={studioUi(t, "10000000 is about 10 MB")}
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
                  label={studioUi(t, "Allow more than one file")}
                  hint={studioUi(
                    t,
                    "Turn this on only when the agent is designed to process a group of files in one run.",
                  )}
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
