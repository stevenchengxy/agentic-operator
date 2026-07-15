"use client";

import { useState, type FormEvent } from "react";
import type { ApiTokenSecret } from "@agentic/contracts";
import {
  Badge,
  Button,
  CodeBlock,
  Icon,
  ModalOverlay,
  Panel,
  Td,
  Th,
} from "@/app/portal/components";
import { fmtAgo } from "@/lib/format";
import {
  useApiTokens,
  useCreateApiToken,
  useRevokeApiToken,
  useRotateApiToken,
} from "@/lib/hooks/useApiTokens";

type RevealOperation = "created" | "rotated";

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "The request could not be completed.";
}

function ApiTokenRevealModal({
  token,
  operation,
  onClose,
}: {
  token: ApiTokenSecret;
  operation: RevealOperation;
  onClose: () => void;
}) {
  const [acknowledged, setAcknowledged] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);

  async function copyToken() {
    try {
      if (navigator.clipboard) {
        await navigator.clipboard.writeText(token.plaintext);
      } else {
        const textarea = document.createElement("textarea");
        textarea.value = token.plaintext;
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand("copy");
        textarea.remove();
      }
      setCopied(true);
      setCopyFailed(false);
    } catch {
      setCopyFailed(true);
    }
  }

  function dismiss() {
    if (acknowledged) onClose();
  }

  return (
    <ModalOverlay
      onClose={dismiss}
      ariaLabel={`${operation === "created" ? "New" : "Rotated"} API token for ${token.name}`}
    >
      <div
        style={{
          width: 590,
          maxWidth: "92vw",
          background: "var(--panel)",
          border: "1px solid var(--border-2)",
          borderRadius: 8,
          boxShadow: "0 24px 60px rgba(0,0,0,0.6)",
          overflow: "hidden",
        }}
      >
        <header
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "14px 18px",
            borderBottom: "1px solid var(--border)",
          }}
        >
          <div>
            <div
              style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}
            >
              API token {operation}
            </div>
            <div style={{ marginTop: 3, fontSize: 11, color: "var(--text-3)" }}>
              {token.name}
            </div>
          </div>
          <button
            type="button"
            onClick={dismiss}
            disabled={!acknowledged}
            aria-label="Close API token dialog"
            title={
              acknowledged ? "Close" : "Confirm secure storage before closing"
            }
            style={{
              padding: 5,
              border: 0,
              background: "transparent",
              color: "var(--text-3)",
              cursor: acknowledged ? "pointer" : "not-allowed",
              opacity: acknowledged ? 1 : 0.45,
            }}
          >
            <Icon name="x" size={12} />
          </button>
        </header>

        <div style={{ padding: "18px" }}>
          <div
            role="note"
            style={{
              marginBottom: 14,
              padding: "10px 12px",
              border: "1px solid rgba(255,181,71,0.32)",
              borderRadius: 5,
              background: "rgba(255,181,71,0.08)",
              color: "var(--text-2)",
              fontSize: 12,
              lineHeight: 1.55,
            }}
          >
            This is the only time the plaintext token will be shown. Store it in
            a secrets manager now; the server keeps only its hash.
          </div>

          <div
            style={{
              padding: 14,
              border: "1px solid var(--border-2)",
              borderRadius: 5,
              background: "var(--bg)",
            }}
          >
            <div
              className="mono"
              aria-label={revealed ? "API token plaintext" : "API token hidden"}
              style={{
                minHeight: 34,
                padding: "8px 10px",
                borderRadius: 4,
                background: "var(--panel-2)",
                color: "var(--text)",
                fontSize: 12,
                lineHeight: 1.45,
                overflowWrap: "anywhere",
              }}
            >
              {revealed ? token.plaintext : `${token.prefix}${"•".repeat(32)}`}
            </div>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 8,
                marginTop: 10,
              }}
            >
              <div style={{ fontSize: 11, color: "var(--text-3)" }}>
                Scope: {token.scopes.join(", ")}
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                <Button
                  small
                  tone="ghost"
                  onClick={() => setRevealed((value) => !value)}
                >
                  {revealed ? "Hide" : "Reveal"}
                </Button>
                <Button small tone="primary" onClick={() => void copyToken()}>
                  {copied ? "Copied" : "Copy token"}
                </Button>
              </div>
            </div>
            {copyFailed && (
              <div
                role="alert"
                style={{ marginTop: 8, fontSize: 11, color: "var(--red)" }}
              >
                Clipboard access failed. Reveal the token and copy it manually.
              </div>
            )}
          </div>
        </div>

        <footer
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            padding: "12px 18px",
            borderTop: "1px solid var(--border)",
          }}
        >
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 7,
              color: "var(--text-2)",
              fontSize: 12,
              cursor: "pointer",
            }}
          >
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(event) => setAcknowledged(event.target.checked)}
            />
            I have stored this token securely
          </label>
          <Button tone="primary" disabled={!acknowledged} onClick={onClose}>
            Done
          </Button>
        </footer>
      </div>
    </ModalOverlay>
  );
}

export function TokensSection() {
  const tokens = useApiTokens();
  const createToken = useCreateApiToken();
  const rotateToken = useRotateApiToken();
  const revokeToken = useRevokeApiToken();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const [reveal, setReveal] = useState<{
    token: ApiTokenSecret;
    operation: RevealOperation;
  } | null>(null);

  async function submitCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName) return;
    setActionError(null);
    try {
      const created = await createToken.mutateAsync({ name: trimmedName });
      setName("");
      setCreating(false);
      setReveal({ token: created, operation: "created" });
    } catch (error) {
      setActionError(errorMessage(error));
    }
  }

  async function rotate(id: string, label: string) {
    if (
      !window.confirm(
        `Rotate “${label}”? The current token will stop working immediately.`,
      )
    ) {
      return;
    }
    setActionError(null);
    try {
      const rotated = await rotateToken.mutateAsync(id);
      setReveal({ token: rotated, operation: "rotated" });
    } catch (error) {
      setActionError(errorMessage(error));
    }
  }

  async function revoke(id: string, label: string) {
    if (
      !window.confirm(
        `Revoke “${label}”? Services using this token will lose access immediately.`,
      )
    ) {
      return;
    }
    setActionError(null);
    try {
      await revokeToken.mutateAsync(id);
    } catch (error) {
      setActionError(errorMessage(error));
    }
  }

  const rows = tokens.data?.items ?? [];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <Panel
        title="Workspace API tokens"
        subtitle="Use these to call the runtime from CI, scripts, or downstream services."
        padded={false}
        action={
          <Button
            small
            icon={creating ? undefined : "plus"}
            tone={creating ? "ghost" : "primary"}
            disabled={createToken.isPending}
            onClick={() => {
              setActionError(null);
              setCreating((value) => !value);
            }}
          >
            {creating ? "Cancel" : "New token"}
          </Button>
        }
      >
        {creating && (
          <form
            onSubmit={(event) => void submitCreate(event)}
            style={{
              display: "grid",
              gridTemplateColumns: "minmax(180px, 1fr) auto auto",
              alignItems: "end",
              gap: 10,
              padding: 14,
              borderBottom: "1px solid var(--border)",
              background: "var(--panel-2)",
            }}
          >
            <label style={{ display: "flex", flexDirection: "column", gap: 5 }}>
              <span style={{ fontSize: 11, color: "var(--text-2)" }}>
                Token label
              </span>
              <input
                autoFocus
                required
                maxLength={80}
                value={name}
                disabled={createToken.isPending}
                onChange={(event) => setName(event.target.value)}
                placeholder="Production deployment"
                style={{
                  minWidth: 0,
                  padding: "7px 9px",
                  border: "1px solid var(--border-2)",
                  borderRadius: 5,
                  outline: "none",
                  background: "var(--panel)",
                  color: "var(--text)",
                  fontFamily: "var(--sans)",
                  fontSize: 12.5,
                }}
              />
            </label>
            <div style={{ paddingBottom: 6 }}>
              <Badge tone="muted">workspace:all</Badge>
            </div>
            <Button
              type="submit"
              tone="primary"
              disabled={createToken.isPending || !name.trim()}
              style={{ marginBottom: 1 }}
            >
              {createToken.isPending ? "Creating…" : "Create token"}
            </Button>
          </form>
        )}

        {actionError && (
          <div
            role="alert"
            style={{
              margin: "12px 14px 0",
              padding: "8px 10px",
              border: "1px solid rgba(255,100,112,0.34)",
              borderRadius: 5,
              background: "rgba(255,100,112,0.08)",
              color: "var(--red)",
              fontSize: 11.5,
            }}
          >
            {actionError}
          </div>
        )}

        {tokens.isPending ? (
          <div
            role="status"
            style={{ padding: 24, color: "var(--text-3)", fontSize: 12 }}
          >
            Loading API tokens…
          </div>
        ) : tokens.isError ? (
          <div
            role="alert"
            style={{ padding: 24, color: "var(--red)", fontSize: 12 }}
          >
            <div>Could not load API tokens: {errorMessage(tokens.error)}</div>
            <Button
              small
              tone="ghost"
              style={{ marginTop: 8 }}
              onClick={() => void tokens.refetch()}
            >
              Retry
            </Button>
          </div>
        ) : rows.length === 0 ? (
          <div
            style={{
              padding: "28px 20px",
              textAlign: "center",
              color: "var(--text-3)",
              fontSize: 12,
              lineHeight: 1.55,
            }}
          >
            No API tokens yet. Create one for a service, CI job, or local
            script.
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                fontSize: 12.5,
              }}
            >
              <thead>
                <tr style={{ borderBottom: "1px solid var(--border)" }}>
                  <Th>Label</Th>
                  <Th>Token prefix</Th>
                  <Th>Scopes</Th>
                  <Th>Created</Th>
                  <Th>Last used</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {rows.map((token) => {
                  const rotating =
                    rotateToken.isPending && rotateToken.variables === token.id;
                  const revoking =
                    revokeToken.isPending && revokeToken.variables === token.id;
                  return (
                    <tr
                      key={token.id}
                      style={{ borderBottom: "1px solid var(--border)" }}
                    >
                      <Td>
                        <div style={{ color: "var(--text)" }}>{token.name}</div>
                        <div
                          className="mono"
                          style={{ fontSize: 10.5, color: "var(--text-3)" }}
                        >
                          {token.id}
                        </div>
                      </Td>
                      <Td>
                        <span
                          className="mono"
                          style={{ fontSize: 12, color: "var(--text-2)" }}
                        >
                          {token.prefix}
                          <span style={{ color: "var(--text-3)" }}>
                            •••••••••••••
                          </span>
                        </span>
                      </Td>
                      <Td>
                        <div
                          style={{ display: "flex", gap: 4, flexWrap: "wrap" }}
                        >
                          {token.scopes.map((scope) => (
                            <Badge key={scope} tone="muted">
                              {scope}
                            </Badge>
                          ))}
                        </div>
                      </Td>
                      <Td>
                        <span style={{ color: "var(--text-3)" }}>
                          {fmtAgo(token.createdAt)}
                        </span>
                      </Td>
                      <Td>
                        <span style={{ color: "var(--text-2)" }}>
                          {token.lastUsedAt === null
                            ? "Never"
                            : fmtAgo(token.lastUsedAt)}
                        </span>
                      </Td>
                      <Td style={{ textAlign: "right" }}>
                        <div style={{ display: "inline-flex", gap: 4 }}>
                          <Button
                            small
                            tone="ghost"
                            disabled={
                              rotateToken.isPending || revokeToken.isPending
                            }
                            onClick={() => void rotate(token.id, token.name)}
                          >
                            {rotating ? "Rotating…" : "Rotate"}
                          </Button>
                          <Button
                            small
                            tone="danger"
                            disabled={
                              rotateToken.isPending || revokeToken.isPending
                            }
                            onClick={() => void revoke(token.id, token.name)}
                          >
                            {revoking ? "Revoking…" : "Revoke"}
                          </Button>
                        </div>
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel title="API authentication" padded>
        <div
          style={{
            fontSize: 12.5,
            color: "var(--text-2)",
            marginBottom: 10,
            lineHeight: 1.55,
          }}
        >
          Send the token as a bearer credential. Keep it in an environment
          variable or secrets manager rather than source control.
        </div>
        <CodeBlock>{`$ export AGENTIC_API_TOKEN='ao_live_…'
$ curl http://localhost:3501/v1/agents \\
    -H "Authorization: Bearer $AGENTIC_API_TOKEN"`}</CodeBlock>
      </Panel>

      {reveal && (
        <ApiTokenRevealModal
          token={reveal.token}
          operation={reveal.operation}
          onClose={() => setReveal(null)}
        />
      )}
    </div>
  );
}
