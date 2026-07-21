"use client";

/**
 * #BLUEPRINT — ontology-grounded 蓝图全景：由工厂 build_blueprint 推理生成的【分阶段】
 * 工作流/业务流/agent 蓝图。数据来自后端 {t:'flow.blueprint'} BrainEvent。每个 phase/step
 * 都锚定本体 entity/action/rule/event；缺证据的进 unresolved（如实标注，未编造）。
 * 图为服务端预渲染的确定性 SVG（blueprint-svg.ts），面板逐字内嵌 → 历史回放渲染一致，可导 PDF。
 */

import React, { useMemo } from "react";
import { Empty, HelpTip } from "@/app/portal/components";
import { useI18n } from "@/app/portal/lib/preferences-context";
import type { BrainEvent } from "@/lib/hooks/useBrainStream";

interface BpAnchor { kind: string; id: string; evidence?: string }
interface BpStep { label: string; agent?: string; reads?: string[]; writes?: string[]; emits?: string[]; anchors?: BpAnchor[] }
interface BpPhase { id: string; title: string; intent?: string; anchors?: BpAnchor[]; steps?: BpStep[]; deliberation?: string }
interface BpDiagram { kind: string; title: string; svg?: string; source?: string; rationale?: string }
interface BpUnresolved { scope: string; ref: string; reason: string }
export interface BlueprintModel {
  domain: string;
  ontologySig?: string;
  phases: BpPhase[];
  diagrams: BpDiagram[];
  unresolved: BpUnresolved[];
}

/** 取最后一次 flow.blueprint（build_blueprint 每次重发，最新即最准）。 */
export function deriveBlueprintModel(events: BrainEvent[]): BlueprintModel | null {
  let model: BlueprintModel | null = null;
  for (const e of events) if (e.t === "flow.blueprint" && e.model) model = e.model as unknown as BlueprintModel;
  return model;
}

const ANCHOR_COLOR: Record<string, string> = {
  entity: "var(--blue)",
  action: "var(--green)",
  rule: "var(--amber)",
  event: "var(--violet)",
};
const KNOWN_ANCHOR_KINDS = new Set(["entity", "action", "rule", "event"]);

function AnchorChips({ anchors }: { anchors?: BpAnchor[] }) {
  const { t } = useI18n();
  if (!anchors?.length) return null;
  return (
    <span style={{ display: "inline-flex", flexWrap: "wrap", gap: 4 }}>
      {anchors.map((a, i) => {
        const color = ANCHOR_COLOR[a.kind] ?? "var(--text-3)";
        const label = KNOWN_ANCHOR_KINDS.has(a.kind) ? t("factory.blueprintPanel.anchorLabel." + a.kind) : a.kind;
        return (
          <span key={`${a.kind}:${a.id}:${i}`} title={`${label}${a.evidence ? " · " + a.evidence : ""}`} style={{ fontSize: 10, fontFamily: "var(--mono)", color, border: `1px solid ${color}`, borderRadius: 5, padding: "0 5px", opacity: 0.9 }}>
            {a.id}
          </span>
        );
      })}
    </span>
  );
}

export function BlueprintPanel({ events }: { events: BrainEvent[] }) {
  const { t } = useI18n();
  const model = useMemo(() => deriveBlueprintModel(events), [events]);
  if (!model) {
    return <Empty title={<>{t("factory.blueprintPanel.empty.title")} <HelpTip>{t("factory.blueprintPanel.empty.helpPre")}<span style={{ fontFamily: "var(--mono)" }}>build_blueprint</span>{t("factory.blueprintPanel.empty.helpPost")}</HelpTip></>} />;
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {/* 渲染出的图（服务端确定性 SVG，逐字内嵌） */}
      {model.diagrams.map((d, i) => (
        <div key={`${d.kind}-${i}`} style={{ border: "1px solid var(--border)", borderRadius: 10, background: "var(--panel-2)", padding: 8, overflowX: "auto" }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-2)", marginBottom: 6, display: "flex", gap: 8, alignItems: "baseline" }}>
            <span>{d.title}</span>
            <span style={{ fontSize: 10, color: "var(--text-3)", fontFamily: "var(--mono)" }}>{d.kind}</span>
            {d.rationale && <span style={{ fontSize: 10, color: "var(--text-3)" }}>· {d.rationale}</span>}
          </div>
          {d.svg
            ? <div style={{ minWidth: 720 }} dangerouslySetInnerHTML={{ __html: d.svg }} />
            : d.source
              ? <pre style={{ fontSize: 11, fontFamily: "var(--mono)", color: "var(--text-2)", margin: 0, whiteSpace: "pre-wrap" }}>{d.source}</pre>
              : <div style={{ fontSize: 11, color: "var(--text-3)" }}>{t("factory.blueprintPanel.diagram.notPreRendered")}</div>}
        </div>
      ))}

      {/* 分阶段结构（每节点带本体锚点） */}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {model.phases.map((p, i) => (
          <div key={p.id} style={{ border: "1px solid var(--border)", borderLeft: "3px solid var(--blue)", borderRadius: "0 10px 10px 0", background: "var(--panel-2)", padding: "9px 11px" }}>
            <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
              <span style={{ fontSize: 12.5, fontWeight: 700, color: "var(--text)" }}>{i + 1}. {p.title}</span>
              <AnchorChips anchors={p.anchors} />
            </div>
            {p.intent && <div style={{ fontSize: 11, color: "var(--text-2)", marginTop: 2 }}>{p.intent}</div>}
            <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 6 }}>
              {(p.steps ?? []).map((s, j) => {
                const io: string[] = [];
                if (s.reads?.length) io.push(t("factory.blueprintPanel.io.read", { items: s.reads.join(", ") }));
                if (s.writes?.length) io.push(t("factory.blueprintPanel.io.write", { items: s.writes.join(", ") }));
                if (s.emits?.length) io.push(t("factory.blueprintPanel.io.emit", { items: s.emits.join(", ") }));
                return (
                  <div key={j} style={{ display: "flex", flexDirection: "column", gap: 1 }}>
                    <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap", fontSize: 11 }}>
                      <span style={{ color: "var(--green)" }}>▸</span>
                      {s.agent && <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-3)" }}>[{s.agent}]</span>}
                      <span style={{ color: "var(--text)" }}>{s.label}</span>
                      <AnchorChips anchors={s.anchors} />
                    </div>
                    {io.length > 0 && (
                      <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-3)", paddingLeft: 16 }}>{io.join("  ·  ")}</div>
                    )}
                  </div>
                );
              })}
            </div>
            {p.deliberation && (
              <div style={{ marginTop: 7, padding: "6px 9px", borderLeft: "2px solid var(--violet)", background: "var(--panel-3)", borderRadius: "0 6px 6px 0" }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: "var(--violet)", marginBottom: 2 }}>{t("factory.blueprintPanel.deliberation.label")} <HelpTip>{t("factory.blueprintPanel.deliberation.help")}</HelpTip></div>
                <div style={{ fontSize: 11, color: "var(--text-2)", whiteSpace: "pre-wrap", lineHeight: 1.5 }}>{p.deliberation}</div>
              </div>
            )}
          </div>
        ))}
      </div>

      {/* 未接地项（fail-closed 如实标注，非编造） */}
      {model.unresolved.length > 0 && (
        <div style={{ border: "1px solid var(--red)", borderRadius: 10, background: "var(--panel-2)", padding: "9px 11px" }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "var(--red)", marginBottom: 5 }}>{t("factory.blueprintPanel.unresolved.heading", { count: model.unresolved.length })}</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
            {model.unresolved.slice(0, 12).map((u, i) => (
              <div key={i} style={{ fontSize: 10.5, color: "var(--text-2)", fontFamily: "var(--mono)" }}>
                {u.scope} · {u.ref} — {u.reason}
              </div>
            ))}
            {model.unresolved.length > 12 && <div style={{ fontSize: 10.5, color: "var(--text-3)" }}>{t("factory.blueprintPanel.unresolved.more", { count: model.unresolved.length - 12 })}</div>}
          </div>
        </div>
      )}
    </div>
  );
}
