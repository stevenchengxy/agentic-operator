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
import { useI18n } from "@/app/portal/lib/preferences-context";
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

const AI_TABS: AiTab[] = ["routing", "connections", "models", "test"];

const REQUIRED_TASKS = [
  {
    id: "ontology.generate",
    key: "ontologyGenerate",
  },
  {
    id: "evaluation.run",
    key: "evaluationRun",
  },
  {
    id: "assistant.suggest",
    key: "assistantSuggest",
  },
  {
    id: "chat.respond",
    key: "chatRespond",
  },
  {
    id: "ontogene.generate",
    key: "ontogeneGenerate",
  },
  {
    id: "graph.query",
    key: "graphQuery",
  },
  {
    id: "file.parse",
    key: "fileParse",
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
  const { t } = useI18n();
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
      dirty ? t("aiSection.dirtyLabel", { tenant }) : null,
    );
    return () => dirtyStore.setDirty("ai-settings", null);
  }, [dirty, dirtyStore, t, tenant]);

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
    const index = AI_TABS.findIndex((candidate) => candidate === current);
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
    setTab(next);
    requestAnimationFrame(() => {
      document.getElementById(`ai-tab-${next}`)?.focus();
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
        t("aiSection.validationError", {
          path: first?.path.join(".") || t("aiSection.settingsPath"),
          message: first?.message ?? t("aiSection.invalidSettings"),
        }),
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
      setMessage(t("aiSection.savedRevision", { revision: next.revision }));
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
    setMessage(t("aiSection.loadedRevision", { revision: next.revision }));
  }

  async function repairMirror() {
    setError(null);
    try {
      const result = await resync.mutateAsync();
      const next = cloneSettings(result.settings);
      setDraft(next);
      setBaseline(cloneSettings(next));
      setMessage(t("aiSection.mirrorRewritten"));
    } catch (repairError) {
      setError(errorText(repairError));
    }
  }

  if (snapshot.isError) {
    return (
      <Panel padded>
        <Empty
          title={t("aiSection.unavailableTitle")}
          hint={errorText(snapshot.error)}
        />
        <div
          style={{ display: "flex", justifyContent: "center", marginTop: 12 }}
        >
          <Button small onClick={() => snapshot.refetch()}>
            {t("aiSection.retry")}
          </Button>
        </div>
      </Panel>
    );
  }

  if (snapshot.isLoading || draftTenant !== tenant || !draft || !baseline) {
    return (
      <Panel padded>
        <div role="status" style={{ color: "var(--text-3)", fontSize: 12 }}>
          {t("aiSection.loading")}
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
                {t("aiSection.controlPlane")}
              </strong>
              <Badge tone={dirty ? "amber" : "muted"}>
                {dirty
                  ? t("aiSection.unsavedChanges")
                  : t("aiSection.revision", { revision: draft.revision })}
              </Badge>
              <Badge tone={sync?.status === "drift" ? "amber" : "green"}>
                {sync?.status === "drift"
                  ? t("aiSection.fileDrift")
                  : t("aiSection.filesSynced")}
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
              {t("aiSection.controlPlaneDescription")}
            </p>
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
            <Button
              small
              tone="ghost"
              disabled={!dirty || save.isPending}
              onClick={() => setDraft(cloneSettings(baseline))}
            >
              {t("aiSection.discard")}
            </Button>
            <Button
              small
              tone="primary"
              disabled={!dirty || save.isPending}
              onClick={saveSettings}
            >
              {save.isPending
                ? t("aiSection.saving")
                : t("aiSection.saveSettings")}
            </Button>
          </div>
        </div>
      </Panel>

      {sync?.status === "drift" && (
        <Notice tone="warn" title={t("aiSection.mirrorDriftTitle")}>
          <span>{sync.message ?? t("aiSection.mirrorDriftMessage")}</span>
          <Button
            small
            onClick={repairMirror}
            disabled={resync.isPending || dirty}
          >
            {resync.isPending
              ? t("aiSection.repairing")
              : t("aiSection.repairMirror")}
          </Button>
          {dirty && <span>{t("aiSection.repairBlockedByDirty")}</span>}
        </Notice>
      )}

      {conflict && (
        <Notice tone="warn" title={t("aiSection.conflictTitle")}>
          <span>{t("aiSection.conflictMessage")}</span>
          <Button small onClick={loadLatest}>
            {t("aiSection.loadLatest")}
          </Button>
        </Notice>
      )}

      {error && (
        <Notice tone="error" title={t("aiSection.actionFailed")}>
          {error}
        </Notice>
      )}
      {message && (
        <Notice tone="ok" title={t("aiSection.updated")}>
          {message}
        </Notice>
      )}
      <div aria-live="polite" className="ai-sr-only">
        {error ?? message ?? ""}
      </div>

      <div
        className="ai-settings-tabs"
        role="tablist"
        aria-label={t("aiSection.tabsAria")}
        aria-orientation="horizontal"
      >
        {AI_TABS.map((item) => (
          <button
            key={item}
            id={`ai-tab-${item}`}
            type="button"
            role="tab"
            aria-selected={tab === item}
            aria-controls={`ai-panel-${item}`}
            tabIndex={tab === item ? 0 : -1}
            onClick={() => setTab(item)}
            onKeyDown={(event) => selectTabFromKeyboard(event, item)}
            style={{
              minWidth: 170,
              padding: "10px 12px",
              border: 0,
              borderBottom: `2px solid ${tab === item ? "var(--signal)" : "transparent"}`,
              background: tab === item ? "var(--panel-2)" : "transparent",
              color: tab === item ? "var(--text)" : "var(--text-2)",
              cursor: "pointer",
              textAlign: "left",
            }}
          >
            <span style={{ display: "block", fontSize: 12, fontWeight: 600 }}>
              {t(`aiSection.tabs.${item}.label`)}
            </span>
            <span
              style={{
                display: "block",
                marginTop: 2,
                color: "var(--text-3)",
                fontSize: 9.5,
              }}
            >
              {t(`aiSection.tabs.${item}.hint`)}
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
            <Notice tone="info" title={t("aiSection.catalogTitle")}>
              {t("aiSection.catalogPrefix")}{" "}
              <code>gateway-instance/provider-model-id</code>.{" "}
              {t("aiSection.catalogDescription")}
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
  const { t } = useI18n();
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
    .map((task) => {
      const coreTask = coreTaskById.get(task.id);
      return {
        id: String(task.id),
        label: coreTask
          ? t(`aiSection.tasks.${coreTask.key}.label`)
          : task.label,
        description: coreTask
          ? t(`aiSection.tasks.${coreTask.key}.description`)
          : (task.description ??
            (task.parent
              ? t("aiSection.taskInheritsParent", { parent: task.parent })
              : t("aiSection.taskUsesClosestParent"))),
      };
    });
  const knownTaskIds = new Set(taskDefinitions.map((task) => task.id));
  for (const task of REQUIRED_TASKS) {
    if (!knownTaskIds.has(task.id)) {
      taskDefinitions.push({
        id: task.id,
        label: t(`aiSection.tasks.${task.key}.label`),
        description: t(`aiSection.tasks.${task.key}.description`),
      });
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
          profile.description ?? t("aiSection.configuredOutsideTaxonomy"),
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
      <Notice tone="info" title={t("aiSection.closestFallbackTitle")}>
        {t("aiSection.closestFallbackDescription")}
      </Notice>

      <ProfileEditor
        title={t("aiSection.workspaceDefault")}
        subtitle={t("aiSection.workspaceDefaultHint")}
        profile={settings.defaultProfile}
        settings={settings}
        onChange={(profile) => setDefault(profile as DefaultTaskRoutingProfile)}
        alwaysOpen
      />

      <Panel
        title={t("aiSection.taskRoutesTitle")}
        subtitle={t("aiSection.taskRoutesCount", {
          count: taskDefinitions.length,
        })}
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
                      {t("aiSection.inheritsRoute", {
                        route:
                          settings.defaultProfile.candidates[0]?.route ?? "—",
                      })}
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
                    <Badge tone="muted">{t("aiSection.usesDefault")}</Badge>
                    <Button small onClick={() => customize(task.id)}>
                      {t("aiSection.customize")}
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
  const { t, language } = useI18n();
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
          label={t("aiSection.profileStatus")}
          hint={t("aiSection.profileStatusHint")}
        >
          <CheckboxControl
            checked={profile.enabled}
            onChange={(checked) => changeProfile({ enabled: checked })}
            label={t("aiSection.enabled")}
          />
        </FormField>
        <FormField
          label={t("aiSection.workload")}
          hint={t("aiSection.workloadHint")}
        >
          <SelectControl
            value={profile.workload}
            onChange={(value) =>
              changeProfile({ workload: value as TaskWorkloadProfile })
            }
            options={WORKLOADS}
            optionLabel={(option) => t(`aiSection.enums.workload.${option}`)}
          />
        </FormField>
      </div>

      <div>
        <div className="ai-subheading">{t("aiSection.routeChain")}</div>
        <p className="ai-help-text">
          {t("aiSection.routeChainPrefix")}{" "}
          <code>openrouter/openai/gpt-5.6-sol</code>{" "}
          {t("aiSection.routeChainSuffix")}
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
                  {index === 0
                    ? t("aiSection.primary")
                    : t("aiSection.fallbackNumber", { index })}
                </span>
                <input
                  className="ai-route-id"
                  value={candidate.route}
                  onChange={(event) =>
                    updateCandidate(index, { route: event.target.value })
                  }
                  aria-label={t("aiSection.routeAria", {
                    title,
                    position:
                      index === 0
                        ? t("aiSection.primaryLower")
                        : t("aiSection.fallbackNumber", { index }),
                  })}
                  spellCheck={false}
                  style={{ ...CONTROL_STYLE, fontFamily: "var(--mono)" }}
                />
                <input
                  className="ai-route-family"
                  value={candidate.modelFamily ?? ""}
                  onChange={(event) =>
                    updateCandidate(index, { modelFamily: event.target.value })
                  }
                  aria-label={t("aiSection.modelFamilyAria", {
                    title,
                    position:
                      index === 0
                        ? t("aiSection.primaryLower")
                        : t("aiSection.fallbackNumber", { index }),
                  })}
                  placeholder={t("aiSection.modelFamilyOptional")}
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
                  {t("aiSection.use")}
                </label>
                <Button
                  small
                  tone="ghost"
                  disabled={profile.candidates.length === 1}
                  onClick={() => removeCandidate(index)}
                  ariaLabel={t("aiSection.removeRouteAria", {
                    title,
                    index: index + 1,
                  })}
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
                    {t("aiSection.fallbackPolicy")} ·{" "}
                    {candidate.fallbackOn?.length ??
                      t("aiSection.defaultValue")}
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
                      {t("aiSection.usePlatformDefaults")}
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
                        {t(`aiSection.enums.fallbackCondition.${condition}`)}
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
          <Icon name="plus" size={10} /> {t("aiSection.addFallback")}
        </Button>
      </div>

      <CapabilitySummary route={firstRoute} capability={capability} />

      <details className="ai-settings-details">
        <summary>{t("aiSection.optionalModelControls")}</summary>
        <p className="ai-help-text">
          {t("aiSection.optionalModelControlsHint")}
        </p>
        <div className="ai-form-grid">
          <FormField
            label={t("aiSection.reasoningMode")}
            hint={
              !model
                ? t("aiSection.catalogCapabilityUnknown")
                : model.reasoning
                  ? t("aiSection.executionPathHint")
                  : t("aiSection.reasoningUnsupported")
            }
          >
            <SelectControl
              value={profile.parameters?.reasoning?.mode ?? ""}
              onChange={(value) => setReasoning("mode", value)}
              disabled={model?.reasoning === false}
              placeholder={t("aiSection.providerDefault")}
              options={model?.reasoningModes ?? ALL_REASONING_MODES}
              optionLabel={(option) =>
                t(`aiSection.enums.reasoningMode.${option}`)
              }
            />
          </FormField>
          <FormField
            label={t("aiSection.reasoningEffort")}
            hint={
              model?.reasoningMandatory
                ? t("aiSection.reasoningMandatory")
                : t("aiSection.reasoningEffortHint")
            }
          >
            <SelectControl
              value={profile.parameters?.reasoning?.effort ?? ""}
              onChange={(value) => setReasoning("effort", value)}
              disabled={model?.reasoning === false}
              placeholder={t("aiSection.providerDefault")}
              options={model?.reasoningEfforts ?? ALL_REASONING_EFFORTS}
              optionLabel={(option) =>
                t(`aiSection.enums.reasoningEffort.${option}`)
              }
            />
          </FormField>
          <FormField
            label={t("aiSection.reasoningSummary")}
            hint={t("aiSection.reasoningSummaryHint")}
          >
            <SelectControl
              value={profile.parameters?.reasoning?.summary ?? ""}
              onChange={(value) => setReasoning("summary", value)}
              disabled={model?.reasoning === false}
              placeholder={t("aiSection.providerDefault")}
              options={model?.reasoningSummaries ?? ALL_REASONING_SUMMARIES}
              optionLabel={(option) =>
                t(`aiSection.enums.reasoningSummary.${option}`)
              }
            />
          </FormField>
          <FormField
            label={t("aiSection.reasoningContext")}
            hint={t("aiSection.reasoningContextHint")}
          >
            <SelectControl
              value={profile.parameters?.reasoning?.context ?? ""}
              onChange={(value) => setReasoning("context", value)}
              disabled={model?.reasoning === false}
              placeholder={t("aiSection.providerDefault")}
              options={model?.reasoningContexts ?? ALL_REASONING_CONTEXTS}
              optionLabel={(option) =>
                t(`aiSection.enums.reasoningContext.${option}`)
              }
            />
          </FormField>
          <FormField
            label={t("aiSection.answerVerbosity")}
            hint={t("aiSection.answerVerbosityHint")}
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
              placeholder={t("aiSection.providerDefault")}
              options={model?.textVerbosities ?? ALL_VERBOSITIES}
              optionLabel={(option) => t(`aiSection.enums.verbosity.${option}`)}
            />
          </FormField>
          <FormField
            label={t("aiSection.temperature")}
            hint={
              model?.temperatureRange === null
                ? t("aiSection.temperatureUnsupported")
                : model?.temperatureRange
                  ? t("aiSection.supportedRange", {
                      min: model.temperatureRange.min,
                      max: model.temperatureRange.max,
                    })
                  : t("aiSection.temperatureUnknown")
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
            label={t("aiSection.maximumOutputTokens")}
            hint={
              model
                ? t("aiSection.maxTokensCatalogHint", {
                    ceiling: (model.out ?? model.ctx).toLocaleString(
                      language === "zh" ? "zh-CN" : "en-US",
                    ),
                  })
                : t("aiSection.maxTokensDefaultHint")
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
            label={t("aiSection.requestTimeout")}
            hint={t("aiSection.requestTimeoutHint")}
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
              suffix={t("aiSection.seconds")}
              onChange={(value) =>
                setParameter(
                  "timeoutMs",
                  value === undefined ? undefined : value * 1000,
                )
              }
            />
          </FormField>
          <FormField
            label={t("aiSection.overallDeadline")}
            hint={t("aiSection.overallDeadlineHint")}
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
              suffix={t("aiSection.seconds")}
              onChange={(value) =>
                setParameter(
                  "overallDeadlineMs",
                  value === undefined ? undefined : value * 1000,
                )
              }
            />
          </FormField>
          <FormField
            label={t("aiSection.jsonMode")}
            hint={t("aiSection.jsonModeHint")}
          >
            <TriStateControl
              value={profile.parameters?.jsonMode}
              onChange={(value) => setParameter("jsonMode", value)}
            />
          </FormField>
          <FormField
            label={t("aiSection.providerStorage")}
            hint={t("aiSection.providerStorageHint")}
          >
            <TriStateControl
              value={profile.parameters?.store}
              onChange={(value) => setParameter("store", value)}
              placeholder={t("aiSection.platformDefault")}
            />
          </FormField>
        </div>
      </details>

      <details className="ai-settings-details">
        <summary>{t("aiSection.capabilityRequirements")}</summary>
        <p className="ai-help-text">
          {t("aiSection.capabilityRequirementsHint")}
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
                {t(`aiSection.enums.requirement.${requirement}`)}
              </label>
            ),
          )}
        </div>
      </details>

      {onRemove && (
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <Button small tone="danger" onClick={onRemove}>
            {t("aiSection.removeOverride")}
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
  const { t, language } = useI18n();
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
        {t("aiSection.candidateOverrides")} ·{" "}
        {overrideCount
          ? t("aiSection.overrideCount", { count: overrideCount })
          : t("aiSection.inherit")}
      </summary>
      <div className="ai-route-parameter-body">
        <p className="ai-help-text">{t("aiSection.candidateOverridesHint")}</p>
        <div className="ai-form-grid ai-form-grid--compact">
          <FormField
            label={t("aiSection.reasoningMode")}
            hint={
              model?.reasoning === false
                ? t("aiSection.reasoningUnsupported")
                : t("aiSection.inheritExecutionPath")
            }
          >
            <SelectControl
              value={parameters?.reasoning?.mode ?? ""}
              onChange={(value) => setReasoning("mode", value)}
              disabled={model?.reasoning === false}
              placeholder={t("aiSection.inheritProfile")}
              options={model?.reasoningModes ?? ALL_REASONING_MODES}
              optionLabel={(option) =>
                t(`aiSection.enums.reasoningMode.${option}`)
              }
            />
          </FormField>
          <FormField
            label={t("aiSection.reasoningEffort")}
            hint={
              model?.reasoningMandatory
                ? t("aiSection.reasoningMandatoryInherit")
                : t("aiSection.inheritReasoningEffort")
            }
          >
            <SelectControl
              value={parameters?.reasoning?.effort ?? ""}
              onChange={(value) => setReasoning("effort", value)}
              disabled={model?.reasoning === false}
              placeholder={t("aiSection.inheritProfile")}
              options={model?.reasoningEfforts ?? ALL_REASONING_EFFORTS}
              optionLabel={(option) =>
                t(`aiSection.enums.reasoningEffort.${option}`)
              }
            />
          </FormField>
          <FormField
            label={t("aiSection.reasoningSummary")}
            hint={t("aiSection.inheritReasoningSummary")}
          >
            <SelectControl
              value={parameters?.reasoning?.summary ?? ""}
              onChange={(value) => setReasoning("summary", value)}
              disabled={model?.reasoning === false}
              placeholder={t("aiSection.inheritProfile")}
              options={model?.reasoningSummaries ?? ALL_REASONING_SUMMARIES}
              optionLabel={(option) =>
                t(`aiSection.enums.reasoningSummary.${option}`)
              }
            />
          </FormField>
          <FormField
            label={t("aiSection.reasoningContext")}
            hint={t("aiSection.inheritReasoningContext")}
          >
            <SelectControl
              value={parameters?.reasoning?.context ?? ""}
              onChange={(value) => setReasoning("context", value)}
              disabled={model?.reasoning === false}
              placeholder={t("aiSection.inheritProfile")}
              options={model?.reasoningContexts ?? ALL_REASONING_CONTEXTS}
              optionLabel={(option) =>
                t(`aiSection.enums.reasoningContext.${option}`)
              }
            />
          </FormField>
          <FormField
            label={t("aiSection.answerVerbosity")}
            hint={t("aiSection.inheritVerbosity")}
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
              placeholder={t("aiSection.inheritProfile")}
              options={model?.textVerbosities ?? ALL_VERBOSITIES}
              optionLabel={(option) => t(`aiSection.enums.verbosity.${option}`)}
            />
          </FormField>
          <FormField
            label={t("aiSection.temperature")}
            hint={
              model?.temperatureRange === null
                ? t("aiSection.temperatureUnsupportedShort")
                : model?.temperatureRange
                  ? t("aiSection.supportedRange", {
                      min: model.temperatureRange.min,
                      max: model.temperatureRange.max,
                    })
                  : t("aiSection.temperatureInheritUnknown")
            }
          >
            <NumberControl
              value={parameters?.temperature}
              min={model?.temperatureRange?.min ?? 0}
              max={model?.temperatureRange?.max ?? 2}
              step={0.1}
              disabled={model?.temperatureRange === null}
              placeholder={t("aiSection.inheritProfile")}
              onChange={(value) => setParameter("temperature", value)}
            />
          </FormField>
          <FormField
            label={t("aiSection.maximumOutputTokens")}
            hint={
              model
                ? t("aiSection.inheritMaxTokensCatalog", {
                    ceiling: (model.out ?? model.ctx).toLocaleString(
                      language === "zh" ? "zh-CN" : "en-US",
                    ),
                  })
                : t("aiSection.inheritMaxTokens")
            }
          >
            <NumberControl
              value={parameters?.maxTokens}
              min={1}
              max={model ? (model.out ?? model.ctx) : 1_048_576}
              step={1}
              placeholder={t("aiSection.inheritProfile")}
              onChange={(value) => setParameter("maxTokens", value)}
            />
          </FormField>
          <FormField
            label={t("aiSection.requestTimeout")}
            hint={t("aiSection.inheritRequestTimeout")}
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
              suffix={t("aiSection.seconds")}
              placeholder={t("aiSection.inheritProfile")}
              onChange={(value) =>
                setParameter(
                  "timeoutMs",
                  value === undefined ? undefined : value * 1000,
                )
              }
            />
          </FormField>
          <FormField
            label={t("aiSection.overallDeadline")}
            hint={t("aiSection.inheritOverallDeadline")}
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
              suffix={t("aiSection.seconds")}
              placeholder={t("aiSection.inheritProfile")}
              onChange={(value) =>
                setParameter(
                  "overallDeadlineMs",
                  value === undefined ? undefined : value * 1000,
                )
              }
            />
          </FormField>
          <FormField
            label={t("aiSection.jsonMode")}
            hint={t("aiSection.inheritJsonMode")}
          >
            <TriStateControl
              value={parameters?.jsonMode}
              onChange={(value) => setParameter("jsonMode", value)}
              placeholder={t("aiSection.inheritProfile")}
            />
          </FormField>
          <FormField
            label={t("aiSection.providerStorage")}
            hint={t("aiSection.inheritProviderStorage")}
          >
            <TriStateControl
              value={parameters?.store}
              onChange={(value) => setParameter("store", value)}
              placeholder={t("aiSection.inheritProfile")}
            />
          </FormField>
        </div>
        {overrideCount > 0 && (
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <Button small tone="ghost" onClick={() => onChange(undefined)}>
              {t("aiSection.clearCandidateOverrides")}
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
  const { t } = useI18n();
  if (!capability.knownRoute) {
    return (
      <Notice tone="warn" title={t("aiSection.unknownGatewayTitle")}>
        {t("aiSection.unknownGatewayPrefix")}{" "}
        <code>gateway-instance/provider-native-model-id</code>{" "}
        {t("aiSection.unknownGatewaySuffix")}
      </Notice>
    );
  }
  if (!capability.model) {
    return (
      <Notice tone="info" title={t("aiSection.modelNotCatalogedTitle")}>
        {t("aiSection.modelNotCatalogedPrefix")} <code>{route}</code>{" "}
        {t("aiSection.modelNotCatalogedSuffix")}
      </Notice>
    );
  }
  const model = capability.model;
  return (
    <div
      className="ai-capability-strip"
      aria-label={t("aiSection.capabilitiesAria")}
    >
      <span className="mono">
        {capability.provider}/{model.name}
      </span>
      <Badge tone={model.reasoning ? "green" : "muted"}>
        {model.reasoning
          ? t("aiSection.reasoning")
          : t("aiSection.noReasoning")}
      </Badge>
      <Badge tone={model.tools ? "green" : "muted"}>
        {model.tools ? t("aiSection.tools") : t("aiSection.noTools")}
      </Badge>
      <Badge tone={model.vision ? "green" : "muted"}>
        {model.vision ? t("aiSection.vision") : t("aiSection.textOnly")}
      </Badge>
      <Badge tone={model.temperatureRange === null ? "amber" : "muted"}>
        {model.temperatureRange === null
          ? t("aiSection.temperatureOmitted")
          : t("aiSection.temperatureOptional")}
      </Badge>
      <Badge tone="muted">
        {t("aiSection.tierLabel", {
          tier: t(`aiSection.enums.tier.${model.tier}`),
        })}
      </Badge>
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
  const { t } = useI18n();
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
      title={t("aiSection.routingPreview")}
      subtitle={t("aiSection.routingPreviewSubtitle")}
      padded
    >
      <form onSubmit={preview}>
        <div className="ai-form-grid">
          <FormField
            label={t("aiSection.taskClass")}
            hint={t("aiSection.taskClassHint")}
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
            label={t("aiSection.explicitRoute")}
            hint={t("aiSection.explicitRouteHint")}
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
            {resolve.isPending
              ? t("aiSection.resolving")
              : t("aiSection.previewRoute")}
          </Button>
          <span
            style={{
              color: dirty ? "var(--amber)" : "var(--text-3)",
              fontSize: 10.5,
            }}
          >
            {dirty
              ? t("aiSection.previewUsesSaved")
              : t("aiSection.savedRevisionShort", {
                  revision: settings.revision,
                })}
          </span>
        </div>
      </form>
      {error && (
        <div style={{ marginTop: 12 }}>
          <Notice tone="error" title={t("aiSection.resolveFailed")}>
            {error}
          </Notice>
        </div>
      )}
      {resolve.data && (
        <div className="ai-routing-result" aria-live="polite">
          <div className="ai-metric-grid">
            <Metric
              label={t("aiSection.requested")}
              value={resolve.data.requestedTaskClass}
            />
            <Metric
              label={t("aiSection.matched")}
              value={
                resolve.data.matchedTaskClass ?? t("aiSection.defaultValue")
              }
            />
            <Metric
              label={t("aiSection.matchType")}
              value={t(`aiSection.enums.matchType.${resolve.data.matchType}`)}
            />
            <Metric
              label={t("aiSection.selectedRoute")}
              value={resolve.data.selectedCandidate.route}
              mono
            />
          </div>
          <p>{resolve.data.explanation}</p>
          <details className="ai-settings-details">
            <summary>
              {t("aiSection.resolutionTrace", {
                count: resolve.data.trace.length,
              })}
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
                    {t(`aiSection.enums.traceOutcome.${step.outcome}`)}
                  </Badge>
                  <code>{t(`aiSection.enums.traceStage.${step.stage}`)}</code>
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
  const { t } = useI18n();
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
      <Notice tone="info" title={t("aiSection.connectionTestTitle")}>
        {t("aiSection.connectionTestDescription")}
      </Notice>
      <Panel
        title={t("aiSection.gatewayInstances")}
        subtitle={t("aiSection.gatewayInstancesSubtitle")}
        action={
          <Button small onClick={() => setShowAdd((value) => !value)}>
            <Icon name={showAdd ? "x" : "plus"} size={10} />
            {showAdd ? t("aiSection.cancel") : t("aiSection.addGateway")}
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
                    ? t("aiSection.removeGatewayReferenced")
                    : settings.gatewayInstances.length === 1
                      ? t("aiSection.oneGatewayRequired")
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
  const { t } = useI18n();
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
      setError(t("aiSection.gatewayAlreadyExists", { id: id.trim() }));
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
        t("aiSection.gatewayValidationError", {
          path: issue?.path.join(".") || t("aiSection.gatewayPath"),
          message: issue?.message ?? t("aiSection.invalidGatewayConfiguration"),
        }),
      );
      return;
    }
    onAdd(result.data);
  }

  return (
    <form onSubmit={submit} className="ai-add-gateway">
      <div>
        <strong style={{ color: "var(--text)", fontSize: 12.5 }}>
          {t("aiSection.addCompatibleGateway")}
        </strong>
        <p className="ai-help-text">
          {t("aiSection.instanceIdPrefix")} <code>newapi-csi</code>{" "}
          {t("aiSection.instanceIdMiddle")} <code>newapi2</code>{" "}
          {t("aiSection.instanceIdSuffix")}
        </p>
      </div>
      <div className="ai-form-grid">
        <FormField
          label={t("aiSection.instanceId")}
          hint={t("aiSection.instanceIdHint")}
        >
          <input
            value={id}
            onChange={(event) => setId(event.target.value)}
            style={{ ...CONTROL_STYLE, fontFamily: "var(--mono)" }}
          />
        </FormField>
        <FormField label={t("aiSection.displayName")}>
          <input
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            style={CONTROL_STYLE}
          />
        </FormField>
        <FormField label={t("aiSection.gatewayType")}>
          <SelectControl
            value={kind}
            onChange={(value) => setKind(value as typeof kind)}
            options={["newapi", "openai-compatible"]}
            optionLabel={(option) => t(`aiSection.enums.gatewayKind.${option}`)}
          />
        </FormField>
        <FormField
          label={t("aiSection.baseUrl")}
          hint={t("aiSection.baseUrlHint")}
        >
          <input
            type="url"
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
            style={CONTROL_STYLE}
          />
        </FormField>
        <FormField
          label={t("aiSection.wireDialect")}
          hint={t("aiSection.wireDialectHint")}
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
            optionLabel={(option) => t(`aiSection.enums.wireDialect.${option}`)}
          />
        </FormField>
        <FormField label={t("aiSection.apiMode")}>
          <SelectControl
            value={apiMode}
            onChange={(value) =>
              setApiMode(value as GatewayInstance["apiMode"])
            }
            options={["auto", "chat-completions", "responses"]}
            optionLabel={(option) => t(`aiSection.enums.apiMode.${option}`)}
          />
        </FormField>
      </div>
      {error && (
        <Notice tone="error" title={t("aiSection.cannotAddGateway")}>
          {error}
        </Notice>
      )}
      <Button type="submit" small tone="primary">
        {t("aiSection.addToDraft")}
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
  const { t } = useI18n();
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
        t("aiSection.credentialSaved", {
          key: result.keyMasked ?? t("aiSection.encryptedSecret"),
        }),
      );
    } catch (keyError) {
      setError(errorText(keyError));
    }
  }

  async function testConnection() {
    setError(null);
    setMessage(null);
    if (instance.kind !== "mock" && transportChanged && !apiKey) {
      setError(t("aiSection.temporaryKeyRequired"));
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
        t("aiSection.connectionTestResult", {
          status: result.ok
            ? t("aiSection.connected")
            : t("aiSection.connectionFailed"),
          latency: result.latencyMs,
          models:
            result.modelCount === null
              ? ""
              : t("aiSection.modelCountSuffix", {
                  count: result.modelCount,
                }),
          message: result.message,
        }),
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
              {instance.enabled
                ? t("aiSection.enabled")
                : t("aiSection.disabled")}
            </Badge>
            {!saved && (
              <Badge tone="amber">{t("aiSection.saveRequired")}</Badge>
            )}
          </div>
          <code>{instance.id}/…</code>
        </div>
        <label className="ai-check-label">
          <input
            type="checkbox"
            checked={instance.enabled}
            onChange={(event) => patch({ enabled: event.target.checked })}
          />
          {t("aiSection.use")}
        </label>
      </header>

      <div className="ai-form-grid ai-form-grid--compact">
        <FormField label={t("aiSection.displayName")}>
          <input
            value={instance.displayName}
            onChange={(event) => patch({ displayName: event.target.value })}
            style={CONTROL_STYLE}
          />
        </FormField>
        <FormField label={t("aiSection.type")}>
          <input
            value={t(`aiSection.enums.gatewayKind.${instance.kind}`)}
            readOnly
            style={{ ...CONTROL_STYLE, color: "var(--text-3)" }}
          />
        </FormField>
        {instance.providerId && (
          <FormField label={t("aiSection.directProvider")}>
            <input
              value={instance.providerId}
              readOnly
              style={{ ...CONTROL_STYLE, color: "var(--text-3)" }}
            />
          </FormField>
        )}
        {isCustomUrl && (
          <FormField label={t("aiSection.baseUrl")}>
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
        <FormField label={t("aiSection.apiMode")}>
          <SelectControl
            value={instance.apiMode}
            onChange={(value) =>
              patch({ apiMode: value as GatewayInstance["apiMode"] })
            }
            options={["auto", "chat-completions", "responses"]}
            optionLabel={(option) => t(`aiSection.enums.apiMode.${option}`)}
          />
        </FormField>
        <FormField label={t("aiSection.wireDialect")}>
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
            optionLabel={(option) => t(`aiSection.enums.wireDialect.${option}`)}
          />
        </FormField>
      </div>

      <details className="ai-settings-details">
        <summary>{t("aiSection.timeoutPolicy")}</summary>
        <div
          className="ai-form-grid ai-form-grid--compact"
          style={{ marginTop: 10 }}
        >
          <FormField label={t("aiSection.connectTimeout")}>
            <NumberControl
              value={
                instance.timeouts?.connectTimeoutMs === undefined
                  ? undefined
                  : instance.timeouts.connectTimeoutMs / 1000
              }
              min={1}
              max={120}
              step={1}
              suffix={t("aiSection.secondsShort")}
              onChange={(value) => patchTimeout("connectTimeoutMs", value)}
            />
          </FormField>
          <FormField label={t("aiSection.requestTimeout")}>
            <NumberControl
              value={
                instance.timeouts?.requestTimeoutMs === undefined
                  ? undefined
                  : instance.timeouts.requestTimeoutMs / 1000
              }
              min={1}
              max={7200}
              step={1}
              suffix={t("aiSection.secondsShort")}
              onChange={(value) => patchTimeout("requestTimeoutMs", value)}
            />
          </FormField>
          <FormField label={t("aiSection.maximumTimeout")}>
            <NumberControl
              value={
                instance.timeouts?.maxRequestTimeoutMs === undefined
                  ? undefined
                  : instance.timeouts.maxRequestTimeoutMs / 1000
              }
              min={1}
              max={7200}
              step={1}
              suffix={t("aiSection.secondsShort")}
              onChange={(value) => patchTimeout("maxRequestTimeoutMs", value)}
            />
          </FormField>
        </div>
      </details>

      {supportsKey && (
        <div className="ai-key-box">
          <div>
            <strong>{t("aiSection.apiCredential")}</strong>
            <span>
              {credential?.hasKey
                ? t("aiSection.storedCredential", {
                    key: credential.keyMasked ?? t("aiSection.keyStored"),
                    source: credential.source,
                  })
                : t("aiSection.noSavedKey")}
            </span>
          </div>
          <div className="ai-key-controls">
            <input
              type="password"
              value={apiKey}
              autoComplete="new-password"
              onChange={(event) => setApiKey(event.target.value)}
              placeholder={t("aiSection.keyPlaceholder")}
              aria-label={t("aiSection.newKeyAria", {
                name: instance.displayName,
              })}
              style={CONTROL_STYLE}
            />
            <SelectControl
              value={scope}
              onChange={(value) => setScope(value as typeof scope)}
              options={["workspace", "tenant"]}
              optionLabel={(option) =>
                t(`aiSection.enums.credentialScope.${option}`)
              }
              disabled={Boolean(instance.credentialScope)}
              ariaLabel={t("aiSection.credentialScopeAria", {
                name: instance.displayName,
              })}
            />
            <Button
              small
              onClick={rotateKey}
              disabled={!saved || !apiKey || saveKey.isPending}
            >
              {saveKey.isPending
                ? t("aiSection.saving")
                : credential?.hasKey
                  ? t("aiSection.rotateKey")
                  : t("aiSection.saveKey")}
            </Button>
          </div>
          {!saved && <small>{t("aiSection.saveBeforeKey")}</small>}
          {transportChanged && saved && (
            <small>{t("aiSection.transportChangedWarning")}</small>
          )}
        </div>
      )}

      <div className="ai-gateway-actions">
        <Button small onClick={testConnection} disabled={test.isPending}>
          <Icon name="replay" size={10} />
          {test.isPending
            ? t("aiSection.testing")
            : t("aiSection.testConnection")}
        </Button>
        <Button
          small
          tone="ghost"
          onClick={() => setShowModels((value) => !value)}
          disabled={!saved || transportChanged}
          title={
            transportChanged ? t("aiSection.saveBeforeDiscovering") : undefined
          }
          ariaExpanded={showModels && !transportChanged}
          ariaControls={`gateway-models-${instance.id}`}
        >
          {showModels
            ? t("aiSection.hideModels")
            : t("aiSection.discoverModels")}
        </Button>
        <Button
          small
          tone="danger"
          onClick={onRemove}
          disabled={removalDisabled}
          title={removalReason}
        >
          {t("aiSection.remove")}
        </Button>
      </div>

      {message && (
        <Notice
          tone={test.data?.ok === false ? "warn" : "ok"}
          title={t("aiSection.connectionResult")}
        >
          {message}
        </Notice>
      )}
      {error && (
        <Notice tone="error" title={t("aiSection.connectionActionFailed")}>
          {error}
        </Notice>
      )}

      {showModels && !transportChanged && (
        <div
          id={`gateway-models-${instance.id}`}
          className="ai-discovered-models"
        >
          {models.isLoading && (
            <span role="status">{t("aiSection.discoveringModels")}</span>
          )}
          {models.isError && (
            <Notice tone="error" title={t("aiSection.modelDiscoveryFailed")}>
              {errorText(models.error)}
            </Notice>
          )}
          {models.data && (
            <>
              <div className="ai-model-discovery-summary">
                <Badge tone={models.data.source === "live" ? "green" : "muted"}>
                  {t(`aiSection.enums.modelSource.${models.data.source}`)}
                </Badge>
                <span>
                  {t("aiSection.modelsCount", {
                    count: models.data.models.length,
                  })}
                </span>
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
                <small>
                  {t("aiSection.showingFirstModels", { count: 60 })}
                </small>
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
  const { t, language } = useI18n();
  const test = useTestLlmCall();
  const [taskClass, setTaskClass] = useState("chat.respond");
  const [route, setRoute] = useState("");
  const [prompt, setPrompt] = useState(t("aiSection.defaultTestPrompt"));
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
      <Notice tone="warn" title={t("aiSection.billableTestTitle")}>
        {t("aiSection.billableTestDescription")}
      </Notice>
      <Panel
        title={t("aiSection.testRoutedCall")}
        subtitle={t("aiSection.testRoutedCallSubtitle")}
        padded
      >
        <form onSubmit={submit}>
          <div className="ai-test-grid">
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <FormField
                label={t("aiSection.taskClass")}
                hint={t("aiSection.testTaskClassHint")}
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
                label={t("aiSection.explicitModelRoute")}
                hint={t("aiSection.explicitModelRouteHint")}
              >
                <input
                  value={route}
                  onChange={(event) => setRoute(event.target.value)}
                  placeholder={t("aiSection.useTaskRouting")}
                  style={{ ...CONTROL_STYLE, fontFamily: "var(--mono)" }}
                />
              </FormField>
              <FormField label={t("aiSection.prompt")}>
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
                label={t("aiSection.maximumOutputTokens")}
                hint={
                  model
                    ? t("aiSection.catalogCeiling", {
                        ceiling: (model.out ?? model.ctx).toLocaleString(
                          language === "zh" ? "zh-CN" : "en-US",
                        ),
                      })
                    : t("aiSection.routeValidatesCeiling")
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
                label={t("aiSection.timeout")}
                hint={t("aiSection.timeoutDefaultHint")}
              >
                <NumberControl
                  value={timeoutSeconds}
                  min={1}
                  max={7200}
                  step={1}
                  suffix={t("aiSection.seconds")}
                  onChange={setTimeoutSeconds}
                />
              </FormField>
              <FormField
                label={t("aiSection.temperature")}
                hint={
                  model?.temperatureRange === null
                    ? t("aiSection.temperatureUnsupportedShort")
                    : t("aiSection.blankUsesProviderDefault")
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
              <FormField label={t("aiSection.reasoningEffort")}>
                <SelectControl
                  value={effort}
                  onChange={setEffort}
                  placeholder={t("aiSection.providerDefault")}
                  disabled={model?.reasoning === false}
                  options={model?.reasoningEfforts ?? ALL_REASONING_EFFORTS}
                  optionLabel={(option) =>
                    t(`aiSection.enums.reasoningEffort.${option}`)
                  }
                />
              </FormField>
              <FormField label={t("aiSection.reasoningMode")}>
                <SelectControl
                  value={mode}
                  onChange={setMode}
                  placeholder={t("aiSection.providerDefault")}
                  disabled={model?.reasoning === false}
                  options={model?.reasoningModes ?? ALL_REASONING_MODES}
                  optionLabel={(option) =>
                    t(`aiSection.enums.reasoningMode.${option}`)
                  }
                />
              </FormField>
              <FormField label={t("aiSection.answerVerbosity")}>
                <SelectControl
                  value={verbosity}
                  onChange={setVerbosity}
                  placeholder={t("aiSection.providerDefault")}
                  disabled={Boolean(model && !model.textVerbosities?.length)}
                  options={model?.textVerbosities ?? ALL_VERBOSITIES}
                  optionLabel={(option) =>
                    t(`aiSection.enums.verbosity.${option}`)
                  }
                />
              </FormField>
              <FormField label={t("aiSection.jsonMode")}>
                <TriStateControl value={jsonMode} onChange={setJsonMode} />
              </FormField>
              <FormField
                label={t("aiSection.providerStorage")}
                hint={t("aiSection.providerStorageTestHint")}
              >
                <TriStateControl
                  value={store}
                  onChange={setStore}
                  placeholder={t("aiSection.platformDefault")}
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
            {t("aiSection.billableConfirmation")}
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
              {test.isPending
                ? t("aiSection.runningModelTest")
                : t("aiSection.runModelTest")}
            </Button>
            {dirty && (
              <span style={{ color: "var(--amber)", fontSize: 10.5 }}>
                {t("aiSection.unsavedRoutesNotUsed")}
              </span>
            )}
          </div>
        </form>
      </Panel>

      {error && (
        <Notice tone="error" title={t("aiSection.modelTestFailed")}>
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
  const { t, language } = useI18n();
  const totalNanos = result.cost?.totalUsdNanos;
  const totalCost =
    totalNanos === null || totalNanos === undefined
      ? t("aiSection.unpriced")
      : `$${(totalNanos / 1_000_000_000).toFixed(6)}`;
  return (
    <Panel
      title={t("aiSection.latestModelResult")}
      subtitle={`${result.provider} · ${result.model}`}
      padded
    >
      <div className="ai-metric-grid">
        <Metric
          label={t("aiSection.latency")}
          value={t("aiSection.latencyMs", {
            value: result.latencyMs.toLocaleString(
              language === "zh" ? "zh-CN" : "en-US",
            ),
          })}
        />
        <Metric
          label={t("aiSection.inputTokens")}
          value={String(result.usage?.inputTokens ?? result.tokensIn ?? "—")}
        />
        <Metric
          label={t("aiSection.outputTokens")}
          value={String(result.usage?.outputTokens ?? result.tokensOut ?? "—")}
        />
        <Metric
          label={t("aiSection.reasoningTokens")}
          value={String(result.usage?.reasoningTokens ?? 0)}
        />
        <Metric label={t("aiSection.estimatedCost")} value={totalCost} />
        <Metric
          label={t("aiSection.finishReason")}
          value={result.finishReason || "—"}
        />
      </div>
      {result.routing && (
        <div className="ai-result-routing">
          <code>
            {result.routing.effectiveRoute ??
              `${result.provider}/${result.model}`}
          </code>
          <Badge tone="muted">
            {result.routing.resolutionReason
              ? t(
                  `aiSection.enums.resolutionReason.${result.routing.resolutionReason}`,
                )
              : t("aiSection.enums.resolutionReason.explicit")}
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
            {t("aiSection.providerRequestId")}:{" "}
            <code>{result.providerRequestId}</code>
          </span>
        )}
        {result.cost?.source && (
          <span>
            {t("aiSection.pricing")}: {result.cost.source}
            {result.cost.priceAsOf
              ? ` · ${t("aiSection.asOf", {
                  date: result.cost.priceAsOf,
                })}`
              : ""}
          </span>
        )}
        {result.usage && result.usage.cachedInputTokens > 0 && (
          <span>
            {t("aiSection.cachedInput", {
              count: result.usage.cachedInputTokens.toLocaleString(
                language === "zh" ? "zh-CN" : "en-US",
              ),
            })}
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
  optionLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  options: readonly string[];
  placeholder?: string;
  disabled?: boolean;
  ariaLabel?: string;
  optionLabel?: (option: string) => string;
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
          {optionLabel ? optionLabel(option) : option}
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
  placeholder,
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
  const { t } = useI18n();
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
        placeholder={placeholder ?? t("aiSection.providerDefault")}
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
  placeholder,
}: {
  value: boolean | undefined;
  onChange: (value: boolean | undefined) => void;
  placeholder?: string;
}) {
  const { t } = useI18n();
  return (
    <SelectControl
      value={value === undefined ? "" : value ? "true" : "false"}
      onChange={(next) => onChange(next === "" ? undefined : next === "true")}
      placeholder={placeholder ?? t("aiSection.providerDefault")}
      options={["true", "false"]}
      optionLabel={(option) =>
        option === "true" ? t("aiSection.yes") : t("aiSection.no")
      }
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
