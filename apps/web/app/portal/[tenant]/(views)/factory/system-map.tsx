"use client";

/**
 * Agent 工厂 — 系统全景（大脑 tab 第三视图，两套系统总纲 §1.5 的实时投影）。
 *
 * 上：系统 A · 生成系统——协调者行（🎯 意图 / 📖 理解 / 🧭 能力解析 / 当前阶段）+
 *     七个内部角色卡（状态灯 + ⚙🧩🔧🛠 四枚能力徽章 + View transcript），
 *     一眼看清「生成 functions 时的多 agents」谁在干活、谁启用了 CodeAct、
 *     谁派生了 sub-agents、谁造了工具/技能。
 * 下：系统 B · 交付 functions——父 function 分组其 -sub- 交付域子函数，
 *     ⚙CodeAct/📄声明式徽章沿用既有语义；点击跳右栏智能体检查器。
 * 中：两座桥（晋升 / 固化）常驻提示。
 */

import { useMemo, useState } from "react";
import type { BrainEvent } from "@/lib/hooks/useBrainStream";
import { FullModal } from "./atoms";
import type { AgentCardData } from "./model";
import { deriveSystemA, groupFunctions, ROLE_META, type RoleCard, type SysBrainEvent } from "./system-view";

const DOT: Record<RoleCard["status"], string> = { running: "var(--signal)", ok: "var(--green)", error: "var(--red)", idle: "var(--text-3)" };

function Badge({ icon, n, title }: { icon: string; n: number; title: string }) {
  if (!n) return null;
  return (
    <span title={title} style={{ fontSize: 10, fontFamily: "var(--mono)", border: "1px solid var(--border)", borderRadius: 5, padding: "0 5px", color: "var(--text-2)" }}>
      {icon}×{n}
    </span>
  );
}

function RoleTranscript({ role }: { role: RoleCard }) {
  const icon: Record<string, string> = { tool: "🔧", spawn: "🧩", make: "✨", code: "⚙" };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      {role.transcript.length === 0 && <div style={{ padding: 12, fontSize: 12, color: "var(--text-4)" }}>该角色本次还没干活</div>}
      {role.transcript.map((it) => (
        <div key={it.id} style={{ display: "flex", gap: 8, padding: "6px 4px", borderBottom: "1px solid var(--border)", fontSize: 12, lineHeight: 1.55 }}>
          <span style={{ width: 18, textAlign: "center", color: it.ok === false ? "var(--red)" : "var(--text-3)" }}>{icon[it.kind] ?? "•"}</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <span style={{ color: "var(--text)" }}>{it.label}</span>
            {it.ok !== undefined && <span style={{ marginLeft: 6, fontSize: 10.5, color: it.ok ? "var(--green)" : "var(--red)" }}>{it.ok ? "✓" : "✗"}</span>}
            {it.detail && <div style={{ color: "var(--text-3)", fontSize: 11.5 }}>{it.detail}</div>}
          </div>
        </div>
      ))}
    </div>
  );
}

const sectionTitle: React.CSSProperties = { fontSize: 10.5, fontFamily: "var(--mono)", color: "var(--text-3)", margin: "2px 0 6px" };

export function SystemMap({ events, agents, running, onSelectAgent }: { events: BrainEvent[]; agents: AgentCardData[]; running: boolean; onSelectAgent: (slug: string) => void }) {
  const view = useMemo(() => deriveSystemA(events as SysBrainEvent[], running), [events, running]);
  const groups = useMemo(() => groupFunctions(agents), [agents]);
  const [openRoleId, setOpenRoleId] = useState<string | null>(null);
  const openRole = view.roles.find((r) => r.id === openRoleId) ?? null;
  const activeRoles = view.roles.filter((r) => r.status !== "idle");

  const totallyIdle = activeRoles.length === 0 && !view.intent && !view.understanding && !view.capability && groups.length === 0;
  if (totallyIdle) return <div style={{ fontSize: 11.5, color: "var(--text-4)", padding: 8 }}>运行后在此展示两套系统的实时活动。</div>;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {openRole && (
        <FullModal title={`${openRole.name} · 过程`} onClose={() => setOpenRoleId(null)}>
          <RoleTranscript role={openRole} />
        </FullModal>
      )}

      {/* ── 系统 A（有活动才渲染）── */}
      {(activeRoles.length > 0 || view.intent || view.understanding || view.capability) && (
      <div style={{ border: "1px solid var(--border)", borderRadius: 10, padding: "10px 12px", background: "var(--panel-2)" }}>
        <div style={sectionTitle}>系统 A · 生成</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11.5, lineHeight: 1.55, marginBottom: 8 }}>
          {view.intent && (
            <div style={{ display: "flex", gap: 6 }}>
              <span style={{ flexShrink: 0 }}>🎯</span>
              <span style={{ color: "var(--text-2)" }}>{view.intent}</span>
            </div>
          )}
          {view.capability && (
            <div style={{ display: "flex", gap: 6 }}>
              <span style={{ flexShrink: 0 }}>🧭</span>
              <span style={{ color: "var(--text-2)" }}>{view.capability}</span>
            </div>
          )}
          {view.understanding && (
            <div style={{ display: "flex", gap: 6 }}>
              <span style={{ flexShrink: 0 }}>📖</span>
              <span style={{ color: "var(--text-3)" }}>{view.understanding}</span>
            </div>
          )}
          {(view.specialists > 0 || view.subbrains > 0) && (
            <div style={{ fontSize: 10.5, color: "var(--text-3)", fontFamily: "var(--mono)" }}>
              生成域 sub-agents：认知专家 ×{view.specialists} · 子大脑 ×{view.subbrains}（永不进交付物）
            </div>
          )}
        </div>
        {activeRoles.length === 0 ? null : (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
            {activeRoles.map((r) => (
              <button
                key={r.id}
                onClick={() => setOpenRoleId(r.id)}
                title={`${ROLE_META[r.id].hint} · 点击看过程`}
                style={{ textAlign: "left", border: "1px solid var(--border)", borderRadius: 8, padding: "7px 9px", background: "var(--panel)", cursor: "pointer" }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span className={r.status === "running" ? "health-pulse" : undefined} style={{ width: 7, height: 7, borderRadius: "50%", background: DOT[r.status], display: "inline-block", flexShrink: 0 }} />
                  <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text)" }}>{r.name}</span>
                  <span style={{ marginLeft: "auto", fontSize: 10, color: "var(--text-3)", fontFamily: "var(--mono)" }}>{r.toolCalls} 次</span>
                </div>
                <div style={{ display: "flex", gap: 4, marginTop: 4, flexWrap: "wrap" }}>
                  <Badge icon="⚙" n={r.badges.codeact} title="CodeAct：写码/驱动执行" />
                  <Badge icon="🧩" n={r.badges.spawns} title="派生 sub-agents（认知专家/子大脑）" />
                  <Badge icon="🔧" n={r.badges.tools} title="造工具" />
                  <Badge icon="🛠" n={r.badges.skills} title="造技能" />
                  {!r.badges.codeact && !r.badges.spawns && !r.badges.tools && !r.badges.skills && <span style={{ fontSize: 10, color: "var(--text-4)" }}>—</span>}
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
      )}

      {/* ── 交付出口：System B 详情在「智能体」tab，这里只留一行链接，避免与之重复 ── */}
      {groups.length > 0 && (
        <button
          onClick={() => onSelectAgent("")}
          style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", textAlign: "left", padding: "8px 11px", border: "1px dashed var(--border)", borderRadius: 10, background: "none", color: "var(--text-2)", cursor: "pointer", fontSize: 11.5 }}
        >
          <span style={{ color: "var(--text-3)" }}>↓ 晋升 · 交付</span>
          <span style={{ flex: 1 }}>系统 B · {groups.length} 个 functions（{groups.reduce((n, g) => n + g.children.length, 0)} 个交付域 sub-agents）</span>
          <span style={{ color: "var(--signal)", whiteSpace: "nowrap" }}>去「智能体」→</span>
        </button>
      )}
    </div>
  );
}
