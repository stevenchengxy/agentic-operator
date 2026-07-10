"use client";

import {
  Badge,
  Button,
  CodeBlock,
  Panel,
  Td,
  Th,
} from "@/app/portal/components";
import { fmtAgo } from "@/lib/format";
import { SETTINGS_KEYS } from "@/app/portal/components/settings/data";
import { useI18n } from "@/app/portal/lib/preferences-context";

export function TokensSection() {
  const { t } = useI18n();
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <Panel
        title={t("tokensSection.workspaceTokensTitle")}
        subtitle={t("tokensSection.workspaceTokensSubtitle")}
        padded={false}
        action={
          <Button small icon="plus" tone="primary">
            {t("tokensSection.newToken")}
          </Button>
        }
      >
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
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
            {SETTINGS_KEYS.map((k) => (
              <tr key={k.id} style={{ borderBottom: "1px solid var(--border)" }}>
                <Td>
                  <div style={{ color: "var(--text)" }}>{k.label}</div>
                  <div style={{ fontSize: 10.5, color: "var(--text-3)" }}>{t("tokensSection.byAuthor", { author: k.author })}</div>
                </Td>
                <Td>
                  <span className="mono" style={{ fontSize: 12, color: "var(--text-2)" }}>
                    {k.prefix}
                    <span style={{ color: "var(--text-4)" }}>•••••••••••••</span>
                  </span>
                </Td>
                <Td>
                  <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                    {k.scopes.map((s) => (
                      <Badge key={s} tone="muted">
                        {s}
                      </Badge>
                    ))}
                  </div>
                </Td>
                <Td>
                  <span style={{ color: "var(--text-3)" }}>{fmtAgo(k.created)}</span>
                </Td>
                <Td>
                  <div style={{ display: "flex", flexDirection: "column" }}>
                    <span style={{ color: "var(--text-2)" }}>{fmtAgo(k.lastUsed)}</span>
                    {k.expiring && (
                      <span style={{ fontSize: 10.5, color: "var(--amber)" }}>
                        {t("tokensSection.expiresInDays", { n: k.expiring })}
                      </span>
                    )}
                  </div>
                </Td>
                <Td style={{ textAlign: "right" }}>
                  <div style={{ display: "inline-flex", gap: 4 }}>
                    <Button small tone="ghost">
                      {t("tokensSection.rotate")}
                    </Button>
                    <Button small tone="ghost">
                      {t("tokensSection.revoke")}
                    </Button>
                  </div>
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>

      <Panel title={t("tokensSection.cliAuthTitle")} padded>
        <div style={{ fontSize: 12.5, color: "var(--text-2)", marginBottom: 10, lineHeight: 1.55 }}>
          {t("tokensSection.cliAuthDescPrefix")} <span className="mono">agentic</span> {t("tokensSection.cliAuthDescSuffix")}
        </div>
        <CodeBlock>{`$ agentic login \\
    --workspace agentic-operator \\
    --region cn-shenzhen-1

→ Visit https://agentic-operator.example.com/cli/auth?code=ABCD1234
→ Returning to terminal…
✓ Token saved to ~/.agentic/credentials (mode 0600)`}</CodeBlock>
      </Panel>
    </div>
  );
}
