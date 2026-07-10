"use client";

/**
 * Deployments — version history + 3-method deploy wizard (P2-FE-14).
 *
 * Ported from `apps/web/public/portal/views/deployments.jsx`. The wizard
 * preserves the lime-tinted box-shadow and three method cards (manifest /
 * code / builder). Live versions card list + history table.
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

import { useMemo, useState } from "react";
import {
  Badge,
  Button,
  Empty,
  Icon,
  Panel,
  ViewHeader,
  CodeBlock,
  Th,
  Td,
  useToast,
} from "@/app/portal/components";
import { fmtAgo } from "@/app/portal/lib/format";
import { useI18n } from "@/app/portal/lib/preferences-context";
import { useTenant } from "@/app/portal/lib/use-tenant";
import { useDag } from "@/lib/hooks/useAgents";
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
  const { t } = useI18n();
  const toast = useToast();
  const tenant = useTenant();
  const dagQuery = useDag();
  const workflowVersion = dagQuery.data?.workflowVersion ?? "";
  const liveAgentCount = dagQuery.data?.agents.length ?? null;

  const { data, isLoading, isError, error } = useDeployments();
  const rollback = useRollbackDeployment();
  const dpls = useMemo<DeploymentItem[]>(
    () => (data?.list ?? []).map(fromApi),
    [data?.list],
  );
  const live = data?.live ?? null;
  const liveDeployedAt = live?.deployedAt ? new Date(live.deployedAt).getTime() : 0;
  const [showWizard, setShowWizard] = useState(false);

  const onRollback = (deploymentId: string) => {
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
        action={
          <Button
            icon="deploy"
            tone="primary"
            onClick={() => setShowWizard(true)}
          >
            {t("deployments.deployNewVersion")}
          </Button>
        }
      />

      <div style={{ flex: 1, overflow: "auto", padding: 20 }}>
        {showWizard && <DeployWizard onClose={() => setShowWizard(false)} />}

        {/* Live versions panel */}
        <Panel
          title={t("deployments.liveVersions")}
          padded={false}
          style={{ marginBottom: 16 }}
        >
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(3, 1fr)",
              gap: 1,
              background: "var(--border)",
            }}
          >
            <LiveCard
              label={t("deployments.cardWorkflow")}
              name={live?.workflowSlug ?? tenant}
              version={live?.versionString ?? workflowVersion ?? "—"}
              agentCount={live?.agentCount ?? liveAgentCount}
              deployedBy={live?.deployedBy ?? "—"}
              at={liveDeployedAt}
            />
            <LiveCard
              label={t("deployments.cardRuntime")}
              name="agentic-operator"
              version={process.env.NEXT_PUBLIC_APP_VERSION ?? "0.6.2"}
              agentCount={null}
              deployedBy="local"
              at={0}
            />
            <LiveCard
              label={t("deployments.cardInngestWorker")}
              name="inngest-dev"
              version="local"
              agentCount={null}
              deployedBy="dev"
              at={0}
            />
          </div>
        </Panel>

        <Panel
          title={t("deployments.historyTitle")}
          padded={false}
          action={
            <Button small icon="filter" tone="ghost">
              {t("deployments.filter")}
            </Button>
          }
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
                        {fmtAgo(d.at)}
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
                        <Button small tone="ghost" icon="external">
                          {t("deployments.diff")}
                        </Button>
                        {d.status === "live" ? (
                          <Button small tone="ghost" disabled>
                            {t("deployments.live")}
                          </Button>
                        ) : d.status === "rolled_back" ||
                          d.status === "rolled-back" ||
                          d.status === "superseded" ? (
                          <Button
                            small
                            tone="ghost"
                            onClick={() => onRollback(d.id)}
                            disabled={rollback.isPending}
                          >
                            {rollback.isPending
                              ? t("deployments.restoring")
                              : t("deployments.restore")}
                          </Button>
                        ) : (
                          <Button small tone="ghost" disabled>
                            {d.status}
                          </Button>
                        )}
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
  const { t } = useI18n();
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
        <span>{fmtAgo(at)}</span>
        <span>· {deployedBy}</span>
      </div>
    </div>
  );
}

function DeployWizard({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const [method, setMethod] = useState<"manifest" | "code" | "builder">(
    "manifest",
  );
  return (
    <div
      style={{
        marginBottom: 16,
        background: "var(--panel)",
        border: "1px solid var(--signal)",
        borderRadius: 8,
        overflow: "hidden",
        boxShadow:
          "0 0 0 1px color-mix(in srgb, var(--signal) 8%, transparent), 0 12px 32px -16px color-mix(in srgb, var(--signal) 18%, transparent)",
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
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Icon
            name="deploy"
            size={14}
            style={{ color: "var(--accent-text)" }}
          />
          <span
            style={{
              fontSize: 13,
              color: "var(--text)",
              fontWeight: 500,
            }}
          >
            {t("deployments.deployNewVersion")}
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
            title={t("deployments.methodManifestTitle")}
            sub={t("deployments.methodManifestSub")}
          />
          <MethodCard
            active={method === "code"}
            onClick={() => setMethod("code")}
            icon="code"
            title={t("deployments.methodCodeTitle")}
            sub={t("deployments.methodCodeSub")}
          />
          <MethodCard
            active={method === "builder"}
            onClick={() => setMethod("builder")}
            icon="workflow"
            title={t("deployments.methodBuilderTitle")}
            sub={t("deployments.methodBuilderSub")}
          />
        </div>

        {method === "manifest" && <ManifestStep />}
        {method === "code" && <CodeStep />}
        {method === "builder" && <BuilderStep />}
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
          style={{ color: active ? "var(--accent-text)" : "var(--text-2)" }}
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

function ManifestStep() {
  const { t } = useI18n();
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "1fr 1fr",
        gap: 12,
      }}
    >
      <div>
        <StepLabel>{t("deployments.manifestStep1")}</StepLabel>
        <div
          style={{
            padding: 24,
            textAlign: "center",
            background: "var(--bg-2)",
            border: "1px dashed var(--border-3)",
            borderRadius: 6,
          }}
        >
          <Icon
            name="upload"
            size={20}
            style={{ color: "var(--text-3)" }}
          />
          <div
            style={{
              marginTop: 8,
              fontSize: 12.5,
              color: "var(--text-2)",
            }}
          >
            {t("deployments.dropPrefix")}{" "}
            <span className="mono">workflow.json</span>{" "}
            {t("deployments.dropAnd")}{" "}
            <span className="mono">actions.json</span>
          </div>
          <div
            style={{
              marginTop: 4,
              fontSize: 11,
              color: "var(--text-3)",
            }}
          >
            {t("deployments.or")}{" "}
            <span style={{ color: "var(--accent-text)", cursor: "pointer" }}>
              {t("deployments.browseFiles")}
            </span>
          </div>
        </div>
        <div
          style={{
            marginTop: 10,
            fontSize: 11.5,
            color: "var(--text-3)",
          }}
        >
          {t("deployments.schemaNote")}{" "}
          <span className="mono">
            id, name, actor, trigger[], actions[], triggered_event[]
          </span>
          .
        </div>
      </div>
      <div>
        <StepLabel>{t("deployments.manifestStep2")}</StepLabel>
        <CodeBlock>{`{
  "version": "raas@2026.05.16-b",
  "agents": 22,           // 18 agent · 4 human
  "events": 33,
  "diff_vs_live": {
    "added": ["enrichCandidateLinkedIn"],
    "modified": ["matchResume", "createJD"],
    "removed": []
  }
}`}</CodeBlock>
        <div style={{ marginTop: 10, display: "flex", gap: 8 }}>
          <Button tone="primary" icon="deploy">
            {t("deployments.deployToProd")}
          </Button>
          <Button>{t("deployments.deployToStaging")}</Button>
        </div>
      </div>
    </div>
  );
}

function CodeStep() {
  const { t } = useI18n();
  return (
    <div>
      <StepLabel>{t("deployments.codeStep1")}</StepLabel>
      <CodeBlock>{`$ npx agentic deploy raas \\
    --version 2026.05.16-b \\
    --target prod

✓ Bundled 22 agents (4 changed)
✓ Compiled handlers (TypeScript 5.6, Node 22)
✓ Uploaded to /var/agentic/deploys/raas/2026.05.16-b/
✓ Registered with Inngest worker · 1842 active runs migrated
→ Live in 3.4s`}</CodeBlock>
      <div style={{ marginTop: 12 }}>
        <StepLabel>{t("deployments.codeStep2")}</StepLabel>
      </div>
      <CodeBlock>{`$ git push agentic main:raas/prod

remote: building...
remote: ✓ agents validated
remote: ✓ workflow graph: 0 cycles, 0 orphans
remote: → deploying as 2026.05.16-b`}</CodeBlock>
    </div>
  );
}

function BuilderStep() {
  const { t } = useI18n();
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
        style={{
          marginTop: 10,
          fontSize: 14,
          color: "var(--text)",
        }}
      >
        {t("deployments.openVisualBuilder")}
      </div>
      <div
        style={{
          marginTop: 4,
          fontSize: 12,
          color: "var(--text-3)",
        }}
      >
        {t("deployments.builderDesc")}
      </div>
      <div style={{ marginTop: 14 }}>
        <Button tone="primary" icon="external">
          {t("deployments.openBuilder")}
        </Button>
      </div>
    </div>
  );
}

function StepLabel({ children }: { children: React.ReactNode }) {
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
