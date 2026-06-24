"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Icon } from "@/components";

export function DeployWizard() {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <Button
        tone="primary"
        icon="deploy"
        onClick={() => setOpen(true)}
      >
        Deploy new version
      </Button>
    );
  }
  return (
    <>
      <Button tone="primary" icon="deploy" onClick={() => setOpen(false)}>
        Close wizard
      </Button>
      <WizardPanel onClose={() => setOpen(false)} />
    </>
  );
}

function WizardPanel({ onClose }: { onClose: () => void }) {
  const [method, setMethod] = useState<"manifest" | "code" | "builder">(
    "manifest",
  );
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.55)",
        zIndex: 50,
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        paddingTop: 80,
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(960px, 92vw)",
          background: "var(--panel)",
          border: "1px solid var(--signal)",
          borderRadius: 8,
          overflow: "hidden",
          boxShadow:
            "0 0 0 1px rgba(208,255,0,0.08), 0 12px 32px -16px rgba(208,255,0,0.18)",
        }}
      >
        <header
          style={{
            padding: "12px 16px",
            borderBottom: "1px solid var(--border)",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
            }}
          >
            <Icon
              name="deploy"
              size={14}
              style={{ color: "var(--signal)" }}
            />
            <span
              style={{
                fontSize: 13,
                color: "var(--text)",
                fontWeight: 500,
              }}
            >
              Deploy new version
            </span>
          </div>
          <Button small icon="x" tone="ghost" onClick={onClose} />
        </header>
        <div style={{ padding: 18 }}>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(3, 1fr)",
              gap: 10,
              marginBottom: 16,
            }}
          >
            <MethodCard
              active={method === "manifest"}
              onClick={() => setMethod("manifest")}
              icon="upload"
              title="Manifest upload"
              sub="Drop a workflow.json + actions.json. Best for declarative pipelines."
            />
            <MethodCard
              active={method === "code"}
              onClick={() => setMethod("code")}
              icon="code"
              title="Code package"
              sub="TypeScript module via CLI / git push. Best for custom logic & tools."
            />
            <MethodCard
              active={method === "builder"}
              onClick={() => setMethod("builder")}
              icon="workflow"
              title="Visual builder"
              sub="Drag agents on a canvas, wire events. Best for prototyping & ops."
            />
          </div>
          {method === "manifest" && <ManifestStep onClose={onClose} />}
          {method === "code" && <CodeStep />}
          {method === "builder" && <BuilderStep />}
        </div>
      </div>
    </div>
  );
}

function MethodCard({
  active,
  onClick,
  icon,
  title,
  sub,
}: {
  active: boolean;
  onClick: () => void;
  icon: "upload" | "code" | "workflow";
  title: string;
  sub: string;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: "12px 14px",
        background: active ? "var(--panel-3)" : "var(--panel-2)",
        border: `1px solid ${active ? "var(--signal)" : "var(--border)"}`,
        borderRadius: 6,
        textAlign: "left",
        cursor: "pointer",
        transition: "background 0.12s, border 0.12s",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 4,
        }}
      >
        <Icon
          name={icon}
          size={13}
          style={{ color: active ? "var(--signal)" : "var(--text-2)" }}
        />
        <span
          style={{
            fontSize: 13,
            fontWeight: 500,
            color: "var(--text)",
          }}
        >
          {title}
        </span>
      </div>
      <div
        style={{
          fontSize: 11.5,
          color: "var(--text-3)",
          lineHeight: 1.45,
        }}
      >
        {sub}
      </div>
    </button>
  );
}

function ManifestStep({ onClose }: { onClose: () => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    version?: string;
    diff?: { added: string[]; modified: string[]; removed: string[] };
  } | null>(null);
  const router = useRouter();

  async function upload() {
    setBusy(true);
    setError(null);
    setResult(null);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      setError("manifest is not valid JSON");
      setBusy(false);
      return;
    }
    const body = Array.isArray(parsed)
      ? { manifest: parsed }
      : { ...(parsed as object) };
    try {
      const r = await fetch("/v1/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = await r.json();
      if (!j.ok) setError(j.error?.message ?? "upload failed");
      else {
        setResult(j.data);
        router.refresh();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "network error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "1fr 1fr",
        gap: 12,
      }}
    >
      <div>
        <Lbl>1 · Upload manifest</Lbl>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder='[{"id":"1","name":"...","actor":["Agent"],"trigger":["..."],"actions":[...],"triggered_event":["..."]}]'
          rows={12}
          style={{
            width: "100%",
            background: "var(--bg-2)",
            color: "var(--text)",
            fontFamily: "var(--mono)",
            fontSize: 11,
            border: "1px dashed var(--border-3)",
            borderRadius: 6,
            padding: 12,
            boxSizing: "border-box",
            resize: "vertical",
          }}
        />
        <div
          style={{
            marginTop: 10,
            fontSize: 11.5,
            color: "var(--text-3)",
          }}
        >
          Schema:{" "}
          <span className="mono">
            id, name, actor, trigger[], actions[], triggered_event[]
          </span>
        </div>
      </div>
      <div>
        <Lbl>2 · Result</Lbl>
        <pre
          style={{
            margin: 0,
            padding: 12,
            background: "var(--bg-2)",
            border: "1px solid var(--border)",
            borderRadius: 4,
            fontFamily: "var(--mono)",
            fontSize: 11.5,
            lineHeight: 1.6,
            color: "var(--text-2)",
            minHeight: 220,
            maxHeight: 320,
            overflow: "auto",
          }}
        >
          {result
            ? JSON.stringify(
                {
                  version: result.version,
                  diff_vs_live: result.diff,
                },
                null,
                2,
              )
            : `{
  "version": "<pending>",
  "diff_vs_live": "validate to see"
}`}
        </pre>
        {error && (
          <div
            style={{
              marginTop: 8,
              fontSize: 11.5,
              color: "var(--red)",
            }}
          >
            {error}
          </div>
        )}
        <div style={{ marginTop: 10, display: "flex", gap: 8 }}>
          <Button
            tone="primary"
            icon="deploy"
            onClick={upload}
            disabled={busy || !text.trim()}
          >
            {busy ? "Deploying…" : "Deploy to prod"}
          </Button>
          <Button onClick={onClose}>Cancel</Button>
        </div>
      </div>
    </div>
  );
}

function CodeStep() {
  return (
    <div>
      <Lbl>1 · From your shell</Lbl>
      <Code>{`$ curl -X POST http://localhost:3540/v1/agents \\
    -H "Content-Type: application/json" \\
    -d @workflow.json

✓ Validated 22 agents
✓ Registered with Inngest worker
→ Live in 3.4s`}</Code>
      <div style={{ height: 14 }} />
      <Lbl>2 · Or via the future CLI</Lbl>
      <Code>{`$ agentic deploy raas \\
    --version 2026.05.16-b \\
    --target prod

(post-v1)`}</Code>
    </div>
  );
}

function BuilderStep() {
  return (
    <div
      style={{
        padding: 32,
        textAlign: "center",
        background: "var(--bg-2)",
        border: "1px dashed var(--border-3)",
        borderRadius: 6,
      }}
    >
      <Icon
        name="workflow"
        size={28}
        style={{ color: "var(--text-3)" }}
      />
      <div
        style={{ marginTop: 10, fontSize: 14, color: "var(--text)" }}
      >
        Open visual builder
      </div>
      <div style={{ marginTop: 4, fontSize: 12, color: "var(--text-3)" }}>
        Drag agents from the palette, connect them with events. Save as a
        manifest, then deploy.
      </div>
      <div style={{ marginTop: 14 }}>
        <Button tone="primary" icon="external">
          Open builder →
        </Button>
      </div>
    </div>
  );
}

function Lbl({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: 11,
        fontFamily: "var(--mono)",
        textTransform: "uppercase",
        color: "var(--text-3)",
        letterSpacing: "0.08em",
        marginBottom: 8,
      }}
    >
      {children}
    </div>
  );
}

function Code({ children }: { children: React.ReactNode }) {
  return (
    <pre
      style={{
        margin: 0,
        padding: 12,
        background: "var(--bg-2)",
        border: "1px solid var(--border)",
        borderRadius: 4,
        fontFamily: "var(--mono)",
        fontSize: 11.5,
        lineHeight: 1.6,
        color: "var(--text-2)",
        whiteSpace: "pre",
        overflow: "auto",
        maxHeight: 220,
      }}
    >
      {children}
    </pre>
  );
}
