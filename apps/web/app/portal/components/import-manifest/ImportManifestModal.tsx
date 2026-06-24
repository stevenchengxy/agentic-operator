"use client";

/**
 * ImportManifestModal — 6-step wizard for importing a workflow.json +
 * actions.json manifest pair. Shared by Workflows ("Import manifest") and
 * Agents ("Import manifest"). P2-FE-17.
 *
 * Steps: source → validate → diff → resolve → preview → deploy
 *
 * Ported from `agentic-operator_v1_1/views/import-manifest.jsx` (809 LOC).
 * Wired end-to-end against `POST /v1/tenants/:slug/manifest-import` (modes
 * validate | commit) and `POST /…/fetch-url`. 423 (pending lock), 409
 * (overwrite required) and 200 envelopes are all handled. The 1132-line
 * UI shape was preserved — only `startValidation` + a new `runCommit` were
 * added.
 */

import { useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type {
  ManifestImportOverwriteRequired,
  ManifestImportPreview,
} from "@agentic/contracts";
import {
  Badge,
  Button,
  CodeBlock,
  Icon,
  ModalOverlay,
  MonacoEditor,
  Panel,
  Stat,
  type IconName,
} from "@/app/portal/components";
import { fmtBytes } from "@/lib/format";
import { useDag, type DagAgent } from "@/lib/hooks/useAgents";
import { tenantHeader } from "@/lib/hooks/tenant-header";
import { useTenant } from "@/app/portal/lib/use-tenant";
import { toast } from "@/app/portal/components/toast";
import { useI18n } from "@/app/portal/lib/preferences-context";
import { OverwriteConfirmModal } from "./OverwriteConfirmModal";

/**
 * Unwrap the standard apps/api envelope. 200 responses are
 * `{ ok: true, data: <T> }`. 423 / 409 are flat (not enveloped). This
 * helper returns the inner shape on the happy envelope and the raw body
 * otherwise — callers that branch on status code receive what they
 * expect from the design doc.
 */
function unwrapEnvelope<T = unknown>(body: unknown): T {
  if (
    body &&
    typeof body === "object" &&
    (body as { ok?: boolean }).ok === true &&
    "data" in (body as object)
  ) {
    return (body as { data: T }).data;
  }
  return body as T;
}

interface ConflictResolution {
  path: string;
  action: "accept_suggestion" | "skip" | "override";
  override_value?: unknown;
}

const IMPORT_STEPS = [
  { id: "source", label: "Source", icon: "upload" as IconName, hint: "Where the manifest comes from" },
  { id: "validate", label: "Validate", icon: "check" as IconName, hint: "Parse + schema lint" },
  { id: "diff", label: "Diff", icon: "git" as IconName, hint: "vs live workflow" },
  { id: "resolve", label: "Resolve", icon: "alert" as IconName, hint: "Conflicts & gaps" },
  { id: "preview", label: "Preview", icon: "workflow" as IconName, hint: "Imported graph" },
  { id: "deploy", label: "Deploy", icon: "deploy" as IconName, hint: "Stage / prod" },
];

// Static workflow ontology labels — mirrors the dashboard funnel so the
// preview mini-graph reads naturally for RAAS-style staged pipelines.
const STAGE_LABELS: Record<number, string> = {
  0: "Intake",
  1: "Analyze",
  2: "JD",
  3: "Publish",
  4: "Resume",
  5: "Match & Interview",
  6: "Package",
  7: "Submit",
};

/**
 * UI-side projection of the real `ManifestImportPreview` from the api. The
 * wizard reads this object across every step — it carries the original
 * preview body so the commit phase can call back with `deployment_id` /
 * `conflict_resolutions` without re-fetching.
 */
export interface ParsedManifest {
  workflow: {
    id: string;
    name: string;
    version: string;
    agent_count: number;
    event_count: number;
    stages: number;
  };
  cycles: number;
  orphans: number;
  issues: Array<{ level: "err" | "warn" | "info"; msg: string }>;
  diff: {
    added: Array<{ id: string; name: string; reason: string }>;
    modified: Array<{ id: string; name: string; was?: string; changes: string[] }>;
    removed: Array<{ id: string; name: string }>;
  };
  conflicts: Array<{ kind: string; name: string; agent: string; note: string; resolved: string }>;
  /** Pending-deployment session id — required by `commit`. */
  deployment_id: string;
  /** Raw preview from the api (used by the commit body + overwrite modal). */
  raw: ManifestImportPreview;
}

/**
 * Map the api `ManifestImportPreview` onto the UI's `ParsedManifest`. The
 * preview returns id-only arrays for diff and a richer `Conflict` shape;
 * we synthesize the labels the wizard already renders so we don't have to
 * rebuild the 1132-line UI.
 */
function previewToParsed(
  preview: ManifestImportPreview,
): ParsedManifest {
  const errs = preview.issues.filter((i) => i.severity === "error");
  // The preview returns id-only diff entries (strings). The wizard renders
  // {id, name, reason} — we use the id as both because the api doesn't
  // round-trip the display name in the preview shape (yet).
  return {
    workflow: {
      id: preview.workflow_version_id ?? "imported",
      name: preview.prior.version ?? "imported",
      version: preview.workflow_version_id ?? "(pending)",
      agent_count: preview.parsed.agents,
      event_count: preview.parsed.events,
      stages: 0,
    },
    // No graph cycle detection result is shipped; treat any error-severity
    // issue as a "block deploy" signal by leaving cycles=0 when clean.
    cycles: errs.length > 0 ? errs.length : 0,
    orphans: 0,
    issues: preview.issues.map((iss) => ({
      level:
        iss.severity === "error"
          ? "err"
          : iss.severity === "warning"
            ? "warn"
            : "info",
      msg: iss.message,
    })),
    diff: {
      added: preview.diff.added.map((id) => ({
        id,
        name: id,
        reason: "added by manifest",
      })),
      modified: preview.diff.modified.map((id) => ({
        id,
        name: id,
        changes: ["modified by manifest"],
      })),
      removed: preview.diff.removed.map((id) => ({
        id,
        name: id,
      })),
    },
    conflicts: preview.conflicts.map((c) => ({
      kind: c.type,
      name: c.path,
      agent: c.path,
      note: c.detail ?? c.type,
      resolved: c.auto_fix ? "accept_suggestion" : "skip",
    })),
    deployment_id: preview.deployment_id,
    raw: preview,
  };
}

interface FileEntry {
  name: string;
  size: number;
  ok: boolean;
}

export interface ImportManifestModalProps {
  onClose: () => void;
  mode?: "workflow" | "agent";
  /**
   * Override the active tenant slug for the manifest-import calls. Used by
   * the "+ New tenant" path in `TenantSwitcher`, which fires this modal
   * before the URL has been switched to the freshly created tenant.
   */
  tenantSlug?: string;
}

export function ImportManifestModal({
  onClose,
  mode = "workflow",
  tenantSlug,
}: ImportManifestModalProps) {
  const { t } = useI18n();
  // Fallback to the tenant in the URL when the caller didn't override.
  const urlTenant = useTenant();
  const slug = tenantSlug ?? urlTenant;
  const queryClient = useQueryClient();
  // After a successful commit, invalidate every query whose data the new
  // manifest touches so the Workflows canvas, Agents list, and DAG
  // reload without a hard refresh.
  const refetchManifestDependents = () => {
    void queryClient.invalidateQueries({ queryKey: ["agents"] as const });
    void queryClient.invalidateQueries({ queryKey: ["workflows"] as const });
    void queryClient.invalidateQueries({ queryKey: ["events"] as const });
    void queryClient.invalidateQueries({ queryKey: ["deployments"] as const });
  };

  const [step, setStep] = useState(0);
  const [source, setSource] = useState<"file" | "paste" | "url" | "git">("file");
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [pasted, setPasted] = useState("");
  const [url, setUrl] = useState("");
  const [validating, setValidating] = useState(false);
  const [parsed, setParsed] = useState<ParsedManifest | null>(null);
  const [resolution, setResolution] = useState<{ model: string }>({ model: "fallback" });
  const [deployTarget, setDeployTarget] = useState({ staging: true, prod: false });
  const [autoRollback, setAutoRollback] = useState(true);
  // Raw manifest pair held between source-step parsing and the commit body.
  const [workflowRaw, setWorkflowRaw] = useState<unknown>(null);
  const [actionsRaw, setActionsRaw] = useState<unknown[] | null>(null);
  // Note + commit lifecycle.
  const [noteText, setNoteText] = useState("");
  const [committing, setCommitting] = useState(false);
  const [commitError, setCommitError] = useState<string | null>(null);
  // Specific issues returned by a blocking_issues commit response — the api
  // ships these alongside the top-level error so the operator can see WHICH
  // agents need attention instead of the bare "commit refused" line.
  const [commitIssues, setCommitIssues] = useState<
    Array<{ path: string; message: string; severity: string; code: string }>
  >([]);
  const [overwriteRequired, setOverwriteRequired] =
    useState<ManifestImportOverwriteRequired | null>(null);
  // Validate-step error surface (replaces the silent mock).
  const [validationError, setValidationError] = useState<string | null>(null);
  // 423 LOCKED: another wizard owns the pending lock.
  const [pendingLock, setPendingLock] = useState<{
    locked_by?: string;
    expires_at?: number;
  } | null>(null);
  const dropRef = useRef<HTMLDivElement | null>(null);

  const canAdvance = useMemo(() => {
    if (step === 0) {
      if (source === "file") return files.length > 0;
      if (source === "paste") return pasted.trim().length > 0;
      if (source === "url") return /^https?:\/\//.test(url) || /^git@/.test(url);
      if (source === "git") return true;
    }
    if (step === 1) return !!parsed && parsed.cycles === 0;
    return true;
  }, [step, source, files, pasted, url, parsed]);

  /**
   * Gather the manifest pair from whichever source the operator picked,
   * then call `POST /v1/tenants/:slug/manifest-import` with `mode:
   * "validate"`. Mirrors the legacy SPA's `startValidation` flow.
   */
  async function startValidation() {
    setValidationError(null);
    setPendingLock(null);
    setParsed(null);

    let nextWorkflow: unknown = null;
    let nextActions: unknown[] | null = null;

    // Build manifest from whichever source step the operator chose.
    if (source === "paste") {
      const trimmed = pasted.trim();
      if (!trimmed) {
        setValidationError(t("importManifestModal.errPasteFirst"));
        return;
      }
      let parsedPaste: unknown;
      try {
        parsedPaste = JSON.parse(trimmed);
      } catch (e) {
        setValidationError(
          `${t("importManifestModal.errInvalidJson")}: ${e instanceof Error ? e.message : t("importManifestModal.errParseError")}`,
        );
        return;
      }
      if (
        parsedPaste &&
        typeof parsedPaste === "object" &&
        !Array.isArray(parsedPaste) &&
        "workflow" in parsedPaste
      ) {
        const bundle = parsedPaste as { workflow: unknown; actions?: unknown };
        nextWorkflow = bundle.workflow;
        nextActions = Array.isArray(bundle.actions)
          ? (bundle.actions as unknown[])
          : null;
      } else {
        nextWorkflow = parsedPaste;
      }
    } else if (source === "url") {
      try {
        const res = await fetch(
          `/v1/tenants/${encodeURIComponent(slug)}/manifest-import/fetch-url`,
          {
            method: "POST",
            credentials: "same-origin",
            headers: {
              "content-type": "application/json",
              ...tenantHeader(),
            },
            body: JSON.stringify({ url }),
          },
        );
        const body = (await res.json().catch(() => ({}))) as unknown;
        if (!res.ok) {
          const errObj =
            body && typeof body === "object"
              ? (body as { error?: { code?: string; message?: string } })
              : {};
          const code =
            errObj.error?.code ??
            errObj.error?.message ??
            `HTTP ${res.status}`;
          setValidationError(`${t("importManifestModal.errUrlFetchFailed")}: ${code}`);
          return;
        }
        const unwrapped = unwrapEnvelope<{
          workflow: unknown;
          actions?: unknown[];
        }>(body);
        nextWorkflow = unwrapped.workflow;
        nextActions = Array.isArray(unwrapped.actions)
          ? unwrapped.actions
          : null;
      } catch (e) {
        setValidationError(
          `${t("importManifestModal.errUrlFetchFailed")}: ${e instanceof Error ? e.message : t("importManifestModal.errNetwork")}`,
        );
        return;
      }
    } else if (source === "file") {
      // Re-read each File the operator dropped — `files` only carries
      // metadata (size + name), so we need the underlying File handles
      // back. We stash them on the modal's hidden <input> change handler
      // (handleFilesContent below). The source-step UI passes the raw
      // file content via setWorkflowRaw / setActionsRaw at pick time.
      nextWorkflow = workflowRaw;
      nextActions = actionsRaw;
      if (!nextWorkflow) {
        setValidationError(t("importManifestModal.errDropFirst"));
        return;
      }
    } else if (source === "git") {
      setValidationError(t("importManifestModal.errRepoComingSoon"));
      return;
    }

    if (!nextWorkflow) {
      setValidationError(t("importManifestModal.errNoManifest"));
      return;
    }

    setWorkflowRaw(nextWorkflow);
    setActionsRaw(nextActions);

    setValidating(true);
    setStep(1);
    try {
      const res = await fetch(
        `/v1/tenants/${encodeURIComponent(slug)}/manifest-import`,
        {
          method: "POST",
          credentials: "same-origin",
          headers: {
            "content-type": "application/json",
            ...tenantHeader(),
          },
          body: JSON.stringify({
            mode: "validate",
            workflow: nextWorkflow,
            actions: nextActions ?? undefined,
          }),
        },
      );
      const body = (await res.json().catch(() => ({}))) as unknown;
      if (res.status === 423) {
        const flat = body as { locked_by?: string; expires_at?: number };
        setPendingLock({
          locked_by: flat.locked_by,
          expires_at: flat.expires_at,
        });
        setValidating(false);
        return;
      }
      if (!res.ok) {
        const errObj =
          body && typeof body === "object"
            ? (body as { error?: { code?: string; message?: string } })
            : {};
        const detail =
          errObj.error?.message ??
          errObj.error?.code ??
          `HTTP ${res.status}`;
        setValidationError(detail);
        setValidating(false);
        return;
      }
      const preview = unwrapEnvelope<ManifestImportPreview>(body);
      setParsed(previewToParsed(preview));
      setValidating(false);
    } catch (e) {
      setValidationError(
        e instanceof Error ? e.message : t("importManifestModal.errNetworkValidate"),
      );
      setValidating(false);
    }
  }

  /**
   * Commit the parsed manifest. Triggered by the Deploy button on the last
   * step. Re-validates with the in-memory manifest if `deployment_id` is
   * missing (shouldn't happen on the happy path, but the legacy SPA's
   * self-heal pattern stays useful). 409 → OverwriteConfirmModal.
   */
  async function runCommit({ confirmOverwrite }: { confirmOverwrite: boolean }) {
    if (!parsed || !parsed.deployment_id) {
      setCommitError(t("importManifestModal.errNoDeploySession"));
      return;
    }
    setCommitError(null);
    setCommitIssues([]);
    setCommitting(true);

    // Map the resolve-step UI's single `resolution.model` into the
    // per-conflict resolution rows the api expects. The legacy wizard
    // keeps one selection across all conflicts in v1.
    const resolutions: ConflictResolution[] = (parsed.raw.conflicts ?? []).map(
      (c) => ({
        path: c.path,
        action:
          resolution.model === "fallback"
            ? c.auto_fix
              ? "accept_suggestion"
              : "skip"
            : resolution.model === "skip"
              ? "skip"
              : c.auto_fix
                ? "accept_suggestion"
                : "skip",
      }),
    );

    try {
      const res = await fetch(
        `/v1/tenants/${encodeURIComponent(slug)}/manifest-import`,
        {
          method: "POST",
          credentials: "same-origin",
          headers: {
            "content-type": "application/json",
            ...tenantHeader(),
          },
          body: JSON.stringify({
            mode: "commit",
            workflow: workflowRaw,
            actions: actionsRaw ?? undefined,
            target: deployTarget.prod ? "production" : "staging",
            deployment_id: parsed.deployment_id,
            conflict_resolutions: resolutions,
            confirm_overwrite: !!confirmOverwrite,
            note: noteText ? noteText.slice(0, 500) : undefined,
          }),
        },
      );
      const body = (await res.json().catch(() => ({}))) as unknown;
      if (res.status === 409) {
        setOverwriteRequired(body as ManifestImportOverwriteRequired);
        setCommitting(false);
        return;
      }
      if (!res.ok) {
        const errObj =
          body && typeof body === "object"
            ? (body as {
                error?: { code?: string; message?: string; hint?: string };
                issues?: Array<{
                  path: string;
                  message: string;
                  severity: string;
                  code: string;
                }>;
              })
            : {};
        const detail =
          errObj.error?.message ??
          errObj.error?.code ??
          `HTTP ${res.status}`;
        setCommitError(detail);
        setCommitIssues(
          Array.isArray(errObj.issues) ? errObj.issues : [],
        );
        setCommitting(false);
        return;
      }
      const committed = unwrapEnvelope<{ version?: string; workflow_version_id?: string }>(body);
      const versionLabel = committed.version ?? committed.workflow_version_id;
      toast({
        tone: "green",
        title: t("importManifestModal.toastDeployedTitle"),
        description: versionLabel
          ? t("importManifestModal.toastVersionLive", { version: versionLabel, slug })
          : t("importManifestModal.toastManifestLive", { slug }),
      });
      setOverwriteRequired(null);
      setCommitting(false);
      // Invalidate dependent TanStack caches so the Workflows canvas and
      // Agents list reflect the freshly committed manifest without a hard
      // refresh.
      refetchManifestDependents();
      // Legacy SPA exposes `window.refreshWorkflowsView` — call it when
      // we're mounted on top of the SPA, otherwise let the App Router
      // page refresh on its own (TanStack Query invalidations downstream).
      try {
        const w = window as unknown as {
          refreshWorkflowsView?: () => void;
        };
        if (typeof w.refreshWorkflowsView === "function") {
          w.refreshWorkflowsView();
        }
      } catch {
        // best-effort
      }
      onClose();
    } catch (e) {
      setCommitError(
        e instanceof Error ? e.message : t("importManifestModal.errNetworkDeploy"),
      );
      setCommitting(false);
    }
  }

  function next() {
    if (step === 0) {
      void startValidation();
      return;
    }
    setStep((s) => Math.min(IMPORT_STEPS.length - 1, s + 1));
  }
  function back() {
    setStep((s) => Math.max(0, s - 1));
  }

  async function handleFiles(list: FileList | null) {
    if (!list) return;
    const arr: FileEntry[] = Array.from(list).map((f) => ({
      name: f.name,
      size: f.size,
      ok: /workflow.*\.json$/i.test(f.name) || /actions.*\.json$/i.test(f.name),
    }));
    setFiles(arr);
    // Read each file's content into memory so the commit body can re-use it
    // without bouncing through the browser File handle (which is unreadable
    // post-React-re-render).
    let nextWorkflow: unknown = null;
    let nextActions: unknown[] | null = null;
    const fileArr = Array.from(list);
    await Promise.all(
      fileArr.map(async (f) => {
        try {
          const text = await f.text();
          const parsed = JSON.parse(text) as unknown;
          if (/actions.*\.json$/i.test(f.name)) {
            if (Array.isArray(parsed)) nextActions = parsed as unknown[];
          } else if (/workflow.*\.json$/i.test(f.name)) {
            nextWorkflow = parsed;
          } else {
            // Unknown filename — best-guess: array w/ first item.kind==='action'
            // is actions; everything else is workflow.
            if (
              Array.isArray(parsed) &&
              parsed.length > 0 &&
              typeof parsed[0] === "object" &&
              (parsed[0] as { kind?: string })?.kind === "action"
            ) {
              nextActions = parsed as unknown[];
            } else if (nextWorkflow == null) {
              nextWorkflow = parsed;
            }
          }
        } catch {
          // Leave file marked as ok=false; the validation error path
          // surfaces this with a clearer message at validate time.
        }
      }),
    );
    setWorkflowRaw(nextWorkflow);
    setActionsRaw(nextActions);
  }
  function onDragOver(e: React.DragEvent) {
    e.preventDefault();
    dropRef.current?.classList.add("drop-hot");
  }
  function onDragLeave() {
    dropRef.current?.classList.remove("drop-hot");
  }
  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    dropRef.current?.classList.remove("drop-hot");
    void handleFiles(e.dataTransfer.files);
  }

  const title = mode === "agent" ? t("importManifestModal.titleAgent") : t("importManifestModal.titleWorkflow");

  return (
    <ModalOverlay onClose={onClose}>
      <div
        style={{
          width: 980,
          maxHeight: "90vh",
          background: "var(--panel)",
          border: "1px solid var(--border-2)",
          borderRadius: 8,
          overflow: "hidden",
          boxShadow: "0 24px 60px -20px rgba(0,0,0,0.6)",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <header style={{ display: "flex", alignItems: "center", gap: 10, padding: "14px 18px", borderBottom: "1px solid var(--border)" }}>
          <Icon name="upload" size={14} style={{ color: "var(--accent-text)" }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 14, color: "var(--text)", fontWeight: 500 }}>{title}</div>
            <div style={{ fontSize: 11, color: "var(--text-3)" }}>
              {t("importManifestModal.headerAccepts")}{" "}
              <span className="mono" style={{ color: "var(--text-2)" }}>workflow.json</span> +{" "}
              <span className="mono" style={{ color: "var(--text-2)" }}>actions.json</span>. {t("importManifestModal.headerValidates")}
            </div>
          </div>
          <button onClick={onClose} style={{ color: "var(--text-3)" }}>
            <Icon name="x" size={13} />
          </button>
        </header>

        <div style={{ display: "flex", padding: "10px 18px", borderBottom: "1px solid var(--border)", background: "var(--bg-2)", gap: 4 }}>
          {IMPORT_STEPS.map((s, i) => (
            <ImportStepDot key={s.id} step={s} idx={i} active={step === i} done={i < step} />
          ))}
        </div>

        <div style={{ padding: 20, overflow: "auto", flex: 1, minHeight: 0 }}>
          {step === 0 && (
            <SourceStep
              source={source}
              setSource={setSource}
              files={files}
              handleFiles={handleFiles}
              pasted={pasted}
              setPasted={setPasted}
              url={url}
              setUrl={setUrl}
              dropRef={dropRef}
              onDragOver={onDragOver}
              onDragLeave={onDragLeave}
              onDrop={onDrop}
            />
          )}
          {step === 1 && (validating ? <ValidatingState /> : <ValidateStep parsed={parsed} />)}
          {step === 2 && parsed && <DiffStep parsed={parsed} />}
          {step === 3 && parsed && (
            <ResolveStep
              parsed={parsed}
              resolution={resolution}
              setResolution={setResolution}
              workflowRaw={workflowRaw}
            />
          )}
          {step === 4 && parsed && <PreviewStep parsed={parsed} />}
          {step === 5 && parsed && (
            <DeployStep
              parsed={parsed}
              target={deployTarget}
              setTarget={setDeployTarget}
              autoRollback={autoRollback}
              setAutoRollback={setAutoRollback}
              mode={mode}
            />
          )}
        </div>

        <footer style={{ display: "flex", alignItems: "center", gap: 8, padding: "12px 18px", borderTop: "1px solid var(--border)", background: "var(--panel-2)" }}>
          {step > 0 && (
            <Button tone="ghost" icon="chevron-left" onClick={back}>
              {t("importManifestModal.back")}
            </Button>
          )}
          <span style={{ fontSize: 11, color: "var(--text-3)" }}>
            {t("importManifestModal.stepCounter", { current: step + 1, total: IMPORT_STEPS.length })}
          </span>
          {step === 2 && parsed && (
            <span style={{ marginLeft: 14, fontSize: 11, fontFamily: "var(--mono)", color: "var(--text-3)" }}>
              <span style={{ color: "var(--green)" }}>+{parsed.diff.added.length}</span>{" "}
              <span style={{ color: "var(--amber)" }}>~{parsed.diff.modified.length}</span>{" "}
              <span style={{ color: "var(--red)" }}>−{parsed.diff.removed.length}</span>
            </span>
          )}
          <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
            <Button tone="ghost" onClick={onClose}>
              {t("importManifestModal.cancel")}
            </Button>
            {step < IMPORT_STEPS.length - 1 ? (
              <Button tone="primary" icon="chevron-right" onClick={next} disabled={!canAdvance}>
                {step === 0 ? t("importManifestModal.validate") : t("importManifestModal.continue")}
              </Button>
            ) : (
              <Button
                tone="primary"
                icon="deploy"
                onClick={
                  committing
                    ? undefined
                    : () => {
                        void runCommit({ confirmOverwrite: false });
                      }
                }
                disabled={committing || !parsed?.deployment_id}
              >
                {committing
                  ? t("importManifestModal.deploying")
                  : deployTarget.prod
                    ? t("importManifestModal.deployToProd")
                    : t("importManifestModal.deployToStaging")}
              </Button>
            )}
          </div>
        </footer>

        <style>{`.drop-hot { background: var(--panel-2) !important; border-color: var(--signal) !important; }`}</style>

        {/* Inline validation / commit error surfaces. The wizard's step
            bodies don't carry a global error chrome — these slips below
            the footer are the legacy SPA's pattern. */}
        {validationError && step === 0 && (
          <div
            style={{
              padding: "10px 18px",
              background: "color-mix(in srgb, var(--red) 8%, transparent)",
              borderTop: "1px solid color-mix(in srgb, var(--red) 32%, transparent)",
              fontSize: 12,
              color: "var(--red)",
            }}
          >
            {validationError}
          </div>
        )}
        {pendingLock && step === 1 && (
          <div
            style={{
              padding: "10px 18px",
              background: "color-mix(in srgb, var(--amber) 8%, transparent)",
              borderTop: "1px solid color-mix(in srgb, var(--amber) 32%, transparent)",
              fontSize: 12,
              color: "var(--amber)",
            }}
          >
            {t("importManifestModal.lockInProgress")}
            {pendingLock.locked_by ? ` (${pendingLock.locked_by})` : ""}. {t("importManifestModal.lockWait")}
          </div>
        )}
        {commitError && step === IMPORT_STEPS.length - 1 && (
          <div
            style={{
              padding: "10px 18px",
              background: "color-mix(in srgb, var(--red) 8%, transparent)",
              borderTop: "1px solid color-mix(in srgb, var(--red) 32%, transparent)",
              fontSize: 12,
              color: "var(--red)",
              maxHeight: 220,
              overflow: "auto",
            }}
          >
            <div style={{ fontWeight: 500, marginBottom: commitIssues.length ? 6 : 0 }}>
              {commitError}
            </div>
            {commitIssues.length > 0 && (
              <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.5 }}>
                {commitIssues.map((iss, i) => (
                  <li key={i} style={{ marginBottom: 2 }}>
                    <span
                      className="mono"
                      style={{ color: "var(--text-3)", marginRight: 6 }}
                    >
                      {iss.path}
                    </span>
                    <span style={{ color: "var(--text-2)" }}>{iss.message}</span>
                    <span
                      className="mono"
                      style={{ color: "var(--text-3)", marginLeft: 6 }}
                    >
                      [{iss.code}]
                    </span>
                  </li>
                ))}
                {commitIssues.length > 0 && (
                  <li
                    style={{
                      listStyle: "none",
                      marginTop: 6,
                      color: "var(--amber)",
                    }}
                  >
                    {t("importManifestModal.commitIssueHintPart1")}{" "}
                    <strong>{t("importManifestModal.stepResolveBold")}</strong>{" "}
                    {t("importManifestModal.commitIssueHintPart2")}{" "}
                    <strong>{t("importManifestModal.skipAgentBold")}</strong>{" "}
                    {t("importManifestModal.commitIssueHintPart3")}
                  </li>
                )}
              </ul>
            )}
          </div>
        )}
      </div>

      {overwriteRequired && (
        <OverwriteConfirmModal
          payload={{
            ...overwriteRequired,
            prior: parsed?.raw.prior
              ? {
                  version_label: parsed.raw.prior.version,
                  agents: parsed.raw.prior.agents,
                }
              : undefined,
          }}
          committing={committing}
          onCancel={() => setOverwriteRequired(null)}
          onConfirm={() => {
            void runCommit({ confirmOverwrite: true });
          }}
        />
      )}
    </ModalOverlay>
  );
}

function ImportStepDot({
  step,
  idx,
  active,
  done,
}: {
  step: (typeof IMPORT_STEPS)[number];
  idx: number;
  active: boolean;
  done: boolean;
}) {
  const { t } = useI18n();
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "5px 12px",
        background: active ? "var(--panel)" : "transparent",
        border: `1px solid ${active ? "var(--signal)" : "transparent"}`,
        borderRadius: 4,
        opacity: active ? 1 : done ? 0.95 : 0.5,
      }}
    >
      <span
        style={{
          width: 18,
          height: 18,
          borderRadius: "50%",
          background: done ? "var(--signal)" : "transparent",
          border: `1px solid ${done || active ? "var(--signal)" : "var(--border-2)"}`,
          color: done ? "var(--on-signal)" : active ? "var(--accent-text)" : "var(--text-3)",
          fontSize: 10,
          fontFamily: "var(--mono)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {done ? "✓" : idx + 1}
      </span>
      <div>
        <div
          style={{
            fontSize: 11,
            fontFamily: "var(--mono)",
            textTransform: "uppercase",
            letterSpacing: "0.06em",
            color: active ? "var(--text)" : "var(--text-3)",
            lineHeight: 1.1,
          }}
        >
          {t(`importManifestModal.step_${step.id}`)}
        </div>
        <div style={{ fontSize: 10, color: "var(--text-3)" }}>{t(`importManifestModal.stepHint_${step.id}`)}</div>
      </div>
    </div>
  );
}

function SourceStep({
  source,
  setSource,
  files,
  handleFiles,
  pasted,
  setPasted,
  url,
  setUrl,
  dropRef,
  onDragOver,
  onDragLeave,
  onDrop,
}: {
  source: "file" | "paste" | "url" | "git";
  setSource: (s: "file" | "paste" | "url" | "git") => void;
  files: FileEntry[];
  handleFiles: (list: FileList | null) => void | Promise<void>;
  pasted: string;
  setPasted: (v: string) => void;
  url: string;
  setUrl: (v: string) => void;
  dropRef: React.RefObject<HTMLDivElement | null>;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: () => void;
  onDrop: (e: React.DragEvent) => void;
}) {
  const { t } = useI18n();
  return (
    <div>
      <div style={{ fontSize: 11, fontFamily: "var(--mono)", textTransform: "uppercase", color: "var(--text-3)", letterSpacing: "0.08em", marginBottom: 10 }}>{t("importManifestModal.source")}</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8, marginBottom: 18 }}>
        <SourceCard active={source === "file"} onClick={() => setSource("file")} icon="upload" title={t("importManifestModal.srcUploadTitle")} sub={t("importManifestModal.srcUploadSub")} />
        <SourceCard active={source === "paste"} onClick={() => setSource("paste")} icon="code" title={t("importManifestModal.srcPasteTitle")} sub={t("importManifestModal.srcPasteSub")} />
        <SourceCard active={source === "url"} onClick={() => setSource("url")} icon="external" title={t("importManifestModal.srcUrlTitle")} sub={t("importManifestModal.srcUrlSub")} />
        <SourceCard active={source === "git"} onClick={() => setSource("git")} icon="git" title={t("importManifestModal.srcRepoTitle")} sub="agentic/raas-workflows" />
      </div>

      {source === "file" && (
        <div>
          <div
            ref={dropRef}
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
            style={{
              padding: 32,
              textAlign: "center",
              background: "var(--bg-2)",
              border: "1px dashed var(--border-3)",
              borderRadius: 6,
              transition: "background 0.12s, border-color 0.12s",
            }}
          >
            <Icon name="upload" size={22} style={{ color: "var(--text-3)" }} />
            <div style={{ marginTop: 8, fontSize: 13, color: "var(--text-2)" }}>
              {t("importManifestModal.dropPrefix")}{" "}
              <span className="mono" style={{ color: "var(--text)" }}>workflow.json</span> {t("importManifestModal.dropAnd")}{" "}
              <span className="mono" style={{ color: "var(--text)" }}>actions.json</span>
            </div>
            <div style={{ marginTop: 4, fontSize: 11.5, color: "var(--text-3)" }}>
              {t("importManifestModal.or")}{" "}
              <label style={{ color: "var(--accent-text)", cursor: "pointer" }}>
                {t("importManifestModal.browseFiles")}
                <input
                  type="file"
                  multiple
                  accept=".json,application/json"
                  style={{ display: "none" }}
                  onChange={(e) => handleFiles(e.target.files)}
                />
              </label>{" "}
              {t("importManifestModal.maxFileSize")}
            </div>
          </div>

          {files.length > 0 && (
            <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 4 }}>
              {files.map((f, i) => (
                <div
                  key={i}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "7px 12px",
                    background: "var(--panel-2)",
                    border: `1px solid ${f.ok ? "var(--border)" : "color-mix(in srgb, var(--amber) 30%, transparent)"}`,
                    borderRadius: 4,
                  }}
                >
                  <Icon name="code" size={12} style={{ color: f.ok ? "var(--green)" : "var(--amber)" }} />
                  <span className="mono" style={{ fontSize: 12, color: "var(--text)" }}>{f.name}</span>
                  <span style={{ marginLeft: "auto", fontSize: 11, fontFamily: "var(--mono)", color: "var(--text-3)" }}>{fmtBytes(f.size)}</span>
                  {f.ok ? <Badge tone="green">{t("importManifestModal.badgeDetected")}</Badge> : <Badge tone="amber">{t("importManifestModal.badgeUnknownRole")}</Badge>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {source === "paste" && <MonacoEditor value={pasted} onChange={setPasted} language="json" height={320} />}

      {source === "url" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div>
            <label style={{ display: "block", fontSize: 11, color: "var(--text-2)", marginBottom: 4 }}>{t("importManifestModal.manifestUrlLabel")}</label>
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://raw.githubusercontent.com/your-org/raas-workflows/main/dist/manifest.zip"
              style={{
                width: "100%",
                padding: "8px 12px",
                background: "var(--panel-2)",
                border: "1px solid var(--border-2)",
                borderRadius: 4,
                color: "var(--text)",
                fontFamily: "var(--mono)",
                fontSize: 12,
                outline: "none",
              }}
            />
            <div style={{ marginTop: 6, fontSize: 11, color: "var(--text-3)" }}>
              {t("importManifestModal.urlHelpPart1")} <span className="mono">GET</span> {t("importManifestModal.urlHelpPart2")}{" "}
              <span className="mono">manifest.zip</span> {t("importManifestModal.urlHelpPart3")}
            </div>
          </div>
          <div style={{ padding: "10px 12px", background: "var(--panel-2)", border: "1px solid var(--border)", borderRadius: 4 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
              <Icon name="alert" size={11} style={{ color: "var(--amber)" }} />
              <span style={{ fontSize: 12, color: "var(--text)" }}>{t("importManifestModal.egressTitle")}</span>
            </div>
            <div style={{ fontSize: 11.5, color: "var(--text-3)", lineHeight: 1.55 }}>
              {t("importManifestModal.egressPart1")}{" "}
              <span className="mono">github.com</span> {t("importManifestModal.egressAnd")} <span className="mono">*.amazonaws.com</span> {t("importManifestModal.egressPart2")}
            </div>
          </div>
        </div>
      )}

      {source === "git" && (
        <div>
          <div style={{ marginBottom: 8, fontSize: 11, fontFamily: "var(--mono)", textTransform: "uppercase", color: "var(--text-3)", letterSpacing: "0.08em" }}>{t("importManifestModal.connectedRepos")}</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <RepoOption name="agentic/raas-workflows" branch="main" path="dist/manifest.zip" connected lastBuilt={t("importManifestModal.repoBuilt3min")} />
            <RepoOption name="agentic/raas-workflows" branch="v2-rewrite" path="dist/manifest.zip" connected lastBuilt={`${t("importManifestModal.repoBuilt11hr")} · ✓ green`} recommended />
            <RepoOption name="agentic/supportflow" branch="main" path="dist/manifest.zip" connected lastBuilt={t("importManifestModal.repoBuilt2days")} />
            <button style={{ padding: "8px 12px", textAlign: "left", background: "var(--panel-2)", border: "1px dashed var(--border-2)", borderRadius: 4, fontSize: 11.5, color: "var(--text-3)" }}>
              <Icon name="plus" size={11} style={{ marginRight: 6 }} />
              {t("importManifestModal.connectAnotherRepo")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function SourceCard({
  active,
  onClick,
  icon,
  title,
  sub,
}: {
  active: boolean;
  onClick: () => void;
  icon: IconName;
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
        borderRadius: 5,
        textAlign: "left",
        cursor: "pointer",
        transition: "background 0.12s, border-color 0.12s",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 5 }}>
        <Icon name={icon} size={12} style={{ color: active ? "var(--accent-text)" : "var(--text-2)" }} />
        <span style={{ fontSize: 12.5, color: "var(--text)", fontWeight: 500 }}>{title}</span>
      </div>
      <div style={{ fontSize: 11, color: "var(--text-3)", lineHeight: 1.45 }}>{sub}</div>
    </button>
  );
}

function RepoOption({
  name,
  branch,
  path,
  connected,
  lastBuilt,
  recommended,
}: {
  name: string;
  branch: string;
  path: string;
  connected?: boolean;
  lastBuilt: string;
  recommended?: boolean;
}) {
  const { t } = useI18n();
  return (
    <label
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "10px 12px",
        background: recommended ? "color-mix(in srgb, var(--signal) 4%, transparent)" : "var(--panel-2)",
        border: `1px solid ${recommended ? "color-mix(in srgb, var(--signal) 30%, transparent)" : "var(--border)"}`,
        borderRadius: 4,
        cursor: "pointer",
      }}
    >
      <input type="radio" name="repo" defaultChecked={recommended} style={{ accentColor: "var(--signal)" }} />
      <Icon name="git" size={12} style={{ color: "var(--text-3)" }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span className="mono" style={{ fontSize: 12, color: "var(--text)" }}>{name}</span>
          <Badge tone="muted">{branch}</Badge>
          {recommended && <Badge tone="signal">{t("importManifestModal.badgeRecommended")}</Badge>}
        </div>
        <div style={{ fontSize: 10.5, color: "var(--text-3)", fontFamily: "var(--mono)", marginTop: 2 }}>{path} · {lastBuilt}</div>
      </div>
      {connected && <span style={{ fontSize: 10, color: "var(--green)", fontFamily: "var(--mono)" }}>● {t("importManifestModal.badgeConnected")}</span>}
    </label>
  );
}

function ValidatingState() {
  const { t } = useI18n();
  return (
    <div style={{ padding: "60px 20px", textAlign: "center" }}>
      <div
        style={{
          display: "inline-block",
          width: 22,
          height: 22,
          border: "3px solid var(--border-2)",
          borderTopColor: "var(--signal)",
          borderRadius: "50%",
          animation: "spin 0.8s linear infinite",
        }}
      />
      <div style={{ marginTop: 16, fontSize: 13, color: "var(--text)" }}>{t("importManifestModal.validatingManifest")}</div>
      <div style={{ marginTop: 6, fontSize: 11.5, color: "var(--text-3)" }}>
        {t("importManifestModal.validatingSteps")}
      </div>
    </div>
  );
}

function ValidateStep({ parsed }: { parsed: ParsedManifest | null }) {
  const { t } = useI18n();
  if (!parsed) return null;
  return (
    <div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(5, 1fr)",
          gap: 0,
          border: "1px solid var(--border)",
          borderRadius: 6,
          marginBottom: 14,
          background: "var(--panel)",
        }}
      >
        <ValidateCell label={t("importManifestModal.cellWorkflow")} value={parsed.workflow.id} mono />
        <ValidateCell label={t("importManifestModal.cellVersion")} value={parsed.workflow.version} mono accent="var(--signal)" />
        <ValidateCell label={t("importManifestModal.cellAgents")} value={parsed.workflow.agent_count} mono />
        <ValidateCell label={t("importManifestModal.cellEvents")} value={parsed.workflow.event_count} mono />
        <ValidateCell
          label={t("importManifestModal.cellCycles")}
          value={parsed.cycles}
          mono
          accent={parsed.cycles === 0 ? "var(--green)" : "var(--red)"}
        />
      </div>

      <Panel title={t("importManifestModal.validationResults")} padded={false}>
        {parsed.issues.map((iss, i) => (
          <div
            key={i}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "8px 14px",
              borderBottom: i < parsed.issues.length - 1 ? "1px solid var(--border)" : "none",
            }}
          >
            <Icon
              name={iss.level === "err" ? "alert" : iss.level === "warn" ? "alert" : "check"}
              size={11}
              style={{ color: iss.level === "err" ? "var(--red)" : iss.level === "warn" ? "var(--amber)" : "var(--green)" }}
            />
            <span style={{ fontSize: 12, color: "var(--text-2)" }}>{iss.msg}</span>
            <span style={{ marginLeft: "auto", fontSize: 10, fontFamily: "var(--mono)", textTransform: "uppercase", color: "var(--text-3)" }}>{iss.level}</span>
          </div>
        ))}
      </Panel>
    </div>
  );
}

function ValidateCell({
  label,
  value,
  mono,
  accent,
}: {
  label: string;
  value: string | number;
  mono?: boolean;
  accent?: string;
}) {
  return (
    <div style={{ padding: "10px 14px", borderRight: "1px solid var(--border)" }}>
      <div style={{ fontSize: 10, fontFamily: "var(--mono)", textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--text-3)" }}>{label}</div>
      <div style={{ marginTop: 4, fontSize: 16, fontFamily: mono ? "var(--mono)" : "var(--sans)", color: accent ?? "var(--text)" }}>{value}</div>
    </div>
  );
}

function DiffStep({ parsed }: { parsed: ParsedManifest }) {
  const { t } = useI18n();
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <Panel
        title={t("importManifestModal.agentDiffTitle")}
        subtitle={`${t("importManifestModal.diffLiveLabel")}: raas@2026.05.16-a → ${t("importManifestModal.diffImportedLabel")}: ${parsed.workflow.version}`}
        padded={false}
      >
        <DiffGroup
          label="Added"
          tone="green"
          items={parsed.diff.added.map((a) => ({ key: a.id, name: a.name, sub: a.reason }))}
        />
        <DiffGroup
          label="Modified"
          tone="amber"
          items={parsed.diff.modified.map((a) => ({
            key: a.id,
            name: a.name,
            sub: (a.was ? `id ${a.was} → ${a.id} · ` : "") + a.changes.join(", "),
          }))}
        />
        <DiffGroup
          label="Removed"
          tone="red"
          items={parsed.diff.removed.map((a) => ({ key: a.id, name: a.name, sub: "" }))}
        />
      </Panel>

      <Panel title={t("importManifestModal.schemaDiffTitle")} padded>
        <div style={{ fontSize: 12, color: "var(--text-2)", lineHeight: 1.6, marginBottom: 10 }}>
          {t("importManifestModal.schemaDiffDesc")}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 8 }}>
          {["input_data", "ontology_instructions", "tool_use", "typescript_code"].map((p) => (
            <div
              key={p}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "8px 12px",
                background: "var(--panel-2)",
                border: "1px solid color-mix(in srgb, var(--signal) 20%, transparent)",
                borderRadius: 4,
              }}
            >
              <Icon name="plus" size={11} style={{ color: "var(--accent-text)" }} />
              <span className="mono" style={{ fontSize: 12, color: "var(--text)" }}>{p}</span>
              <span style={{ marginLeft: "auto", fontSize: 10.5, color: "var(--text-3)" }}>{t("importManifestModal.onNAgents", { count: 22 })}</span>
            </div>
          ))}
        </div>
      </Panel>
    </div>
  );
}

function DiffGroup({
  label,
  tone,
  items,
}: {
  label: "Added" | "Modified" | "Removed";
  tone: "green" | "amber" | "red";
  items: Array<{ key: string; name: string; sub: string }>;
}) {
  const { t } = useI18n();
  const sigil = label === "Added" ? "+" : label === "Removed" ? "−" : "~";
  const toneVar = tone === "green" ? "var(--green)" : tone === "amber" ? "var(--amber)" : "var(--red)";
  const labelText =
    label === "Added"
      ? t("importManifestModal.diffAdded")
      : label === "Removed"
        ? t("importManifestModal.diffRemoved")
        : t("importManifestModal.diffModified");
  if (items.length === 0) {
    return (
      <div style={{ padding: "8px 14px", borderBottom: "1px solid var(--border)", fontSize: 11.5, color: "var(--text-3)" }}>
        <span style={{ color: toneVar, fontFamily: "var(--mono)", marginRight: 8 }}>{sigil}</span>
        {labelText}: {t("importManifestModal.diffNone")}
      </div>
    );
  }
  return (
    <div style={{ borderBottom: "1px solid var(--border)" }}>
      <div style={{ padding: "8px 14px", display: "flex", alignItems: "center", gap: 8, background: "var(--panel-2)" }}>
        <span style={{ color: toneVar, fontFamily: "var(--mono)", fontSize: 13, fontWeight: 700, width: 12, textAlign: "center" }}>{sigil}</span>
        <span style={{ fontSize: 11, fontFamily: "var(--mono)", textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--text-2)" }}>{labelText} · {items.length}</span>
      </div>
      {items.map((it) => (
        <div
          key={it.key}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "8px 14px 8px 36px",
            borderTop: "1px solid var(--border)",
          }}
        >
          <Badge tone="muted">{it.key}</Badge>
          <span className="mono" style={{ fontSize: 12, color: "var(--text)" }}>{it.name}</span>
          <span
            style={{
              marginLeft: "auto",
              fontSize: 11,
              color: "var(--text-3)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              maxWidth: 480,
            }}
          >
            {it.sub}
          </span>
        </div>
      ))}
    </div>
  );
}

function ResolveStep({
  parsed,
  resolution,
  setResolution,
  workflowRaw,
}: {
  parsed: ParsedManifest;
  resolution: { model: string };
  setResolution: (r: { model: string }) => void;
  workflowRaw: unknown;
}) {
  const { t } = useI18n();
  // Map agent indices that the current resolution mode will drop. Skip
  // mode drops every conflicted agent; fallback drops only the
  // block-severity conflicts that have no auto-fix (since fallback maps
  // them to skip server-side).
  const rawConflicts = parsed.raw.conflicts ?? [];
  const dropIdx = new Set<number>();
  for (const c of rawConflicts) {
    const m = c.path.match(/^agents\[(\d+)\]/);
    if (!m) continue;
    const idx = Number(m[1]);
    if (resolution.model === "skip") {
      dropIdx.add(idx);
    } else if (
      resolution.model === "fallback" &&
      c.severity === "block" &&
      !c.auto_fix
    ) {
      dropIdx.add(idx);
    }
  }
  const workflowArr = Array.isArray(workflowRaw)
    ? (workflowRaw as Array<{ id?: string; name?: string; title?: string }>)
    : [];
  const dropNames: string[] = [];
  for (const idx of Array.from(dropIdx).sort((a, b) => a - b)) {
    const a = workflowArr[idx];
    if (!a) continue;
    dropNames.push(a.name ?? a.id ?? `agents[${idx}]`);
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {dropNames.length > 0 && (
        <div
          role="status"
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: 10,
            padding: "10px 12px",
            background: "color-mix(in srgb, var(--amber) 8%, transparent)",
            border: "1px solid color-mix(in srgb, var(--amber) 32%, transparent)",
            borderRadius: 4,
            fontSize: 11.5,
            color: "var(--text-2)",
          }}
        >
          <Icon name="alert" size={11} style={{ color: "var(--amber)", marginTop: 2 }} />
          <div>
            <div style={{ color: "var(--text)", fontWeight: 500, marginBottom: 2 }}>
              {dropNames.length === 1
                ? t("importManifestModal.dropWarnOne", { count: dropNames.length })
                : t("importManifestModal.dropWarnMany", { count: dropNames.length })}
            </div>
            <div style={{ color: "var(--text-3)", fontFamily: "var(--mono)", fontSize: 11 }}>
              {dropNames.slice(0, 8).join(", ")}
              {dropNames.length > 8 ? ` · ${t("importManifestModal.dropMore", { count: dropNames.length - 8 })}` : ""}
            </div>
            <div style={{ color: "var(--text-3)", marginTop: 4 }}>
              {resolution.model === "skip"
                ? t("importManifestModal.dropExplainSkip")
                : t("importManifestModal.dropExplainFallback")}
            </div>
          </div>
        </div>
      )}
      <Panel
        title={t("importManifestModal.conflictsTitle", { count: parsed.conflicts.length })}
        subtitle={t("importManifestModal.conflictsSubtitle")}
        padded={false}
      >
        {parsed.conflicts.map((c, i) => (
          <div
            key={i}
            style={{
              padding: "12px 14px",
              borderBottom: i < parsed.conflicts.length - 1 ? "1px solid var(--border)" : "none",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
              <Badge tone="amber">{c.kind}</Badge>
              <span className="mono" style={{ fontSize: 12, color: "var(--text)" }}>{c.name}</span>
              <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--text-3)" }}>
                {t("importManifestModal.referencedBy")} <span className="mono">{c.agent}</span>
              </span>
            </div>
            <div style={{ fontSize: 11.5, color: "var(--text-2)", marginBottom: 10 }}>{c.note}</div>
            <div style={{ display: "flex", gap: 0, border: "1px solid var(--border-2)", borderRadius: 4, overflow: "hidden", width: "fit-content" }}>
              <ResolveOption value="fallback" current={resolution.model} setCurrent={(v) => setResolution({ ...resolution, model: v })} label={t("importManifestModal.optUseFallback")} hint="claude-sonnet-4-5" />
              <ResolveOption value="connect" current={resolution.model} setCurrent={(v) => setResolution({ ...resolution, model: v })} label={t("importManifestModal.optConnectOpenai")} hint={t("importManifestModal.optConnectOpenaiHint")} />
              <ResolveOption value="skip" current={resolution.model} setCurrent={(v) => setResolution({ ...resolution, model: v })} label={t("importManifestModal.optSkipAgent")} hint={t("importManifestModal.optSkipAgentHint")} />
            </div>
          </div>
        ))}
      </Panel>

      <Panel title={t("importManifestModal.idConflictsTitle")} padded>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <ResolveLine ok label="matchResume" hint={t("importManifestModal.idConflictHint1")} />
          <ResolveLine ok label="recallStockCandidates" hint={t("importManifestModal.idConflictHint2")} />
          <ResolveLine ok label={t("importManifestModal.allEventsMatch")} hint={t("importManifestModal.idConflictHint3")} />
        </div>
      </Panel>
    </div>
  );
}

function ResolveOption({
  value,
  current,
  setCurrent,
  label,
  hint,
}: {
  value: string;
  current: string;
  setCurrent: (v: string) => void;
  label: string;
  hint: string;
}) {
  const active = current === value;
  return (
    <button
      onClick={() => setCurrent(value)}
      style={{
        padding: "6px 12px",
        background: active ? "var(--panel-3)" : "var(--panel-2)",
        color: active ? "var(--text)" : "var(--text-3)",
        fontSize: 11.5,
        borderRight: "1px solid var(--border-2)",
        borderBottom: active ? "2px solid var(--signal)" : "2px solid transparent",
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-start",
        gap: 1,
      }}
    >
      <span>{label}</span>
      <span style={{ fontSize: 10, fontFamily: "var(--mono)", color: "var(--text-3)" }}>{hint}</span>
    </button>
  );
}

function ResolveLine({ ok, label, hint }: { ok: boolean; label: string; hint: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0", fontSize: 12 }}>
      <Icon name={ok ? "check" : "alert"} size={11} style={{ color: ok ? "var(--green)" : "var(--amber)" }} />
      <span className="mono" style={{ color: "var(--text-2)" }}>{label}</span>
      <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--text-3)" }}>{hint}</span>
    </div>
  );
}

function PreviewStep({ parsed }: { parsed: ParsedManifest }) {
  const { t } = useI18n();
  // Source of truth for the preview mini-graph: the live workflow DAG.
  // Stages are derived from the indices actually used by tenant agents
  // (mirrors the dashboard funnel logic) so non-RAAS tenants render too.
  const { data: dag } = useDag();
  const dagAgents: DagAgent[] = dag?.agents ?? [];
  const stages = useMemo(() => {
    const used = new Set<number>();
    for (const a of dagAgents) used.add(a.stage);
    return Array.from(used)
      .sort((x, y) => x - y)
      .map((id) => ({
        id,
        label:
          id in STAGE_LABELS
            ? t(`importManifestModal.stage_${id}`)
            : t("importManifestModal.stageGeneric", { id }),
      }));
  }, [dagAgents, t]);
  // Mini-graph wants {id, name, actor, stage}; DagAgent already carries
  // these fields (with the id from the kebabId form).
  const agents = dagAgents.map((a) => ({
    id: a.kebabId,
    name: a.name,
    actor: a.actor,
    stage: a.stage,
  }));
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <Panel title={t("importManifestModal.importedWorkflow")} subtitle={parsed.workflow.version} padded>
        <PreviewMiniGraph stages={stages} agents={agents} />
        <div style={{ display: "flex", gap: 14, marginTop: 14, fontSize: 11.5, color: "var(--text-3)" }}>
          <span>
            <span style={{ display: "inline-block", width: 8, height: 8, background: "var(--signal)", marginRight: 5, borderRadius: 1 }} />
            {t("importManifestModal.legendExisting")}
          </span>
          <span>
            <span style={{ display: "inline-block", width: 8, height: 8, background: "var(--green)", marginRight: 5, borderRadius: 1 }} />
            {t("importManifestModal.legendAdded", { count: 1 })}
          </span>
          <span>
            <span style={{ display: "inline-block", width: 8, height: 8, background: "var(--amber)", marginRight: 5, borderRadius: 1 }} />
            {t("importManifestModal.legendModified", { count: 22 })}
          </span>
          <span>
            <span style={{ display: "inline-block", width: 8, height: 8, background: "var(--violet)", marginRight: 5, borderRadius: 1 }} />
            {t("importManifestModal.legendHumanTask")}
          </span>
        </div>
      </Panel>

      <Panel title={t("importManifestModal.summaryTitle")} padded>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12 }}>
          <Stat
            label={t("importManifestModal.statNetAgents")}
            value={`+${parsed.diff.added.length - parsed.diff.removed.length}`}
            mono
            accent="var(--signal)"
          />
          <Stat label={t("importManifestModal.statModified")} value={parsed.diff.modified.length} mono accent="var(--amber)" />
          <Stat label={t("importManifestModal.statNewProperties")} value="4" mono sub={t("importManifestModal.statNewPropertiesSub")} />
          <Stat label={t("importManifestModal.statEstimatedRollout")} value="~ 4 s" mono />
        </div>
      </Panel>
    </div>
  );
}

function PreviewMiniGraph({
  stages,
  agents,
}: {
  stages: Array<{ id: number; label: string }>;
  agents: Array<{ id: string; name: string; actor: "Agent" | "Human"; stage: number }>;
}) {
  const COL = 100;
  const NODE_H = 22;
  const NODE_W = 90;
  const ROW_GAP = 28;
  const PAD = 16;
  const byStage: Record<number, typeof agents> = {};
  agents.forEach((a) => {
    (byStage[a.stage] = byStage[a.stage] || []).push(a);
  });
  const maxLanes = Math.max(1, ...stages.map((s) => (byStage[s.id] || []).length));
  const W = PAD * 2 + stages.length * COL;
  const H = PAD * 2 + maxLanes * ROW_GAP;

  return (
    <svg width={W} height={H} style={{ display: "block", width: "100%", maxWidth: "100%" }} viewBox={`0 0 ${W} ${H}`}>
      {stages.map((s, i) => (
        <line key={i} x1={PAD + i * COL} x2={PAD + i * COL} y1={4} y2={H - 4} stroke="var(--border)" opacity="0.6" />
      ))}
      {stages.map((s, i) => (
        <text key={"l" + i} x={PAD + i * COL + 4} y={12} fill="var(--text-3)" fontSize="8" fontFamily="var(--mono)">
          {String(i).padStart(2, "0")} {s.label.toUpperCase()}
        </text>
      ))}
      {stages.map((s, i) => {
        const list = byStage[s.id] || [];
        return list.map((a, lane) => {
          const x = PAD + i * COL + 4;
          const y = PAD + lane * ROW_GAP;
          const isNew = a.id === "10-1";
          const isModified = a.id === "10-2" || a.id === "2" || a.id === "12" || a.id === "14-1";
          const color = a.actor === "Human" ? "var(--violet)" : isNew ? "var(--green)" : isModified ? "var(--amber)" : "var(--signal)";
          return (
            <g key={a.id}>
              <rect
                x={x}
                y={y}
                width={NODE_W}
                height={NODE_H}
                rx={2}
                fill={isNew ? "color-mix(in srgb, var(--green) 10%, transparent)" : "var(--panel-2)"}
                stroke={color}
                strokeWidth={isNew ? 1.5 : 1}
                strokeDasharray={isModified && !isNew ? "3 2" : "0"}
              />
              <text x={x + 5} y={y + 13} fill="var(--text)" fontSize="9" fontFamily="var(--mono)">{a.id}</text>
              <text x={x + 5} y={y + 13 + 8} fill="var(--text-3)" fontSize="7.5" fontFamily="var(--mono)">
                {a.name.length > 16 ? a.name.slice(0, 14) + "…" : a.name}
              </text>
            </g>
          );
        });
      })}
    </svg>
  );
}

function DeployStep({
  parsed,
  target,
  setTarget,
  autoRollback,
  setAutoRollback,
}: {
  parsed: ParsedManifest;
  target: { staging: boolean; prod: boolean };
  setTarget: (v: { staging: boolean; prod: boolean }) => void;
  autoRollback: boolean;
  setAutoRollback: (v: boolean) => void;
  mode: "workflow" | "agent";
}) {
  const { t } = useI18n();
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <Panel title={t("importManifestModal.deployTarget")} padded>
          <DeployTargetIM
            on={target.staging}
            onToggle={() => setTarget({ ...target, staging: !target.staging })}
            label={`${t("importManifestModal.targetStaging")} · raas-stage`}
            sub={t("importManifestModal.targetStagingSub")}
            recommended
          />
          <DeployTargetIM
            on={target.prod}
            onToggle={() => setTarget({ ...target, prod: !target.prod })}
            label={`${t("importManifestModal.targetProduction")} · raas`}
            sub={t("importManifestModal.targetProductionSub")}
            warn
          />
        </Panel>

        <Panel title={t("importManifestModal.safetyTitle")} padded>
          <label style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "8px 0", cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={autoRollback}
              onChange={(e) => setAutoRollback(e.target.checked)}
              style={{ accentColor: "var(--signal)", marginTop: 3 }}
            />
            <div>
              <div style={{ fontSize: 12.5, color: "var(--text)" }}>{t("importManifestModal.safetyAutoRollback")}</div>
              <div style={{ fontSize: 11, color: "var(--text-3)" }}>
                {t("importManifestModal.safetyAutoRollbackDesc")}
              </div>
            </div>
          </label>
          <label style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "8px 0", cursor: "pointer" }}>
            <input type="checkbox" defaultChecked style={{ accentColor: "var(--signal)", marginTop: 3 }} />
            <div>
              <div style={{ fontSize: 12.5, color: "var(--text)" }}>{t("importManifestModal.safetyDrain")}</div>
              <div style={{ fontSize: 11, color: "var(--text-3)" }}>
                {t("importManifestModal.safetyDrainDesc")}
              </div>
            </div>
          </label>
          <label style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "8px 0", cursor: "pointer" }}>
            <input type="checkbox" style={{ accentColor: "var(--signal)", marginTop: 3 }} />
            <div>
              <div style={{ fontSize: 12.5, color: "var(--text)" }}>{t("importManifestModal.safetyReview")}</div>
              <div style={{ fontSize: 11, color: "var(--text-3)" }}>
                {t("importManifestModal.safetyReviewDesc")}
              </div>
            </div>
          </label>
        </Panel>
      </div>

      <Panel
        title={t("importManifestModal.finalManifest")}
        subtitle={t("importManifestModal.finalManifestSubtitle")}
        padded={false}
      >
        <CodeBlock>
          {JSON.stringify(
            {
              workflow: parsed.workflow,
              source: "imported",
              deploy_target: target.prod ? "prod" : "staging",
              summary: {
                added: parsed.diff.added.length,
                modified: parsed.diff.modified.length,
                removed: parsed.diff.removed.length,
                new_properties: ["input_data", "ontology_instructions", "tool_use", "typescript_code"],
              },
              auto_rollback: autoRollback,
              tenant: "raas",
              tag: "imported-via-ui",
            },
            null,
            2,
          )}
        </CodeBlock>
      </Panel>
    </div>
  );
}

function DeployTargetIM({
  on,
  onToggle,
  label,
  sub,
  recommended,
  warn,
}: {
  on: boolean;
  onToggle: () => void;
  label: string;
  sub: string;
  recommended?: boolean;
  warn?: boolean;
}) {
  const { t } = useI18n();
  return (
    <label
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "10px 12px",
        background: on ? "var(--panel-2)" : "transparent",
        border: `1px solid ${on ? "var(--signal)" : "var(--border)"}`,
        borderRadius: 4,
        cursor: "pointer",
        marginBottom: 6,
      }}
    >
      <input type="checkbox" checked={on} onChange={onToggle} style={{ accentColor: "var(--signal)" }} />
      <div style={{ flex: 1 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ fontSize: 12.5, color: "var(--text)" }}>{label}</span>
          {recommended && <Badge tone="signal">{t("importManifestModal.badgeRecommended")}</Badge>}
        </div>
        <div style={{ fontSize: 11, color: "var(--text-3)" }}>{sub}</div>
      </div>
      {warn && <Badge tone="amber">{t("importManifestModal.requiresApproval")}</Badge>}
    </label>
  );
}
