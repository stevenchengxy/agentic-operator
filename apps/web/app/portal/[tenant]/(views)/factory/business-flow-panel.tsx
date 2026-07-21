"use client";

/**
 * #BIZFLOW — 业务流全景：由工厂推理生成的端到端业务流程图（外部平台 · 每个 agent 的
 * 读/调/写/通知 · emit 分支语义），数据来自后端 validate_graph 发出的 `flow.business`
 * BrainEvent（packages/agent-factory/src/business-flow.ts 的纯推理产物）。
 * 纯投影：历史运行回放渲染一致。目标形态 = 手绘的 6-agent 业务工作流图，但由工厂自己生成。
 */

import React, { useMemo } from "react";
import { Empty, HelpTip } from "@/app/portal/components";
import { useI18n } from "@/app/portal/lib/preferences-context";
import type { BrainEvent } from "@/lib/hooks/useBrainStream";

// —— 与 business-flow.ts#BusinessFlowModel 对齐的宽松前端形状（事件流是 loose 的） ——
export interface BizEmit { event: string; semantic: string; consumers: string[]; externalConsumer?: string }
export interface BizAgent {
  actionName: string; slug: string; nameZh: string; isSubAgent: boolean;
  triggers: Array<{ event: string; external: boolean; source?: string }>;
  reads: string[]; calls: string[];
  writes: Array<{ object: string; action: string }>;
  notifies: string[];
  emits: BizEmit[];
}
export interface BizModel {
  domain: string;
  externals: Array<{ name: string; kind: string; usedBy: string[]; roles: string[] }>;
  agents: BizAgent[];
  entries: Array<{ event: string; consumers: string[] }>;
}

/** 取最后一次 flow.business（validate_graph 每次重发，最新即最准）。 */
export function deriveBusinessFlowModel(events: BrainEvent[]): BizModel | null {
  let model: BizModel | null = null;
  for (const e of events) if (e.t === "flow.business" && e.model) model = e.model as unknown as BizModel;
  return model;
}

const SEM_COLOR: Record<string, string> = {
  internal: "var(--blue)",
  success: "var(--green)",
  terminal: "var(--green)",
  failure: "var(--red)",
  park: "var(--violet)",
  external: "var(--amber)",
};
const SEMANTICS = new Set(["internal", "success", "terminal", "failure", "park", "external"]);
const KIND_ICON: Record<string, string> = {
  external_api: "🌐",
  file_store: "📁",
  rulebase: "📚",
  email: "✉️",
  external_platform: "🏢",
  datastore: "🗄️",
  internal: "⚙️",
};

const chipStyle = (color: string): React.CSSProperties => ({
  display: "inline-block", fontSize: 10.5, fontFamily: "var(--mono)", color,
  border: `1px solid ${color}`, borderRadius: 6, padding: "1px 7px", opacity: 0.92,
});

function Line({ icon, items, color }: { icon: string; items: string[]; color?: string }) {
  if (!items.length) return null;
  return (
    <div style={{ fontSize: 10.5, color: color ?? "var(--text-3)", fontFamily: "var(--mono)", lineHeight: 1.6 }}>
      {icon} {items.join(" · ")}
    </div>
  );
}

export function BusinessFlowPanel({ events, onSelect }: { events: BrainEvent[]; onSelect?: (slug: string) => void }) {
  const { language, t } = useI18n();
  const model = useMemo(() => deriveBusinessFlowModel(events), [events]);
  const listSeparator = language === "zh" ? "、" : ", ";
  if (!model) {
    return <Empty title={<>{t("factory.businessFlow.empty.title")} <HelpTip>{t("factory.businessFlow.emptyTip.before")}<span style={{ fontFamily: "var(--mono)" }}>validate_graph</span>{t("factory.businessFlow.emptyTip.after")}</HelpTip></>} />;
  }
  const topAgents = model.agents.filter((a) => !a.isSubAgent);
  const subAgents = model.agents.filter((a) => a.isSubAgent);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {/* 外部平台目录 */}
      {model.externals.length > 0 && (
        <div style={{ border: "1px solid var(--border)", borderRadius: 10, background: "var(--panel-2)", padding: "9px 11px" }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "var(--amber)", marginBottom: 6 }}>{t("factory.businessFlow.externals.heading", { count: model.externals.length })}</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {model.externals.map((x) => (
              <span key={x.name} style={chipStyle("var(--amber)")} title={t("factory.businessFlow.externals.usedByTitle", { usedBy: x.usedBy.join(listSeparator), roles: x.roles.join("/") })}>
                {KIND_ICON[x.kind] ?? "🏢"} {x.name} <span style={{ color: "var(--text-4)" }}>{x.roles.join("/")}</span>
              </span>
            ))}
          </div>
        </div>
      )}

      {/* agent 泳道：外部来源 → trigger → agent → 读/调/写 → emit 分支 */}
      {topAgents.map((a) => (
        <div
          key={a.slug}
          onClick={() => onSelect?.(a.slug)}
          style={{ border: "1px solid var(--border)", borderRadius: 10, background: "var(--panel-2)", padding: "9px 11px", cursor: onSelect ? "pointer" : "default", display: "flex", gap: 10, alignItems: "flex-start", flexWrap: "wrap" }}
        >
          {/* triggers */}
          <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 150 }}>
            {a.triggers.map((trigger) => (
              <div key={trigger.event}>
                {trigger.external && (
                  <div style={{ fontSize: 9.5, color: "var(--amber)", fontFamily: "var(--mono)", marginBottom: 1 }}>🏢 {trigger.source ?? t("factory.businessFlow.trigger.externalSourceFallback")} ▸</div>
                )}
                <span style={chipStyle("var(--blue)")}>◂ {trigger.event}</span>
              </div>
            ))}
          </div>

          {/* agent box */}
          <div style={{ minWidth: 148, borderLeft: "2px solid var(--signal)", paddingLeft: 10 }}>
            <div style={{ fontSize: 12.5, fontWeight: 700, color: "var(--text)" }}>{a.nameZh || a.actionName}</div>
            <div style={{ fontSize: 10, color: "var(--text-4)", fontFamily: "var(--mono)" }}>{a.actionName}</div>
          </div>

          {/* reads / calls / writes / notifies */}
          <div style={{ flex: 1, minWidth: 200 }}>
            <Line icon="📥" items={a.reads} />
            <Line icon="🌐" items={a.calls} color="var(--text-2)" />
            <Line icon="🗄️" items={a.writes.map((w) => `${w.object}(${w.action})`)} />
            <Line icon="✉️" items={a.notifies} />
          </div>

          {/* emit branches */}
          <div style={{ display: "flex", flexDirection: "column", gap: 4, alignItems: "flex-end" }}>
            {a.emits.map((em) => {
              const color = SEM_COLOR[em.semantic] ?? "var(--text-3)";
              return (
                <div key={em.event} style={{ textAlign: "right" }}>
                  <span style={chipStyle(color)}>▸ {em.event}</span>
                  <div style={{ fontSize: 9.5, color: "var(--text-4)", fontFamily: "var(--mono)", marginTop: 1 }}>
                    {SEMANTICS.has(em.semantic) ? t(`factory.businessFlow.semantic.${em.semantic}`) : em.semantic}
                    {em.semantic === "external" && em.externalConsumer ? ` → ${em.externalConsumer}` : em.consumers.length ? ` → ${em.consumers.join(listSeparator)}` : ""}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}

      {/* sub-agents（invoke-only 助手） */}
      {subAgents.length > 0 && (
        <div style={{ border: "1px dashed var(--border-2)", borderRadius: 10, padding: "8px 11px" }}>
          <div style={{ fontSize: 10.5, color: "var(--violet)", fontFamily: "var(--mono)", marginBottom: 5 }}>🧩 {t("factory.businessFlow.subAgents.heading")}</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {subAgents.map((a) => (
              <span key={a.slug} style={{ ...chipStyle("var(--violet)"), cursor: onSelect ? "pointer" : "default" }} onClick={() => onSelect?.(a.slug)}>
                {a.nameZh || a.actionName}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
