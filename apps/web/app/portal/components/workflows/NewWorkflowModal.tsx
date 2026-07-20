"use client";

import { useEffect, useMemo, useState } from "react";
import type {
  CreateWorkflowBody,
  GenerateWorkflowBody,
  GenerateWorkflowResponse,
  ProviderId,
  WorkflowDetail,
} from "@agentic/contracts";
import {
  Badge,
  Button,
  Icon,
  ModalOverlay,
  type IconName,
} from "@/app/portal/components";
import { useTenant } from "@/app/portal/lib/use-tenant";
import { useFleet } from "@/lib/hooks/useModelFleet";
import {
  useCreateWorkflow,
  useGenerateWorkflow,
  useWorkflowCatalog,
  useWorkflowDetail,
  useWorkflowDocumentFolders,
  useWorkflowTemplates,
} from "@/lib/hooks/useWorkflowAuthoring";

type CreationPath = "generate" | "blank" | "template" | "clone" | "import";

export interface NewWorkflowModalProps {
  onClose: () => void;
  onCreated?: (workflow: WorkflowDetail) => void;
  onImport?: (target: { slug: string; name: string }) => void;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function formatError(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "The request could not be completed.";
}

/** Stable identity for every input that can change an AI proposal. */
export function generationFingerprint(
  input: Pick<
    GenerateWorkflowBody,
    | "purpose"
    | "documentFolder"
    | "webResearch"
    | "provider"
    | "model"
    | "constraints"
    | "expectedOutputs"
  >,
): string {
  return JSON.stringify({
    purpose: input.purpose.trim(),
    documentFolder: input.documentFolder ?? "",
    webResearch: input.webResearch ?? false,
    provider: input.provider ?? "",
    model: input.model ?? "",
    constraints: input.constraints,
    expectedOutputs: input.expectedOutputs,
  });
}

export function parseGenerationLines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^[-*]\s+/, ""))
    .filter(Boolean);
}

export function NewWorkflowModal({
  onClose,
  onCreated,
  onImport,
}: NewWorkflowModalProps) {
  const tenant = useTenant();
  const templatesQuery = useWorkflowTemplates();
  const workflowsQuery = useWorkflowCatalog();
  const foldersQuery = useWorkflowDocumentFolders();
  const fleetQuery = useFleet();
  const generate = useGenerateWorkflow();
  const create = useCreateWorkflow();

  const templates = templatesQuery.data?.templates ?? [];
  const workflows = workflowsQuery.data?.workflows ?? [];
  const fleet = fleetQuery.data ?? [];

  const [path, setPath] = useState<CreationPath>("generate");
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [templateId, setTemplateId] = useState("");
  const [cloneSlug, setCloneSlug] = useState("");
  const [cloneVersionId, setCloneVersionId] = useState("");
  const [overrideCloneModel, setOverrideCloneModel] = useState(false);
  const [purpose, setPurpose] = useState("");
  const [documentFolder, setDocumentFolder] = useState("");
  const [webResearch, setWebResearch] = useState(false);
  const [constraintsText, setConstraintsText] = useState("");
  const [outputsText, setOutputsText] = useState("");
  const [modelKey, setModelKey] = useState("");
  const [preview, setPreview] = useState<GenerateWorkflowResponse | null>(null);
  const [previewFingerprint, setPreviewFingerprint] = useState<string | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const cloneDetailQuery = useWorkflowDetail(
    path === "clone" && cloneSlug ? cloneSlug : null,
  );

  useEffect(() => {
    if (!templateId && templates[0]) setTemplateId(templates[0].id);
  }, [templateId, templates]);
  useEffect(() => {
    if (!cloneSlug && workflows[0]) setCloneSlug(workflows[0].slug);
  }, [cloneSlug, workflows]);
  useEffect(() => {
    if (cloneDetailQuery.data && !cloneVersionId) {
      setCloneVersionId(cloneDetailQuery.data.latestVersionId);
    }
  }, [cloneDetailQuery.data, cloneVersionId]);
  useEffect(() => {
    if (!modelKey && fleet[0]) {
      const primary =
        fleet.find((entry) => entry.role === "primary") ?? fleet[0];
      setModelKey(`${primary.provider}::${primary.modelName}`);
    }
  }, [fleet, modelKey]);

  const model = useMemo(() => {
    if (!modelKey) return undefined;
    const split = modelKey.indexOf("::");
    if (split < 1) return undefined;
    return {
      provider: modelKey.slice(0, split) as ProviderId,
      model: modelKey.slice(split + 2),
    };
  }, [modelKey]);
  const generationInput = useMemo<GenerateWorkflowBody>(
    () => ({
      purpose,
      documentFolder: documentFolder || undefined,
      webResearch,
      provider: model?.provider,
      model: model?.model,
      constraints: parseGenerationLines(constraintsText),
      expectedOutputs: parseGenerationLines(outputsText),
    }),
    [
      constraintsText,
      documentFolder,
      model?.model,
      model?.provider,
      outputsText,
      purpose,
      webResearch,
    ],
  );
  const currentGenerationFingerprint = useMemo(
    () => generationFingerprint(generationInput),
    [generationInput],
  );
  const previewIsCurrent =
    preview !== null && previewFingerprint === currentGenerationFingerprint;

  function changeName(next: string) {
    setName(next);
    if (!slugTouched) setSlug(slugify(next));
  }

  function choosePath(next: CreationPath) {
    setPath(next);
    setError(null);
    if (next !== "generate") setPreview(null);
  }

  async function runGeneration() {
    setError(null);
    const requestedFingerprint = currentGenerationFingerprint;
    try {
      const result = await generate.mutateAsync(generationInput);
      setPreview(result);
      setPreviewFingerprint(requestedFingerprint);
      if (!name.trim()) changeName(result.summary.slice(0, 120));
    } catch (generationError) {
      setError(formatError(generationError));
    }
  }

  async function createDraft() {
    if (!name.trim() || !slug.trim()) {
      setError("Display name and workflow slug are required.");
      return;
    }
    if (path === "import") {
      onClose();
      onImport?.({ slug: slug.trim(), name: name.trim() });
      return;
    }
    let source: CreateWorkflowBody["source"];
    if (path === "blank") source = { type: "blank" };
    else if (path === "template") {
      if (!templateId) {
        setError("Choose a template first.");
        return;
      }
      source = { type: "template", templateId };
    } else if (path === "clone") {
      if (!cloneSlug) {
        setError("Choose a source workflow first.");
        return;
      }
      source = {
        type: "clone",
        workflowSlug: cloneSlug,
        versionId: cloneVersionId || undefined,
      };
    } else {
      if (!previewIsCurrent || !preview) {
        setError("Generate and review a current workflow proposal first.");
        return;
      }
      source = { type: "manifest", manifest: preview.manifest };
    }

    setError(null);
    try {
      const workflow = await create.mutateAsync({
        name: name.trim(),
        slug: slug.trim(),
        description:
          path === "generate" ? purpose.trim() : `Created from ${path}.`,
        source,
        model: path === "clone" && !overrideCloneModel ? undefined : model,
      });
      onCreated?.(workflow);
      onClose();
    } catch (createError) {
      setError(formatError(createError));
    }
  }

  const ready =
    name.trim().length > 0 &&
    slug.trim().length > 0 &&
    (path !== "generate" || preview !== null);
  const canCreate = ready && (path !== "generate" || previewIsCurrent);

  return (
    <ModalOverlay onClose={onClose} ariaLabel="Create a new workflow">
      <div
        style={{
          width: "min(980px, calc(100vw - 32px))",
          maxHeight: "92vh",
          background: "var(--panel)",
          border: "1px solid var(--border-2)",
          borderRadius: 8,
          overflow: "hidden",
          boxShadow: "0 24px 60px -20px rgba(0,0,0,0.7)",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <header
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "16px 20px",
            borderBottom: "1px solid var(--border)",
          }}
        >
          <Icon name="workflow" size={15} style={{ color: "var(--signal)" }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{ fontSize: 15, color: "var(--text)", fontWeight: 600 }}
            >
              New workflow
            </div>
            <div
              style={{ fontSize: 11.5, color: "var(--text-3)", marginTop: 2 }}
            >
              Every path creates an editable draft. Publishing live is a
              separate action.
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close new workflow dialog"
            style={{ color: "var(--text-3)" }}
          >
            <Icon name="x" size={13} />
          </button>
        </header>

        <div style={{ padding: 20, overflow: "auto", flex: 1 }}>
          <SectionLabel>Start from</SectionLabel>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
              gap: 8,
              marginBottom: 22,
            }}
          >
            <PathCard
              active={path === "generate"}
              onClick={() => choosePath("generate")}
              icon="spark"
              title="Generate with AI"
              sub="Purpose, research, and process documents."
            />
            <PathCard
              active={path === "blank"}
              onClick={() => choosePath("blank")}
              icon="plus"
              title="Blank canvas"
              sub="One safe starter agent."
            />
            <PathCard
              active={path === "template"}
              onClick={() => choosePath("template")}
              icon="workflow"
              title="Template"
              sub="Maintained workflow patterns."
            />
            <PathCard
              active={path === "clone"}
              onClick={() => choosePath("clone")}
              icon="git"
              title="Existing workflow"
              sub="Clone a full draft snapshot."
            />
            <PathCard
              active={path === "import"}
              onClick={() => choosePath("import")}
              icon="upload"
              title="Import manifest"
              sub="Validate, resolve, and create an editable draft."
            />
          </div>

          <>
            <SectionLabel>Identity</SectionLabel>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
                gap: 10,
                marginBottom: 20,
              }}
            >
              <Field label="Display name">
                <TextInput
                  value={name}
                  onChange={changeName}
                  placeholder="Customer support triage"
                />
              </Field>
              <Field label="Workflow id (slug)">
                <TextInput
                  value={slug}
                  onChange={(value) => {
                    setSlugTouched(true);
                    setSlug(slugify(value));
                  }}
                  placeholder="customer-support-triage"
                  mono
                />
              </Field>
              <Field label="Tenant">
                <div style={readOnlyFieldStyle}>{tenant}</div>
              </Field>
              {path !== "import" &&
                (path !== "clone" || overrideCloneModel) && (
                  <Field
                    label={
                      path === "clone" ? "Model override" : "Default model"
                    }
                  >
                    <select
                      value={modelKey}
                      onChange={(event) => setModelKey(event.target.value)}
                      style={controlStyle}
                    >
                      {!fleet.length && (
                        <option value="">Workspace default</option>
                      )}
                      {fleet.map((entry) => (
                        <option
                          key={entry.id}
                          value={`${entry.provider}::${entry.modelName}`}
                        >
                          {entry.alias} · {entry.provider}
                        </option>
                      ))}
                    </select>
                  </Field>
                )}
            </div>
          </>

          {path === "generate" && (
            <GenerationPanel
              purpose={purpose}
              onPurpose={setPurpose}
              folder={documentFolder}
              onFolder={setDocumentFolder}
              folders={foldersQuery.data?.folders ?? []}
              webResearch={webResearch}
              onWebResearch={setWebResearch}
              constraints={constraintsText}
              onConstraints={setConstraintsText}
              expectedOutputs={outputsText}
              onExpectedOutputs={setOutputsText}
              preview={preview}
              previewStale={preview !== null && !previewIsCurrent}
              pending={generate.isPending}
              onGenerate={() => void runGeneration()}
            />
          )}

          {path === "blank" && (
            <InfoPanel
              title="Blank starter"
              body="Creates one production-shaped starter agent with editable prompt, typed input/output, a logic action, conservative limits, and a completion event. Add and connect nodes on the canvas."
            />
          )}

          {path === "template" && (
            <TemplatePicker
              templates={templates}
              selected={templateId}
              onSelect={setTemplateId}
              loading={templatesQuery.isLoading}
            />
          )}

          {path === "clone" && (
            <div>
              <SectionLabel>Source workflow</SectionLabel>
              {workflowsQuery.isLoading ? (
                <InfoPanel
                  title="Loading workflows…"
                  body="Reading immutable workflow versions for this tenant."
                />
              ) : workflows.length === 0 ? (
                <InfoPanel
                  title="No workflows to clone"
                  body="Create from AI, Blank canvas, Template, or Import instead."
                />
              ) : (
                <div style={{ display: "grid", gap: 8 }}>
                  {workflows.map((workflow) => (
                    <button
                      type="button"
                      key={workflow.id}
                      onClick={() => {
                        setCloneSlug(workflow.slug);
                        setCloneVersionId("");
                      }}
                      style={{
                        ...choiceStyle,
                        borderColor:
                          cloneSlug === workflow.slug
                            ? "var(--signal)"
                            : "var(--border)",
                        background:
                          cloneSlug === workflow.slug
                            ? "var(--panel-3)"
                            : "var(--panel-2)",
                      }}
                    >
                      <span style={{ color: "var(--text)", fontWeight: 600 }}>
                        {workflow.name}
                      </span>
                      <Badge
                        tone={workflow.status === "live" ? "green" : "muted"}
                      >
                        {workflow.status}
                      </Badge>
                      <span
                        className="mono"
                        style={{ color: "var(--text-3)", marginLeft: "auto" }}
                      >
                        {workflow.latestVersion} · {workflow.agentCount} agents
                      </span>
                    </button>
                  ))}
                  {cloneDetailQuery.data && (
                    <div
                      style={{
                        display: "grid",
                        gridTemplateColumns:
                          "repeat(auto-fit, minmax(240px, 1fr))",
                        gap: 10,
                        marginTop: 4,
                      }}
                    >
                      <Field label="Immutable source version">
                        <select
                          value={
                            cloneVersionId ||
                            cloneDetailQuery.data.latestVersionId
                          }
                          onChange={(event) =>
                            setCloneVersionId(event.target.value)
                          }
                          style={controlStyle}
                        >
                          {cloneDetailQuery.data.versions.map((version) => (
                            <option key={version.id} value={version.id}>
                              {version.version} · {version.status} ·{" "}
                              {version.agentCount} agents
                            </option>
                          ))}
                        </select>
                      </Field>
                      <label
                        style={{ ...choiceStyle, alignItems: "flex-start" }}
                      >
                        <input
                          type="checkbox"
                          checked={overrideCloneModel}
                          onChange={(event) =>
                            setOverrideCloneModel(event.target.checked)
                          }
                          style={{ marginTop: 2, accentColor: "var(--signal)" }}
                        />
                        <span>
                          <span
                            style={{
                              display: "block",
                              color: "var(--text)",
                              fontSize: 12.5,
                            }}
                          >
                            Override source models
                          </span>
                          <span
                            style={{
                              display: "block",
                              color: "var(--text-3)",
                              fontSize: 11,
                              marginTop: 3,
                            }}
                          >
                            Off by default so prompts, parameters, tools,
                            providers, and models are cloned exactly.
                          </span>
                        </span>
                      </label>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {path === "import" && (
            <InfoPanel
              title="Advanced manifest import"
              body="Continue to the six-step importer to upload or paste JSON, fetch an HTTPS source, validate the schema and graph, resolve conflicts, and create an editable server-backed draft. Live runs are unchanged."
            />
          )}

          {error && (
            <div
              role="alert"
              style={{
                marginTop: 14,
                padding: "10px 12px",
                border: "1px solid rgba(255,100,112,0.35)",
                background: "rgba(255,100,112,0.08)",
                borderRadius: 5,
                color: "var(--red)",
                fontSize: 12,
              }}
            >
              {error}
            </div>
          )}
        </div>

        <footer
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "12px 20px",
            borderTop: "1px solid var(--border)",
            background: "var(--panel-2)",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              fontSize: 11,
              color: "var(--text-3)",
            }}
          >
            <Icon name="check" size={10} style={{ color: "var(--green)" }} />
            <span>
              {path === "import"
                ? "The importer will validate before creating an editable draft."
                : "Creates a server-backed draft; live runs are unchanged."}
            </span>
          </div>
          <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
            <Button tone="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              tone="primary"
              icon={path === "import" ? "chevron-right" : "check"}
              onClick={() => void createDraft()}
              disabled={!canCreate || create.isPending}
            >
              {create.isPending
                ? "Creating…"
                : path === "import"
                  ? "Continue to import"
                  : "Create draft"}
            </Button>
          </div>
        </footer>
      </div>
    </ModalOverlay>
  );
}

function GenerationPanel({
  purpose,
  onPurpose,
  folder,
  onFolder,
  folders,
  webResearch,
  onWebResearch,
  constraints,
  onConstraints,
  expectedOutputs,
  onExpectedOutputs,
  preview,
  previewStale,
  pending,
  onGenerate,
}: {
  purpose: string;
  onPurpose: (value: string) => void;
  folder: string;
  onFolder: (value: string) => void;
  folders: Array<{ path: string; name: string; fileCount: number }>;
  webResearch: boolean;
  onWebResearch: (value: boolean) => void;
  constraints: string;
  onConstraints: (value: string) => void;
  expectedOutputs: string;
  onExpectedOutputs: (value: string) => void;
  preview: GenerateWorkflowResponse | null;
  previewStale: boolean;
  pending: boolean;
  onGenerate: () => void;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div>
        <SectionLabel>Workflow purpose</SectionLabel>
        <textarea
          value={purpose}
          onChange={(event) => onPurpose(event.target.value)}
          rows={5}
          maxLength={12_000}
          placeholder="Describe the business outcome, who or what starts the process, decisions and approvals, expected deliverables, systems involved, and important rules."
          style={{ ...controlStyle, resize: "vertical", lineHeight: 1.55 }}
        />
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            marginTop: 5,
            fontSize: 10.5,
            color: "var(--text-3)",
          }}
        >
          <span>
            Minimum 20 characters. Specific constraints produce better agent
            prompts.
          </span>
          <span className="mono">{purpose.length}/12000</span>
        </div>
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
          gap: 10,
        }}
      >
        <Field label="Process document folder (optional)">
          <select
            value={folder}
            onChange={(event) => onFolder(event.target.value)}
            style={controlStyle}
          >
            <option value="">No folder</option>
            {folders.map((item) => (
              <option key={item.path || "__root__"} value={item.path || "."}>
                {item.name} · {item.fileCount} files
              </option>
            ))}
          </select>
        </Field>
        <label style={{ ...choiceStyle, alignItems: "flex-start" }}>
          <input
            type="checkbox"
            checked={webResearch}
            onChange={(event) => onWebResearch(event.target.checked)}
            style={{ marginTop: 2, accentColor: "var(--signal)" }}
          />
          <span>
            <span
              style={{ display: "block", color: "var(--text)", fontSize: 12.5 }}
            >
              Research relevant functionality
            </span>
            <span
              style={{
                display: "block",
                color: "var(--text-3)",
                fontSize: 11,
                marginTop: 3,
              }}
            >
              Uses the configured tenant search provider. Missing credentials
              become a visible warning.
            </span>
          </span>
        </label>
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
          gap: 10,
        }}
      >
        <Field label="Constraints (one per line)">
          <textarea
            aria-label="Workflow constraints"
            value={constraints}
            onChange={(event) => onConstraints(event.target.value)}
            rows={4}
            maxLength={60_000}
            placeholder={
              "Keep customer data in-region\nRequire human approval above $10,000"
            }
            style={{ ...controlStyle, resize: "vertical", lineHeight: 1.45 }}
          />
        </Field>
        <Field label="Expected outputs (one per line)">
          <textarea
            aria-label="Expected workflow outputs"
            value={expectedOutputs}
            onChange={(event) => onExpectedOutputs(event.target.value)}
            rows={4}
            maxLength={30_000}
            placeholder={"Approved case decision\nAuditable decision record"}
            style={{ ...controlStyle, resize: "vertical", lineHeight: 1.45 }}
          />
        </Field>
      </div>
      <div>
        <Button
          tone="primary"
          icon="spark"
          onClick={onGenerate}
          disabled={pending || purpose.trim().length < 20}
        >
          {pending
            ? "Architecting workflow…"
            : preview
              ? "Regenerate proposal"
              : "Generate proposal"}
        </Button>
      </div>
      {preview && (
        <div
          style={{
            border: "1px solid var(--border-2)",
            borderRadius: 6,
            overflow: "hidden",
          }}
        >
          <div
            style={{
              padding: "12px 14px",
              background: "var(--panel-2)",
              borderBottom: "1px solid var(--border)",
              display: "flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            <Icon name="spark" size={12} style={{ color: "var(--signal)" }} />
            <span
              style={{ color: "var(--text)", fontSize: 13, fontWeight: 600 }}
            >
              {preview.summary}
            </span>
            <Badge tone={preview.validation.valid ? "green" : "amber"}>
              {previewStale
                ? "STALE — REGENERATE"
                : preview.validation.valid
                  ? "VALID"
                  : "NEEDS REVIEW"}
            </Badge>
            <span
              className="mono"
              style={{
                marginLeft: "auto",
                color: "var(--text-3)",
                fontSize: 10.5,
              }}
            >
              {preview.manifest.agents.length} agents ·{" "}
              {preview.modelSelection.provider}/{preview.modelSelection.model}
            </span>
          </div>
          <div style={{ padding: 14 }}>
            {previewStale && (
              <div
                role="alert"
                style={{ ...previewAlertStyle, marginBottom: 10 }}
              >
                Generator inputs changed after this proposal was created. This
                preview cannot be used to create a draft until it is
                regenerated.
              </div>
            )}
            <div
              style={{
                color: "var(--text-2)",
                fontSize: 11.5,
                lineHeight: 1.55,
                marginBottom: 10,
              }}
            >
              {preview.rationale}
            </div>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
                gap: 8,
              }}
            >
              {preview.manifest.agents.map((agent) => {
                const score = preview.validation.promptScores.find(
                  (item) => item.agentId === agent.id,
                );
                return (
                  <div
                    key={agent.id}
                    style={{
                      padding: "9px 10px",
                      background: "var(--panel-2)",
                      border: "1px solid var(--border)",
                      borderRadius: 4,
                    }}
                  >
                    <div
                      style={{ display: "flex", gap: 6, alignItems: "center" }}
                    >
                      <span
                        style={{
                          color: "var(--text)",
                          fontSize: 12,
                          fontWeight: 600,
                        }}
                      >
                        {agent.title ?? agent.name}
                      </span>
                      <Badge
                        tone={agent.actor[0] === "Human" ? "violet" : "muted"}
                      >
                        {agent.actor[0]}
                      </Badge>
                    </div>
                    <div
                      className="mono"
                      style={{
                        color: "var(--text-3)",
                        fontSize: 10,
                        marginTop: 5,
                      }}
                    >
                      {agent.id}
                    </div>
                    {agent.actor[0] !== "Human" && (
                      <div
                        style={{
                          color: score?.missing.length
                            ? "var(--amber)"
                            : "var(--green)",
                          fontSize: 10.5,
                          marginTop: 5,
                        }}
                      >
                        Prompt rubric {score?.score ?? 0}/
                        {score?.required ?? 11}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            {(preview.warnings.length > 0 || preview.risks.length > 0) && (
              <div
                style={{ marginTop: 10, color: "var(--amber)", fontSize: 11 }}
              >
                {[...preview.warnings, ...preview.risks]
                  .slice(0, 4)
                  .join(" · ")}
              </div>
            )}
            <PreviewSection title="Assumptions" items={preview.assumptions} />
            <PreviewSection title="Risks" items={preview.risks} />
            <PreviewSection title="Warnings" items={preview.warnings} />
            <PreviewSection
              title="Validation"
              items={preview.validation.issues.map(
                (issue) =>
                  `${issue.severity.toUpperCase()} · ${issue.path}: ${issue.message}`,
              )}
              empty="No manifest validation issues."
            />
            <PreviewSection
              title="Sources"
              items={preview.sources.map((source) =>
                [
                  `${source.kind.toUpperCase()} · ${source.title}`,
                  source.reference,
                  source.query ? `query: ${source.query}` : "",
                  source.snippet ?? "",
                ]
                  .filter(Boolean)
                  .join(" — "),
              )}
              empty="No external sources were used."
            />
            {preview.documents && (
              <PreviewSection
                title="Document diagnostics"
                items={[
                  `${preview.documents.filesIncluded}/${preview.documents.filesSeen} files included · ${preview.documents.totalCharacters.toLocaleString()} characters${preview.documents.truncated ? " · truncated" : ""}`,
                  ...preview.documents.diagnostics.map(
                    (diagnostic) =>
                      `${diagnostic.status.toUpperCase()} · ${diagnostic.path}${diagnostic.reason ? `: ${diagnostic.reason}` : ""}`,
                  ),
                ]}
              />
            )}
            <div style={{ marginTop: 12, display: "grid", gap: 8 }}>
              <div style={previewSectionTitleStyle}>Agent design details</div>
              {preview.manifest.agents.map((agent) => (
                <details
                  key={`${agent.id}-details`}
                  style={previewDetailsStyle}
                >
                  <summary style={previewSummaryStyle}>
                    {agent.title ?? agent.name} · prompts, actions, tools,
                    events
                  </summary>
                  <PreviewCode
                    label="System prompt"
                    value={agent.ontology_instructions}
                  />
                  <PreviewCode
                    label="User prompt"
                    value={agent.user_prompt_template}
                  />
                  <PreviewCode label="Actions" value={agent.actions} />
                  <PreviewCode label="Tools" value={agent.tool_use ?? []} />
                  <PreviewCode
                    label="Events"
                    value={{
                      listensFor: agent.trigger,
                      emits: agent.triggered_event,
                    }}
                  />
                </details>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function PreviewSection({
  title,
  items,
  empty,
}: {
  title: string;
  items: string[];
  empty?: string;
}) {
  if (items.length === 0 && !empty) return null;
  return (
    <div style={{ marginTop: 12 }}>
      <div style={previewSectionTitleStyle}>{title}</div>
      <ul
        style={{ margin: "6px 0 0", paddingLeft: 18, color: "var(--text-2)" }}
      >
        {(items.length ? items : [empty ?? "None"]).map((item, index) => (
          <li
            key={`${title}-${index}`}
            style={{ fontSize: 11, lineHeight: 1.55 }}
          >
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}

function PreviewCode({ label, value }: { label: string; value: unknown }) {
  const rendered =
    typeof value === "string" ? value : JSON.stringify(value ?? null, null, 2);
  return (
    <div style={{ marginTop: 9 }}>
      <div style={previewSectionTitleStyle}>{label}</div>
      <pre
        style={{
          margin: "5px 0 0",
          padding: 9,
          maxHeight: 220,
          overflow: "auto",
          whiteSpace: "pre-wrap",
          background: "var(--bg)",
          border: "1px solid var(--border)",
          borderRadius: 4,
          color: "var(--text-2)",
          fontSize: 10.5,
          lineHeight: 1.5,
        }}
      >
        {rendered || "(not configured)"}
      </pre>
    </div>
  );
}

function TemplatePicker({
  templates,
  selected,
  onSelect,
  loading,
}: {
  templates: Array<{
    id: string;
    name: string;
    description: string;
    agentCount: number;
    actionCount: number;
    eventCount: number;
    hasHumanTask: boolean;
  }>;
  selected: string;
  onSelect: (id: string) => void;
  loading: boolean;
}) {
  return (
    <div>
      <SectionLabel>Template catalog</SectionLabel>
      {loading ? (
        <InfoPanel
          title="Loading templates…"
          body="Validating the server-owned catalog."
        />
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(270px, 1fr))",
            gap: 8,
          }}
        >
          {templates.map((template) => (
            <button
              type="button"
              key={template.id}
              onClick={() => onSelect(template.id)}
              style={{
                padding: "12px 14px",
                background:
                  selected === template.id
                    ? "var(--panel-3)"
                    : "var(--panel-2)",
                border: `1px solid ${selected === template.id ? "var(--signal)" : "var(--border)"}`,
                borderRadius: 5,
                textAlign: "left",
              }}
            >
              <div style={{ display: "flex", gap: 7, alignItems: "center" }}>
                <Icon
                  name="workflow"
                  size={11}
                  style={{
                    color:
                      selected === template.id
                        ? "var(--signal)"
                        : "var(--text-3)",
                  }}
                />
                <span
                  style={{
                    color: "var(--text)",
                    fontSize: 12.5,
                    fontWeight: 600,
                  }}
                >
                  {template.name}
                </span>
                {template.hasHumanTask && <Badge tone="violet">HITL</Badge>}
                {selected === template.id && (
                  <Icon
                    name="check"
                    size={10}
                    style={{ color: "var(--signal)", marginLeft: "auto" }}
                  />
                )}
              </div>
              <div
                style={{
                  color: "var(--text-2)",
                  fontSize: 11.5,
                  lineHeight: 1.45,
                  marginTop: 7,
                }}
              >
                {template.description}
              </div>
              <div
                className="mono"
                style={{ color: "var(--text-3)", fontSize: 10.5, marginTop: 7 }}
              >
                {template.agentCount} agents · {template.actionCount} actions ·{" "}
                {template.eventCount} events
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
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

function PathCard({
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
      type="button"
      onClick={onClick}
      aria-pressed={active}
      style={{
        padding: "12px 13px",
        background: active ? "var(--panel-3)" : "var(--panel-2)",
        border: `1px solid ${active ? "var(--signal)" : "var(--border)"}`,
        borderRadius: 5,
        textAlign: "left",
        minHeight: 86,
      }}
    >
      <div
        style={{
          display: "flex",
          gap: 7,
          alignItems: "center",
          marginBottom: 6,
        }}
      >
        <Icon
          name={icon}
          size={12}
          style={{ color: active ? "var(--signal)" : "var(--text-2)" }}
        />
        <span style={{ fontSize: 12.5, color: "var(--text)", fontWeight: 600 }}>
          {title}
        </span>
      </div>
      <div style={{ fontSize: 11, color: "var(--text-3)", lineHeight: 1.4 }}>
        {sub}
      </div>
    </button>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span
        style={{
          fontSize: 10.5,
          fontFamily: "var(--mono)",
          color: "var(--text-3)",
          textTransform: "uppercase",
          letterSpacing: "0.06em",
        }}
      >
        {label}
      </span>
      {children}
    </label>
  );
}

function TextInput({
  value,
  onChange,
  placeholder,
  mono,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  mono?: boolean;
}) {
  return (
    <input
      value={value}
      onChange={(event) => onChange(event.target.value)}
      placeholder={placeholder}
      style={{
        ...controlStyle,
        fontFamily: mono ? "var(--mono)" : "var(--sans)",
      }}
    />
  );
}

function InfoPanel({ title, body }: { title: string; body: string }) {
  return (
    <div
      style={{
        padding: 16,
        background: "var(--panel-2)",
        border: "1px dashed var(--border-2)",
        borderRadius: 6,
      }}
    >
      <div style={{ color: "var(--text)", fontSize: 12.5, fontWeight: 600 }}>
        {title}
      </div>
      <div
        style={{
          color: "var(--text-3)",
          fontSize: 11.5,
          lineHeight: 1.55,
          marginTop: 6,
        }}
      >
        {body}
      </div>
    </div>
  );
}

const controlStyle: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  background: "var(--panel-2)",
  border: "1px solid var(--border-2)",
  borderRadius: 4,
  padding: "7px 9px",
  color: "var(--text)",
  fontSize: 12,
  outline: "none",
};

const readOnlyFieldStyle: React.CSSProperties = {
  ...controlStyle,
  color: "var(--text-2)",
  fontFamily: "var(--mono)",
};

const choiceStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "10px 12px",
  background: "var(--panel-2)",
  border: "1px solid var(--border)",
  borderRadius: 5,
  textAlign: "left",
};

const previewAlertStyle: React.CSSProperties = {
  padding: "9px 10px",
  border: "1px solid rgba(255,181,71,0.35)",
  background: "rgba(255,181,71,0.08)",
  borderRadius: 4,
  color: "var(--amber)",
  fontSize: 11,
  lineHeight: 1.5,
};

const previewSectionTitleStyle: React.CSSProperties = {
  color: "var(--text-3)",
  fontFamily: "var(--mono)",
  fontSize: 10,
  letterSpacing: "0.06em",
  textTransform: "uppercase",
};

const previewDetailsStyle: React.CSSProperties = {
  padding: "8px 10px",
  border: "1px solid var(--border)",
  borderRadius: 4,
  background: "var(--panel-2)",
};

const previewSummaryStyle: React.CSSProperties = {
  cursor: "pointer",
  color: "var(--text)",
  fontSize: 11.5,
  fontWeight: 600,
};
