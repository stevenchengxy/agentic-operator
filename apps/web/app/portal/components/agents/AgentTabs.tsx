"use client";

/**
 * Read-only tabs in the Agents detail view.
 *
 * Consumes a normalized `ViewAgent` shape constructed only from the live,
 * deployed AgentDetail source snapshot. Missing deployment/source state is
 * explicit and is never converted into an empty manifest.
 */

import {
  Badge,
  Button,
  CodeBlock,
  Empty,
  Icon,
  Panel,
  StatusDot,
  Th,
  Td,
} from "@/app/portal/components";
import { fmtAgo, fmtDur } from "@/lib/format";
import { useI18n } from "@/app/portal/lib/preferences-context";
import { useDeployments, useRollbackDeployment } from "@/lib/hooks/useDeployments";

/**
 * Normalized view of an agent the tabs render. Matches the legacy SpaAgent
 * shape so the heavy code/io/versions tab markup didn't need rewriting.
 */
export interface ViewAgent {
  id: string;
  name: string;
  title: string;
  description: string | null;
  actor: "Agent" | "Human";
  triggers: string[];
  emits: string[];
  steps: string[];
  input_data: Record<string, unknown> | null;
  ontology_instructions: string | null;
  tool_use: Array<{ name: string; [key: string]: unknown }> | null;
  typescript_code: string | null;
  workflowVersion: string | null;
  sourceUnavailable: boolean;
  deployedSource: {
    deploymentId: string;
    deploymentTarget: "workflow" | "agent" | "code_agent";
    deployedAt: string;
    agentVersionId: string;
    workflowVersionId: string;
    storage: "agent_versions.manifest_json";
  } | null;
}

/**
 * Row shape for `RunsTab`. Wider than `AgentDetail.recentRuns` so the live
 * `RunListRow` from `/v1/runs` can be passed directly — only the small set
 * of fields the table renders is required.
 */
export interface RunRow {
  id: string;
  status: string;
  subject: string | null;
  triggerEvent: string | null;
  durationMs: number | null;
  startedAt: string | null;
  testRun?: boolean;
}

// ────────────────────────────────────────────────────────────────────────────

export function ConfigTab({ agent }: { agent: ViewAgent }) {
  const { t } = useI18n();
  if (agent.sourceUnavailable) {
    return (
      <Empty
        title={t("agentTabs.sourceUnavailableTitle")}
        hint={t("agentTabs.sourceUnavailableHint")}
      />
    );
  }
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
      <Panel title={t("agentTabs.manifest")} padded={false}>
        <CodeBlock>
          {JSON.stringify(
            {
              id: agent.id,
              name: agent.name,
              title: agent.title,
              description: agent.description,
              actor: agent.actor,
              triggers: agent.triggers,
              emits: agent.emits,
              steps: agent.steps,
              tool_use: agent.tool_use,
              input_data: agent.input_data,
              ontology_instructions: agent.ontology_instructions,
              typescript_code: agent.typescript_code
                ? `<recorded · ${agent.typescript_code.split("\n").length} lines>`
                : null,
              workflowVersion: agent.workflowVersion,
              deployedSource: agent.deployedSource,
            },
            null,
            2,
          )}
        </CodeBlock>
      </Panel>

      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <Panel title={t("agentTabs.triggers")} padded>
          {agent.triggers.length === 0 ? (
            <span style={{ fontSize: 12, color: "var(--text-3)" }}>{t("agentTabs.manualOperatorInitiated")}</span>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {agent.triggers.map((trig) => (
                <div
                  key={trig}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "6px 8px",
                    background: "var(--panel-2)",
                    border: "1px solid var(--border)",
                    borderRadius: 4,
                  }}
                >
                  <Badge tone="blue">{trig}</Badge>
                  <span
                    style={{
                      marginLeft: "auto",
                      fontSize: 10.5,
                      color: "var(--text-3)",
                      fontFamily: "var(--mono)",
                    }}
                  >
                    ↓ {t("agentTabs.inbound")}
                  </span>
                </div>
              ))}
            </div>
          )}
        </Panel>
        <Panel title={t("agentTabs.emits")} padded>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {agent.emits.map((ev) => (
              <div
                key={ev}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "6px 8px",
                  background: "var(--panel-2)",
                  border: "1px solid var(--border)",
                  borderRadius: 4,
                }}
              >
                <Badge tone="green">{ev}</Badge>
                <span
                  style={{
                    marginLeft: "auto",
                    fontSize: 10.5,
                    color: "var(--text-3)",
                    fontFamily: "var(--mono)",
                  }}
                >
                  ↑ {t("agentTabs.outbound")}
                </span>
              </div>
            ))}
          </div>
        </Panel>
        {agent.tool_use && agent.tool_use.length > 0 && (
          <Panel title={t("agentTabs.toolBindings")} padded>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {agent.tool_use.map((tool) => (
                <div
                  key={tool.name}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "6px 8px",
                    background: "var(--panel-2)",
                    border: "1px solid var(--border)",
                    borderRadius: 4,
                  }}
                >
                  <Icon name="code" size={11} style={{ color: "var(--text-3)" }} />
                  <span className="mono" style={{ fontSize: 11.5, color: "var(--text)" }}>{tool.name}</span>
                  <span
                    style={{
                      marginLeft: "auto",
                      fontSize: 10,
                      color: "var(--text-3)",
                      fontFamily: "var(--mono)",
                    }}
                  >
                    {t("agentTabs.bound")}
                  </span>
                </div>
              ))}
            </div>
          </Panel>
        )}
      </div>
    </div>
  );
}

export function IOConfigTab({ agent }: { agent: ViewAgent }) {
  const { t } = useI18n();
  if (agent.sourceUnavailable) {
    return (
      <Empty
        title={t("agentTabs.sourceUnavailableTitle")}
        hint={t("agentTabs.sourceUnavailableHint")}
      />
    );
  }
  return (
    <Panel title={t("agentTabs.schema")} padded>
      <CodeBlock>
        {JSON.stringify(
          {
            triggers: agent.triggers,
            emits: agent.emits,
            recordedInputData: agent.input_data,
          },
          null,
          2,
        )}
      </CodeBlock>
    </Panel>
  );
}

export function VersionsTab({ agent }: { agent: ViewAgent }) {
  // /v1/deployments returns workflow-level deployments only — there is no
  // per-agent version history endpoint yet. We show the workflow deploys
  // (best correlate) and surface an empty-state when the api hasn't
  // recorded any. The legacy `{ agent: agent.name }` filter is gone —
  // it was a synthetic field from the bootstrap mock that never matched
  // real deploys.
  void agent;
  const { language, t } = useI18n();
  const deploymentsQuery = useDeployments();
  const rollback = useRollbackDeployment();
  const versions = deploymentsQuery.data?.list ?? [];
  return (
    <Panel title={t("agentTabs.versions")} padded={false}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
        <thead>
          <tr style={{ borderBottom: "1px solid var(--border)" }}>
            <Th>{t("agentTabs.colVersion")}</Th>
            <Th>{t("agentTabs.colStatus")}</Th>
            <Th>{t("agentTabs.colDeployedBy")}</Th>
            <Th>{t("agentTabs.colWhen")}</Th>
            <Th>{t("agentTabs.colNotes")}</Th>
            <Th />
          </tr>
        </thead>
        <tbody>
          {deploymentsQuery.isError ? (
            <tr>
              <Td colSpan={6} style={{ padding: 24, textAlign: "center", color: "var(--text-3)" }}>
                {t("agentTabs.loadDeploymentsFailed")} {deploymentsQuery.error?.message ?? t("agentTabs.apiUnreachable")}
              </Td>
            </tr>
          ) : deploymentsQuery.isLoading ? (
            <tr>
              <Td colSpan={6} style={{ padding: 24, textAlign: "center", color: "var(--text-3)" }}>
                {t("agentTabs.loadingDeployments")}
              </Td>
            </tr>
          ) : versions.length === 0 ? (
            <tr>
              <Td colSpan={6} style={{ padding: 24, textAlign: "center", color: "var(--text-3)" }}>
                {t("agentTabs.noDeploymentsYet")}
              </Td>
            </tr>
          ) : (
            versions.map((v) => {
              const at = v.deployedAt ? new Date(v.deployedAt).getTime() : 0;
              return (
                <tr key={v.id} style={{ borderBottom: "1px solid var(--border)" }}>
                  <Td>
                    <span className="mono">{v.versionString}</span>
                  </Td>
                  <Td>
                    {v.status === "live" ? (
                      <Badge tone="signal">{t("agentTabs.statusLive")}</Badge>
                    ) : v.status === "rolled_back" || v.status === "rolled-back" ? (
                      <Badge tone="muted">{t("agentTabs.statusRolledBack")}</Badge>
                    ) : (
                      <Badge tone="muted">{v.status}</Badge>
                    )}
                  </Td>
                  <Td>
                    <span style={{ color: "var(--text-2)" }}>{v.deployedBy ?? "—"}</span>
                  </Td>
                  <Td>
                    <span style={{ color: "var(--text-3)" }}>{at > 0 ? fmtAgo(at, language) : "—"}</span>
                  </Td>
                  <Td>
                    <span style={{ color: "var(--text-2)" }}>{v.note ?? ""}</span>
                  </Td>
                  <Td>
                    {v.status !== "live" && (
                      <Button
                        small
                        tone="ghost"
                        disabled={rollback.isPending}
                        onClick={async () => {
                          if (!window.confirm(t("agentTabs.rollbackConfirm", { version: v.versionString }))) return;
                          try {
                            await rollback.mutateAsync(v.id);
                          } catch (cause) {
                            window.alert(t("agentTabs.rollbackFailed", {
                              error: cause instanceof Error ? cause.message : String(cause),
                            }));
                          }
                        }}
                      >
                        {t("agentTabs.rollback")}
                      </Button>
                    )}
                  </Td>
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </Panel>
  );
}

export function RunsTab({
  runs,
  onOpenRun,
}: {
  runs: RunRow[];
  onOpenRun: (id: string) => void;
}) {
  const { language, t } = useI18n();
  if (runs.length === 0) return <Empty title={t("agentTabs.noRecentRuns")} />;
  const testCount = runs.filter((r) => r.testRun).length;
  return (
    <Panel
      title={t("agentTabs.recentRuns", { count: runs.length })}
      subtitle={testCount > 0 ? t("agentTabs.testCount", { count: testCount }) : undefined}
      padded={false}
    >
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
        <thead>
          <tr>
            <Th />
            <Th>{t("agentTabs.colRun")}</Th>
            <Th>{t("agentTabs.colSubject")}</Th>
            <Th>{t("agentTabs.colTrigger")}</Th>
            <Th>{t("agentTabs.colDuration")}</Th>
            <Th>{t("agentTabs.colWhen")}</Th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => (
            <tr
              key={r.id}
              onClick={() => onOpenRun(r.id)}
              style={{ cursor: "pointer", borderBottom: "1px solid var(--border)" }}
            >
              <Td>
                <StatusDot status={(r.status as never) ?? "idle"} />
              </Td>
              <Td>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span className="mono" style={{ color: "var(--text-2)" }}>{r.id}</span>
                  {r.testRun && <Badge tone="signal" style={{ fontSize: 9 }}>{t("agentTabs.testBadge")}</Badge>}
                </div>
              </Td>
              <Td>
                <span className="mono" style={{ color: "var(--text-2)" }}>{r.subject}</span>
              </Td>
              <Td>
                <Badge tone="muted">{r.triggerEvent}</Badge>
              </Td>
              <Td>
                <span className="mono" style={{ color: "var(--text-2)" }}>{fmtDur(r.durationMs)}</span>
              </Td>
              <Td>
                <span style={{ color: "var(--text-3)" }}>
                  {r.startedAt ? fmtAgo(Date.parse(r.startedAt), language) : "—"}
                </span>
              </Td>
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  );
}
