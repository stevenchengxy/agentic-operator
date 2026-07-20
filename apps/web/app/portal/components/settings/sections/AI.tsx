"use client";

import {
  Children,
  cloneElement,
  createContext,
  isValidElement,
  useContext,
  useEffect,
  useId,
  useMemo,
  useState,
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import {
  GatewayInstanceSchema,
  LlmSettingsSchema,
  behavioralProviderForCandidate,
  findCatalogModel,
  parseModelRouteId,
  type CatalogModel,
  type DefaultTaskRoutingProfile,
  type GatewayInstance,
  type LlmSettings,
  type ReasoningConfig,
  type RouteFallbackCondition,
  type TaskModelParameters,
  type TaskRouteCandidate,
  type TaskRoutingProfile,
  type TaskWorkloadProfile,
  type TextVerbosity,
} from "@agentic/contracts";
import { Badge, Button, Empty, Icon, Panel } from "@/app/portal/components";
import { ModelsSection } from "@/app/portal/components/settings/sections/Models";
import { useDirty } from "@/app/portal/lib/dirty-context";
import { useTenant } from "@/app/portal/lib/use-tenant";
import {
  LlmSettingsApiError,
  useGatewayModels,
  useLlmSettings,
  useResolveLlmRouting,
  useResyncLlmSettings,
  useSaveGatewayKey,
  useSaveLlmSettings,
  useTestGatewayConnection,
  useTestLlmCall,
  type GatewayCredentialMeta,
  type TestCallInput,
} from "@/lib/hooks/useLlmSettings";

type AiTab = "routing" | "connections" | "models" | "test";

const AI_TABS: Array<{ id: AiTab; label: string; hint: string }> = [
  {
    id: "routing",
    label: "Routing & defaults",
    hint: "Map task classes to primary and fallback models",
  },
  {
    id: "connections",
    label: "Provider connections",
    hint: "Direct providers, OpenRouter, and NewAPI instances",
  },
  {
    id: "models",
    label: "Model routes",
    hint: "Browse the current model catalog and tenant fleet",
  },
  {
    id: "test",
    label: "Test lab",
    hint: "Run a billable prompt and inspect routing and usage",
  },
];

const REQUIRED_TASKS = [
  {
    id: "ontology.generate",
    label: "Ontology generation",
    description: "Schema, class, relationship, and ontology generation.",
  },
  {
    id: "evaluation.run",
    label: "Evaluation",
    description: "Rubrics, graders, quality evaluation, and comparison runs.",
  },
  {
    id: "assistant.suggest",
    label: "AI suggestion",
    description: "Inline suggestions, completions, and operator assistance.",
  },
  {
    id: "chat.respond",
    label: "Chat",
    description: "Interactive assistant and conversational responses.",
  },
  {
    id: "ontogene.generate",
    label: "OntoGene",
    description: "OntoGene-specific generation and transformation.",
  },
  {
    id: "graph.query",
    label: "Graph Engine query",
    description: "Natural-language graph queries and result synthesis.",
  },
  {
    id: "file.parse",
    label: "File parsing",
    description: "Document extraction, parsing, and structured output.",
  },
] as const;

const WORKLOADS: TaskWorkloadProfile[] = [
  "quality",
  "balanced",
  "fast",
  "low-cost",
  "structured",
  "long-context",
  "tool-use",
];

const ALL_REASONING_EFFORTS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
const ALL_REASONING_MODES = ["standard", "pro"] as const;
const ALL_REASONING_SUMMARIES = [
  "none",
  "auto",
  "concise",
  "detailed",
] as const;
const ALL_REASONING_CONTEXTS = ["auto", "current_turn", "all_turns"] as const;
const ALL_VERBOSITIES = ["low", "medium", "high"] as const;
const FALLBACK_CONDITIONS: RouteFallbackCondition[] = [
  "rate_limit",
  "timeout",
  "network",
  "provider_error",
  "not_configured",
  "auth",
  "model_not_found",
];
const CONTROL_STYLE: CSSProperties = {
  width: "100%",
  minWidth: 0,
  minHeight: 34,
  padding: "7px 9px",
  border: "1px solid var(--border-2)",
  borderRadius: 5,
  outline: "none",
  background: "var(--panel-2)",
  color: "var(--text)",
  fontFamily: "var(--sans)",
  fontSize: 12,
};

function cloneSettings<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function errorText(error: unknown): string {
  if (error instanceof LlmSettingsApiError) {
    return error.hint ? `${error.message} ${error.hint}` : error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

function routeGatewayId(route: string): string {
  return route.slice(0, Math.max(0, route.indexOf("/")));
}

function gatewayIsReferenced(settings: LlmSettings, id: string): boolean {
  return [
    ...settings.defaultProfile.candidates,
    ...settings.taskProfiles.flatMap((profile) => profile.candidates),
  ].some((candidate) => routeGatewayId(candidate.route) === id);
}

function inferCatalogModel(
  settings: LlmSettings,
  route: string,
  modelFamily?: string,
): {
  model?: CatalogModel;
  provider?: ReturnType<typeof behavioralProviderForCandidate>;
  knownRoute: boolean;
} {
  try {
    const parsed = parseModelRouteId(route);
    const gateway = settings.gatewayInstances.find(
      (candidate) => candidate.id === parsed.gatewayInstanceId,
    );
    if (!gateway) return { knownRoute: false };

    const provider = behavioralProviderForCandidate(gateway, {
      route: parsed.id,
      enabled: true,
      ...(modelFamily ? { modelFamily } : {}),
    } as TaskRouteCandidate);
    if (!provider) return { knownRoute: true };

    let nativeModel = String(parsed.modelId);
    if (provider !== "openrouter" && nativeModel.includes("/")) {
      nativeModel = nativeModel.slice(nativeModel.lastIndexOf("/") + 1);
    }
    return {
      knownRoute: true,
      provider,
      model: findCatalogModel(provider, nativeModel),
    };
  } catch {
    return { knownRoute: false };
  }
}

function sanitizeForModel(
  profile: DefaultTaskRoutingProfile | TaskRoutingProfile,
  model?: CatalogModel,
): DefaultTaskRoutingProfile | TaskRoutingProfile {
  if (!model) return profile;
  return {
    ...profile,
    parameters: sanitizeParametersForModel(profile.parameters, model),
  };
}

function sanitizeParametersForModel(
  current: TaskModelParameters | undefined,
  model?: CatalogModel,
): TaskModelParameters | undefined {
  if (!current || !model) return current;
  const parameters = { ...current };
  const maxOutputTokens = model.out ?? model.ctx;
  if (
    parameters.maxTokens !== undefined &&
    parameters.maxTokens > maxOutputTokens
  ) {
    parameters.maxTokens = maxOutputTokens;
  }
  if (model.temperatureRange === null) delete parameters.temperature;
  if (!model.reasoning) delete parameters.reasoning;
  if (!model.textVerbosities?.length) delete parameters.verbosity;
  return Object.keys(parameters).length ? parameters : undefined;
}

export function AISection() {
  const tenant = useTenant();
  const dirtyStore = useDirty();
  const snapshot = useLlmSettings();
  const save = useSaveLlmSettings();
  const resync = useResyncLlmSettings();
  const [tab, setTab] = useState<AiTab>("routing");
  const [draft, setDraft] = useState<LlmSettings | null>(null);
  const [baseline, setBaseline] = useState<LlmSettings | null>(null);
  const [draftTenant, setDraftTenant] = useState(tenant);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);

  useEffect(() => {
    if (draftTenant === tenant) return;
    setDraftTenant(tenant);
    setDraft(null);
    setBaseline(null);
    setMessage(null);
    setError(null);
    setConflict(false);
  }, [draftTenant, tenant]);

  useEffect(() => {
    if (draftTenant !== tenant || !snapshot.data?.settings || draft !== null)
      return;
    const next = cloneSettings(snapshot.data.settings);
    setDraft(next);
    setBaseline(cloneSettings(next));
  }, [snapshot.data?.settings, draft, draftTenant, tenant]);

  const dirty = useMemo(
    () =>
      Boolean(
        draftTenant === tenant &&
        draft &&
        baseline &&
        JSON.stringify(draft) !== JSON.stringify(baseline),
      ),
    [draft, baseline, draftTenant, tenant],
  );

  useEffect(() => {
    dirtyStore.setDirty(
      "ai-settings",
      dirty ? `AI settings for ${tenant}` : null,
    );
    return () => dirtyStore.setDirty("ai-settings", null);
  }, [dirty, dirtyStore, tenant]);

  useEffect(() => {
    if (!dirty) return;
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeUnload);
    return () => window.removeEventListener("beforeunload", warnBeforeUnload);
  }, [dirty]);

  function selectTabFromKeyboard(
    event: ReactKeyboardEvent<HTMLButtonElement>,
    current: AiTab,
  ) {
    const index = AI_TABS.findIndex((candidate) => candidate.id === current);
    let nextIndex: number | undefined;
    if (event.key === "ArrowRight") nextIndex = (index + 1) % AI_TABS.length;
    if (event.key === "ArrowLeft")
      nextIndex = (index - 1 + AI_TABS.length) % AI_TABS.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = AI_TABS.length - 1;
    if (nextIndex === undefined) return;
    event.preventDefault();
    const next = AI_TABS[nextIndex];
    if (!next) return;
    setTab(next.id);
    requestAnimationFrame(() => {
      document.getElementById(`ai-tab-${next.id}`)?.focus();
    });
  }

  async function saveSettings() {
    if (!draft || !baseline) return;
    setError(null);
    setMessage(null);
    setConflict(false);
    const parsed = LlmSettingsSchema.safeParse(draft);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      setError(
        `${first?.path.join(".") || "settings"}: ${first?.message ?? "Invalid settings"}. Check route IDs, timeouts, and gateway URLs.`,
      );
      return;
    }
    try {
      const result = await save.mutateAsync({
        expectedRevision: baseline.revision,
        settings: parsed.data,
      });
      const next = cloneSettings(result.settings);
      setDraft(next);
      setBaseline(cloneSettings(next));
      setMessage(`Saved AI settings revision ${next.revision}.`);
    } catch (saveError) {
      if (
        saveError instanceof LlmSettingsApiError &&
        saveError.status === 409
      ) {
        setConflict(true);
      }
      setError(errorText(saveError));
    }
  }

  async function loadLatest() {
    setError(null);
    const result = await snapshot.refetch();
    if (!result.data) return;
    const next = cloneSettings(result.data.settings);
    setDraft(next);
    setBaseline(cloneSettings(next));
    setConflict(false);
    setMessage(`Loaded server revision ${next.revision}.`);
  }

  async function repairMirror() {
    setError(null);
    try {
      const result = await resync.mutateAsync();
      const next = cloneSettings(result.settings);
      setDraft(next);
      setBaseline(cloneSettings(next));
      setMessage(
        "Rewrote the managed .env.local mirror from the JSON settings file.",
      );
    } catch (repairError) {
      setError(errorText(repairError));
    }
  }

  if (snapshot.isError) {
    return (
      <Panel padded>
        <Empty
          title="AI settings unavailable"
          hint={errorText(snapshot.error)}
        />
        <div
          style={{ display: "flex", justifyContent: "center", marginTop: 12 }}
        >
          <Button small onClick={() => snapshot.refetch()}>
            Retry
          </Button>
        </div>
      </Panel>
    );
  }

  if (snapshot.isLoading || draftTenant !== tenant || !draft || !baseline) {
    return (
      <Panel padded>
        <div role="status" style={{ color: "var(--text-3)", fontSize: 12 }}>
          Loading AI settings…
        </div>
      </Panel>
    );
  }

  const sync = snapshot.data?.sync;
  const credentials = snapshot.data?.credentials ?? {};

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <Panel padded>
        <div className="ai-settings-savebar">
          <div style={{ minWidth: 0 }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                flexWrap: "wrap",
                gap: 7,
              }}
            >
              <strong style={{ color: "var(--text)", fontSize: 13 }}>
                AI control plane
              </strong>
              <Badge tone={dirty ? "amber" : "muted"}>
                {dirty ? "Unsaved changes" : `Revision ${draft.revision}`}
              </Badge>
              <Badge tone={sync?.status === "drift" ? "amber" : "green"}>
                {sync?.status === "drift" ? "File drift" : "Files synced"}
              </Badge>
            </div>
            <p
              style={{
                margin: "5px 0 0",
                maxWidth: 720,
                color: "var(--text-3)",
                fontSize: 11.5,
                lineHeight: 1.55,
              }}
            >
              Routes are stored in JSON and mirrored to .env.local. API keys
              stay encrypted and are never written into either settings file.
            </p>
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
            <Button
              small
              tone="ghost"
              disabled={!dirty || save.isPending}
              onClick={() => setDraft(cloneSettings(baseline))}
            >
              Discard
            </Button>
            <Button
              small
              tone="primary"
              disabled={!dirty || save.isPending}
              onClick={saveSettings}
            >
              {save.isPending ? "Saving…" : "Save AI settings"}
            </Button>
          </div>
        </div>
      </Panel>

      {sync?.status === "drift" && (
        <Notice tone="warn" title="The JSON and .env.local mirrors differ">
          <span>
            {sync.message ?? "The managed mirror needs to be rebuilt."}
          </span>
          <Button
            small
            onClick={repairMirror}
            disabled={resync.isPending || dirty}
          >
            {resync.isPending ? "Repairing…" : "Repair mirror"}
          </Button>
          {dirty && <span>Save or discard local edits before repairing.</span>}
        </Notice>
      )}

      {conflict && (
        <Notice tone="warn" title="A newer settings revision exists">
          <span>
            Your edits were not overwritten. Load the server revision before
            applying them again.
          </span>
          <Button small onClick={loadLatest}>
            Load latest
          </Button>
        </Notice>
      )}

      {error && (
        <Notice tone="error" title="Settings action failed">
          {error}
        </Notice>
      )}
      {message && (
        <Notice tone="ok" title="Settings updated">
          {message}
        </Notice>
      )}
      <div aria-live="polite" className="ai-sr-only">
        {error ?? message ?? ""}
      </div>

      <div
        className="ai-settings-tabs"
        role="tablist"
        aria-label="AI settings areas"
        aria-orientation="horizontal"
      >
        {AI_TABS.map((item) => (
          <button
            key={item.id}
            id={`ai-tab-${item.id}`}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            aria-controls={`ai-panel-${item.id}`}
            tabIndex={tab === item.id ? 0 : -1}
            onClick={() => setTab(item.id)}
            onKeyDown={(event) => selectTabFromKeyboard(event, item.id)}
            style={{
              minWidth: 170,
              padding: "10px 12px",
              border: 0,
              borderBottom: `2px solid ${tab === item.id ? "var(--signal)" : "transparent"}`,
              background: tab === item.id ? "var(--panel-2)" : "transparent",
              color: tab === item.id ? "var(--text)" : "var(--text-2)",
              cursor: "pointer",
              textAlign: "left",
            }}
          >
            <span style={{ display: "block", fontSize: 12, fontWeight: 600 }}>
              {item.label}
            </span>
            <span
              style={{
                display: "block",
                marginTop: 2,
                color: "var(--text-3)",
                fontSize: 9.5,
              }}
            >
              {item.hint}
            </span>
          </button>
        ))}
      </div>

      <div
        key={tenant}
        id={`ai-panel-${tab}`}
        role="tabpanel"
        aria-labelledby={`ai-tab-${tab}`}
      >
        {tab === "routing" && (
          <RoutingPanel settings={draft} onChange={setDraft} dirty={dirty} />
        )}
        {tab === "connections" && (
          <ConnectionsPanel
            settings={draft}
            persisted={baseline}
            credentials={credentials}
            onChange={setDraft}
          />
        )}
        {tab === "models" && (
          <div className="ai-settings-models">
            <Notice tone="info" title="Catalog and fleet">
              Model routes use <code>gateway-instance/provider-model-id</code>.
              This existing fleet view remains the place to browse current,
              tiered, and free catalog entries.
            </Notice>
            <ModelsSection />
          </div>
        )}
        {tab === "test" && <TestLab settings={draft} dirty={dirty} />}
      </div>
    </div>
  );
}

function RoutingPanel({
  settings,
  onChange,
  dirty,
}: {
  settings: LlmSettings;
  onChange: (settings: LlmSettings) => void;
  dirty: boolean;
}) {
  const profileByTask = new Map(
    settings.taskProfiles.map((profile) => [
      String(profile.taskClass),
      profile,
    ]),
  );
  const coreTaskById = new Map<string, (typeof REQUIRED_TASKS)[number]>(
    REQUIRED_TASKS.map((task) => [task.id, task] as const),
  );
  const taskDefinitions = settings.taxonomy
    .filter((task) => task.id !== "default")
    .map((task) => ({
      id: String(task.id),
      label: task.label,
      description:
        task.description ??
        coreTaskById.get(task.id)?.description ??
        (task.parent
          ? `Inherits from ${task.parent} before falling back to the workspace default.`
          : "Uses the closest configured parent before the workspace default."),
    }));
  const knownTaskIds = new Set(taskDefinitions.map((task) => task.id));
  for (const task of REQUIRED_TASKS) {
    if (!knownTaskIds.has(task.id)) {
      taskDefinitions.push(task);
      knownTaskIds.add(task.id);
    }
  }
  for (const profile of settings.taskProfiles) {
    const id = String(profile.taskClass);
    if (!knownTaskIds.has(id)) {
      taskDefinitions.push({
        id,
        label: id,
        description:
          profile.description ??
          "Configured task profile retained outside the current taxonomy.",
      });
      knownTaskIds.add(id);
    }
  }

  function setDefault(profile: DefaultTaskRoutingProfile) {
    onChange({ ...settings, defaultProfile: profile });
  }

  function setTask(profile: TaskRoutingProfile) {
    onChange({
      ...settings,
      taskProfiles: settings.taskProfiles.some(
        (candidate) => candidate.taskClass === profile.taskClass,
      )
        ? settings.taskProfiles.map((candidate) =>
            candidate.taskClass === profile.taskClass ? profile : candidate,
          )
        : [...settings.taskProfiles, profile],
    });
  }

  function customize(taskClass: string) {
    const inherited = cloneSettings(settings.defaultProfile);
    setTask({
      ...inherited,
      taskClass: taskClass as TaskRoutingProfile["taskClass"],
      description: undefined,
    });
  }

  function removeOverride(taskClass: string) {
    onChange({
      ...settings,
      taskProfiles: settings.taskProfiles.filter(
        (profile) => profile.taskClass !== taskClass,
      ),
    });
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <Notice tone="info" title="Closest-task fallback is automatic">
        Exact and alias matches win first, followed by the nearest parent task
        class and finally the workspace default. Blank controls are omitted so
        each provider can apply its native defaults.
      </Notice>

      <ProfileEditor
        title="Workspace default"
        subtitle="Used only when no closer task profile can be resolved"
        profile={settings.defaultProfile}
        settings={settings}
        onChange={(profile) => setDefault(profile as DefaultTaskRoutingProfile)}
        alwaysOpen
      />

      <Panel
        title="Task-specific routes"
        subtitle={`${taskDefinitions.length} taxonomy and configured task classes`}
        padded
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
          {taskDefinitions.map((task) => {
            const profile = profileByTask.get(task.id);
            if (!profile) {
              return (
                <div key={task.id} className="ai-inherited-profile">
                  <div style={{ minWidth: 0 }}>
                    <strong style={{ color: "var(--text)", fontSize: 12.5 }}>
                      {task.label}
                    </strong>
                    <div
                      style={{
                        marginTop: 3,
                        color: "var(--text-3)",
                        fontSize: 11,
                        lineHeight: 1.5,
                      }}
                    >
                      {task.description}
                    </div>
                    <code
                      style={{
                        display: "block",
                        marginTop: 5,
                        color: "var(--text-2)",
                        fontSize: 10.5,
                        overflowWrap: "anywhere",
                      }}
                    >
                      Inherits {settings.defaultProfile.candidates[0]?.route}
                    </code>
                  </div>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      flexWrap: "wrap",
                      gap: 7,
                    }}
                  >
                    <Badge tone="muted">Uses default</Badge>
                    <Button small onClick={() => customize(task.id)}>
                      Customize
                    </Button>
                  </div>
                </div>
              );
            }
            return (
              <ProfileEditor
                key={task.id}
                title={task.label}
                subtitle={task.description}
                taskClass={task.id}
                profile={profile}
                settings={settings}
                onChange={(next) => setTask(next as TaskRoutingProfile)}
                onRemove={() => removeOverride(task.id)}
              />
            );
          })}
        </div>
      </Panel>

      <RoutingPreview settings={settings} dirty={dirty} />
    </div>
  );
}

function ProfileEditor({
  title,
  subtitle,
  taskClass,
  profile,
  settings,
  onChange,
  onRemove,
  alwaysOpen,
}: {
  title: string;
  subtitle: string;
  taskClass?: string;
  profile: DefaultTaskRoutingProfile | TaskRoutingProfile;
  settings: LlmSettings;
  onChange: (profile: DefaultTaskRoutingProfile | TaskRoutingProfile) => void;
  onRemove?: () => void;
  alwaysOpen?: boolean;
}) {
  const firstCandidate = profile.candidates[0];
  const firstRoute = String(firstCandidate?.route ?? "");
  const capability = inferCatalogModel(
    settings,
    firstRoute,
    firstCandidate?.modelFamily,
  );
  const model = capability.model;

  function changeProfile(
    patch: Partial<DefaultTaskRoutingProfile | TaskRoutingProfile>,
  ) {
    onChange({ ...profile, ...patch } as typeof profile);
  }

  function updateCandidate(
    index: number,
    patch: {
      route?: string;
      enabled?: boolean;
      modelFamily?: string;
      fallbackOn?: RouteFallbackCondition[] | null;
      parameters?: TaskModelParameters | null;
    },
  ) {
    const candidates = profile.candidates.map((candidate, candidateIndex) => {
      if (candidateIndex !== index) return candidate;
      const route = patch.route ?? String(candidate.route);
      const candidateModel = inferCatalogModel(
        settings,
        route,
        patch.modelFamily !== undefined
          ? patch.modelFamily.trim() || undefined
          : candidate.modelFamily,
      ).model;
      const candidateParameters =
        patch.parameters === undefined
          ? candidate.parameters
          : (patch.parameters ?? undefined);
      const next = {
        ...candidate,
        ...(patch.route !== undefined
          ? { route: patch.route as typeof candidate.route }
          : {}),
        ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
        parameters: sanitizeParametersForModel(
          candidateParameters,
          candidateModel,
        ),
      };
      if (patch.modelFamily !== undefined) {
        const modelFamily = patch.modelFamily.trim();
        if (modelFamily) {
          next.modelFamily = modelFamily as NonNullable<
            (typeof candidate)["modelFamily"]
          >;
        } else {
          delete next.modelFamily;
        }
      }
      if (patch.fallbackOn !== undefined) {
        if (patch.fallbackOn === null) delete next.fallbackOn;
        else next.fallbackOn = patch.fallbackOn;
      }
      return next;
    });
    let next = { ...profile, candidates } as typeof profile;
    if (
      index === 0 &&
      (patch.route !== undefined || patch.modelFamily !== undefined)
    ) {
      next = sanitizeForModel(
        next,
        inferCatalogModel(
          settings,
          patch.route ?? String(next.candidates[0]?.route ?? ""),
          next.candidates[0]?.modelFamily,
        ).model,
      ) as typeof profile;
    }
    onChange(next);
  }

  function removeCandidate(index: number) {
    if (profile.candidates.length === 1) return;
    onChange({
      ...profile,
      candidates: profile.candidates.filter(
        (_, candidateIndex) => candidateIndex !== index,
      ),
    } as typeof profile);
  }

  function addCandidate() {
    const seed = settings.gatewayInstances[0]?.id ?? "openai";
    onChange({
      ...profile,
      candidates: [
        ...profile.candidates,
        {
          route:
            `${seed}/model-id` as (typeof profile.candidates)[number]["route"],
          enabled: true,
          fallbackOn: [
            "rate_limit",
            "timeout",
            "network",
            "provider_error",
            "not_configured",
          ],
        },
      ],
    } as typeof profile);
  }

  function setParameter<K extends keyof TaskModelParameters>(
    key: K,
    value: TaskModelParameters[K] | undefined,
  ) {
    const parameters = { ...(profile.parameters ?? {}) };
    if (value === undefined) delete parameters[key];
    else parameters[key] = value as never;
    changeProfile({
      parameters: Object.keys(parameters).length ? parameters : undefined,
    });
  }

  function setReasoning(key: keyof ReasoningConfig, value: string) {
    const reasoning = { ...(profile.parameters?.reasoning ?? {}) };
    if (!value) delete reasoning[key];
    else reasoning[key] = value as never;
    setParameter(
      "reasoning",
      Object.keys(reasoning).length ? reasoning : undefined,
    );
  }

  const body = (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div className="ai-form-grid">
        <FormField
          label="Profile status"
          hint="Disabled profiles are skipped during task resolution."
        >
          <CheckboxControl
            checked={profile.enabled}
            onChange={(checked) => changeProfile({ enabled: checked })}
            label="Enabled"
          />
        </FormField>
        <FormField
          label="Workload"
          hint="A routing intent used by policy and telemetry."
        >
          <SelectControl
            value={profile.workload}
            onChange={(value) =>
              changeProfile({ workload: value as TaskWorkloadProfile })
            }
            options={WORKLOADS}
          />
        </FormField>
      </div>

      <div>
        <div className="ai-subheading">Route chain</div>
        <p className="ai-help-text">
          The first eligible route is selected. A route splits only on its first
          slash, so <code>openrouter/openai/gpt-5.6-sol</code> preserves the
          provider-native model ID.
        </p>
        <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
          {profile.candidates.map((candidate, index) => {
            const candidateCapability = inferCatalogModel(
              settings,
              String(candidate.route),
              candidate.modelFamily,
            );
            return (
              <div key={`${index}-${candidate.route}`} className="ai-route-row">
                <span className="ai-route-rank">
                  {index === 0 ? "Primary" : `Fallback ${index}`}
                </span>
                <input
                  className="ai-route-id"
                  value={candidate.route}
                  onChange={(event) =>
                    updateCandidate(index, { route: event.target.value })
                  }
                  aria-label={`${title} ${index === 0 ? "primary" : `fallback ${index}`} route`}
                  spellCheck={false}
                  style={{ ...CONTROL_STYLE, fontFamily: "var(--mono)" }}
                />
                <input
                  className="ai-route-family"
                  value={candidate.modelFamily ?? ""}
                  onChange={(event) =>
                    updateCandidate(index, { modelFamily: event.target.value })
                  }
                  aria-label={`${title} ${index === 0 ? "primary" : `fallback ${index}`} model family`}
                  placeholder="Model family (optional)"
                  spellCheck={false}
                  style={{ ...CONTROL_STYLE, fontFamily: "var(--mono)" }}
                />
                <label className="ai-check-label ai-route-enabled">
                  <input
                    type="checkbox"
                    checked={candidate.enabled}
                    onChange={(event) =>
                      updateCandidate(index, { enabled: event.target.checked })
                    }
                  />
                  Use
                </label>
                <Button
                  small
                  tone="ghost"
                  disabled={profile.candidates.length === 1}
                  onClick={() => removeCandidate(index)}
                  ariaLabel={`Remove ${title} route ${index + 1}`}
                >
                  <Icon name="x" size={10} />
                </Button>
                <CandidateParameterEditor
                  parameters={candidate.parameters}
                  model={candidateCapability.model}
                  onChange={(parameters) =>
                    updateCandidate(index, {
                      parameters: parameters ?? null,
                    })
                  }
                />
                <details className="ai-route-fallbacks">
                  <summary>
                    Fallback policy ·{" "}
                    {candidate.fallbackOn?.length ?? "default"}
                  </summary>
                  <div className="ai-route-fallback-options">
                    <label className="ai-check-label">
                      <input
                        type="checkbox"
                        checked={candidate.fallbackOn === undefined}
                        onChange={(event) =>
                          updateCandidate(index, {
                            fallbackOn: event.target.checked
                              ? null
                              : FALLBACK_CONDITIONS.slice(0, 5),
                          })
                        }
                      />
                      Use platform defaults
                    </label>
                    {FALLBACK_CONDITIONS.map((condition) => (
                      <label className="ai-check-label" key={condition}>
                        <input
                          type="checkbox"
                          disabled={candidate.fallbackOn === undefined}
                          checked={
                            candidate.fallbackOn?.includes(condition) ?? false
                          }
                          onChange={(event) => {
                            const current = candidate.fallbackOn ?? [];
                            updateCandidate(index, {
                              fallbackOn: event.target.checked
                                ? [...current, condition]
                                : current.filter(
                                    (value) => value !== condition,
                                  ),
                            });
                          }}
                        />
                        {condition.replaceAll("_", " ")}
                      </label>
                    ))}
                  </div>
                </details>
              </div>
            );
          })}
        </div>
        <Button
          small
          tone="ghost"
          onClick={addCandidate}
          style={{ marginTop: 8 }}
        >
          <Icon name="plus" size={10} /> Add fallback
        </Button>
      </div>

      <CapabilitySummary route={firstRoute} capability={capability} />

      <details className="ai-settings-details">
        <summary>Optional model controls</summary>
        <p className="ai-help-text">
          Leave any control blank to use the selected model or provider default.
          Unsupported controls are omitted from the request.
        </p>
        <div className="ai-form-grid">
          <FormField
            label="Reasoning mode"
            hint={
              !model
                ? "Catalog capability unknown."
                : model.reasoning
                  ? "Execution path, where supported."
                  : "This model does not support normalized reasoning controls."
            }
          >
            <SelectControl
              value={profile.parameters?.reasoning?.mode ?? ""}
              onChange={(value) => setReasoning("mode", value)}
              disabled={model?.reasoning === false}
              placeholder="Provider default"
              options={model?.reasoningModes ?? ALL_REASONING_MODES}
            />
          </FormField>
          <FormField
            label="Reasoning effort"
            hint={
              model?.reasoningMandatory
                ? "Reasoning is mandatory for this model."
                : "Higher effort can increase latency and reasoning-token cost."
            }
          >
            <SelectControl
              value={profile.parameters?.reasoning?.effort ?? ""}
              onChange={(value) => setReasoning("effort", value)}
              disabled={model?.reasoning === false}
              placeholder="Provider default"
              options={model?.reasoningEfforts ?? ALL_REASONING_EFFORTS}
            />
          </FormField>
          <FormField
            label="Reasoning summary"
            hint="Safe provider-generated summary; raw chain-of-thought is never requested."
          >
            <SelectControl
              value={profile.parameters?.reasoning?.summary ?? ""}
              onChange={(value) => setReasoning("summary", value)}
              disabled={model?.reasoning === false}
              placeholder="Provider default"
              options={model?.reasoningSummaries ?? ALL_REASONING_SUMMARIES}
            />
          </FormField>
          <FormField
            label="Reasoning context"
            hint="Controls reuse of persisted reasoning items when supported."
          >
            <SelectControl
              value={profile.parameters?.reasoning?.context ?? ""}
              onChange={(value) => setReasoning("context", value)}
              disabled={model?.reasoning === false}
              placeholder="Provider default"
              options={model?.reasoningContexts ?? ALL_REASONING_CONTEXTS}
            />
          </FormField>
          <FormField
            label="Answer verbosity"
            hint="Provider-normalized visible answer detail."
          >
            <SelectControl
              value={profile.parameters?.verbosity ?? ""}
              onChange={(value) =>
                setParameter(
                  "verbosity",
                  (value || undefined) as TextVerbosity | undefined,
                )
              }
              disabled={Boolean(model && !model.textVerbosities?.length)}
              placeholder="Provider default"
              options={model?.textVerbosities ?? ALL_VERBOSITIES}
            />
          </FormField>
          <FormField
            label="Temperature"
            hint={
              model?.temperatureRange === null
                ? "Not supported by this model; the gateway will omit it."
                : model?.temperatureRange
                  ? `Supported range ${model.temperatureRange.min}–${model.temperatureRange.max}.`
                  : "Catalog support unknown; leave blank unless verified."
            }
          >
            <NumberControl
              value={profile.parameters?.temperature}
              min={model?.temperatureRange?.min ?? 0}
              max={model?.temperatureRange?.max ?? 2}
              step={0.1}
              disabled={model?.temperatureRange === null}
              onChange={(value) => setParameter("temperature", value)}
            />
          </FormField>
          <FormField
            label="Maximum output tokens"
            hint={
              model
                ? `Blank uses the provider default; catalog ceiling ${(
                    model.out ?? model.ctx
                  ).toLocaleString("en-US")}.`
                : "Blank uses the provider/model maximum or default."
            }
          >
            <NumberControl
              value={profile.parameters?.maxTokens}
              min={1}
              max={model ? (model.out ?? model.ctx) : 1_048_576}
              step={1}
              onChange={(value) => setParameter("maxTokens", value)}
            />
          </FormField>
          <FormField
            label="Request timeout"
            hint="Per upstream attempt, in seconds."
          >
            <NumberControl
              value={
                profile.parameters?.timeoutMs === undefined
                  ? undefined
                  : profile.parameters.timeoutMs / 1000
              }
              min={1}
              max={7200}
              step={1}
              suffix="seconds"
              onChange={(value) =>
                setParameter(
                  "timeoutMs",
                  value === undefined ? undefined : value * 1000,
                )
              }
            />
          </FormField>
          <FormField
            label="Overall deadline"
            hint="Across retries and fallbacks, in seconds."
          >
            <NumberControl
              value={
                profile.parameters?.overallDeadlineMs === undefined
                  ? undefined
                  : profile.parameters.overallDeadlineMs / 1000
              }
              min={1}
              max={7200}
              step={1}
              suffix="seconds"
              onChange={(value) =>
                setParameter(
                  "overallDeadlineMs",
                  value === undefined ? undefined : value * 1000,
                )
              }
            />
          </FormField>
          <FormField
            label="JSON mode"
            hint="Request a structured JSON response where supported."
          >
            <TriStateControl
              value={profile.parameters?.jsonMode}
              onChange={(value) => setParameter("jsonMode", value)}
            />
          </FormField>
          <FormField
            label="Provider storage"
            hint="Blank keeps the platform privacy default (off for Responses); local usage logs are separate."
          >
            <TriStateControl
              value={profile.parameters?.store}
              onChange={(value) => setParameter("store", value)}
              placeholder="Platform default"
            />
          </FormField>
        </div>
      </details>

      <details className="ai-settings-details">
        <summary>Task capability requirements</summary>
        <p className="ai-help-text">
          Candidates that cannot satisfy a required capability are skipped by
          policy when capability data is available.
        </p>
        <div className="ai-checkbox-grid">
          {(["vision", "tools", "reasoning", "structuredOutput"] as const).map(
            (requirement) => (
              <label className="ai-check-label" key={requirement}>
                <input
                  type="checkbox"
                  checked={profile.requirements?.[requirement] === true}
                  onChange={(event) => {
                    const requirements = { ...(profile.requirements ?? {}) };
                    if (event.target.checked) requirements[requirement] = true;
                    else delete requirements[requirement];
                    changeProfile({
                      requirements: Object.keys(requirements).length
                        ? requirements
                        : undefined,
                    });
                  }}
                />
                {requirement === "structuredOutput"
                  ? "Structured output"
                  : requirement}
              </label>
            ),
          )}
        </div>
      </details>

      {onRemove && (
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <Button small tone="danger" onClick={onRemove}>
            Remove override
          </Button>
        </div>
      )}
    </div>
  );

  if (alwaysOpen) {
    return (
      <Panel title={title} subtitle={subtitle} padded>
        {body}
      </Panel>
    );
  }

  return (
    <details className="ai-profile-card">
      <summary>
        <span>
          <strong>{title}</strong>
          <small>{taskClass}</small>
        </span>
        <code>{firstRoute}</code>
      </summary>
      <div className="ai-profile-card__body">{body}</div>
    </details>
  );
}

function CandidateParameterEditor({
  parameters,
  model,
  onChange,
}: {
  parameters?: TaskModelParameters;
  model?: CatalogModel;
  onChange: (parameters: TaskModelParameters | undefined) => void;
}) {
  const overrideCount = Object.keys(parameters ?? {}).length;

  function setParameter<K extends keyof TaskModelParameters>(
    key: K,
    value: TaskModelParameters[K] | undefined,
  ) {
    const next = { ...(parameters ?? {}) };
    if (value === undefined) delete next[key];
    else next[key] = value as never;
    onChange(Object.keys(next).length ? next : undefined);
  }

  function setReasoning(key: keyof ReasoningConfig, value: string) {
    const reasoning = { ...(parameters?.reasoning ?? {}) };
    if (!value) delete reasoning[key];
    else reasoning[key] = value as never;
    setParameter(
      "reasoning",
      Object.keys(reasoning).length ? reasoning : undefined,
    );
  }

  return (
    <details className="ai-route-parameters">
      <summary>
        Candidate overrides ·{" "}
        {overrideCount ? `${overrideCount} set` : "inherit"}
      </summary>
      <div className="ai-route-parameter-body">
        <p className="ai-help-text">
          Blank values inherit the task profile, then the model/provider
          default. Unsupported controls are omitted from this candidate.
        </p>
        <div className="ai-form-grid ai-form-grid--compact">
          <FormField
            label="Reasoning mode"
            hint={
              model?.reasoning === false
                ? "This model does not support normalized reasoning controls."
                : "Blank inherits the profile execution path."
            }
          >
            <SelectControl
              value={parameters?.reasoning?.mode ?? ""}
              onChange={(value) => setReasoning("mode", value)}
              disabled={model?.reasoning === false}
              placeholder="Inherit profile"
              options={model?.reasoningModes ?? ALL_REASONING_MODES}
            />
          </FormField>
          <FormField
            label="Reasoning effort"
            hint={
              model?.reasoningMandatory
                ? "Reasoning is mandatory; blank inherits the profile/provider effort."
                : "Blank inherits the profile effort."
            }
          >
            <SelectControl
              value={parameters?.reasoning?.effort ?? ""}
              onChange={(value) => setReasoning("effort", value)}
              disabled={model?.reasoning === false}
              placeholder="Inherit profile"
              options={model?.reasoningEfforts ?? ALL_REASONING_EFFORTS}
            />
          </FormField>
          <FormField
            label="Reasoning summary"
            hint="Safe provider-generated summary; blank inherits the profile."
          >
            <SelectControl
              value={parameters?.reasoning?.summary ?? ""}
              onChange={(value) => setReasoning("summary", value)}
              disabled={model?.reasoning === false}
              placeholder="Inherit profile"
              options={model?.reasoningSummaries ?? ALL_REASONING_SUMMARIES}
            />
          </FormField>
          <FormField
            label="Reasoning context"
            hint="Blank inherits persisted-reasoning reuse policy."
          >
            <SelectControl
              value={parameters?.reasoning?.context ?? ""}
              onChange={(value) => setReasoning("context", value)}
              disabled={model?.reasoning === false}
              placeholder="Inherit profile"
              options={model?.reasoningContexts ?? ALL_REASONING_CONTEXTS}
            />
          </FormField>
          <FormField
            label="Answer verbosity"
            hint="Blank inherits visible answer detail from the profile."
          >
            <SelectControl
              value={parameters?.verbosity ?? ""}
              onChange={(value) =>
                setParameter(
                  "verbosity",
                  (value || undefined) as TextVerbosity | undefined,
                )
              }
              disabled={Boolean(model && !model.textVerbosities?.length)}
              placeholder="Inherit profile"
              options={model?.textVerbosities ?? ALL_VERBOSITIES}
            />
          </FormField>
          <FormField
            label="Temperature"
            hint={
              model?.temperatureRange === null
                ? "Unsupported by this model; omitted automatically."
                : model?.temperatureRange
                  ? `Supported range ${model.temperatureRange.min}–${model.temperatureRange.max}.`
                  : "Catalog support unknown; blank inherits the profile."
            }
          >
            <NumberControl
              value={parameters?.temperature}
              min={model?.temperatureRange?.min ?? 0}
              max={model?.temperatureRange?.max ?? 2}
              step={0.1}
              disabled={model?.temperatureRange === null}
              placeholder="Inherit profile"
              onChange={(value) => setParameter("temperature", value)}
            />
          </FormField>
          <FormField
            label="Maximum output tokens"
            hint={
              model
                ? `Blank inherits the profile/model limit; catalog ceiling ${(
                    model.out ?? model.ctx
                  ).toLocaleString("en-US")}.`
                : "Blank inherits the profile/model output limit."
            }
          >
            <NumberControl
              value={parameters?.maxTokens}
              min={1}
              max={model ? (model.out ?? model.ctx) : 1_048_576}
              step={1}
              placeholder="Inherit profile"
              onChange={(value) => setParameter("maxTokens", value)}
            />
          </FormField>
          <FormField
            label="Request timeout"
            hint="Per upstream attempt; blank inherits the profile timeout."
          >
            <NumberControl
              value={
                parameters?.timeoutMs === undefined
                  ? undefined
                  : parameters.timeoutMs / 1000
              }
              min={1}
              max={7200}
              step={1}
              suffix="seconds"
              placeholder="Inherit profile"
              onChange={(value) =>
                setParameter(
                  "timeoutMs",
                  value === undefined ? undefined : value * 1000,
                )
              }
            />
          </FormField>
          <FormField
            label="Overall deadline"
            hint="Across retries/fallbacks; blank inherits the profile deadline."
          >
            <NumberControl
              value={
                parameters?.overallDeadlineMs === undefined
                  ? undefined
                  : parameters.overallDeadlineMs / 1000
              }
              min={1}
              max={7200}
              step={1}
              suffix="seconds"
              placeholder="Inherit profile"
              onChange={(value) =>
                setParameter(
                  "overallDeadlineMs",
                  value === undefined ? undefined : value * 1000,
                )
              }
            />
          </FormField>
          <FormField
            label="JSON mode"
            hint="Blank inherits the profile structured-output preference."
          >
            <TriStateControl
              value={parameters?.jsonMode}
              onChange={(value) => setParameter("jsonMode", value)}
              placeholder="Inherit profile"
            />
          </FormField>
          <FormField
            label="Provider storage"
            hint="Blank inherits the profile, then the platform privacy default."
          >
            <TriStateControl
              value={parameters?.store}
              onChange={(value) => setParameter("store", value)}
              placeholder="Inherit profile"
            />
          </FormField>
        </div>
        {overrideCount > 0 && (
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <Button small tone="ghost" onClick={() => onChange(undefined)}>
              Clear candidate overrides
            </Button>
          </div>
        )}
      </div>
    </details>
  );
}

function CapabilitySummary({
  route,
  capability,
}: {
  route: string;
  capability: ReturnType<typeof inferCatalogModel>;
}) {
  if (!capability.knownRoute) {
    return (
      <Notice
        tone="warn"
        title="Route is incomplete or references an unknown gateway"
      >
        Use <code>gateway-instance/provider-native-model-id</code> and save a
        matching provider connection first.
      </Notice>
    );
  }
  if (!capability.model) {
    return (
      <Notice tone="info" title="Model capability is not in the local catalog">
        The route <code>{route}</code> is allowed, but optional controls cannot
        be pre-validated. Leave them blank to use provider defaults.
      </Notice>
    );
  }
  const model = capability.model;
  return (
    <div
      className="ai-capability-strip"
      aria-label="Selected model capabilities"
    >
      <span className="mono">
        {capability.provider}/{model.name}
      </span>
      <Badge tone={model.reasoning ? "green" : "muted"}>
        {model.reasoning ? "Reasoning" : "No reasoning control"}
      </Badge>
      <Badge tone={model.tools ? "green" : "muted"}>
        {model.tools ? "Tools" : "No tools"}
      </Badge>
      <Badge tone={model.vision ? "green" : "muted"}>
        {model.vision ? "Vision" : "Text only"}
      </Badge>
      <Badge tone={model.temperatureRange === null ? "amber" : "muted"}>
        {model.temperatureRange === null
          ? "Temperature omitted"
          : "Temperature optional"}
      </Badge>
      <Badge tone="muted">{model.tier}-tier</Badge>
    </div>
  );
}

function RoutingPreview({
  settings,
  dirty,
}: {
  settings: LlmSettings;
  dirty: boolean;
}) {
  const resolve = useResolveLlmRouting();
  const [taskClass, setTaskClass] = useState("chat.respond");
  const [explicitRoute, setExplicitRoute] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function preview(event: FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      await resolve.mutateAsync({
        taskClass: taskClass.trim() || "default",
        explicitRoute: explicitRoute.trim() || undefined,
      });
    } catch (previewError) {
      setError(errorText(previewError));
    }
  }

  return (
    <Panel
      title="Routing preview"
      subtitle="Explain the saved resolver decision"
      padded
    >
      <form onSubmit={preview}>
        <div className="ai-form-grid">
          <FormField
            label="Task class"
            hint="Aliases and parent categories are accepted."
          >
            <input
              list="ai-task-taxonomy"
              value={taskClass}
              onChange={(event) => setTaskClass(event.target.value)}
              style={CONTROL_STYLE}
            />
            <datalist id="ai-task-taxonomy">
              {settings.taxonomy.map((task) => (
                <option key={task.id} value={task.id}>
                  {task.label}
                </option>
              ))}
            </datalist>
          </FormField>
          <FormField
            label="Explicit route"
            hint="Optional; bypasses task-profile matching."
          >
            <input
              value={explicitRoute}
              onChange={(event) => setExplicitRoute(event.target.value)}
              placeholder="gateway/model-id"
              style={{ ...CONTROL_STYLE, fontFamily: "var(--mono)" }}
            />
          </FormField>
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginTop: 12,
          }}
        >
          <Button type="submit" small disabled={resolve.isPending}>
            {resolve.isPending ? "Resolving…" : "Preview route"}
          </Button>
          <span
            style={{
              color: dirty ? "var(--amber)" : "var(--text-3)",
              fontSize: 10.5,
            }}
          >
            {dirty
              ? "Preview uses the last saved revision, not unsaved edits."
              : `Saved revision ${settings.revision}.`}
          </span>
        </div>
      </form>
      {error && (
        <div style={{ marginTop: 12 }}>
          <Notice tone="error" title="Could not resolve route">
            {error}
          </Notice>
        </div>
      )}
      {resolve.data && (
        <div className="ai-routing-result" aria-live="polite">
          <div className="ai-metric-grid">
            <Metric label="Requested" value={resolve.data.requestedTaskClass} />
            <Metric
              label="Matched"
              value={resolve.data.matchedTaskClass ?? "default"}
            />
            <Metric label="Match type" value={resolve.data.matchType} />
            <Metric
              label="Selected route"
              value={resolve.data.selectedCandidate.route}
              mono
            />
          </div>
          <p>{resolve.data.explanation}</p>
          <details className="ai-settings-details">
            <summary>
              Resolution trace ({resolve.data.trace.length} steps)
            </summary>
            <ol className="ai-trace-list">
              {resolve.data.trace.map((step, index) => (
                <li key={`${step.stage}-${index}`}>
                  <Badge
                    tone={
                      step.outcome === "selected" || step.outcome === "eligible"
                        ? "green"
                        : "muted"
                    }
                  >
                    {step.outcome}
                  </Badge>
                  <code>{step.stage}</code>
                  <span>{step.message}</span>
                </li>
              ))}
            </ol>
          </details>
        </div>
      )}
    </Panel>
  );
}

function ConnectionsPanel({
  settings,
  persisted,
  credentials,
  onChange,
}: {
  settings: LlmSettings;
  persisted: LlmSettings;
  credentials: Record<string, GatewayCredentialMeta>;
  onChange: (settings: LlmSettings) => void;
}) {
  const [showAdd, setShowAdd] = useState(false);

  function update(instance: GatewayInstance) {
    onChange({
      ...settings,
      gatewayInstances: settings.gatewayInstances.map((candidate) =>
        candidate.id === instance.id ? instance : candidate,
      ),
    });
  }

  function add(instance: GatewayInstance) {
    onChange({
      ...settings,
      gatewayInstances: [...settings.gatewayInstances, instance],
    });
    setShowAdd(false);
  }

  function remove(instance: GatewayInstance) {
    onChange({
      ...settings,
      gatewayInstances: settings.gatewayInstances.filter(
        (candidate) => candidate.id !== instance.id,
      ),
    });
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <Notice tone="info" title="Connection tests do not generate tokens">
        Test a base URL and credential here before saving. Use Test lab only
        when you are ready to make a real, potentially billable model call.
      </Notice>
      <Panel
        title="Gateway instances"
        subtitle="Canonical route prefix and upstream transport"
        action={
          <Button small onClick={() => setShowAdd((value) => !value)}>
            <Icon name={showAdd ? "x" : "plus"} size={10} />
            {showAdd ? "Cancel" : "Add gateway"}
          </Button>
        }
        padded
      >
        {showAdd && <AddGatewayForm settings={settings} onAdd={add} />}
        <div
          className="ai-connections-grid"
          style={{ marginTop: showAdd ? 14 : 0 }}
        >
          {settings.gatewayInstances.map((instance) => {
            const persistedInstance = persisted.gatewayInstances.find(
              (candidate) => candidate.id === instance.id,
            );
            const saved = Boolean(persistedInstance);
            const referenced = gatewayIsReferenced(settings, instance.id);
            return (
              <GatewayCard
                key={instance.id}
                instance={instance}
                saved={saved}
                persistedInstance={persistedInstance}
                credential={credentials[instance.id]}
                onChange={update}
                onRemove={() => remove(instance)}
                removalDisabled={
                  referenced || settings.gatewayInstances.length === 1
                }
                removalReason={
                  referenced
                    ? "Remove this gateway from all route chains first."
                    : settings.gatewayInstances.length === 1
                      ? "At least one gateway instance is required."
                      : undefined
                }
              />
            );
          })}
        </div>
      </Panel>
    </div>
  );
}

function AddGatewayForm({
  settings,
  onAdd,
}: {
  settings: LlmSettings;
  onAdd: (instance: GatewayInstance) => void;
}) {
  const [id, setId] = useState("newapi-csi");
  const [displayName, setDisplayName] = useState("NewAPI CSI");
  const [kind, setKind] = useState<"newapi" | "openai-compatible">("newapi");
  const [baseUrl, setBaseUrl] = useState("https://newapi.example.com/v1");
  const [dialect, setDialect] = useState<GatewayInstance["dialect"]>("auto");
  const [apiMode, setApiMode] = useState<GatewayInstance["apiMode"]>("auto");
  const [error, setError] = useState<string | null>(null);

  function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (
      settings.gatewayInstances.some((instance) => instance.id === id.trim())
    ) {
      setError(`Gateway instance ${id.trim()} already exists.`);
      return;
    }
    const result = GatewayInstanceSchema.safeParse({
      id: id.trim(),
      displayName: displayName.trim(),
      kind,
      baseUrl: baseUrl.trim(),
      enabled: true,
      apiMode,
      dialect,
      timeouts: {
        connectTimeoutMs: 10_000,
        requestTimeoutMs: 120_000,
        maxRequestTimeoutMs: 600_000,
      },
      retry: { maxAttempts: 2, baseBackoffMs: 500 },
    });
    if (!result.success) {
      const issue = result.error.issues[0];
      setError(
        `${issue?.path.join(".") || "gateway"}: ${issue?.message ?? "Invalid gateway configuration"}`,
      );
      return;
    }
    onAdd(result.data);
  }

  return (
    <form onSubmit={submit} className="ai-add-gateway">
      <div>
        <strong style={{ color: "var(--text)", fontSize: 12.5 }}>
          Add NewAPI or compatible gateway
        </strong>
        <p className="ai-help-text">
          The instance ID becomes the route prefix. Arbitrary aliases such as
          <code> newapi-csi</code> and <code>newapi2</code> are supported.
        </p>
      </div>
      <div className="ai-form-grid">
        <FormField
          label="Instance ID"
          hint="Lowercase kebab-case; cannot be renamed after adding."
        >
          <input
            value={id}
            onChange={(event) => setId(event.target.value)}
            style={{ ...CONTROL_STYLE, fontFamily: "var(--mono)" }}
          />
        </FormField>
        <FormField label="Display name">
          <input
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            style={CONTROL_STYLE}
          />
        </FormField>
        <FormField label="Gateway type">
          <SelectControl
            value={kind}
            onChange={(value) => setKind(value as typeof kind)}
            options={["newapi", "openai-compatible"]}
          />
        </FormField>
        <FormField
          label="Base URL"
          hint="HTTP(S), with no embedded credential, query, or fragment."
        >
          <input
            type="url"
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
            style={CONTROL_STYLE}
          />
        </FormField>
        <FormField
          label="Wire dialect"
          hint="Use auto unless the gateway requires provider-specific request translation."
        >
          <SelectControl
            value={dialect}
            onChange={(value) =>
              setDialect(value as GatewayInstance["dialect"])
            }
            options={[
              "auto",
              "openai-chat",
              "openrouter",
              "moonshot",
              "zai",
              "deepseek",
              "unsupported",
            ]}
          />
        </FormField>
        <FormField label="API mode">
          <SelectControl
            value={apiMode}
            onChange={(value) =>
              setApiMode(value as GatewayInstance["apiMode"])
            }
            options={["auto", "chat-completions", "responses"]}
          />
        </FormField>
      </div>
      {error && (
        <Notice tone="error" title="Cannot add gateway">
          {error}
        </Notice>
      )}
      <Button type="submit" small tone="primary">
        Add to draft
      </Button>
    </form>
  );
}

function GatewayCard({
  instance,
  saved,
  persistedInstance,
  credential,
  onChange,
  onRemove,
  removalDisabled,
  removalReason,
}: {
  instance: GatewayInstance;
  saved: boolean;
  persistedInstance?: GatewayInstance;
  credential?: GatewayCredentialMeta;
  onChange: (instance: GatewayInstance) => void;
  onRemove: () => void;
  removalDisabled: boolean;
  removalReason?: string;
}) {
  const saveKey = useSaveGatewayKey();
  const test = useTestGatewayConnection();
  const [apiKey, setApiKey] = useState("");
  const [scope, setScope] = useState<"workspace" | "tenant">(
    credential?.scope ?? instance.credentialScope ?? "workspace",
  );
  const [showModels, setShowModels] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const supportsKey = instance.kind !== "mock";
  const isCustomUrl =
    instance.kind === "newapi" || instance.kind === "openai-compatible";
  const transportChanged =
    !persistedInstance ||
    instance.kind !== persistedInstance.kind ||
    instance.providerId !== persistedInstance.providerId ||
    instance.baseUrl !== persistedInstance.baseUrl ||
    instance.credentialRef !== persistedInstance.credentialRef ||
    instance.credentialScope !== persistedInstance.credentialScope;
  const models = useGatewayModels(
    instance.id,
    showModels && saved && !transportChanged,
  );

  function patch(next: Partial<GatewayInstance>) {
    onChange({ ...instance, ...next });
  }

  function patchTimeout(
    key: "connectTimeoutMs" | "requestTimeoutMs" | "maxRequestTimeoutMs",
    seconds: number | undefined,
  ) {
    const timeouts = { ...(instance.timeouts ?? {}) };
    if (seconds === undefined) delete timeouts[key];
    else timeouts[key] = seconds * 1000;
    patch({ timeouts: Object.keys(timeouts).length ? timeouts : undefined });
  }

  async function rotateKey() {
    setError(null);
    setMessage(null);
    try {
      const result = await saveKey.mutateAsync({
        id: instance.id,
        apiKey,
        scope,
      });
      setApiKey("");
      if (!instance.credentialScope) patch({ credentialScope: scope });
      setMessage(
        `Credential saved as ${result.keyMasked ?? "encrypted secret"}.`,
      );
    } catch (keyError) {
      setError(errorText(keyError));
    }
  }

  async function testConnection() {
    setError(null);
    setMessage(null);
    if (instance.kind !== "mock" && transportChanged && !apiKey) {
      setError(
        "Paste a temporary API key to test an unsaved or changed endpoint. Stored credentials are deliberately not sent to draft base URLs.",
      );
      return;
    }
    try {
      const result = await test.mutateAsync({
        id: instance.id,
        apiKey: apiKey || undefined,
        instance: transportChanged ? instance : undefined,
        timeoutMs: instance.timeouts?.connectTimeoutMs,
      });
      setMessage(
        `${result.ok ? "Connected" : "Connection failed"} in ${result.latencyMs} ms${result.modelCount === null ? "" : ` · ${result.modelCount} models`}. ${result.message}`,
      );
    } catch (testError) {
      setError(errorText(testError));
    }
  }

  return (
    <article className="ai-gateway-card">
      <header>
        <div style={{ minWidth: 0 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              flexWrap: "wrap",
              gap: 6,
            }}
          >
            <strong>{instance.displayName}</strong>
            <Badge tone={instance.enabled ? "green" : "muted"}>
              {instance.enabled ? "Enabled" : "Disabled"}
            </Badge>
            {!saved && <Badge tone="amber">Save required</Badge>}
          </div>
          <code>{instance.id}/…</code>
        </div>
        <label className="ai-check-label">
          <input
            type="checkbox"
            checked={instance.enabled}
            onChange={(event) => patch({ enabled: event.target.checked })}
          />
          Use
        </label>
      </header>

      <div className="ai-form-grid ai-form-grid--compact">
        <FormField label="Display name">
          <input
            value={instance.displayName}
            onChange={(event) => patch({ displayName: event.target.value })}
            style={CONTROL_STYLE}
          />
        </FormField>
        <FormField label="Type">
          <input
            value={instance.kind}
            readOnly
            style={{ ...CONTROL_STYLE, color: "var(--text-3)" }}
          />
        </FormField>
        {instance.providerId && (
          <FormField label="Direct provider">
            <input
              value={instance.providerId}
              readOnly
              style={{ ...CONTROL_STYLE, color: "var(--text-3)" }}
            />
          </FormField>
        )}
        {isCustomUrl && (
          <FormField label="Base URL">
            <input
              type="url"
              value={instance.baseUrl ?? ""}
              onChange={(event) =>
                patch({ baseUrl: event.target.value || undefined })
              }
              style={CONTROL_STYLE}
            />
          </FormField>
        )}
        <FormField label="API mode">
          <SelectControl
            value={instance.apiMode}
            onChange={(value) =>
              patch({ apiMode: value as GatewayInstance["apiMode"] })
            }
            options={["auto", "chat-completions", "responses"]}
          />
        </FormField>
        <FormField label="Wire dialect">
          <SelectControl
            value={instance.dialect}
            onChange={(value) =>
              patch({ dialect: value as GatewayInstance["dialect"] })
            }
            options={[
              "auto",
              "openai-chat",
              "openrouter",
              "moonshot",
              "zai",
              "deepseek",
              "unsupported",
            ]}
          />
        </FormField>
      </div>

      <details className="ai-settings-details">
        <summary>Timeout policy</summary>
        <div
          className="ai-form-grid ai-form-grid--compact"
          style={{ marginTop: 10 }}
        >
          <FormField label="Connect timeout">
            <NumberControl
              value={
                instance.timeouts?.connectTimeoutMs === undefined
                  ? undefined
                  : instance.timeouts.connectTimeoutMs / 1000
              }
              min={1}
              max={120}
              step={1}
              suffix="sec"
              onChange={(value) => patchTimeout("connectTimeoutMs", value)}
            />
          </FormField>
          <FormField label="Request timeout">
            <NumberControl
              value={
                instance.timeouts?.requestTimeoutMs === undefined
                  ? undefined
                  : instance.timeouts.requestTimeoutMs / 1000
              }
              min={1}
              max={7200}
              step={1}
              suffix="sec"
              onChange={(value) => patchTimeout("requestTimeoutMs", value)}
            />
          </FormField>
          <FormField label="Maximum timeout">
            <NumberControl
              value={
                instance.timeouts?.maxRequestTimeoutMs === undefined
                  ? undefined
                  : instance.timeouts.maxRequestTimeoutMs / 1000
              }
              min={1}
              max={7200}
              step={1}
              suffix="sec"
              onChange={(value) => patchTimeout("maxRequestTimeoutMs", value)}
            />
          </FormField>
        </div>
      </details>

      {supportsKey && (
        <div className="ai-key-box">
          <div>
            <strong>API credential</strong>
            <span>
              {credential?.hasKey
                ? `${credential.keyMasked ?? "Key stored"} · ${credential.source}`
                : "No saved key detected"}
            </span>
          </div>
          <div className="ai-key-controls">
            <input
              type="password"
              value={apiKey}
              autoComplete="new-password"
              onChange={(event) => setApiKey(event.target.value)}
              placeholder="Paste a new key (write-only)"
              aria-label={`New API key for ${instance.displayName}`}
              style={CONTROL_STYLE}
            />
            <SelectControl
              value={scope}
              onChange={(value) => setScope(value as typeof scope)}
              options={["workspace", "tenant"]}
              disabled={Boolean(instance.credentialScope)}
              ariaLabel={`Credential scope for ${instance.displayName}`}
            />
            <Button
              small
              onClick={rotateKey}
              disabled={!saved || !apiKey || saveKey.isPending}
            >
              {saveKey.isPending
                ? "Saving…"
                : credential?.hasKey
                  ? "Rotate key"
                  : "Save key"}
            </Button>
          </div>
          {!saved && (
            <small>
              Save the gateway instance before storing its key. You can still
              test the draft connection below with a temporary key.
            </small>
          )}
          {transportChanged && saved && (
            <small>
              The connection draft differs from the saved instance. Testing it
              requires re-entering a temporary key so a stored secret cannot be
              sent to a substituted URL.
            </small>
          )}
        </div>
      )}

      <div className="ai-gateway-actions">
        <Button small onClick={testConnection} disabled={test.isPending}>
          <Icon name="replay" size={10} />
          {test.isPending ? "Testing…" : "Test connection"}
        </Button>
        <Button
          small
          tone="ghost"
          onClick={() => setShowModels((value) => !value)}
          disabled={!saved || transportChanged}
          title={
            transportChanged
              ? "Save connection changes before discovering models."
              : undefined
          }
          ariaExpanded={showModels && !transportChanged}
          ariaControls={`gateway-models-${instance.id}`}
        >
          {showModels ? "Hide models" : "Discover models"}
        </Button>
        <Button
          small
          tone="danger"
          onClick={onRemove}
          disabled={removalDisabled}
          title={removalReason}
        >
          Remove
        </Button>
      </div>

      {message && (
        <Notice
          tone={test.data?.ok === false ? "warn" : "ok"}
          title="Connection result"
        >
          {message}
        </Notice>
      )}
      {error && (
        <Notice tone="error" title="Connection action failed">
          {error}
        </Notice>
      )}

      {showModels && !transportChanged && (
        <div
          id={`gateway-models-${instance.id}`}
          className="ai-discovered-models"
        >
          {models.isLoading && <span role="status">Discovering models…</span>}
          {models.isError && (
            <Notice tone="error" title="Model discovery failed">
              {errorText(models.error)}
            </Notice>
          )}
          {models.data && (
            <>
              <div className="ai-model-discovery-summary">
                <Badge tone={models.data.source === "live" ? "green" : "muted"}>
                  {models.data.source}
                </Badge>
                <span>{models.data.models.length} models</span>
                {models.data.message && <span>{models.data.message}</span>}
              </div>
              <div className="ai-model-chip-list">
                {models.data.models.slice(0, 60).map((model) => (
                  <code key={model.id} title={model.id}>
                    {model.id}
                  </code>
                ))}
              </div>
              {models.data.models.length > 60 && (
                <small>Showing the first 60 models.</small>
              )}
            </>
          )}
        </div>
      )}
    </article>
  );
}

function TestLab({
  settings,
  dirty,
}: {
  settings: LlmSettings;
  dirty: boolean;
}) {
  const test = useTestLlmCall();
  const [taskClass, setTaskClass] = useState("chat.respond");
  const [route, setRoute] = useState("");
  const [prompt, setPrompt] = useState(
    "Reply with one sentence confirming the model route and your role.",
  );
  const [maxTokens, setMaxTokens] = useState<number | undefined>(256);
  const [timeoutSeconds, setTimeoutSeconds] = useState<number | undefined>();
  const [temperature, setTemperature] = useState<number | undefined>();
  const [effort, setEffort] = useState("");
  const [mode, setMode] = useState("");
  const [verbosity, setVerbosity] = useState("");
  const [jsonMode, setJsonMode] = useState<boolean | undefined>();
  const [store, setStore] = useState<boolean | undefined>();
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const capability = route ? inferCatalogModel(settings, route) : undefined;
  const model = capability?.model;

  useEffect(() => {
    if (model?.temperatureRange === null) setTemperature(undefined);
    if (model?.reasoning === false) {
      setEffort("");
      setMode("");
    }
    if (model && !model.textVerbosities?.length) setVerbosity("");
    if (model) {
      const maximum = model.out ?? model.ctx;
      setMaxTokens((current) =>
        current !== undefined && current > maximum ? maximum : current,
      );
    }
  }, [model]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    const reasoning: ReasoningConfig = {
      ...(effort ? { effort: effort as ReasoningConfig["effort"] } : {}),
      ...(mode ? { mode: mode as ReasoningConfig["mode"] } : {}),
    };
    const input: TestCallInput = {
      taskClass: taskClass.trim() || "default",
      route: route.trim() || undefined,
      prompt,
      maxTokens,
      timeoutMs:
        timeoutSeconds === undefined ? undefined : timeoutSeconds * 1000,
      temperature: model?.temperatureRange === null ? undefined : temperature,
      reasoning: Object.keys(reasoning).length ? reasoning : undefined,
      verbosity: (verbosity || undefined) as TextVerbosity | undefined,
      jsonMode,
      store,
    };
    try {
      await test.mutateAsync(input);
    } catch (testError) {
      setError(errorText(testError));
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <Notice tone="warn" title="Model tests can incur provider charges">
        A test call generates tokens, appears in LLM usage logs, and may be
        retained by the upstream provider if storage is enabled. Connection-only
        probes live on the Provider connections tab.
      </Notice>
      <Panel
        title="Test a routed LLM call"
        subtitle="Prompt, routing, tokens, latency, and cost"
        padded
      >
        <form onSubmit={submit}>
          <div className="ai-test-grid">
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <FormField
                label="Task class"
                hint="Leave the route blank to exercise task routing."
              >
                <input
                  list="ai-test-task-taxonomy"
                  value={taskClass}
                  onChange={(event) => setTaskClass(event.target.value)}
                  style={CONTROL_STYLE}
                />
                <datalist id="ai-test-task-taxonomy">
                  {settings.taxonomy.map((task) => (
                    <option key={task.id} value={task.id}>
                      {task.label}
                    </option>
                  ))}
                </datalist>
              </FormField>
              <FormField
                label="Explicit model route"
                hint="Optional canonical route, e.g. newapi/kimi-k3."
              >
                <input
                  value={route}
                  onChange={(event) => setRoute(event.target.value)}
                  placeholder="Use task routing"
                  style={{ ...CONTROL_STYLE, fontFamily: "var(--mono)" }}
                />
              </FormField>
              <FormField label="Prompt">
                <textarea
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  rows={8}
                  style={{
                    ...CONTROL_STYLE,
                    resize: "vertical",
                    lineHeight: 1.55,
                  }}
                />
              </FormField>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <FormField
                label="Maximum output tokens"
                hint={
                  model
                    ? `Catalog ceiling ${(
                        model.out ?? model.ctx
                      ).toLocaleString("en-US")}.`
                    : "The selected route validates its model-specific ceiling."
                }
              >
                <NumberControl
                  value={maxTokens}
                  min={1}
                  max={model ? (model.out ?? model.ctx) : 1_048_576}
                  step={1}
                  onChange={setMaxTokens}
                />
              </FormField>
              <FormField
                label="Timeout"
                hint="Blank uses the route/provider timeout."
              >
                <NumberControl
                  value={timeoutSeconds}
                  min={1}
                  max={7200}
                  step={1}
                  suffix="seconds"
                  onChange={setTimeoutSeconds}
                />
              </FormField>
              <FormField
                label="Temperature"
                hint={
                  model?.temperatureRange === null
                    ? "Unsupported; omitted automatically."
                    : "Blank uses provider default."
                }
              >
                <NumberControl
                  value={temperature}
                  min={model?.temperatureRange?.min ?? 0}
                  max={model?.temperatureRange?.max ?? 2}
                  step={0.1}
                  disabled={model?.temperatureRange === null}
                  onChange={setTemperature}
                />
              </FormField>
              <FormField label="Reasoning effort">
                <SelectControl
                  value={effort}
                  onChange={setEffort}
                  placeholder="Provider default"
                  disabled={model?.reasoning === false}
                  options={model?.reasoningEfforts ?? ALL_REASONING_EFFORTS}
                />
              </FormField>
              <FormField label="Reasoning mode">
                <SelectControl
                  value={mode}
                  onChange={setMode}
                  placeholder="Provider default"
                  disabled={model?.reasoning === false}
                  options={model?.reasoningModes ?? ALL_REASONING_MODES}
                />
              </FormField>
              <FormField label="Answer verbosity">
                <SelectControl
                  value={verbosity}
                  onChange={setVerbosity}
                  placeholder="Provider default"
                  disabled={Boolean(model && !model.textVerbosities?.length)}
                  options={model?.textVerbosities ?? ALL_VERBOSITIES}
                />
              </FormField>
              <FormField label="JSON mode">
                <TriStateControl value={jsonMode} onChange={setJsonMode} />
              </FormField>
              <FormField
                label="Provider storage"
                hint="Blank keeps the platform privacy default (off for Responses)."
              >
                <TriStateControl
                  value={store}
                  onChange={setStore}
                  placeholder="Platform default"
                />
              </FormField>
            </div>
          </div>
          {route && capability && (
            <div style={{ marginTop: 12 }}>
              <CapabilitySummary route={route} capability={capability} />
            </div>
          )}
          <label className="ai-billable-confirm">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            I understand this sends a real model request and may incur cost.
          </label>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              flexWrap: "wrap",
              gap: 8,
              marginTop: 12,
            }}
          >
            <Button
              type="submit"
              tone="primary"
              disabled={!confirmed || !prompt.trim() || test.isPending}
            >
              <Icon name="play" size={11} />{" "}
              {test.isPending ? "Running model test…" : "Run model test"}
            </Button>
            {dirty && (
              <span style={{ color: "var(--amber)", fontSize: 10.5 }}>
                Unsaved route changes are not used by this test.
              </span>
            )}
          </div>
        </form>
      </Panel>

      {error && (
        <Notice tone="error" title="Model test failed">
          {error}
        </Notice>
      )}
      {test.data && <TestResult result={test.data} />}
    </div>
  );
}

function TestResult({
  result,
}: {
  result: NonNullable<ReturnType<typeof useTestLlmCall>["data"]>;
}) {
  const totalNanos = result.cost?.totalUsdNanos;
  const totalCost =
    totalNanos === null || totalNanos === undefined
      ? "Unpriced"
      : `$${(totalNanos / 1_000_000_000).toFixed(6)}`;
  return (
    <Panel
      title="Latest model result"
      subtitle={`${result.provider} · ${result.model}`}
      padded
    >
      <div className="ai-metric-grid">
        <Metric
          label="Latency"
          value={`${result.latencyMs.toLocaleString()} ms`}
        />
        <Metric
          label="Input tokens"
          value={String(result.usage?.inputTokens ?? result.tokensIn ?? "—")}
        />
        <Metric
          label="Output tokens"
          value={String(result.usage?.outputTokens ?? result.tokensOut ?? "—")}
        />
        <Metric
          label="Reasoning tokens"
          value={String(result.usage?.reasoningTokens ?? 0)}
        />
        <Metric label="Estimated cost" value={totalCost} />
        <Metric label="Finish reason" value={result.finishReason || "—"} />
      </div>
      {result.routing && (
        <div className="ai-result-routing">
          <code>
            {result.routing.effectiveRoute ??
              `${result.provider}/${result.model}`}
          </code>
          <Badge tone="muted">
            {result.routing.resolutionReason ?? "explicit"}
          </Badge>
          {result.routing.explanation && (
            <span>{result.routing.explanation}</span>
          )}
        </div>
      )}
      <pre className="ai-test-output">{result.text}</pre>
      <div className="ai-result-footnotes">
        {result.providerRequestId && (
          <span>
            Provider request ID: <code>{result.providerRequestId}</code>
          </span>
        )}
        {result.cost?.source && (
          <span>
            Pricing: {result.cost.source}
            {result.cost.priceAsOf ? ` · as of ${result.cost.priceAsOf}` : ""}
          </span>
        )}
        {result.usage && result.usage.cachedInputTokens > 0 && (
          <span>
            Cached input: {result.usage.cachedInputTokens.toLocaleString()}{" "}
            tokens
          </span>
        )}
      </div>
    </Panel>
  );
}

interface FormFieldA11y {
  controlId: string;
  descriptionId?: string;
}

const FormFieldA11yContext = createContext<FormFieldA11y | null>(null);

function associateNativeControls(
  children: ReactNode,
  controlId: string,
  descriptionId?: string,
): ReactNode {
  return Children.map(children, (child) => {
    if (
      !isValidElement<Record<string, unknown>>(child) ||
      typeof child.type !== "string" ||
      !["input", "select", "textarea"].includes(child.type)
    ) {
      return child;
    }
    const existingDescription =
      typeof child.props["aria-describedby"] === "string"
        ? child.props["aria-describedby"]
        : undefined;
    const descriptions = [existingDescription, descriptionId]
      .filter(Boolean)
      .join(" ");
    return cloneElement(child as ReactElement<Record<string, unknown>>, {
      id: typeof child.props.id === "string" ? child.props.id : controlId,
      ...(descriptions ? { "aria-describedby": descriptions } : {}),
    });
  });
}

function FormField({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  const generatedId = useId();
  const controlId = `ai-field-${generatedId}`;
  const descriptionId = hint ? `${controlId}-description` : undefined;
  const controls = associateNativeControls(children, controlId, descriptionId);
  return (
    <div className="ai-form-field">
      <label className="ai-form-field__label" htmlFor={controlId}>
        {label}
      </label>
      {hint && (
        <span id={descriptionId} className="ai-form-field__hint">
          {hint}
        </span>
      )}
      <FormFieldA11yContext.Provider value={{ controlId, descriptionId }}>
        <span className="ai-form-field__control">{controls}</span>
      </FormFieldA11yContext.Provider>
    </div>
  );
}

function SelectControl({
  value,
  onChange,
  options,
  placeholder,
  disabled,
  ariaLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  options: readonly string[];
  placeholder?: string;
  disabled?: boolean;
  ariaLabel?: string;
}) {
  const field = useContext(FormFieldA11yContext);
  return (
    <select
      id={field?.controlId}
      aria-label={ariaLabel}
      aria-describedby={field?.descriptionId}
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
      style={CONTROL_STYLE}
    >
      {placeholder !== undefined && <option value="">{placeholder}</option>}
      {options.map((option) => (
        <option key={option} value={option}>
          {option}
        </option>
      ))}
    </select>
  );
}

function NumberControl({
  value,
  onChange,
  min,
  max,
  step,
  disabled,
  suffix,
  placeholder = "Provider default",
}: {
  value: number | undefined;
  onChange: (value: number | undefined) => void;
  min: number;
  max: number;
  step: number;
  disabled?: boolean;
  suffix?: string;
  placeholder?: string;
}) {
  const field = useContext(FormFieldA11yContext);
  return (
    <div className="ai-number-control">
      <input
        id={field?.controlId}
        aria-describedby={field?.descriptionId}
        type="number"
        value={value ?? ""}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(event) =>
          onChange(
            event.target.value === "" ? undefined : Number(event.target.value),
          )
        }
        style={CONTROL_STYLE}
      />
      {suffix && <span>{suffix}</span>}
    </div>
  );
}

function CheckboxControl({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
}) {
  const field = useContext(FormFieldA11yContext);
  return (
    <label className="ai-check-label" htmlFor={field?.controlId}>
      <input
        id={field?.controlId}
        aria-describedby={field?.descriptionId}
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      {label}
    </label>
  );
}

function TriStateControl({
  value,
  onChange,
  placeholder = "Provider default",
}: {
  value: boolean | undefined;
  onChange: (value: boolean | undefined) => void;
  placeholder?: string;
}) {
  return (
    <SelectControl
      value={value === undefined ? "" : value ? "true" : "false"}
      onChange={(next) => onChange(next === "" ? undefined : next === "true")}
      placeholder={placeholder}
      options={["true", "false"]}
    />
  );
}

function Metric({
  label,
  value,
  mono,
}: {
  label: string;
  value: ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="ai-metric">
      <span>{label}</span>
      <strong className={mono ? "mono" : undefined}>{value}</strong>
    </div>
  );
}

function Notice({
  tone,
  title,
  children,
}: {
  tone: "info" | "ok" | "warn" | "error";
  title: string;
  children: ReactNode;
}) {
  const color =
    tone === "error"
      ? "var(--red)"
      : tone === "warn"
        ? "var(--amber)"
        : tone === "ok"
          ? "var(--green)"
          : "var(--signal)";
  return (
    <div
      role={tone === "error" ? "alert" : undefined}
      style={{
        display: "flex",
        alignItems: "center",
        flexWrap: "wrap",
        gap: 8,
        padding: "9px 11px",
        border: `1px solid color-mix(in srgb, ${color} 35%, var(--border))`,
        borderRadius: 6,
        background: `color-mix(in srgb, ${color} 7%, var(--panel))`,
        color: "var(--text-2)",
        fontSize: 11.5,
        lineHeight: 1.5,
      }}
    >
      <Icon
        name={tone === "ok" ? "check" : tone === "info" ? "spark" : "alert"}
        size={12}
        style={{ color }}
      />
      <strong style={{ color }}>{title}</strong>
      {children}
    </div>
  );
}
