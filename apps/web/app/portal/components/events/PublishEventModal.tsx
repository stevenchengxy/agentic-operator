"use client";

/**
 * PublishEventModal — operator-facing "Publish a new event" dialog.
 *
 * Production parity for the SPA-prototype Event Tester. Fires a single
 * `POST /v1/events` so the operator can kick off a workflow without
 * leaving the portal or composing a curl by hand. The two on-disk paths
 * (CLI clients) keep working — this is purely additive.
 *
 * Form shape:
 *   1. Event name        — dropdown from `/v1/events/catalog` (with a
 *                          "custom" free-text fallback for ad-hoc names).
 *   2. Subject           — required real correlation/business identifier.
 *   3. Payload           — typed inputs derived from the selected catalog
 *                          entry's `fields[]` (name + type). When no
 *                          fields are declared, falls back to a JSON
 *                          textarea. A "Raw JSON" toggle swaps the two
 *                          modes manually so power users can always paste.
 *
 * On submit the same `useEmitEvent` mutation that the rest of the portal
 * uses runs — the events list & live stream auto-refresh via the
 * mutation's onSettled invalidate.
 */

import { useEffect, useMemo, useState } from "react";

import { Button } from "@/app/portal/components";
import { ModalOverlay } from "@/app/portal/components/Modal";
import { useI18n } from "@/app/portal/lib/preferences-context";
import {
  useEmitEvent,
  useEventCatalog,
  type EventCatalogEntry,
  type EventCatalogField,
} from "@/lib/hooks/useEvents";
import { useDag } from "@/lib/hooks/useAgents";

/**
 * Source of an option in the event dropdown:
 *   - "catalog"   — declared in `event_types` (full schema available)
 *   - "workflow"  — referenced by an agent's `trigger` or `emits` in the
 *                   current DAG but has no catalog entry. Still publishable;
 *                   no schema → operator gets the raw-JSON editor.
 *   - "custom"    — operator typed a one-off name in the free-text field.
 */
type OptionSource = "catalog" | "workflow";

interface DropdownOption {
  name: string;
  source: OptionSource;
  /** Present only when source === "catalog". */
  entry?: EventCatalogEntry;
  /** Subset of agents that trigger on / emit this event (for the hint). */
  triggeredBy: string[];
  emittedBy: string[];
}

interface PublishEventModalProps {
  onClose: () => void;
  /** Optional — preselect this event name (used by the "Replay window" CTA later). */
  initialName?: string;
}

/**
 * Map the catalog's loose `type` strings ("String" / "Boolean" / "Number"
 * / "Integer" / "Datetime" / "Array<X>" / "Object" / …) onto an input
 * shape. Anything unrecognised falls back to plain text.
 */
type FieldKind = "string" | "boolean" | "number" | "datetime" | "json";
function fieldKind(t: string | undefined): FieldKind {
  const s = (t ?? "").toLowerCase().trim();
  if (s === "boolean" || s === "bool") return "boolean";
  if (s === "integer" || s === "int" || s === "number" || s === "float")
    return "number";
  if (s === "datetime" || s === "date" || s === "timestamp") return "datetime";
  if (s.startsWith("array") || s.startsWith("object") || s === "json")
    return "json";
  return "string";
}

/** Best-effort coercion before the body is JSON-stringified. */
function coerceFieldValue(kind: FieldKind, raw: string): unknown {
  if (raw === "") return undefined;
  if (kind === "boolean") return raw === "true";
  if (kind === "number") {
    const n = Number(raw);
    return Number.isFinite(n) ? n : raw;
  }
  if (kind === "json") {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  return raw;
}

export function PublishEventModal({
  onClose,
  initialName,
}: PublishEventModalProps) {
  const { t } = useI18n();
  const catalog = useEventCatalog();
  const dag = useDag();
  const emit = useEmitEvent();

  const [eventName, setEventName] = useState<string>(initialName ?? "");
  const [customName, setCustomName] = useState<string>("");
  const [subject, setSubject] = useState<string>("");
  /** name → raw string value from the typed inputs. */
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});
  const [rawMode, setRawMode] = useState(false);
  const [rawJson, setRawJson] = useState<string>("{}");
  const [parseError, setParseError] = useState<string | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const [showSchema, setShowSchema] = useState(false);
  const [submitted, setSubmitted] = useState<{
    id: string;
    name: string;
    at: number;
  } | null>(null);

  // Merged option list: every event name reachable from the current
  // workflow (DAG triggers + emits) PLUS every declared catalog entry.
  // Catalog wins on collision because it carries the schema. The dropdown
  // is grouped by source so the operator can see at a glance which events
  // have a typed form and which fall back to the raw-JSON editor.
  const options: DropdownOption[] = useMemo(() => {
    const map = new Map<string, DropdownOption>();
    const dagAgents = dag.data?.agents ?? [];
    for (const a of dagAgents) {
      for (const t of a.triggers ?? []) {
        if (!map.has(t)) {
          map.set(t, {
            name: t,
            source: "workflow",
            triggeredBy: [],
            emittedBy: [],
          });
        }
        map.get(t)!.triggeredBy.push(a.title || a.name);
      }
      for (const e of a.emits ?? []) {
        if (!map.has(e)) {
          map.set(e, {
            name: e,
            source: "workflow",
            triggeredBy: [],
            emittedBy: [],
          });
        }
        map.get(e)!.emittedBy.push(a.title || a.name);
      }
    }
    for (const entry of catalog.data ?? []) {
      const existing = map.get(entry.name);
      if (existing) {
        existing.source = "catalog";
        existing.entry = entry;
      } else {
        map.set(entry.name, {
          name: entry.name,
          source: "catalog",
          entry,
          triggeredBy: [],
          emittedBy: [],
        });
      }
    }
    return Array.from(map.values()).sort((a, b) => {
      // Catalog entries first (richer UI), then by name.
      if (a.source !== b.source) return a.source === "catalog" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }, [catalog.data, dag.data]);

  const catalogOptions = options.filter((o) => o.source === "catalog");
  const workflowOptions = options.filter((o) => o.source === "workflow");

  // Auto-select the first option once data loads so the form isn't empty.
  useEffect(() => {
    const first = options[0];
    if (!eventName && first) {
      setEventName(first.name);
    }
  }, [options, eventName]);

  const selectedOption: DropdownOption | undefined = useMemo(() => {
    if (eventName === "__custom__") return undefined;
    return options.find((o) => o.name === eventName);
  }, [options, eventName]);

  const selectedEntry: EventCatalogEntry | undefined = selectedOption?.entry;
  const fields: EventCatalogField[] = selectedEntry?.fields ?? [];
  const finalName = eventName === "__custom__" ? customName.trim() : eventName;

  // Reset field-state when switching events so leftover values from a
  // previous selection don't bleed into the new payload.
  useEffect(() => {
    setFieldValues({});
    setRawJson("{}");
    setParseError(null);
    setServerError(null);
  }, [eventName]);

  function buildPayload(): { ok: true; payload: Record<string, unknown> } | { ok: false; error: string } {
    if (rawMode) {
      try {
        const v = rawJson.trim() === "" ? {} : JSON.parse(rawJson);
        if (typeof v !== "object" || v === null || Array.isArray(v)) {
          return { ok: false, error: t("publishEventModal.errPayloadObject") };
        }
        return { ok: true, payload: v as Record<string, unknown> };
      } catch (err) {
        return {
          ok: false,
          error: t("publishEventModal.errJsonParse", {
            message: err instanceof Error ? err.message : String(err),
          }),
        };
      }
    }
    const out: Record<string, unknown> = {};
    for (const f of fields) {
      const raw = fieldValues[f.name] ?? "";
      const coerced = coerceFieldValue(fieldKind(f.type), raw);
      if (coerced !== undefined) {
        out[f.name] = coerced;
      }
    }
    return { ok: true, payload: out };
  }

  async function handleSubmit() {
    if (!finalName) {
      setServerError(t("publishEventModal.errNameRequired"));
      return;
    }
    if (!subject.trim()) {
      setServerError(t("publishEventModal.errSubjectRequired"));
      return;
    }
    const built = buildPayload();
    if (!built.ok) {
      setParseError(built.error);
      return;
    }
    setParseError(null);
    setServerError(null);
    try {
      const res = await emit.mutateAsync({
        name: finalName,
        subject: subject.trim(),
        payload: built.payload,
      });
      setSubmitted({ id: res.event_id, name: res.name, at: Date.now() });
    } catch (err) {
      setServerError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <ModalOverlay onClose={onClose} ariaLabel={t("publishEventModal.ariaLabel")}>
      <div
        style={{
          width: "min(640px, 92vw)",
          maxHeight: "88vh",
          background: "var(--panel)",
          border: "1px solid var(--border)",
          borderRadius: 6,
          padding: 20,
          display: "flex",
          flexDirection: "column",
          gap: 14,
          overflow: "hidden",
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
            {t("publishEventModal.heading")}
          </h3>
          <span
            className="mono"
            style={{ fontSize: 11.5, color: "var(--text-3)" }}
          >
            POST /v1/events
          </span>
        </header>

        <p style={{ margin: 0, fontSize: 12.5, color: "var(--text-2)" }}>
          {t("publishEventModal.introBeforeTrigger")}{" "}
          <code className="mono">trigger</code>{" "}
          {t("publishEventModal.introMatches")}{" "}
          <code className="mono">{finalName || "<name>"}</code>{" "}
          {t("publishEventModal.introAfterName")}
        </p>

        <div style={{ overflow: "auto", display: "flex", flexDirection: "column", gap: 14 }}>
          {/* Event name */}
          <Field label={t("publishEventModal.fieldEventName")} required>
            <select
              value={eventName}
              onChange={(e) => setEventName(e.target.value)}
              style={selectStyle}
            >
              {(catalog.isLoading || dag.isLoading) && options.length === 0 ? (
                <option value="">{t("publishEventModal.loading")}</option>
              ) : options.length === 0 ? (
                <option value="">
                  {t("publishEventModal.noEventsDeclared")}
                </option>
              ) : null}
              {catalogOptions.length > 0 && (
                <optgroup label={t("publishEventModal.groupCatalog")}>
                  {catalogOptions.map((o) => (
                    <option key={o.name} value={o.name}>
                      {o.name}
                      {o.entry?.category ? ` (${o.entry.category})` : ""}
                    </option>
                  ))}
                </optgroup>
              )}
              {workflowOptions.length > 0 && (
                <optgroup label={t("publishEventModal.groupWorkflow")}>
                  {workflowOptions.map((o) => (
                    <option key={o.name} value={o.name}>
                      {o.name}
                    </option>
                  ))}
                </optgroup>
              )}
              <option value="__custom__">{t("publishEventModal.customOption")}</option>
            </select>
            {eventName === "__custom__" && (
              <input
                type="text"
                placeholder={t("publishEventModal.customPlaceholder")}
                value={customName}
                onChange={(e) => setCustomName(e.target.value)}
                style={{ ...inputStyle, marginTop: 6 }}
              />
            )}
            {selectedEntry?.description && (
              <p style={hintStyle}>{selectedEntry.description}</p>
            )}
            {selectedOption && (
              <p style={hintStyle}>
                {selectedOption.triggeredBy.length > 0 && (
                  <>
                    {t("publishEventModal.triggersLabel")}{" "}
                    <span className="mono" style={{ color: "var(--text-2)" }}>
                      {selectedOption.triggeredBy.join(", ")}
                    </span>
                  </>
                )}
                {selectedOption.triggeredBy.length > 0 &&
                  selectedOption.emittedBy.length > 0 &&
                  " · "}
                {selectedOption.emittedBy.length > 0 && (
                  <>
                    {t("publishEventModal.emittedByLabel")}{" "}
                    <span className="mono" style={{ color: "var(--text-2)" }}>
                      {selectedOption.emittedBy.join(", ")}
                    </span>
                  </>
                )}
              </p>
            )}
          </Field>

          {/* Subject */}
          <Field label={t("publishEventModal.fieldSubject")} hint={t("publishEventModal.subjectHint")} required>
            <input
              type="text"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder={t("publishEventModal.subjectPlaceholder")}
              required
              style={inputStyle}
            />
          </Field>

          {/* Payload schema (collapsed by default) — only meaningful when
              the catalog has a declared schema for this event. For workflow-
              only events the panel shows a "no schema declared" notice so
              operators don't think it failed to load. */}
          {selectedOption && (
            <div>
              <button
                type="button"
                onClick={() => setShowSchema((v) => !v)}
                style={{
                  ...labelStyle,
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  background: "transparent",
                  border: "none",
                  padding: 0,
                  cursor: "pointer",
                }}
                aria-expanded={showSchema}
              >
                <span>{showSchema ? "▾" : "▸"}</span>
                {t("publishEventModal.payloadSchema")}
                {selectedEntry ? (
                  <span style={{ color: "var(--text-3)", marginLeft: 6 }}>
                    ·{" "}
                    {fields.length === 1
                      ? t("publishEventModal.fieldCountOne", { count: fields.length })
                      : t("publishEventModal.fieldCountMany", { count: fields.length })}
                  </span>
                ) : (
                  <span style={{ color: "var(--text-3)", marginLeft: 6 }}>
                    · {t("publishEventModal.noneDeclared")}
                  </span>
                )}
              </button>
              {showSchema && (
                <div style={schemaBoxStyle}>
                  {selectedEntry?.raw_payload_schema ? (
                    <pre style={schemaPreStyle}>
                      {JSON.stringify(selectedEntry.raw_payload_schema, null, 2)}
                    </pre>
                  ) : fields.length > 0 ? (
                    <pre style={schemaPreStyle}>
                      {JSON.stringify(
                        {
                          type: "object",
                          required: fields
                            .filter((f) => f.required)
                            .map((f) => f.name),
                          properties: Object.fromEntries(
                            fields.map((f) => [
                              f.name,
                              {
                                type: f.type,
                                ...(f.enum ? { enum: f.enum } : {}),
                                ...(f.target_object
                                  ? { targetObject: f.target_object }
                                  : {}),
                              },
                            ]),
                          ),
                        },
                        null,
                        2,
                      )}
                    </pre>
                  ) : (
                    <p style={{ ...hintStyle, marginTop: 0 }}>
                      {t("publishEventModal.noSchemaBefore")}{" "}
                      <code className="mono">event_types</code>
                      {t("publishEventModal.noSchemaAfter")}
                    </p>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Payload */}
          <div>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                marginBottom: 6,
              }}
            >
              <label style={labelStyle}>
                {t("publishEventModal.payload")}
                {fields.length > 0 && !rawMode ? (
                  <span style={{ color: "var(--text-3)", marginLeft: 6 }}>
                    ·{" "}
                    {fields.length === 1
                      ? t("publishEventModal.declaredFieldOne", { count: fields.length })
                      : t("publishEventModal.declaredFieldMany", { count: fields.length })}
                  </span>
                ) : null}
              </label>
              <button
                type="button"
                onClick={() => {
                  // Round-trip current state when toggling so the operator
                  // doesn't lose what they typed.
                  if (!rawMode) {
                    const built = buildPayload();
                    if (built.ok) setRawJson(JSON.stringify(built.payload, null, 2));
                  }
                  setRawMode(!rawMode);
                  setParseError(null);
                }}
                style={{
                  fontSize: 11,
                  color: "var(--text-3)",
                  background: "transparent",
                  border: "1px solid var(--border)",
                  padding: "2px 8px",
                  borderRadius: 3,
                  cursor: "pointer",
                  fontFamily: "var(--mono)",
                }}
              >
                {rawMode ? t("publishEventModal.toggleForm") : t("publishEventModal.toggleRawJson")}
              </button>
            </div>

            {rawMode || fields.length === 0 ? (
              <textarea
                value={rawJson}
                onChange={(e) => setRawJson(e.target.value)}
                spellCheck={false}
                style={{
                  ...inputStyle,
                  minHeight: 160,
                  maxHeight: 280,
                  fontFamily: "var(--mono)",
                  fontSize: 12.5,
                  resize: "vertical",
                  borderColor: parseError ? "var(--red)" : "var(--border)",
                }}
              />
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {fields.map((f) => (
                  <FieldRow
                    key={f.name}
                    field={f}
                    value={fieldValues[f.name] ?? ""}
                    onChange={(v) =>
                      setFieldValues((cur) => ({ ...cur, [f.name]: v }))
                    }
                  />
                ))}
              </div>
            )}
          </div>

          {parseError && <p style={errorStyle}>{parseError}</p>}
          {serverError && (
            <p style={errorStyle}>
              {t("publishEventModal.serverPrefix")} {serverError}
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
              }}
            >
              {t("publishEventModal.published")} · {submitted.name}{" "}
              <span className="mono" style={{ color: "var(--text)" }}>
                {submitted.id}
              </span>
              <span
                className="mono"
                style={{
                  fontSize: 11,
                  color: "var(--text-3)",
                  marginLeft: 8,
                }}
              >
                ({new Date(submitted.at).toLocaleTimeString()})
              </span>
            </div>
          )}
        </div>

        <footer
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
            marginTop: 4,
          }}
        >
          <Button small tone="ghost" onClick={onClose} disabled={emit.isPending}>
            {submitted ? t("publishEventModal.close") : t("publishEventModal.cancel")}
          </Button>
          <Button
            small
            icon="run"
            tone="primary"
            onClick={handleSubmit}
            disabled={emit.isPending || !finalName || !subject.trim()}
          >
            {emit.isPending
              ? t("publishEventModal.publishing")
              : submitted
                ? t("publishEventModal.publishAnother")
                : t("publishEventModal.publish")}
          </Button>
        </footer>
      </div>
    </ModalOverlay>
  );
}

function Field({
  label,
  hint,
  required,
  children,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label style={labelStyle}>
        {label}
        {required && <span style={{ color: "var(--red)", marginLeft: 4 }}>*</span>}
      </label>
      <div style={{ marginTop: 6 }}>{children}</div>
      {hint && <p style={hintStyle}>{hint}</p>}
    </div>
  );
}

function FieldRow({
  field,
  value,
  onChange,
}: {
  field: EventCatalogField;
  value: string;
  onChange: (v: string) => void;
}) {
  const kind = fieldKind(field.type);
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "180px 1fr",
        gap: 10,
        alignItems: "start",
      }}
    >
      <div>
        <div
          className="mono"
          style={{ fontSize: 12, color: "var(--text)", lineHeight: 1.3 }}
        >
          {field.name}
          {field.required && (
            <span style={{ color: "var(--red)", marginLeft: 4 }}>*</span>
          )}
        </div>
        <div
          className="mono"
          style={{ fontSize: 10.5, color: "var(--text-3)" }}
        >
          {field.type}
        </div>
      </div>
      <div>
        {field.enum && field.enum.length > 0 ? (
          <select
            value={value}
            onChange={(e) => onChange(e.target.value)}
            style={selectStyle}
          >
            <option value="">—</option>
            {field.enum.map((opt) => (
              <option key={opt} value={opt}>
                {opt}
              </option>
            ))}
          </select>
        ) : kind === "boolean" ? (
          <select
            value={value}
            onChange={(e) => onChange(e.target.value)}
            style={selectStyle}
          >
            <option value="">—</option>
            <option value="true">true</option>
            <option value="false">false</option>
          </select>
        ) : kind === "number" ? (
          <input
            type="number"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder="0"
            style={inputStyle}
          />
        ) : kind === "datetime" ? (
          <input
            type="datetime-local"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            style={inputStyle}
          />
        ) : kind === "json" ? (
          <textarea
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder="[] or {}"
            spellCheck={false}
            style={{
              ...inputStyle,
              minHeight: 60,
              fontFamily: "var(--mono)",
              fontSize: 12,
              resize: "vertical",
            }}
          />
        ) : (
          <input
            type="text"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            style={inputStyle}
          />
        )}
      </div>
    </div>
  );
}

const labelStyle: React.CSSProperties = {
  fontSize: 11,
  textTransform: "uppercase",
  letterSpacing: 0.4,
  color: "var(--text-3)",
  fontFamily: "var(--mono)",
};
const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "8px 10px",
  fontFamily: "var(--mono)",
  fontSize: 12.5,
  background: "var(--panel-2)",
  color: "var(--text)",
  border: "1px solid var(--border)",
  borderRadius: 4,
  outline: "none",
};
const selectStyle: React.CSSProperties = {
  ...inputStyle,
  appearance: "auto",
};
const hintStyle: React.CSSProperties = {
  margin: "6px 0 0 0",
  fontSize: 11.5,
  color: "var(--text-3)",
  lineHeight: 1.4,
};
const errorStyle: React.CSSProperties = {
  margin: 0,
  fontSize: 12,
  color: "var(--red)",
};
const schemaBoxStyle: React.CSSProperties = {
  marginTop: 6,
  padding: "8px 10px",
  background: "var(--panel-2)",
  border: "1px solid var(--border)",
  borderRadius: 4,
  maxHeight: 200,
  overflow: "auto",
};
const schemaPreStyle: React.CSSProperties = {
  margin: 0,
  fontFamily: "var(--mono)",
  fontSize: 11.5,
  color: "var(--text-2)",
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
};
