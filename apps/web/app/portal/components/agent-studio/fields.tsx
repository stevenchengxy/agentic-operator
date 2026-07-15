"use client";

import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  Badge,
  Button,
  Icon,
  MonacoEditor,
  Panel,
} from "@/app/portal/components";
import { parseLooseJson, toPrettyJson } from "./model";

export function StudioPanel({
  title,
  subtitle,
  action,
  children,
  style,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <Panel
      title={title}
      subtitle={subtitle}
      action={action}
      padded
      style={style}
    >
      {children}
    </Panel>
  );
}

export function Field({
  label,
  hint,
  example,
  required,
  children,
  style,
}: {
  label: ReactNode;
  hint?: ReactNode;
  example?: ReactNode;
  required?: boolean;
  children: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <label style={{ display: "block", ...style }}>
      <span
        style={{
          display: "flex",
          alignItems: "center",
          gap: 5,
          marginBottom: 4,
          fontSize: 11,
          fontWeight: 500,
          color: "var(--text)",
        }}
      >
        {label}
        {required && <span style={{ color: "var(--amber)" }}>*</span>}
      </span>
      {hint && (
        <span
          style={{
            display: "block",
            marginBottom: 6,
            fontSize: 10.5,
            lineHeight: 1.45,
            color: "var(--text-3)",
          }}
        >
          {hint}
        </span>
      )}
      {example && (
        <span
          style={{
            display: "block",
            marginTop: hint ? -2 : 0,
            marginBottom: 6,
            fontSize: 10,
            lineHeight: 1.45,
            color: "var(--text-4)",
          }}
        >
          <strong style={{ color: "var(--text-3)", fontWeight: 500 }}>
            Example:
          </strong>{" "}
          {example}
        </span>
      )}
      {children}
    </label>
  );
}

export function TextInput({
  value,
  onChange,
  placeholder,
  mono,
  disabled,
  type = "text",
  min,
  max,
}: {
  value: string | number;
  onChange: (value: string) => void;
  placeholder?: string;
  mono?: boolean;
  disabled?: boolean;
  type?: "text" | "number";
  min?: number;
  max?: number;
}) {
  return (
    <input
      value={value}
      onChange={(event) => onChange(event.target.value)}
      placeholder={placeholder}
      disabled={disabled}
      type={type}
      min={min}
      max={max}
      style={{
        width: "100%",
        padding: "7px 9px",
        background: disabled ? "var(--bg-2)" : "var(--panel-2)",
        color: disabled ? "var(--text-3)" : "var(--text)",
        border: "1px solid var(--border-2)",
        borderRadius: 4,
        fontFamily: mono ? "var(--mono)" : "var(--sans)",
        fontSize: 12,
      }}
    />
  );
}

export function TextArea({
  value,
  onChange,
  placeholder,
  rows = 5,
  mono,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  rows?: number;
  mono?: boolean;
  disabled?: boolean;
}) {
  return (
    <textarea
      value={value}
      onChange={(event) => onChange(event.target.value)}
      placeholder={placeholder}
      rows={rows}
      disabled={disabled}
      style={{
        width: "100%",
        padding: "8px 10px",
        background: disabled ? "var(--bg-2)" : "var(--panel-2)",
        color: disabled ? "var(--text-3)" : "var(--text)",
        border: "1px solid var(--border-2)",
        borderRadius: 4,
        resize: "vertical",
        fontFamily: mono ? "var(--mono)" : "var(--sans)",
        fontSize: 12,
        lineHeight: 1.55,
      }}
    />
  );
}

export function SelectInput({
  value,
  onChange,
  options,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string; disabled?: boolean }>;
  disabled?: boolean;
}) {
  return (
    <select
      value={value}
      onChange={(event) => onChange(event.target.value)}
      disabled={disabled}
      style={{
        width: "100%",
        padding: "7px 9px",
        background: "var(--panel-2)",
        color: disabled ? "var(--text-3)" : "var(--text)",
        border: "1px solid var(--border-2)",
        borderRadius: 4,
        fontFamily: "var(--mono)",
        fontSize: 11.5,
      }}
    >
      {options.map((option) => (
        <option
          key={option.value}
          value={option.value}
          disabled={option.disabled}
        >
          {option.label}
        </option>
      ))}
    </select>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  hint,
  disabled,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: ReactNode;
  hint?: ReactNode;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      style={{
        display: "grid",
        gridTemplateColumns: "34px 1fr",
        alignItems: "center",
        gap: 9,
        width: "100%",
        padding: "6px 0",
        textAlign: "left",
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <span
        style={{
          position: "relative",
          width: 32,
          height: 18,
          borderRadius: 10,
          border: `1px solid ${checked ? "var(--signal)" : "var(--border-2)"}`,
          background: checked ? "rgba(208,255,0,0.15)" : "var(--panel-2)",
        }}
      >
        <span
          style={{
            position: "absolute",
            top: 3,
            left: checked ? 17 : 3,
            width: 10,
            height: 10,
            borderRadius: "50%",
            background: checked ? "var(--signal)" : "var(--text-3)",
            transition: "left 0.12s",
          }}
        />
      </span>
      <span>
        <span
          style={{ display: "block", fontSize: 11.5, color: "var(--text)" }}
        >
          {label}
        </span>
        {hint && (
          <span
            style={{
              display: "block",
              marginTop: 2,
              fontSize: 10.5,
              color: "var(--text-3)",
            }}
          >
            {hint}
          </span>
        )}
      </span>
    </button>
  );
}

export function Segmented<T extends string>({
  value,
  onChange,
  options,
  ariaLabel = "Choose an option",
}: {
  value: T;
  onChange: (value: T) => void;
  options: Array<{ value: T; label: string }>;
  ariaLabel?: string;
}) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      style={{
        display: "inline-flex",
        border: "1px solid var(--border-2)",
        borderRadius: 5,
        overflow: "hidden",
      }}
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
          style={{
            padding: "5px 9px",
            background:
              value === option.value ? "var(--panel-3)" : "var(--panel-2)",
            color: value === option.value ? "var(--text)" : "var(--text-3)",
            borderRight: "1px solid var(--border)",
            borderBottom: `2px solid ${value === option.value ? "var(--signal)" : "transparent"}`,
            fontFamily: "var(--mono)",
            fontSize: 10.5,
          }}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function JsonValueEditor({
  value,
  onChange,
  height = 220,
  label = "JSON",
  hint,
  example,
  readOnly = false,
}: {
  value: unknown;
  onChange: (value: unknown) => void;
  height?: number | string;
  label?: string;
  hint?: ReactNode;
  example?: ReactNode;
  readOnly?: boolean;
}) {
  const serialized = toPrettyJson(value);
  const [text, setText] = useState(serialized);
  const [error, setError] = useState<string | null>(null);
  const lastExternal = useRef(serialized);

  useEffect(() => {
    if (serialized === lastExternal.current) return;
    lastExternal.current = serialized;
    setText(serialized);
    setError(null);
  }, [serialized]);

  return (
    <div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 6,
        }}
      >
        <span
          className="mono"
          style={{ fontSize: 10.5, color: "var(--text-3)" }}
        >
          {label}
        </span>
        {error ? (
          <Badge tone="red">JSON error</Badge>
        ) : (
          <Badge tone="green">Valid JSON</Badge>
        )}
      </div>
      {hint && (
        <div
          style={{
            margin: "-1px 0 6px",
            color: "var(--text-3)",
            fontSize: 10.5,
            lineHeight: 1.45,
          }}
        >
          {hint}
        </div>
      )}
      {example && (
        <div
          style={{
            margin: "-2px 0 7px",
            color: "var(--text-4)",
            fontSize: 10,
            lineHeight: 1.45,
          }}
        >
          <strong style={{ color: "var(--text-3)", fontWeight: 500 }}>
            Example:
          </strong>{" "}
          {example}
        </div>
      )}
      <MonacoEditor
        value={text}
        language="json"
        height={height}
        readOnly={readOnly}
        onChange={(next) => {
          setText(next);
          const result = parseLooseJson(next);
          setError(result.error ?? null);
          if (!result.error) onChange(result.value);
        }}
      />
      {error && (
        <div
          className="mono"
          style={{ marginTop: 5, color: "var(--red)", fontSize: 10 }}
        >
          {error}
        </div>
      )}
    </div>
  );
}

export function InlineNotice({
  tone = "default",
  title,
  children,
  action,
}: {
  tone?: "default" | "signal" | "green" | "blue" | "amber" | "red";
  title?: ReactNode;
  children: ReactNode;
  action?: ReactNode;
}) {
  const color =
    tone === "signal"
      ? "var(--signal)"
      : tone === "green"
        ? "var(--green)"
        : tone === "blue"
          ? "var(--blue)"
          : tone === "amber"
            ? "var(--amber)"
            : tone === "red"
              ? "var(--red)"
              : "var(--text-2)";
  return (
    <div
      style={{
        display: "flex",
        gap: 9,
        alignItems: "flex-start",
        padding: "9px 10px",
        background: "var(--panel-2)",
        border: `1px solid color-mix(in srgb, ${color} 30%, var(--border))`,
        borderRadius: 5,
        color: "var(--text-2)",
        fontSize: 11.5,
        lineHeight: 1.5,
      }}
    >
      <Icon
        name={tone === "red" || tone === "amber" ? "alert" : "spark"}
        size={11}
        style={{ color, marginTop: 2 }}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        {title && (
          <div style={{ marginBottom: 2, color, fontWeight: 500 }}>{title}</div>
        )}
        {children}
      </div>
      {action}
    </div>
  );
}

export function EmptySection({
  title,
  hint,
  actionLabel,
  onAction,
}: {
  title: string;
  hint: string;
  actionLabel: string;
  onAction: () => void;
}) {
  return (
    <div
      style={{
        padding: 24,
        border: "1px dashed var(--border-2)",
        borderRadius: 6,
        background: "var(--bg-2)",
        textAlign: "center",
      }}
    >
      <div style={{ fontSize: 13, color: "var(--text)", marginBottom: 4 }}>
        {title}
      </div>
      <div style={{ fontSize: 11.5, color: "var(--text-3)", marginBottom: 12 }}>
        {hint}
      </div>
      <Button small icon="plus" onClick={onAction}>
        {actionLabel}
      </Button>
    </div>
  );
}
