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
import { useI18n, type Translate } from "@/app/portal/lib/preferences-context";
import { fmtAgo } from "@/lib/format";
import {
  useApiTokens,
  useCreateApiToken,
  useRevokeApiToken,
  useRotateApiToken,
} from "@/lib/hooks/useApiTokens";

type RevealOperation = "created" | "rotated";

function errorMessage(error: unknown, t: Translate): string {
  return error instanceof Error
    ? error.message
    : t("tokensSection.requestFailed");
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
  const { t } = useI18n();
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
      ariaLabel={t(`tokensSection.reveal.${operation === "created" ? "ariaCreated" : "ariaRotated"}`, { name: token.name })}
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
              {t(`tokensSection.reveal.${operation === "created" ? "titleCreated" : "titleRotated"}`)}
            </div>
            <div style={{ marginTop: 3, fontSize: 11, color: "var(--text-3)" }}>
              {token.name}
            </div>
          </div>
          <button
            type="button"
            onClick={dismiss}
            disabled={!acknowledged}
            aria-label={t("tokensSection.reveal.closeAria")}
            title={
              acknowledged ? t("tokensSection.reveal.close") : t("tokensSection.reveal.confirmBeforeClose")
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
            {t("tokensSection.reveal.warning")}
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
              aria-label={revealed ? t("tokensSection.reveal.plaintextAria") : t("tokensSection.reveal.hiddenAria")}
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
                {t("tokensSection.reveal.scope", { scopes: token.scopes.join(", ") })}
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                <Button
                  small
                  tone="ghost"
                  onClick={() => setRevealed((value) => !value)}
                >
                  {revealed ? t("tokensSection.reveal.hide") : t("tokensSection.reveal.show")}
                </Button>
                <Button small tone="primary" onClick={() => void copyToken()}>
                  {copied ? t("tokensSection.reveal.copied") : t("tokensSection.reveal.copy")}
                </Button>
              </div>
            </div>
            {copyFailed && (
              <div
                role="alert"
                style={{ marginTop: 8, fontSize: 11, color: "var(--red)" }}
              >
                {t("tokensSection.reveal.copyFailed")}
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
            {t("tokensSection.reveal.acknowledged")}
          </label>
          <Button tone="primary" disabled={!acknowledged} onClick={onClose}>
            {t("tokensSection.reveal.done")}
          </Button>
        </footer>
      </div>
    </ModalOverlay>
  );
}

export function TokensSection() {
  const { language, t } = useI18n();
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
      setActionError(errorMessage(error, t));
    }
  }

  async function rotate(id: string, label: string) {
    if (
      !window.confirm(
        t("tokensSection.rotateConfirm", { label }),
      )
    ) {
      return;
    }
    setActionError(null);
    try {
      const rotated = await rotateToken.mutateAsync(id);
      setReveal({ token: rotated, operation: "rotated" });
    } catch (error) {
      setActionError(errorMessage(error, t));
    }
  }

  async function revoke(id: string, label: string) {
    if (
      !window.confirm(
        t("tokensSection.revokeConfirm", { label }),
      )
    ) {
      return;
    }
    setActionError(null);
    try {
      await revokeToken.mutateAsync(id);
    } catch (error) {
      setActionError(errorMessage(error, t));
    }
  }

  const rows = tokens.data?.items ?? [];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <Panel
        title={t("tokensSection.workspaceTokensTitle")}
        subtitle={t("tokensSection.workspaceTokensSubtitle")}
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
            {creating ? t("tokensSection.cancel") : t("tokensSection.newToken")}
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
                {t("tokensSection.tokenLabel")}
              </span>
              <input
                autoFocus
                required
                maxLength={80}
                value={name}
                disabled={createToken.isPending}
                onChange={(event) => setName(event.target.value)}
                placeholder={t("tokensSection.tokenLabelPlaceholder")}
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
              {createToken.isPending ? t("tokensSection.creating") : t("tokensSection.createToken")}
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
            {t("tokensSection.loading")}
          </div>
        ) : tokens.isError ? (
          <div
            role="alert"
            style={{ padding: 24, color: "var(--red)", fontSize: 12 }}
          >
            <div>{t("tokensSection.loadFailed", { message: errorMessage(tokens.error, t) })}</div>
            <Button
              small
              tone="ghost"
              style={{ marginTop: 8 }}
              onClick={() => void tokens.refetch()}
            >
              {t("tokensSection.retry")}
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
            {t("tokensSection.empty")}
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
                  <Th>{t("tokensSection.colLabel")}</Th>
                  <Th>{t("tokensSection.colTokenPrefix")}</Th>
                  <Th>{t("tokensSection.colScopes")}</Th>
                  <Th>{t("tokensSection.colCreated")}</Th>
                  <Th>{t("tokensSection.colLastUsed")}</Th>
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
                          {fmtAgo(token.createdAt, language)}
                        </span>
                      </Td>
                      <Td>
                        <span style={{ color: "var(--text-2)" }}>
                          {token.lastUsedAt === null
                            ? t("tokensSection.never")
                            : fmtAgo(token.lastUsedAt, language)}
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
                            {rotating ? t("tokensSection.rotating") : t("tokensSection.rotate")}
                          </Button>
                          <Button
                            small
                            tone="danger"
                            disabled={
                              rotateToken.isPending || revokeToken.isPending
                            }
                            onClick={() => void revoke(token.id, token.name)}
                          >
                            {revoking ? t("tokensSection.revoking") : t("tokensSection.revoke")}
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

      <Panel title={t("tokensSection.apiAuthTitle")} padded>
        <div
          style={{
            fontSize: 12.5,
            color: "var(--text-2)",
            marginBottom: 10,
            lineHeight: 1.55,
          }}
        >
          {t("tokensSection.apiAuthDescription")}
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
