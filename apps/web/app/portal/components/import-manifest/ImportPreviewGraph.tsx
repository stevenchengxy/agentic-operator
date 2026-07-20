"use client";

/**
 * ImportPreviewGraph — read-only DAG of a migrated workflow manifest.
 *
 * Used by the Import Manifest wizard (Preview step). Renders agents as
 * rectangles laid out in stage columns; edges are cubic Bezier curves.
 * Nodes are colored by their diff classification (added/modified/unchanged);
 * a hover highlight dims everything else.
 *
 * Ported from `apps/web/public/portal/components/import-preview-graph.jsx`.
 */

import { useMemo, useState } from "react";
import type { ManifestDiff } from "@agentic/contracts";
import { useI18n } from "@/app/portal/lib/preferences-context";

const PAD_X = 24;
const PAD_Y = 28;
const COL_W = 188;
const ROW_H = 76;
const NODE_W = 156;
const NODE_H = 56;

interface RawAgent {
  id?: string;
  kebabId?: string;
  kebab_id?: string;
  name?: string;
  title?: string;
  actor?: string | string[];
  trigger?: string[];
  triggers?: string[];
  triggered_event?: string[];
  emits?: string[];
  emitted_events?: string[];
}

interface NormalizedAgent {
  id: string;
  name: string;
  kebabId: string;
  actor: "Agent" | "Human";
  triggers: string[];
  emits: string[];
}

interface Edge {
  src: string;
  dst: string;
  event: string;
}

export interface ImportPreviewGraphProps {
  /**
   * Raw manifest input — either a bare AgentSpec[] (v1) or
   * `{ $schemaVersion: 2, agents: [...] }` (v2). Accepts `unknown` because
   * the wizard hands through what the operator pasted/uploaded; we
   * normalize defensively.
   */
  manifest: unknown;
  diff?: ManifestDiff | null;
}

export function ImportPreviewGraph({ manifest, diff }: ImportPreviewGraphProps) {
  const { t } = useI18n();
  const agents = useMemo(() => normalizeManifest(manifest), [manifest]);
  const stages = useMemo(() => computeStages(agents), [agents]);

  // Group by stage.
  const byStage = useMemo(() => {
    const m = new Map<number, NormalizedAgent[]>();
    agents.forEach((a) => {
      const s = stages.get(a.id) ?? 0;
      const arr = m.get(s) ?? [];
      arr.push(a);
      m.set(s, arr);
    });
    for (const v of m.values()) {
      v.sort((x, y) => String(x.name).localeCompare(String(y.name)));
    }
    return m;
  }, [agents, stages]);

  // Compute node positions.
  const positions = useMemo(() => {
    const pos = new Map<string, { x: number; y: number }>();
    const stageKeys = Array.from(byStage.keys()).sort((a, b) => a - b);
    stageKeys.forEach((s, colIdx) => {
      const lane = byStage.get(s) ?? [];
      lane.forEach((a, laneIdx) => {
        pos.set(a.id, {
          x: PAD_X + colIdx * COL_W,
          y: PAD_Y + laneIdx * ROW_H,
        });
      });
    });
    return { pos, stageKeys };
  }, [byStage]);

  // Edges: emit → trigger.
  const edges = useMemo<Edge[]>(() => {
    const out: Edge[] = [];
    const listeners = new Map<string, string[]>();
    agents.forEach((a) => {
      a.triggers.forEach((ev) => {
        const arr = listeners.get(ev) ?? [];
        arr.push(a.id);
        listeners.set(ev, arr);
      });
    });
    agents.forEach((src) => {
      src.emits.forEach((ev) => {
        const dsts = listeners.get(ev) ?? [];
        dsts.forEach((dstId) => {
          if (dstId !== src.id) out.push({ src: src.id, dst: dstId, event: ev });
        });
      });
    });
    return out;
  }, [agents]);

  // Diff classification map keyed by id and kebabId.
  const tag = useMemo(() => {
    const map = new Map<string, "added" | "modified">();
    if (diff) {
      (diff.added ?? []).forEach((id) => map.set(id, "added"));
      (diff.modified ?? []).forEach((id) => map.set(id, "modified"));
      // Note: removed agents are not in `agents` (they're in the live workflow only).
    }
    return map;
  }, [diff]);

  // Canvas dimensions.
  const maxLane = useMemo(() => {
    let m = 0;
    for (const v of byStage.values()) m = Math.max(m, v.length);
    return m;
  }, [byStage]);

  const W = PAD_X * 2 + Math.max(1, positions.stageKeys.length) * COL_W;
  const H = PAD_Y * 2 + Math.max(1, maxLane) * ROW_H;

  const [hovered, setHovered] = useState<string | null>(null);

  // Hover highlight set.
  const highlighted = useMemo(() => {
    if (!hovered) return { nodes: new Set<string>(), edges: new Set<number>() };
    const nodes = new Set<string>([hovered]);
    const edgeSet = new Set<number>();
    edges.forEach((e, i) => {
      if (e.src === hovered || e.dst === hovered) {
        edgeSet.add(i);
        nodes.add(e.src);
        nodes.add(e.dst);
      }
    });
    return { nodes, edges: edgeSet };
  }, [hovered, edges]);

  if (agents.length === 0) {
    return (
      <div
        style={{
          padding: "32px 12px",
          textAlign: "center",
          color: "var(--text-3)",
          fontSize: 12,
        }}
      >
        {t("importPreviewGraph.emptyState")}
      </div>
    );
  }

  return (
    <div
      style={{
        width: "100%",
        overflow: "auto",
        background: "var(--bg-2)",
        border: "1px solid var(--border)",
        borderRadius: 6,
      }}
    >
      <svg
        width={W}
        height={H + 24}
        role="img"
        aria-label={t("importPreviewGraph.title")}
        style={{ display: "block", minWidth: "100%" }}
        viewBox={`0 0 ${W} ${H + 24}`}
      >
        <title>{t("importPreviewGraph.title")}</title>
        {/* Stage column headers + dividers */}
        {positions.stageKeys.map((s, i) => (
          <g key={`stage-${s}`}>
            <line
              x1={PAD_X + i * COL_W - 6}
              x2={PAD_X + i * COL_W - 6}
              y1={4}
              y2={H + 16}
              stroke="var(--border)"
              opacity="0.5"
            />
            <text
              x={PAD_X + i * COL_W}
              y={16}
              fill="var(--text-3)"
              fontSize="9"
              fontFamily="var(--mono)"
              letterSpacing="0.08em"
            >
              {String(s).padStart(2, "0")} · {t("importPreviewGraph.stage")}
            </text>
          </g>
        ))}

        {/* Arrow markers */}
        <defs>
          <marker
            id="ipg-arrow"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto"
          >
            <path d="M0,0 L10,5 L0,10 z" fill="var(--text-3)" />
          </marker>
          <marker
            id="ipg-arrow-hi"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto"
          >
            <path d="M0,0 L10,5 L0,10 z" fill="var(--signal)" />
          </marker>
        </defs>

        {/* Edges (drawn before nodes) */}
        {edges.map((e, i) => {
          const sPos = positions.pos.get(e.src);
          const dPos = positions.pos.get(e.dst);
          if (!sPos || !dPos) return null;
          const sx = sPos.x + NODE_W;
          const sy = sPos.y + NODE_H / 2;
          const dx = dPos.x;
          const dy = dPos.y + NODE_H / 2;
          const midX = (sx + dx) / 2;
          const d = `M ${sx} ${sy} C ${midX} ${sy}, ${midX} ${dy}, ${dx} ${dy}`;
          const isHi = highlighted.edges.has(i);
          const dim = hovered != null && !isHi;
          return (
            <path
              key={i}
              d={d}
              stroke={isHi ? "var(--signal)" : "var(--text-3)"}
              strokeWidth={isHi ? 1.6 : 1}
              fill="none"
              opacity={dim ? 0.18 : isHi ? 1 : 0.5}
              markerEnd={isHi ? "url(#ipg-arrow-hi)" : "url(#ipg-arrow)"}
              style={{ transition: "opacity 0.12s, stroke 0.12s" }}
            >
              <title>{e.event}</title>
            </path>
          );
        })}

        {/* Nodes */}
        {agents.map((a) => {
          const p = positions.pos.get(a.id);
          if (!p) return null;
          const klass = tag.get(a.id) ?? tag.get(a.kebabId);
          const isHi = !hovered || highlighted.nodes.has(a.id);
          const stroke =
            klass === "added"
              ? "var(--green)"
              : klass === "modified"
                ? "var(--amber)"
                : a.actor === "Human"
                  ? "var(--violet)"
                  : "var(--signal)";
          const fill =
            klass === "added"
              ? "color-mix(in srgb, var(--green) 8%, transparent)"
              : klass === "modified"
                ? "color-mix(in srgb, var(--amber) 6%, transparent)"
                : "var(--panel)";
          return (
            <g
              key={a.id}
              onMouseEnter={() => setHovered(a.id)}
              onMouseLeave={() =>
                setHovered((h) => (h === a.id ? null : h))
              }
              style={{
                cursor: "default",
                opacity: isHi ? 1 : 0.3,
                transition: "opacity 0.12s",
              }}
            >
              <title>{`${a.name} · ${a.id}`}</title>
              <rect
                x={p.x}
                y={p.y}
                width={NODE_W}
                height={NODE_H}
                rx={5}
                fill={fill}
                stroke={stroke}
                strokeWidth={klass ? 1.5 : 1}
                strokeDasharray={klass === "modified" ? "3 2" : "0"}
              />
              <text
                x={p.x + 10}
                y={p.y + 16}
                fill="var(--text-3)"
                fontSize="9.5"
                fontFamily="var(--mono)"
                letterSpacing="0.04em"
              >
                {String(a.id).slice(0, 24)}
              </text>
              <text
                x={p.x + 10}
                y={p.y + 32}
                fill="var(--text)"
                fontSize="11.5"
                fontFamily="var(--sans)"
                fontWeight="500"
              >
                {trim(a.name, 22)}
              </text>
              <text
                x={p.x + 10}
                y={p.y + 46}
                fill="var(--text-3)"
                fontSize="9.5"
                fontFamily="var(--mono)"
              >
                {a.actor === "Human" ? "HUMAN" : "AGENT"}
                {klass ? ` · ${klass.toUpperCase()}` : ""}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

// ── Manifest helpers ─────────────────────────────────────────────────────

function normalizeManifest(raw: unknown): NormalizedAgent[] {
  if (!raw) return [];
  const list: RawAgent[] = Array.isArray(raw)
    ? (raw as RawAgent[])
    : Array.isArray((raw as { agents?: RawAgent[] }).agents)
      ? ((raw as { agents: RawAgent[] }).agents)
      : [];
  return list.map((a, idx) => {
    const id = String(a.id ?? a.kebab_id ?? a.kebabId ?? idx);
    const name = String(a.name ?? a.title ?? id);
    const kebabId = String(a.kebabId ?? a.kebab_id ?? toKebab(name) ?? id);
    const actorList = Array.isArray(a.actor)
      ? a.actor
      : a.actor
        ? [a.actor]
        : [];
    const actor: "Agent" | "Human" = actorList.includes("Human")
      ? "Human"
      : "Agent";
    const triggers = Array.isArray(a.trigger)
      ? a.trigger
      : Array.isArray(a.triggers)
        ? a.triggers
        : [];
    const emits = Array.isArray(a.triggered_event)
      ? a.triggered_event
      : Array.isArray(a.emits)
        ? a.emits
        : Array.isArray(a.emitted_events)
          ? a.emitted_events
          : [];
    return { id, name, kebabId, actor, triggers, emits };
  });
}

function toKebab(s: string): string {
  return String(s ?? "")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[_\s]+/g, "-")
    .toLowerCase();
}

/** Longest-path stages for the acyclic portion; cycle-bound nodes stay at 0. */
function computeStages(agents: NormalizedAgent[]): Map<string, number> {
  const listeners = new Map<string, string[]>();
  agents.forEach((a) => {
    a.triggers.forEach((ev) => {
      const arr = listeners.get(ev) ?? [];
      arr.push(a.id);
      listeners.set(ev, arr);
    });
  });

  const stage = new Map<string, number>();
  const outgoing = new Map<string, Set<string>>();
  const indegree = new Map<string, number>();
  agents.forEach((a) => {
    stage.set(a.id, 0);
    outgoing.set(a.id, new Set());
    indegree.set(a.id, 0);
  });

  agents.forEach((source) => {
    source.emits.forEach((event) => {
      (listeners.get(event) ?? []).forEach((destinationId) => {
        if (destinationId === source.id || !indegree.has(destinationId)) return;
        const targets = outgoing.get(source.id);
        if (!targets || targets.has(destinationId)) return;
        targets.add(destinationId);
        indegree.set(destinationId, (indegree.get(destinationId) ?? 0) + 1);
      });
    });
  });

  const queue = agents
    .map((a) => a.id)
    .filter((id) => (indegree.get(id) ?? 0) === 0)
    .sort();
  for (let index = 0; index < queue.length; index += 1) {
    const sourceId = queue[index]!;
    for (const destinationId of outgoing.get(sourceId) ?? []) {
      stage.set(
        destinationId,
        Math.max(stage.get(destinationId) ?? 0, (stage.get(sourceId) ?? 0) + 1),
      );
      const nextDegree = (indegree.get(destinationId) ?? 0) - 1;
      indegree.set(destinationId, nextDegree);
      if (nextDegree === 0) queue.push(destinationId);
    }
  }
  return stage;
}

function trim(s: string, n: number): string {
  const str = String(s ?? "");
  return str.length > n ? str.slice(0, n - 1) + "…" : str;
}
