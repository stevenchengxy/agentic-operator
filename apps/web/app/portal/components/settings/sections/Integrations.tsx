"use client";

/**
 * Settings → Integrations — configure external services this workspace can
 * reach (first provider: the GoHire ATS). Wires to the real
 * `/v1/integrations` surface: list configured integrations, add/edit one
 * (base URL + API key), test the connection, and remove one.
 *
 * The API key is write-only — it's sent on save and never returned, so the
 * key field shows a masked fragment + "leave blank to keep" when editing an
 * integration that already has a key stored.
 */

import { useMemo, useState } from "react";
import { Button, Icon, Panel } from "@/app/portal/components";
import { Field, StatusPill, TextIn } from "@/app/portal/components/settings/atoms";
import {
  useDeleteIntegration,
  useIntegrations,
  useTestIntegration,
  useUpsertIntegration,
  type AvailableIntegration,
  type Integration,
  type IntegrationStatus,
} from "@/lib/hooks/useIntegrations";

function pillStatus(s: IntegrationStatus): "ok" | "warn" | "err" | "off" {
  if (s === "ok") return "ok";
  if (s === "error") return "err";
  return "off";
}

interface EditorState {
  provider: string;
  isNew: boolean;
  name: string;
  baseUrl: string;
  apiKey: string;
  /** True when the row being edited already has a key stored. */
  hadKey: boolean;
}

export function IntegrationsSection() {
  const q = useIntegrations();
  const upsert = useUpsertIntegration();
  const del = useDeleteIntegration();
  const test = useTestIntegration();
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [error, setError] = useState<string | null>(null);

  const integrations = q.data?.integrations ?? [];
  const available = q.data?.available ?? [];

  // Providers from the catalog that aren't configured yet — the "Add" picker.
  const addable = useMemo(
    () => available.filter((a) => !integrations.some((i) => i.provider === a.id)),
    [available, integrations],
  );

  function openNew(provider: AvailableIntegration) {
    setError(null);
    setEditor({
      provider: provider.id,
      isNew: true,
      name: provider.name,
      baseUrl: provider.defaultBaseUrl,
      apiKey: "",
      hadKey: false,
    });
  }

  function openEdit(row: Integration) {
    setError(null);
    setEditor({
      provider: row.provider,
      isNew: false,
      name: row.name,
      baseUrl: row.baseUrl ?? "",
      apiKey: "",
      hadKey: row.hasKey,
    });
  }

  async function save() {
    if (!editor) return;
    setError(null);
    try {
      await upsert.mutateAsync({
        provider: editor.provider,
        name: editor.name || undefined,
        baseUrl: editor.baseUrl.trim() || undefined,
        // Only send the key when the operator typed one — blank means "keep".
        apiKey: editor.apiKey.length > 0 ? editor.apiKey : undefined,
      });
      setEditor(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function remove(provider: string, name: string) {
    if (!confirm(`Remove the ${name} integration? Agents using it will lose access.`)) return;
    setError(null);
    try {
      await del.mutateAsync(provider);
      if (editor?.provider === provider) setEditor(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function runTest(provider: string) {
    setError(null);
    try {
      const r = await test.mutateAsync(provider);
      if (!r.ok) setError(`Connection test failed: ${r.message ?? "unknown error"}`);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      {error && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "9px 12px",
            background: "rgba(255,107,107,0.08)",
            border: "1px solid rgba(255,107,107,0.3)",
            borderRadius: 5,
            fontSize: 12,
            color: "var(--text-2)",
          }}
        >
          <Icon name="alert" size={12} style={{ color: "var(--red)" }} />
          {error}
        </div>
      )}

      <Panel
        title={`Integrations · ${integrations.length}`}
        subtitle="External systems this workspace can reach. API keys are encrypted at rest."
        padded={false}
        action={
          addable.length > 0 ? (
            <Button
              small
              icon="plus"
              tone="primary"
              onClick={() => openNew(addable[0]!)}
              disabled={!!editor}
            >
              {addable.length === 1 ? `Add ${addable[0]!.name}` : "New integration"}
            </Button>
          ) : undefined
        }
      >
        {q.isLoading && (
          <div style={{ padding: 16, fontSize: 12.5, color: "var(--text-3)" }}>
            Loading integrations…
          </div>
        )}
        {q.isError && (
          <div style={{ padding: 16, fontSize: 12.5, color: "var(--red)" }}>
            Couldn’t reach the API. Integrations are unavailable.
          </div>
        )}
        {!q.isLoading && !q.isError && integrations.length === 0 && (
          <div style={{ padding: 16, fontSize: 12.5, color: "var(--text-3)" }}>
            No integrations configured yet.
            {addable.length > 0 && ` Add ${addable[0]!.name} to get started.`}
          </div>
        )}

        {integrations.map((i, idx) => (
          <div
            key={i.id}
            style={{
              display: "grid",
              gridTemplateColumns: "32px 1fr 220px 150px 84px",
              alignItems: "center",
              gap: 14,
              padding: "12px 14px",
              borderBottom:
                idx < integrations.length - 1 ? "1px solid var(--border)" : "none",
            }}
          >
            <div
              style={{
                width: 28,
                height: 28,
                borderRadius: 4,
                background: "var(--panel-2)",
                border: "1px solid var(--border-2)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Icon name="external" size={12} style={{ color: "var(--text-3)" }} />
            </div>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 13, color: "var(--text)" }}>{i.name}</div>
              <div
                style={{
                  fontSize: 11,
                  color: "var(--text-3)",
                  fontFamily: "var(--mono)",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {i.baseUrl ?? "no base URL"} · {i.hasKey ? (i.keyMasked ?? "key set") : "no key"}
              </div>
            </div>
            <div style={{ fontSize: 11.5, color: "var(--text-2)" }}>
              {i.lastError && i.status === "error" ? (
                <span style={{ color: "var(--red)" }}>{i.lastError}</span>
              ) : i.lastCheckedAt ? (
                `Checked ${new Date(i.lastCheckedAt).toLocaleString()}`
              ) : (
                "Not tested yet"
              )}
            </div>
            <div>
              <StatusPill status={pillStatus(i.status)} />
            </div>
            <div style={{ display: "flex", gap: 4, justifyContent: "flex-end" }}>
              <Button
                small
                tone="ghost"
                onClick={() => runTest(i.provider)}
                disabled={test.isPending || !i.hasKey}
                title={i.hasKey ? "Test connection" : "Add an API key first"}
              >
                {test.isPending && test.variables === i.provider ? "Testing…" : "Test"}
              </Button>
              <Button small tone="ghost" onClick={() => openEdit(i)} disabled={!!editor}>
                <Icon name="settings" size={10} />
              </Button>
              <Button small tone="ghost" onClick={() => remove(i.provider, i.name)} disabled={del.isPending}>
                <Icon name="x" size={10} />
              </Button>
            </div>
          </div>
        ))}
      </Panel>

      {editor && (
        <Panel
          title={`${editor.isNew ? "Add" : "Configure"} ${editor.name}`}
          subtitle={
            available.find((a) => a.id === editor.provider)?.description ??
            "Configure the base URL and API key."
          }
          padded
        >
          <div style={{ display: "flex", flexDirection: "column" }}>
            <Field label="Base URL" hint="The provider's API root. Falls back to the env/default when blank.">
              <TextIn
                value={editor.baseUrl}
                onChange={(v) => setEditor({ ...editor, baseUrl: v })}
                placeholder="https://api.gohire.io/v1"
                mono
                ariaLabel="Base URL"
              />
            </Field>
            <Field
              label="API key"
              hint={
                editor.hadKey
                  ? "A key is stored (encrypted). Leave blank to keep it; type a new one to replace."
                  : "Stored encrypted at rest; never shown again after saving."
              }
            >
              <TextIn
                value={editor.apiKey}
                onChange={(v) => setEditor({ ...editor, apiKey: v })}
                placeholder={editor.hadKey ? "•••••••• (leave blank to keep)" : "Paste the API key from GoHire"}
                mono
                ariaLabel="API key"
              />
            </Field>
            <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
              <Button tone="primary" small onClick={save} disabled={upsert.isPending}>
                {upsert.isPending ? "Saving…" : "Save"}
              </Button>
              <Button tone="ghost" small onClick={() => setEditor(null)} disabled={upsert.isPending}>
                Cancel
              </Button>
              {!editor.isNew && (
                <Button
                  tone="ghost"
                  small
                  onClick={() => runTest(editor.provider)}
                  disabled={test.isPending}
                >
                  {test.isPending ? "Testing…" : "Test connection"}
                </Button>
              )}
            </div>
          </div>
        </Panel>
      )}
    </div>
  );
}
