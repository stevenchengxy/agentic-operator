"use client";

import { useState } from "react";
import {
  Badge,
  Button,
  Icon,
  ModalOverlay,
} from "@/app/portal/components";
import { useTenants } from "@/lib/hooks/useTenants";
import { useI18n } from "@/app/portal/lib/preferences-context";

const WORKFLOW_TEMPLATES = [
  { id: "raas", name: "RAAS · Recruitment", desc: "22-agent pipeline: sync → JD → match → submit", agents: 22, events: 33, color: "#d0ff00" },
  { id: "support", name: "Tier-1 Ticket Triage", desc: "Classify → enrich → route → draft reply", agents: 11, events: 18, color: "#7c9eff" },
  { id: "finance", name: "Monthly Close", desc: "GL reconcile → variance review → sign-off", agents: 8, events: 12, color: "#f5c46b" },
  { id: "rag", name: "Doc Q&A · RAG", desc: "Ingest → chunk → embed → answer", agents: 5, events: 7, color: "#b594ff" },
  { id: "sales", name: "Outbound Sequence", desc: "Enrich lead → personalize → followups", agents: 9, events: 14, color: "#65e0a3" },
  { id: "compl", name: "Compliance Review", desc: "Detect PII → redact → audit → archive", agents: 6, events: 9, color: "#ff6470" },
];

export function NewWorkflowModal({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const tenantsQuery = useTenants();
  // Tenant switcher dropdown. Empty list while the query is in-flight or
  // when the api is unreachable — chrome.tsx surfaces the api-down banner
  // so we don't double-warn here.
  const tenants = (tenantsQuery.data?.items ?? []).filter(
    (t) => t.archivedAt == null,
  );
  const [path, setPath] = useState<"blank" | "template" | "import">("template");
  const [name, setName] = useState("");
  const [id, setId] = useState("");
  const [tenant, setTenant] = useState("raas");
  const [template, setTemplate] = useState("raas");

  function slugify(s: string) {
    return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  }
  function suggestId(n: string) {
    const slug = slugify(n);
    if (!id || id === slugify(name)) setId(slug);
    setName(n);
  }

  return (
    <ModalOverlay onClose={onClose}>
      <div
        style={{
          width: 780,
          maxHeight: "86vh",
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
          <Icon name="workflow" size={14} style={{ color: "var(--accent-text)" }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 14, color: "var(--text)", fontWeight: 500 }}>{t("newWorkflowModal.title")}</div>
            <div style={{ fontSize: 11, color: "var(--text-3)" }}>
              {t("newWorkflowModal.subtitle")}
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label={t("newWorkflowModal.closeAria")}
            style={{ color: "var(--text-3)" }}
          >
            <Icon name="x" size={13} />
          </button>
        </header>

        <div style={{ padding: 18, overflow: "auto", flex: 1 }}>
          <SectionLabel>{t("newWorkflowModal.startFrom")}</SectionLabel>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8, marginBottom: 20 }}>
            <PathCard active={path === "blank"} onClick={() => setPath("blank")} icon="plus" title={t("newWorkflowModal.blankTitle")} sub={t("newWorkflowModal.blankSub")} />
            <PathCard active={path === "template"} onClick={() => setPath("template")} icon="workflow" title={t("newWorkflowModal.templateTitle")} sub={t("newWorkflowModal.templateSub")} />
            <PathCard active={path === "import"} onClick={() => setPath("import")} icon="upload" title={t("newWorkflowModal.importTitle")} sub={t("newWorkflowModal.importSub")} />
          </div>

          <SectionLabel>{t("newWorkflowModal.identity")}</SectionLabel>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 20 }}>
            <FieldInline label={t("newWorkflowModal.displayName")}>
              <InlineText value={name} onChange={suggestId} />
            </FieldInline>
            <FieldInline label={t("newWorkflowModal.workflowId")}>
              <InlineText value={id} onChange={setId} mono />
            </FieldInline>
            <FieldInline label={t("newWorkflowModal.tenant")}>
              <select
                value={tenant}
                onChange={(e) => setTenant(e.target.value)}
                style={{
                  background: "var(--panel-2)",
                  border: "1px solid var(--border-2)",
                  borderRadius: 4,
                  padding: "5px 8px",
                  color: "var(--text)",
                  fontSize: 12,
                  outline: "none",
                }}
              >
                {tenants.map((t) => (
                  <option key={t.slug} value={t.slug}>
                    {t.name}
                  </option>
                ))}
              </select>
            </FieldInline>
            <FieldInline label={t("newWorkflowModal.defaultModel")}>
              <select
                defaultValue="claude-sonnet-4-5"
                style={{
                  background: "var(--panel-2)",
                  border: "1px solid var(--border-2)",
                  borderRadius: 4,
                  padding: "5px 8px",
                  color: "var(--text)",
                  fontSize: 12,
                  fontFamily: "var(--mono)",
                  outline: "none",
                }}
              >
                <option>claude-sonnet-4-5</option>
                <option>claude-haiku-4-5</option>
                <option>gpt-4.1-mini</option>
              </select>
            </FieldInline>
          </div>

          {path === "blank" && (
            <div>
              <SectionLabel>{t("newWorkflowModal.trigger")}</SectionLabel>
              <div
                style={{
                  padding: 14,
                  background: "var(--panel-2)",
                  border: "1px dashed var(--border-3)",
                  borderRadius: 6,
                }}
              >
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                  <FieldInline label={t("newWorkflowModal.triggerType")}>
                    <select
                      style={{
                        background: "var(--panel)",
                        border: "1px solid var(--border-2)",
                        borderRadius: 4,
                        padding: "5px 8px",
                        color: "var(--text)",
                        fontSize: 12,
                        outline: "none",
                      }}
                    >
                      <option>{t("newWorkflowModal.triggerEvent")}</option>
                      <option>{t("newWorkflowModal.triggerScheduled")}</option>
                      <option>{t("newWorkflowModal.triggerWebhook")}</option>
                      <option>{t("newWorkflowModal.triggerManual")}</option>
                    </select>
                  </FieldInline>
                  <FieldInline label={t("newWorkflowModal.firstAgentName")}>
                    <InlineText value="processNewRequest" mono onChange={() => {}} />
                  </FieldInline>
                </div>
                <div style={{ marginTop: 10, fontSize: 11.5, color: "var(--text-3)", lineHeight: 1.55 }}>
                  {t("newWorkflowModal.blankStubHelp")}
                </div>
              </div>
            </div>
          )}

          {path === "template" && (
            <div>
              <SectionLabel>{t("newWorkflowModal.pickTemplate")}</SectionLabel>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 8 }}>
                {WORKFLOW_TEMPLATES.map((tpl) => (
                  <button
                    key={tpl.id}
                    onClick={() => setTemplate(tpl.id)}
                    style={{
                      padding: "12px 14px",
                      background: template === tpl.id ? "var(--panel-3)" : "var(--panel-2)",
                      border: `1px solid ${template === tpl.id ? "var(--signal)" : "var(--border)"}`,
                      borderRadius: 5,
                      textAlign: "left",
                      cursor: "pointer",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                      <div style={{ width: 14, height: 14, background: tpl.color, borderRadius: 2 }} />
                      <span style={{ fontSize: 13, color: "var(--text)", fontWeight: 500 }}>{t(`newWorkflowModal.tplName_${tpl.id}`)}</span>
                      {template === tpl.id && (
                        <Icon name="check" size={11} style={{ color: "var(--accent-text)", marginLeft: "auto" }} />
                      )}
                    </div>
                    <div style={{ fontSize: 11.5, color: "var(--text-2)", marginBottom: 6 }}>{t(`newWorkflowModal.tplDesc_${tpl.id}`)}</div>
                    <div style={{ fontSize: 10.5, color: "var(--text-3)", fontFamily: "var(--mono)" }}>
                      {t("newWorkflowModal.agentsEvents", { agents: tpl.agents, events: tpl.events })}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {path === "import" && (
            <div>
              <SectionLabel>{t("newWorkflowModal.manifest")}</SectionLabel>
              <div
                style={{
                  padding: 28,
                  textAlign: "center",
                  background: "var(--bg-2)",
                  border: "1px dashed var(--border-3)",
                  borderRadius: 6,
                }}
              >
                <Icon name="upload" size={22} style={{ color: "var(--text-3)" }} />
                <div style={{ marginTop: 8, fontSize: 12.5, color: "var(--text-2)" }}>
                  {t("newWorkflowModal.dropPrefix")} <span className="mono">workflow.json</span> {t("newWorkflowModal.dropAnd")} <span className="mono">actions.json</span>
                </div>
                <div style={{ marginTop: 4, fontSize: 11, color: "var(--text-3)" }}>
                  {t("newWorkflowModal.or")} <span style={{ color: "var(--accent-text)" }}>{t("newWorkflowModal.browseFiles")}</span>
                </div>
              </div>
              <div style={{ marginTop: 10, fontSize: 11.5, color: "var(--text-3)", lineHeight: 1.55 }}>
                {t("newWorkflowModal.schemaNotePrefix")} <span className="mono">RAAS</span>:{" "}
                <span className="mono">id, name, actor, trigger[], actions[], triggered_event[]</span>. {t("newWorkflowModal.schemaNoteSuffix")}
              </div>
            </div>
          )}
        </div>

        <footer style={{ display: "flex", alignItems: "center", gap: 8, padding: "12px 18px", borderTop: "1px solid var(--border)", background: "var(--panel-2)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--text-3)" }}>
            <Icon name="check" size={10} style={{ color: "var(--green)" }} />
            <span>{t("newWorkflowModal.draftNote")}</span>
          </div>
          <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
            <Button tone="ghost" onClick={onClose}>{t("newWorkflowModal.cancel")}</Button>
            <Button tone="primary" icon="check" onClick={onClose}>{t("newWorkflowModal.create")}</Button>
          </div>
        </footer>
      </div>
    </ModalOverlay>
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
  icon: "plus" | "workflow" | "upload";
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

function FieldInline({ label, children }: { label: string; children: React.ReactNode }) {
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

function InlineText({
  value,
  onChange,
  mono,
}: {
  value: string;
  onChange: (v: string) => void;
  mono?: boolean;
}) {
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      style={{
        background: "var(--panel-2)",
        border: "1px solid var(--border-2)",
        borderRadius: 4,
        padding: "5px 8px",
        color: "var(--text)",
        fontFamily: mono ? "var(--mono)" : "var(--sans)",
        fontSize: mono ? 11.5 : 12,
        outline: "none",
      }}
    />
  );
}

// Unused helper kept for parity / future extensibility.
export { Badge };
