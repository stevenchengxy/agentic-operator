import React from "react";
import type { TaskFormDefinition, TaskFormRawValue } from "./task-form";

interface TaskFormFieldsProps {
  definition: TaskFormDefinition;
  values: Record<string, TaskFormRawValue>;
  errors: Record<string, string>;
  disabled?: boolean;
  onChange: (name: string, value: TaskFormRawValue) => void;
}

const controlStyle = {
  width: "100%",
  padding: "8px 10px",
  borderRadius: 4,
  border: "1px solid var(--border-2)",
  background: "var(--panel-2)",
  color: "var(--text)",
  fontFamily: "var(--sans)",
  fontSize: 12.5,
} as const;

export function TaskFormFields({
  definition,
  values,
  errors,
  disabled,
  onChange,
}: TaskFormFieldsProps) {
  if (definition.fields.length === 0) return null;
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
        gap: 14,
        marginBottom: 16,
      }}
    >
      {definition.fields.map((field) => {
        const errorId = `${field.name}-task-error`;
        const value = values[field.name] ?? field.initialValue;
        return (
          <label
            key={field.name}
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 5,
              gridColumn:
                field.kind === "textarea" || field.kind === "json"
                  ? "1 / -1"
                  : undefined,
            }}
          >
            <span style={{ fontSize: 11.5, color: "var(--text-2)" }}>
              {field.label}
              {field.required ? (
                <span style={{ color: "var(--red)" }}> *</span>
              ) : null}
            </span>
            {field.description ? (
              <span style={{ fontSize: 10.5, color: "var(--text-3)" }}>
                {field.description}
              </span>
            ) : null}
            {field.kind === "select" ? (
              <select
                name={field.name}
                value={String(value)}
                disabled={disabled}
                required={field.required}
                aria-describedby={errors[field.name] ? errorId : undefined}
                onChange={(event) => onChange(field.name, event.target.value)}
                style={controlStyle}
              >
                <option value="">Select…</option>
                {field.options.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            ) : field.kind === "boolean" ? (
              <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <input
                  name={field.name}
                  type="checkbox"
                  checked={value === true}
                  disabled={disabled}
                  onChange={(event) =>
                    onChange(field.name, event.target.checked)
                  }
                />
                <span style={{ fontSize: 12, color: "var(--text)" }}>
                  Confirm
                </span>
              </span>
            ) : field.kind === "textarea" || field.kind === "json" ? (
              <textarea
                name={field.name}
                value={String(value)}
                disabled={disabled}
                required={field.required}
                rows={field.kind === "json" ? 6 : 4}
                aria-describedby={errors[field.name] ? errorId : undefined}
                onChange={(event) => onChange(field.name, event.target.value)}
                style={{
                  ...controlStyle,
                  resize: "vertical",
                  fontFamily:
                    field.kind === "json" ? "var(--mono)" : "var(--sans)",
                }}
              />
            ) : (
              <input
                name={field.name}
                type={field.kind === "number" ? "number" : "text"}
                step={field.schemaType === "integer" ? 1 : undefined}
                value={String(value)}
                disabled={disabled}
                required={field.required}
                minLength={field.minLength}
                maxLength={field.maxLength}
                aria-describedby={errors[field.name] ? errorId : undefined}
                onChange={(event) => onChange(field.name, event.target.value)}
                style={controlStyle}
              />
            )}
            {errors[field.name] ? (
              <span
                id={errorId}
                role="alert"
                style={{ fontSize: 10.5, color: "var(--red)" }}
              >
                {errors[field.name]}
              </span>
            ) : null}
          </label>
        );
      })}
    </div>
  );
}
