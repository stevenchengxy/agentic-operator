"use client";

/**
 * Deployments — live workflow pointer, version history, and real rollback.
 *
 * Data path (production-mode wiring):
 *   - `useDeployments()` → `/v1/deployments` (apps/api/src/routes/v1/deployments.ts)
 *     tenant-scoped via the `x-agentic-tenant` header that lib/hooks/tenant-header.ts
 *     injects from `window.location.pathname`. No bootstrap fallback. No mock.
 *   - `useRollbackDeployment()` → `POST /v1/deployments/:id/rollback`.
 *   - `useDag()` → workflow version + agent count for the Live-Workflow card.
 *
 * Loading + error states are explicit per the production-mode rule:
 * "no silent mock fallback when api is unreachable" (apps/web/app/portal/components/shell/chrome.tsx
 * shows the global banner; this view shows a localized Empty/Error state).
 */

import { useMemo } from "react";
import {
  Badge,
  Button,
  Empty,
  Panel,
  ViewHeader,
  Th,
  Td,
  useToast,
} from "@/app/portal/components";
import { fmtAgo } from "@/app/portal/lib/format";
import { useI18n } from "@/app/portal/lib/preferences-context";
import { useTenant } from "@/app/portal/lib/use-tenant";
import {
  useDeployments,
  useRollbackDeployment,
  type DeploymentRow,
} from "@/lib/hooks/useDeployments";

interface DeploymentItem {
  id: string;
  version: string;
  agent: string;
  status: string;
  by: string;
  at: number;
  note: string;
}

function fromApi(d: DeploymentRow): DeploymentItem {
  return {
    id: d.id,
    version: d.versionString,
    agent: d.workflowSlug,
    status: d.status,
    by: d.deployedBy ?? "—",
    at: d.deployedAt ? new Date(d.deployedAt).getTime() : 0,
    note: d.note ?? "",
  };
}

export default function DeploymentsPage() {
  const { language, t } = useI18n();
  const toast = useToast();
  const tenant = useTenant();
  const { data, isLoading, isError, error } = useDeployments();
  const rollback = useRollbackDeployment();
  const dpls = useMemo<DeploymentItem[]>(
    () => (data?.list ?? []).map(fromApi),
    [data?.list],
  );
  const live = data?.live ?? null;
  const liveDeployedAt = live?.deployedAt ? new Date(live.deployedAt).getTime() : 0;

  const onRollback = (deploymentId: string, version: string) => {
    if (!window.confirm(t("deployments.rollbackConfirm", { version }))) return;
    rollback.mutate(deploymentId, {
      onSuccess: (res) =>
        toast({
          tone: "green",
          title: t("deployments.rolledBackToast"),
          description: res.note,
        }),
      onError: (e) =>
        toast({
          tone: "red",
          title: t("deployments.rollbackFailedToast"),
          description: e instanceof Error ? e.message : String(e),
        }),
    });
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <ViewHeader
        title={t("nav.deployments")}
        subtitle={t("deployments.subtitle")}
      />

      <div style={{ flex: 1, overflow: "auto", padding: 20 }}>
        {/* Live versions panel */}
        <Panel
          title={t("deployments.liveVersions")}
          padded={false}
          style={{ marginBottom: 16 }}
        >
          {isLoading && !data ? (
            <Empty title={t("deployments.loadingTitle")} hint="" />
          ) : isError ? (
            <Empty
              title={t("deployments.loadFailedTitle")}
              hint={error instanceof Error ? error.message : t("deployments.loadFailedHint")}
            />
          ) : live ? (
            <LiveCard
              label={t("deployments.cardWorkflow")}
              name={live.workflowSlug}
              version={live.versionString}
              agentCount={live.agentCount}
              deployedBy={live.deployedBy ?? "—"}
              at={liveDeployedAt}
            />
          ) : (
            <Empty title={t("deployments.noLiveTitle")} hint={t("deployments.noLiveHint")} />
          )}
        </Panel>

        <Panel
          title={t("deployments.historyTitle")}
          padded={false}
        >
          {isLoading ? (
            <div style={{ padding: 14 }}>
              <Empty title={t("deployments.loadingTitle")} hint="" />
            </div>
          ) : isError ? (
            <div style={{ padding: 14 }}>
              <Empty
                title={t("deployments.loadFailedTitle")}
                hint={
                  error instanceof Error
                    ? error.message
                    : t("deployments.loadFailedHint")
                }
              />
            </div>
          ) : dpls.length === 0 ? (
            <div style={{ padding: 14 }}>
              <Empty
                title={t("deployments.emptyTitle")}
                hint={t("deployments.emptyHint", { tenant })}
              />
            </div>
          ) : (
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                fontSize: 12.5,
              }}
            >
              <thead>
                <tr
                  style={{
                    borderBottom: "1px solid var(--border)",
                    background: "var(--panel)",
                  }}
                >
                  <Th>{t("deployments.colStatus")}</Th>
                  <Th>{t("deployments.colVersion")}</Th>
                  <Th>{t("deployments.colTarget")}</Th>
                  <Th>{t("deployments.colBy")}</Th>
                  <Th>{t("deployments.colWhen")}</Th>
                  <Th>{t("deployments.colNotes")}</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {dpls.map((d) => (
                  <tr
                    key={d.id}
                    style={{
                      borderBottom: "1px solid var(--border)",
                    }}
                  >
                    <Td>
                      {d.status === "live" ? (
                        <Badge tone="signal">{t("deployments.statusLive")}</Badge>
                      ) : d.status === "rolled_back" || d.status === "rolled-back" ? (
                        <Badge tone="muted">
                          {t("deployments.statusRolledBack")}
                        </Badge>
                      ) : d.status === "pending" ? (
                        <Badge tone="amber">
                          {t("deployments.statusPending")}
                        </Badge>
                      ) : d.status === "superseded" ? (
                        <Badge tone="muted">
                          {t("deployments.statusSuperseded")}
                        </Badge>
                      ) : (
                        <Badge tone="muted">{d.status}</Badge>
                      )}
                    </Td>
                    <Td>
                      <span className="mono">{d.version}</span>
                    </Td>
                    <Td>
                      <span
                        className="mono"
                        style={{ color: "var(--text-2)" }}
                      >
                        {d.agent}
                      </span>
                    </Td>
                    <Td>
                      <span style={{ color: "var(--text-2)" }}>{d.by}</span>
                    </Td>
                    <Td>
                      <span style={{ color: "var(--text-3)" }}>
                        {d.at > 0 ? fmtAgo(d.at, language) : "—"}
                      </span>
                    </Td>
                    <Td>
                      <span style={{ color: "var(--text-2)" }}>{d.note}</span>
                    </Td>
                    <Td>
                      <div
                        style={{
                          display: "flex",
                          gap: 6,
                          justifyContent: "flex-end",
                        }}
                      >
                        {d.status === "rolled_back" ||
                          d.status === "rolled-back" ||
                          d.status === "superseded" ? (
                          <Button
                            small
                            tone="ghost"
                            onClick={() => onRollback(d.id, d.version)}
                            disabled={rollback.isPending}
                          >
                            {rollback.isPending && rollback.variables === d.id
                              ? t("deployments.restoring")
                              : t("deployments.restore")}
                          </Button>
                        ) : <span style={{ color: "var(--text-3)" }}>—</span>}
                      </div>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
      </div>
    </div>
  );
}

function LiveCard({
  label,
  name,
  version,
  agentCount,
  deployedBy,
  at,
}: {
  label: string;
  name: string;
  version: string;
  agentCount: number | null;
  deployedBy: string;
  at: number;
}) {
  const { language, t } = useI18n();
  return (
    <div style={{ padding: "14px 16px", background: "var(--panel)" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          marginBottom: 6,
        }}
      >
        <Badge tone="signal">{t("deployments.statusLive")}</Badge>
        <span
          style={{
            fontSize: 10.5,
            fontFamily: "var(--mono)",
            textTransform: "uppercase",
            color: "var(--text-3)",
            letterSpacing: "0.08em",
          }}
        >
          {label}
        </span>
      </div>
      <div
        style={{
          fontSize: 16,
          fontWeight: 500,
          color: "var(--text)",
          lineHeight: 1.2,
          marginBottom: 2,
        }}
      >
        {name}
      </div>
      <div
        className="mono"
        style={{ fontSize: 12, color: "var(--accent-text)" }}
      >
        {version}
      </div>
      <div
        style={{
          display: "flex",
          gap: 14,
          marginTop: 8,
          fontSize: 11,
          color: "var(--text-3)",
          fontFamily: "var(--mono)",
        }}
      >
        {agentCount != null && (
          <span>{t("deployments.agentCount", { count: agentCount })}</span>
        )}
        <span>{at > 0 ? fmtAgo(at, language) : "—"}</span>
        <span>· {deployedBy}</span>
      </div>
    </div>
  );
}
