"use client";

/**
 * Settings → Models — browse a provider's available models and pick the
 * ones this tenant should use.
 *
 * Two panels:
 *   1. "Configured models" — the tenant's fleet from `/v1/llm/fleet`. Role
 *      is editable inline (PATCH), entries can be removed (DELETE).
 *   2. "Browse models" — pick a provider, see live models from its /models
 *      endpoint (catalog metadata only enriches matching live ids), checkbox the
 *      ones to add. Models already in the fleet are dimmed.
 *
 * Providers without live discovery show an explicit free-text input; static
 * catalog entries are never presented as provider-confirmed availability.
 */

import { Fragment, useMemo, useState } from "react";
import { Badge, Button, Icon, Panel, Td, Th, useToast } from "@/app/portal/components";
import { Field, SelectIn, TextIn } from "@/app/portal/components/settings/atoms";
import { useI18n } from "@/app/portal/lib/preferences-context";
import {
  useAddFleetEntry,
  useAvailableModels,
  useDeleteProviderKey,
  useDeleteFleetEntry,
  useFleet,
  useModelProviders,
  useProviderKeys,
  useSaveProviderKey,
  useTestProviderKey,
  useUpdateFleetEntry,
  type AvailableModel,
  type FleetEntry,
  type FleetRole,
  type ProviderInfo,
} from "@/lib/hooks/useModelFleet";

const FLEET_ROLES: FleetRole[] = ["primary", "fallback", "shadow"];

export function ModelsSection() {
  const fleet = useFleet();
  const providers = useModelProviders();

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <ProviderCredentialsPanel
        providers={providers.data ?? []}
        loading={providers.isLoading}
        error={providers.error}
      />
      <ConfiguredFleetPanel
        fleet={fleet.data ?? []}
        loading={fleet.isLoading}
        error={fleet.error}
      />
      <BrowseModelsPanel
        providers={providers.data ?? []}
        providersLoading={providers.isLoading}
        providersError={providers.error}
      />
      {!fleet.error ? <FallbackChainPanel fleet={fleet.data ?? []} /> : null}
    </div>
  );
}

// ─── Workspace provider credentials ──────────────────────────────────────

function ProviderCredentialsPanel({
  providers,
  loading,
  error,
}: {
  providers: ProviderInfo[];
  loading: boolean;
  error: Error | null;
}) {
  const { t } = useI18n();
  const keys = useProviderKeys();
  const saveKey = useSaveProviderKey();
  const deleteKey = useDeleteProviderKey();
  const testKey = useTestProviderKey();
  const toast = useToast();
  const [editing, setEditing] = useState<string | null>(null);
  const [candidate, setCandidate] = useState("");
  const [feedback, setFeedback] = useState<{ ok: boolean; message: string } | null>(null);
  const keyByProvider = useMemo(
    () => new Map((keys.data ?? []).map((key) => [key.provider, key])),
    [keys.data],
  );

  function beginEdit(provider: string) {
    setEditing(provider);
    setCandidate("");
    setFeedback(null);
  }

  async function test(provider: string) {
    setFeedback(null);
    try {
      const result = await testKey.mutateAsync({ provider, apiKey: candidate || undefined });
      setFeedback({ ok: result.ok, message: result.message });
    } catch (cause) {
      setFeedback({ ok: false, message: cause instanceof Error ? cause.message : String(cause) });
    }
  }

  async function save(provider: string) {
    setFeedback(null);
    try {
      const result = await saveKey.mutateAsync({ provider, apiKey: candidate.trim() });
      setCandidate("");
      setFeedback({ ok: true, message: t("models.keySaved", { key: result.keyMasked ?? "—" }) });
    } catch (cause) {
      setFeedback({ ok: false, message: cause instanceof Error ? cause.message : String(cause) });
    }
  }

  async function revoke(provider: string, providerName: string) {
    if (!window.confirm(t("models.revokeKeyConfirm", { provider: providerName }))) return;
    setFeedback(null);
    try {
      const result = await deleteKey.mutateAsync(provider);
      setEditing((current) => current === provider ? null : current);
      setCandidate("");
      toast({
        tone: "green",
        title: result.effective.hasKey
          ? t("models.keyVaultRevokedEnvActive", { provider: providerName })
          : t("models.keyRevoked", { provider: providerName }),
      });
    } catch (cause) {
      toast({
        tone: "red",
        title: t("models.revokeKeyFailed", {
          provider: providerName,
          error: cause instanceof Error ? cause.message : String(cause),
        }),
      });
    }
  }

  return (
    <Panel
      title={t("models.credentialsTitle")}
      subtitle={t("models.credentialsWorkspaceOnly")}
      padded={false}
    >
      {(error || keys.error) && (
        <div role="alert" style={{ padding: 14, color: "var(--red)", fontSize: 12 }}>
          {t("models.providersLoadFailed")}: {(error ?? keys.error)?.message}
        </div>
      )}
      {!error && !keys.error && (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
          <thead>
            <tr style={{ borderBottom: "1px solid var(--border)" }}>
              <Th>{t("models.colProvider")}</Th>
              <Th>{t("models.keyStatus")}</Th>
              <Th>{t("models.keySource")}</Th>
              <Th>{t("models.keyUpdated")}</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {(loading || keys.isLoading) && (
              <tr><Td colSpan={5}>{t("models.loadingProviders")}</Td></tr>
            )}
            {!loading && !keys.isLoading && providers.length === 0 && (
              <tr><Td colSpan={5}>{t("models.noRuntimeProviders")}</Td></tr>
            )}
            {providers.map((provider) => {
              const meta = keyByProvider.get(provider.id);
              const configured = meta?.hasKey ?? provider.hasKey;
              const isEditing = editing === provider.id;
              return (
                <Fragment key={provider.id}>
                  <tr style={{ borderBottom: isEditing ? "none" : "1px solid var(--border)" }}>
                    <Td>
                      <span style={{ color: "var(--text)" }}>{provider.name}</span>{" "}
                      <span className="mono" style={{ color: "var(--text-3)", fontSize: 10.5 }}>{provider.id}</span>
                    </Td>
                    <Td>
                      <Badge tone={configured ? "green" : "muted"}>
                        {configured
                          ? meta?.keyMasked ?? t("models.keyConfigured")
                          : t("models.keyMissing")}
                      </Badge>
                    </Td>
                    <Td>
                      <span className="mono" style={{ color: "var(--text-2)", fontSize: 11 }}>
                        {meta?.source ?? (configured ? "runtime" : "none")} · {meta?.scope ?? "workspace"}
                      </span>
                    </Td>
                    <Td>
                      <span style={{ color: "var(--text-3)", fontSize: 11 }}>
                        {meta?.setAt ? new Date(meta.setAt).toLocaleString() : "—"}
                      </span>
                    </Td>
                    <Td style={{ textAlign: "right" }}>
                      <span style={{ display: "inline-flex", gap: 6, alignItems: "center", justifyContent: "flex-end" }}>
                        {configured && meta?.source === "env" && (
                          <span
                            title={t("models.envKeyRemovalHint")}
                            style={{ color: "var(--text-3)", fontSize: 10.5 }}
                          >
                            {t("models.managedByEnvironment")}
                          </span>
                        )}
                        {configured && meta?.source === "vault" && (
                          <Button
                            small
                            tone="danger"
                            onClick={() => void revoke(provider.id, provider.name)}
                            disabled={deleteKey.isPending}
                          >
                            {deleteKey.isPending && deleteKey.variables === provider.id
                              ? t("models.revokingKey")
                              : t("models.revokeKey")}
                          </Button>
                        )}
                        <Button small tone="ghost" onClick={() => isEditing ? setEditing(null) : beginEdit(provider.id)}>
                          {isEditing ? t("models.cancelKeyEdit") : configured ? t("models.rotateKey") : t("models.configureKey")}
                        </Button>
                      </span>
                    </Td>
                  </tr>
                  {isEditing && (
                    <tr style={{ borderBottom: "1px solid var(--border)" }}>
                      <Td colSpan={5} style={{ padding: "10px 14px" }}>
                        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                          <input
                            type="password"
                            value={candidate}
                            onChange={(event) => setCandidate(event.target.value)}
                            placeholder={configured ? t("models.newKeyPlaceholder") : t("models.keyPlaceholder")}
                            aria-label={t("models.keyForProvider", { provider: provider.name })}
                            autoComplete="new-password"
                            style={{
                              flex: 1,
                              minWidth: 180,
                              padding: "7px 9px",
                              color: "var(--text)",
                              background: "var(--panel-2)",
                              border: "1px solid var(--border-2)",
                              borderRadius: 5,
                              fontFamily: "var(--mono)",
                              fontSize: 12,
                            }}
                          />
                          <Button
                            small
                            tone="ghost"
                            onClick={() => void test(provider.id)}
                            disabled={testKey.isPending || (!candidate.trim() && !configured)}
                          >
                            {testKey.isPending ? t("models.testingKey") : t("models.testKey")}
                          </Button>
                          <Button
                            small
                            tone="primary"
                            onClick={() => void save(provider.id)}
                            disabled={saveKey.isPending || candidate.trim().length < 8}
                          >
                            {saveKey.isPending ? t("models.savingKey") : t("models.saveWorkspaceKey")}
                          </Button>
                        </div>
                        {feedback && (
                          <div role="status" style={{ marginTop: 8, color: feedback.ok ? "var(--green)" : "var(--red)", fontSize: 11.5 }}>
                            {feedback.message}
                          </div>
                        )}
                      </Td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      )}
    </Panel>
  );
}

// ─── Configured fleet ─────────────────────────────────────────────────────

function ConfiguredFleetPanel({
  fleet,
  loading,
  error,
}: {
  fleet: FleetEntry[];
  loading: boolean;
  error: Error | null;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const updateMut = useUpdateFleetEntry();
  const deleteMut = useDeleteFleetEntry();
  const fleetCount: string | number = error
    ? "—"
    : loading && fleet.length === 0
      ? "…"
      : fleet.length;

  return (
    <Panel
      title={`${t("models.configuredTitle")} · ${fleetCount}`}
      subtitle={t("models.configuredSubtitle")}
      padded={false}
    >
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
        <thead>
          <tr style={{ borderBottom: "1px solid var(--border)" }}>
            <Th>{t("models.colModel")}</Th>
            <Th>{t("models.colProvider")}</Th>
            <Th>{t("models.colAvailability")}</Th>
            <Th>{t("models.colAlias")}</Th>
            <Th>{t("models.colRole")}</Th>
            <Th>{t("models.colDailyCap")}</Th>
            <Th />
          </tr>
        </thead>
        <tbody>
          {error && (
            <tr>
              <Td colSpan={7} style={{ color: "var(--red)", padding: 14 }}>
                {t("models.fleetLoadFailed")}: {error.message}
              </Td>
            </tr>
          )}
          {loading && (
            <tr>
              <Td colSpan={7} style={{ color: "var(--text-3)", padding: 14 }}>
                {t("models.loadingFleet")}
              </Td>
            </tr>
          )}
          {!error && !loading && fleet.length === 0 && (
            <tr>
              <Td colSpan={7} style={{ color: "var(--text-3)", padding: 14 }}>
                {t("models.noneConfigured")}
              </Td>
            </tr>
          )}
          {fleet.map((m) => (
            <tr key={m.id} style={{ borderBottom: "1px solid var(--border)" }}>
              <Td>
                <span className="mono" style={{ color: "var(--text)" }}>
                  {m.modelName}
                </span>
              </Td>
              <Td>
                <Badge tone="muted">{m.provider}</Badge>
              </Td>
              <Td>
                <span
                  title={m.availabilityMessage ?? undefined}
                  style={{ display: "inline-flex", flexDirection: "column", gap: 3 }}
                >
                  <Badge tone={m.availability === "provider_confirmed" ? "green" : "amber"}>
                    {m.availability === "provider_confirmed"
                      ? t("models.availabilityConfirmed")
                      : t("models.availabilityUnverified")}
                  </Badge>
                  {m.availabilityCheckedAt && (
                    <span style={{ color: "var(--text-4)", fontSize: 9.5 }}>
                      {t("models.availabilityChecked", {
                        time: new Date(m.availabilityCheckedAt).toLocaleString(),
                      })}
                    </span>
                  )}
                </span>
              </Td>
              <Td>
                <span className="mono" style={{ color: "var(--text-2)" }}>
                  {m.alias}
                </span>
              </Td>
              <Td>
                <select
                  value={m.role}
                  onChange={(e) =>
                    updateMut.mutate(
                      {
                        id: m.id,
                        patch: { role: e.target.value as FleetRole },
                      },
                      {
                        onError: (cause) =>
                          toast({
                            tone: "red",
                            title: t("models.updateFailed"),
                            description: cause.message,
                          }),
                      },
                    )
                  }
                  disabled={updateMut.isPending}
                  aria-label={t("models.roleForAria", { name: m.modelName })}
                  style={{
                    background: "var(--panel-2)",
                    border: "1px solid var(--border-2)",
                    borderRadius: 4,
                    padding: "4px 8px",
                    color: "var(--text)",
                    fontSize: 11.5,
                    fontFamily: "var(--mono)",
                    outline: "none",
                  }}
                >
                  {FLEET_ROLES.map((r) => (
                    <option key={r} value={r}>
                      {t(`models.role_${r}`)}
                    </option>
                  ))}
                </select>
              </Td>
              <Td>
                <span className="mono" style={{ color: "var(--text-2)" }}>
                  ${m.dailyCapUsd.toFixed(2)}
                </span>
              </Td>
              <Td style={{ textAlign: "right" }}>
                <Button
                  small
                  tone="ghost"
                  onClick={async () => {
                    if (!confirm(t("models.removeConfirm", { name: m.modelName }))) return;
                    try {
                      await deleteMut.mutateAsync(m.id);
                    } catch (err) {
                      alert(t("models.removeFailed", { name: m.modelName, error: (err as Error).message }));
                    }
                  }}
                  disabled={deleteMut.isPending}
                >
                  <Icon name="x" size={10} /> {t("models.remove")}
                </Button>
              </Td>
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  );
}

// ─── Browse models from provider ──────────────────────────────────────────

function BrowseModelsPanel({
  providers,
  providersLoading,
  providersError,
}: {
  providers: ProviderInfo[];
  providersLoading: boolean;
  providersError: Error | null;
}) {
  const { t } = useI18n();
  const [pickedProvider, setPickedProvider] = useState<string>("");
  const provider = providers.some((candidate) => candidate.id === pickedProvider)
    ? pickedProvider
    : providers[0]?.id ?? "";
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [freeText, setFreeText] = useState("");
  const available = useAvailableModels(provider);
  const addMut = useAddFleetEntry();

  // Reset checkbox state when the provider changes — selections from one
  // provider don't make sense against a different /models list.
  function pickProvider(next: string) {
    setPickedProvider(next);
    setSelected(new Set());
    setFreeText("");
  }

  function toggle(id: string) {
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function addSelected() {
    const ids = [...selected];
    const failed = new Set<string>();
    // Fire mutations sequentially so duplicate-alias errors from one don't
    // race the next; the fleet hook invalidates the list on each settle.
    for (const id of ids) {
      try {
        await addMut.mutateAsync({ provider, modelName: id });
      } catch (err) {
        failed.add(id);
        alert(t("models.addFailed", { id, error: (err as Error).message }));
      }
    }
    setSelected(failed);
  }

  async function addFreeText() {
    const id = freeText.trim();
    if (!id) return;
    try {
      await addMut.mutateAsync({ provider, modelName: id });
      setFreeText("");
    } catch (err) {
      alert(t("models.addFailed", { id, error: (err as Error).message }));
    }
  }

  const models = available.data?.models ?? [];
  const source = available.data?.source ?? null;
  const message = available.data?.message ?? null;
  const isEmptyCatalog =
    !available.isLoading && !available.isError && models.length === 0;
  const addableCount = useMemo(
    () => [...selected].filter((id) => !modelInFleet(models, id)).length,
    [selected, models],
  );

  return (
    <Panel
      title={t("models.browseTitle")}
      subtitle={t("models.browseSubtitle")}
      padded
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Field label={t("models.providerLabel")}>
            <SelectIn
              value={provider}
              onChange={pickProvider}
              options={providers.map((item) => ({ value: item.id, label: item.name }))}
              disabled={providersLoading || providers.length === 0}
            />
          </Field>
          <div style={{ flex: 1 }} />
          <Button
            small
            tone="ghost"
            onClick={() => available.refetch()}
            disabled={available.isFetching || !provider}
          >
            <Icon name="replay" size={11} />{" "}
            {available.isFetching ? t("models.refreshing") : t("models.refresh")}
          </Button>
        </div>

        {providersError && (
          <Banner tone="warn">
            <Icon name="alert" size={11} /> {t("models.providersLoadFailed")}: {providersError.message}
          </Banner>
        )}

        {available.isError ? (
          <Banner tone="warn">
            <Icon name="alert" size={11} /> {t("models.modelListFailed")}: {available.error.message}
          </Banner>
        ) : (
          <SourceBanner
            loading={available.isLoading}
            source={source}
            message={message}
            modelCount={models.length}
          />
        )}

        {available.isLoading && (
          <div style={{ padding: 14, color: "var(--text-3)", fontSize: 12.5 }}>
            {t("models.fetchingModels")}
          </div>
        )}

        {isEmptyCatalog && source === "unsupported" && (
          <FreeTextAdd
            provider={provider}
            value={freeText}
            onChange={setFreeText}
            onAdd={addFreeText}
            adding={addMut.isPending}
          />
        )}

        {isEmptyCatalog && source === "live" ? (
          <div style={{ padding: 14, color: "var(--text-3)", fontSize: 12.5 }}>
            {t("models.noModelsFound")}
          </div>
        ) : null}

        {!available.isLoading && !available.isError && models.length > 0 && (
          <>
            <div style={{ maxHeight: 360, overflowY: "auto", border: "1px solid var(--border)", borderRadius: 4 }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
                <thead style={{ position: "sticky", top: 0, background: "var(--bg-2)" }}>
                  <tr style={{ borderBottom: "1px solid var(--border)" }}>
                    <Th style={{ width: 32 }} />
                    <Th>{t("models.colModelId")}</Th>
                    <Th>{t("models.colTier")}</Th>
                    <Th>{t("models.colContext")}</Th>
                    <Th>{t("models.colPrice")}</Th>
                    <Th>{t("models.colCapabilities")}</Th>
                    <Th>{t("models.colSource")}</Th>
                  </tr>
                </thead>
                <tbody>
                  {models.map((m) => (
                    <ModelRow
                      key={m.id}
                      model={m}
                      checked={selected.has(m.id)}
                      onToggle={() => toggle(m.id)}
                    />
                  ))}
                </tbody>
              </table>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <div style={{ fontSize: 12, color: "var(--text-3)", flex: 1 }}>
                {selected.size === 0
                  ? t("models.selectToAdd")
                  : t("models.selectionSummary", {
                      addable: addableCount,
                      total: selected.size,
                      inFleet: selected.size - addableCount,
                    })}
              </div>
              <Button
                tone="primary"
                small
                onClick={addSelected}
                disabled={addableCount === 0 || addMut.isPending}
              >
                <Icon name="plus" size={11} />{" "}
                {addMut.isPending ? t("models.adding") : t("models.addToFleet", { count: addableCount })}
              </Button>
            </div>
          </>
        )}
      </div>
    </Panel>
  );
}

function modelInFleet(models: AvailableModel[], id: string): boolean {
  return models.find((m) => m.id === id)?.inFleet ?? false;
}

function SourceBanner({
  loading,
  source,
  message,
  modelCount,
}: {
  loading: boolean;
  source: "live" | "unsupported" | null;
  message: string | null;
  modelCount: number;
}) {
  const { t } = useI18n();
  if (loading || source === null) return null;
  if (source === "live") {
    return (
      <Banner tone="ok">
        <Icon name="check" size={11} /> {t("models.liveBanner", { count: modelCount })}
      </Banner>
    );
  }
  return (
    <Banner tone="warn">
      <Icon name="alert" size={11} />{" "}
      {message ?? t("models.unsupportedBanner")}
    </Banner>
  );
}

function Banner({ tone, children }: { tone: "ok" | "warn"; children: React.ReactNode }) {
  const colors =
    tone === "ok"
      ? { bg: "color-mix(in srgb, var(--green) 8%, transparent)", border: "color-mix(in srgb, var(--green) 30%, transparent)", text: "var(--text-2)" }
      : { bg: "color-mix(in srgb, var(--amber) 8%, transparent)", border: "color-mix(in srgb, var(--amber) 30%, transparent)", text: "var(--text-2)" };
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "8px 12px",
        background: colors.bg,
        border: `1px solid ${colors.border}`,
        borderRadius: 4,
        fontSize: 12,
        color: colors.text,
      }}
    >
      {children}
    </div>
  );
}

function ModelRow({
  model,
  checked,
  onToggle,
}: {
  model: AvailableModel;
  checked: boolean;
  onToggle: () => void;
}) {
  const { t } = useI18n();
  return (
    <tr
      style={{
        borderBottom: "1px solid var(--border)",
        opacity: model.inFleet || !model.selectable ? 0.55 : 1,
      }}
    >
      <Td>
        <input
          type="checkbox"
          checked={checked}
          onChange={onToggle}
          disabled={model.inFleet || !model.selectable}
          aria-label={t("models.selectAria", { id: model.id })}
        />
      </Td>
      <Td>
        <span className="mono" style={{ color: "var(--text)" }}>
          {model.id}
        </span>{" "}
        {model.inFleet && (
          <Badge tone="muted" style={{ marginLeft: 6 }}>
            {t("models.inFleet")}
          </Badge>
        )}
        {!model.selectable && (
          <div style={{ color: "var(--text-3)", fontSize: 10.5, marginTop: 3 }}>
            {t("models.notSelectable")} · {formatPolicyReason(model.unavailableReason)}
          </div>
        )}
      </Td>
      <Td>
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
          <Badge tone={tierTone(model.tier)}>
            {model.tier ? `${model.tier}-tier` : t("models.tierUnclassified")}
          </Badge>
          <Badge
            tone={
              model.status === "current"
                ? "green"
                : model.status === "legacy"
                  ? "amber"
                  : "muted"
            }
          >
            {model.status}
          </Badge>
        </div>
      </Td>
      <Td>
        <span
          className="mono"
          title={
            model.contextLength && model.contextLength > 0
              ? `${model.contextLength.toLocaleString("en-US")} tokens`
              : undefined
          }
          style={{ color: "var(--text-2)" }}
        >
          {formatContext(model.contextLength)}
        </span>
      </Td>
      <Td>
        <span className="mono" style={{ color: "var(--text-2)" }}>
          {formatPriceRange(model.inputPricePerMTok, model.outputPricePerMTok)}
        </span>
      </Td>
      <Td>
        <CapabilityChips model={model} />
      </Td>
      <Td>
        <Badge tone={model.origin === "live" ? "blue" : "muted"}>
          {model.origin}
        </Badge>
      </Td>
    </tr>
  );
}

function CapabilityChips({ model }: { model: AvailableModel }) {
  const { t } = useI18n();
  const chips: string[] = [];
  if (model.vision) chips.push("vision");
  if (model.tools) chips.push("tools");
  if (model.reasoning) chips.push("reasoning");
  if (chips.length === 0) return <span style={{ color: "var(--text-3)", fontSize: 11 }}>—</span>;
  return (
    <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
      {chips.map((c) => (
        <Badge key={c} tone="muted">
          {t(`models.cap_${c}`)}
        </Badge>
      ))}
    </div>
  );
}

function tierTone(
  tier: AvailableModel["tier"],
): "signal" | "blue" | "muted" | "green" {
  if (tier === "top") return "signal";
  if (tier === "mid") return "blue";
  if (tier === "free") return "green";
  return "muted";
}

function formatPolicyReason(reason: string | null): string {
  if (!reason) return "catalog policy";
  return reason.replaceAll("_", " ");
}

function formatContext(ctx: number | null): string {
  if (ctx === null || ctx <= 0) return "—";
  if (ctx >= 1_000_000) return `${(ctx / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (ctx >= 1_000) return `${Math.round(ctx / 1_000)}k`;
  return String(ctx);
}

function formatPriceRange(inP: number | null, outP: number | null): string {
  if (inP === null && outP === null) return "—";
  const i = inP === null ? "?" : `$${inP}`;
  const o = outP === null ? "?" : `$${outP}`;
  return `${i} → ${o}`;
}

function FreeTextAdd({
  provider,
  value,
  onChange,
  onAdd,
  adding,
}: {
  provider: string;
  value: string;
  onChange: (v: string) => void;
  onAdd: () => void;
  adding: boolean;
}) {
  const { t } = useI18n();
  return (
    <div
      style={{
        padding: 14,
        background: "var(--bg-2)",
        border: "1px solid var(--border)",
        borderRadius: 4,
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <div style={{ fontSize: 12, color: "var(--text-2)" }}>
        {t("models.freeTextDescPrefix")} <span className="mono">{provider}</span>{" "}
        {t("models.freeTextDescSuffix")}
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <div style={{ flex: 1 }}>
          <TextIn
            value={value}
            onChange={onChange}
            placeholder={t("models.freeTextPlaceholder")}
            mono
            ariaLabel={t("models.modelIdAria")}
          />
        </div>
        <Button
          tone="primary"
          small
          onClick={onAdd}
          disabled={!value.trim() || adding}
        >
          {adding ? t("models.adding") : t("models.addToFleetPlain")}
        </Button>
      </div>
    </div>
  );
}

// ─── Fallback chain ───────────────────────────────────────────────────────

function FallbackChainPanel({ fleet }: { fleet: FleetEntry[] }) {
  const { t } = useI18n();
  const chain = fleet.filter((m) => m.role === "primary" || m.role === "fallback");
  if (chain.length === 0) return null;
  return (
    <Panel title={t("models.fallbackTitle")} padded>
      <div style={{ fontSize: 12.5, color: "var(--text-2)", marginBottom: 10, lineHeight: 1.55 }}>
        {t("models.fallbackDesc")}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {chain.map((m, i) => (
          <div
            key={m.id}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "8px 12px",
              background: "var(--panel-2)",
              border: "1px solid var(--border)",
              borderRadius: 4,
            }}
          >
            <span
              style={{
                fontSize: 10.5,
                fontFamily: "var(--mono)",
                color: "var(--text-3)",
                width: 18,
              }}
            >
              {i + 1}.
            </span>
            <span className="mono" style={{ fontSize: 12, color: "var(--text)", flex: 1 }}>
              {m.alias}
            </span>
            <Badge tone="muted">{m.provider}</Badge>
            <Badge tone={m.availability === "provider_confirmed" ? "green" : "amber"}>
              {m.availability === "provider_confirmed"
                ? t("models.availabilityConfirmed")
                : t("models.availabilityUnverified")}
            </Badge>
            <Badge tone={m.role === "primary" ? "signal" : "muted"}>{t(`models.role_${m.role}`)}</Badge>
          </div>
        ))}
      </div>
    </Panel>
  );
}
