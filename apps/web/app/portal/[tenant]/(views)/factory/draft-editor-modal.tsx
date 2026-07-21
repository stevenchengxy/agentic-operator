"use client";

import React, { useEffect, useMemo, useState } from "react";
import { Button, ModalOverlay } from "@/app/portal/components";
import { useI18n } from "@/app/portal/lib/preferences-context";
import {
  draftDiffText,
  draftEditorValueText,
  prepareDraftFieldEdit,
  type DraftEditorContract,
  type StructuredDraftPatch,
} from "./draft-editor";

export interface DraftEditorSaveResult {
  ok: boolean;
  message?: string;
}

export function DraftEditorModal({
  contract,
  onClose,
  onSave,
}: {
  contract: DraftEditorContract;
  onClose: () => void;
  onSave: (patch: StructuredDraftPatch) => Promise<DraftEditorSaveResult>;
}) {
  const { t } = useI18n();
  const [selectedKey, setSelectedKey] = useState(contract.fields[0]?.key ?? "");
  const selected = contract.fields.find((field) => field.key === selectedKey) ?? contract.fields[0];
  const [text, setText] = useState(() => selected ? draftEditorValueText(selected) : "");
  const [unset, setUnset] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!selected) return;
    setText(draftEditorValueText(selected));
    setUnset(false);
    setDirty(false);
    setConfirmed(false);
    setError("");
  }, [selected]);

  const preview = useMemo(
    () => selected && dirty ? prepareDraftFieldEdit(t, selected, text, unset) : null,
    [dirty, selected, t, text, unset],
  );
  const canSave = Boolean(selected?.editable && preview?.ok && confirmed && !saving);

  async function save() {
    if (!preview?.ok || !confirmed || saving) return;
    setSaving(true);
    setError("");
    try {
      const result = await onSave(preview.data.patch);
      if (!result.ok) {
        setError(result.message || t("factory.draftEditor.saveFailed"));
        return;
      }
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("factory.draftEditor.saveFailed"));
    } finally {
      setSaving(false);
    }
  }

  if (!selected) return null;
  const useSelect = selected.valueType === "boolean" || selected.valueType === "enum";
  const selectValues = selected.valueType === "boolean" ? ["true", "false"] : selected.enumValues ?? [];
  const compactInput = selected.valueType === "string" || selected.valueType === "integer" || selected.valueType === "number";

  return (
    <ModalOverlay onClose={() => { if (!saving) onClose(); }} ariaLabel={t("factory.draftEditor.ariaLabel")}>
      <div style={{ width: "min(980px, 94vw)", maxHeight: "92vh", display: "flex", flexDirection: "column", overflow: "hidden", border: "1px solid var(--border)", borderRadius: 12, background: "var(--panel)", boxShadow: "0 24px 70px rgba(0,0,0,.35)" }}>
        <header style={{ padding: "14px 16px", borderBottom: "1px solid var(--border)", display: "flex", gap: 12, alignItems: "flex-start" }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ color: "var(--text)", fontSize: 14, fontWeight: 700 }}>{t("factory.draftEditor.title")}</div>
            <div className="mono" style={{ marginTop: 4, color: "var(--text-3)", fontSize: 10.5, overflowWrap: "anywhere" }}>
              {contract.scope.tenantSlug} / {contract.scope.domain} / {contract.scope.slug} / {contract.scope.versionId}
            </div>
          </div>
          <Button small tone="ghost" icon="x" onClick={onClose} disabled={saving}>{t("factory.draftEditor.close")}</Button>
        </header>

        <div style={{ overflow: "auto", padding: 16, display: "grid", gap: 14 }}>
          <div role="note" style={{ padding: "10px 12px", border: "1px solid var(--amber)", borderRadius: 8, color: "var(--amber)", background: "var(--panel-2)", fontSize: 11.5, lineHeight: 1.6 }}>
            {t("factory.draftEditor.derivedVersionNotice")}
          </div>

          <section style={{ display: "grid", gap: 8 }}>
            <label htmlFor="factory-draft-edit-field" style={{ color: "var(--text-2)", fontSize: 11.5, fontWeight: 650 }}>{t("factory.draftEditor.selectFieldLabel")}</label>
            <select
              id="factory-draft-edit-field"
              value={selected.key}
              onChange={(event) => setSelectedKey(event.target.value)}
              disabled={saving}
              style={{ width: "100%", padding: "8px 10px", border: "1px solid var(--border)", borderRadius: 7, background: "var(--panel-2)", color: "var(--text)", fontSize: 12 }}
            >
              {contract.fields.map((field) => (
                <option key={field.key} value={field.key}>{field.label} · {field.key}{field.editable ? "" : t("factory.draftEditor.ontologyReadonlySuffix")}{field.valueStatus === "withheld_sensitive" ? t("factory.draftEditor.originalHiddenSuffix") : ""}</option>
              ))}
            </select>
            <div style={{ color: "var(--text-3)", fontSize: 10.5, lineHeight: 1.5 }}>{selected.help}</div>
            {!selected.editable && (
              <div role="status" style={{ padding: "8px 10px", border: "1px solid var(--blue)", borderRadius: 7, color: "var(--blue)", fontSize: 10.5, lineHeight: 1.5 }}>
                {selected.readonlyReason}
              </div>
            )}
            {selected.valueStatus === "withheld_sensitive" && (
              <div role="status" style={{ padding: "8px 10px", border: "1px solid var(--amber)", borderRadius: 7, color: "var(--amber)", fontSize: 10.5, lineHeight: 1.5 }}>
                {t("factory.draftEditor.sensitiveWithheldNotice")}
              </div>
            )}
          </section>

          <section style={{ display: "grid", gap: 8 }}>
            <label htmlFor="factory-draft-edit-value" style={{ color: "var(--text-2)", fontSize: 11.5, fontWeight: 650 }}>{selected.editable ? t("factory.draftEditor.newValueLabel") : t("factory.draftEditor.currentValueReadonlyLabel")}</label>
            {useSelect ? (
              <select
                id="factory-draft-edit-value"
                value={text}
                disabled={!selected.editable || unset || saving}
                onChange={(event) => { setText(event.target.value); setDirty(true); setConfirmed(false); }}
                style={{ width: "100%", padding: "8px 10px", border: "1px solid var(--border)", borderRadius: 7, background: "var(--panel-2)", color: "var(--text)", fontSize: 12 }}
              >
                {!selectValues.includes(text) && <option value="">{t("factory.draftEditor.selectPlaceholder")}</option>}
                {selectValues.map((value) => <option key={value} value={value}>{value}</option>)}
              </select>
            ) : compactInput ? (
              <input
                id="factory-draft-edit-value"
                type={selected.valueType === "number" || selected.valueType === "integer" ? "number" : "text"}
                step={selected.valueType === "integer" ? 1 : selected.valueType === "number" ? "any" : undefined}
                value={text}
                disabled={!selected.editable || unset || saving}
                onChange={(event) => { setText(event.target.value); setDirty(true); setConfirmed(false); }}
                style={{ width: "100%", boxSizing: "border-box", padding: "8px 10px", border: "1px solid var(--border)", borderRadius: 7, background: "var(--panel-2)", color: "var(--text)", fontSize: 12 }}
              />
            ) : (
              <textarea
                id="factory-draft-edit-value"
                value={text}
                disabled={!selected.editable || unset || saving}
                rows={selected.valueType === "code" ? 18 : selected.valueType === "json" || selected.valueType === "string_array" ? 12 : 8}
                spellCheck={selected.valueType !== "code" && selected.valueType !== "json" && selected.valueType !== "string_array"}
                onChange={(event) => { setText(event.target.value); setDirty(true); setConfirmed(false); }}
                style={{ width: "100%", boxSizing: "border-box", resize: "vertical", padding: 10, border: "1px solid var(--border)", borderRadius: 7, background: "var(--panel-2)", color: "var(--text)", fontFamily: selected.valueType === "multiline" ? "var(--sans)" : "var(--mono)", fontSize: 11.5, lineHeight: 1.55 }}
              />
            )}
            {selected.unsettable && (
              <label style={{ display: "flex", gap: 8, alignItems: "flex-start", color: "var(--text-2)", fontSize: 11 }}>
                <input
                  type="checkbox"
                  checked={unset}
                  disabled={!selected.editable || !selected.present || saving}
                  onChange={(event) => { setUnset(event.target.checked); setDirty(true); setConfirmed(false); }}
                />
                {t("factory.draftEditor.removeOptionalField")}
              </label>
            )}
          </section>

          {dirty && preview && !preview.ok && (
            <div role="alert" style={{ color: "var(--red)", fontSize: 11.5, lineHeight: 1.5 }}>{preview.message}</div>
          )}

          {preview?.ok && (
            <section aria-labelledby="factory-draft-diff-heading" style={{ display: "grid", gap: 9 }}>
              <div id="factory-draft-diff-heading" style={{ color: "var(--text)", fontSize: 12, fontWeight: 700 }}>{t("factory.draftEditor.diffHeading", { label: selected.label })}</div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 8 }}>
                <div style={{ minWidth: 0, border: "1px solid var(--border)", borderRadius: 8, padding: 10 }}>
                  <div style={{ color: "var(--red)", fontSize: 10.5, fontWeight: 650 }}>{t("factory.draftEditor.oldVersion")}</div>
                  <pre style={{ margin: "7px 0 0", maxHeight: 230, overflow: "auto", whiteSpace: "pre-wrap", overflowWrap: "anywhere", color: "var(--text-2)", fontSize: 10.5, lineHeight: 1.5 }}>{draftDiffText(t, preview.data.before, preview.data.beforeWithheld)}</pre>
                </div>
                <div style={{ minWidth: 0, border: "1px solid var(--border)", borderRadius: 8, padding: 10 }}>
                  <div style={{ color: "var(--green)", fontSize: 10.5, fontWeight: 650 }}>{t("factory.draftEditor.newVersion")}</div>
                  <pre style={{ margin: "7px 0 0", maxHeight: 230, overflow: "auto", whiteSpace: "pre-wrap", overflowWrap: "anywhere", color: "var(--text-2)", fontSize: 10.5, lineHeight: 1.5 }}>{draftDiffText(t, preview.data.after)}</pre>
                </div>
              </div>
              <label style={{ display: "flex", gap: 9, alignItems: "flex-start", padding: 10, border: "1px solid var(--border)", borderRadius: 8, color: "var(--text-2)", fontSize: 11.5, lineHeight: 1.5 }}>
                <input type="checkbox" checked={confirmed} disabled={saving} onChange={(event) => setConfirmed(event.target.checked)} style={{ marginTop: 2 }} />
                {t("factory.draftEditor.confirmReviewCheckbox")}
              </label>
            </section>
          )}

          {error && <div role="alert" style={{ color: "var(--red)", fontSize: 11.5, lineHeight: 1.5 }}>{error}</div>}
        </div>

        <footer style={{ padding: "12px 16px", borderTop: "1px solid var(--border)", display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <Button tone="ghost" onClick={onClose} disabled={saving}>{t("factory.draftEditor.cancel")}</Button>
          <Button tone="primary" onClick={() => void save()} disabled={!canSave}>{saving ? t("factory.draftEditor.creatingVersion") : t("factory.draftEditor.confirmCreateVersion")}</Button>
        </footer>
      </div>
    </ModalOverlay>
  );
}
