"use client";

/**
 * Events — live event stream + per-event detail with replay (P2-FE-11).
 *
 * Live data via canonical TanStack hooks:
 *   - useEvents({ limit: 200 }) — event stream + types
 *   - useDag() — agent triggers/emits for the emitters & listeners panel
 *
 * Layout matches v1_1 events.jsx:51-143:
 *   - Histogram strip (60 buckets, last bucket lime)
 *   - 260 / 1fr / 360 three-column body
 */

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  ActorTag,
  Badge,
  Button,
  Empty,
  Icon,
  ViewHeader,
  SearchInput,
  FilterChip,
  CodeBlock,
  Th,
  Td,
  eventTone,
} from "@/app/portal/components";
import { fmtAgo, fmtBytes, fmtTime } from "@/app/portal/lib/format";
import { useTenant } from "@/app/portal/lib/use-tenant";
import { useEvents, type EventRow } from "@/lib/hooks/useEvents";
import { useDag, type DagAgent } from "@/lib/hooks/useAgents";
import { PublishEventModal } from "@/app/portal/components/events/PublishEventModal";

/** Narrowed shape of an /v1/events row, normalized for the table + ticker. */
interface EventItem {
  id: string;
  name: string;
  color: string;
  category: string;
  at: number;
  source: string;
  sourceTitle: string;
  subject: string;
  payloadBytes: number | null;
}

function fromApiRow(r: EventRow): EventItem {
  return {
    id: r.id,
    name: r.name,
    color: r.color ?? "muted",
    category: r.category ?? "agent",
    at: r.receivedAt ? Date.parse(r.receivedAt) : Date.now(),
    source: r.sourceAgentName ?? "external",
    sourceTitle: r.sourceAgentTitle ?? r.sourceAgentName ?? "External",
    subject: r.subject ?? "",
    payloadBytes: r.payloadRef ? Number(r.payloadRef.length) : null,
  };
}

export default function EventsPage() {
  const eventsQuery = useEvents({ limit: 200 });
  const dagQuery = useDag();
  const apiEvents = eventsQuery.data ?? [];
  const agents = dagQuery.data?.agents ?? [];

  // Live stream of events from /v1/events.
  const stream = useMemo<EventItem[]>(
    () => apiEvents.map(fromApiRow),
    [apiEvents],
  );

  // Event type catalog — derived from the event names actually observed
  // plus any name an agent declares as emit/trigger via the DAG. This way
  // the type filter shows every name the tenant cares about, not just
  // those that have already fired.
  const eventTypes = useMemo(() => {
    const names = new Map<string, { name: string; color: string }>();
    for (const e of stream) {
      if (!names.has(e.name))
        names.set(e.name, { name: e.name, color: e.color });
    }
    for (const a of agents) {
      for (const n of [...a.triggers, ...a.emits]) {
        if (!names.has(n)) names.set(n, { name: n, color: "muted" });
      }
    }
    return Array.from(names.values()).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  }, [stream, agents]);

  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [catFilter, setCatFilter] = useState<string>("all");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    setSelectedId(new URLSearchParams(window.location.search).get("eventId"));
  }, []);

  // Live toggle proxy.
  const [liveStream] = useState(true);
  const [publishOpen, setPublishOpen] = useState(false);

  const filtered = useMemo(() => {
    return stream.filter((e) => {
      if (typeFilter !== "all" && e.name !== typeFilter) return false;
      if (catFilter !== "all" && e.category !== catFilter) return false;
      if (query) {
        const q = query.toLowerCase();
        if (
          !e.name.toLowerCase().includes(q) &&
          !e.id.toLowerCase().includes(q) &&
          !e.subject.toLowerCase().includes(q)
        )
          return false;
      }
      return true;
    });
  }, [stream, typeFilter, catFilter, query]);

  // Histogram of last 60 min by category.
  const hist = useMemo(() => {
    const now = Date.now();
    const buckets = new Array(60).fill(0);
    filtered.forEach((e) => {
      const idx = Math.floor((now - e.at) / 60_000);
      if (idx >= 0 && idx < 60) buckets[59 - idx]++;
    });
    return buckets;
  }, [filtered]);

  // "Now" indicator pulse — every 2.5s when liveStream is on.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!liveStream) return;
    const id = setInterval(() => setTick((t) => t + 1), 2500);
    return () => clearInterval(id);
  }, [liveStream]);

  const selected = selectedId
    ? stream.find((e) => e.id === selectedId)
    : filtered[0];

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <ViewHeader
        title="Events"
        subtitle={`${filtered.length} events · ${eventTypes.length} event types · ${
          liveStream ? "live tail" : "paused"
        }`}
        badge={
          liveStream ? (
            <Badge tone="signal">
              <span className="live-dot" style={{ width: 5, height: 5 }} /> LIVE
            </Badge>
          ) : null
        }
        action={
          <div style={{ display: "flex", gap: 6 }}>
            <Button icon="replay" small>
              Replay window
            </Button>
            <Button
              icon="run"
              tone="primary"
              small
              onClick={() => setPublishOpen(true)}
            >
              Publish event
            </Button>
          </div>
        }
      />
      {publishOpen && (
        <PublishEventModal onClose={() => setPublishOpen(false)} />
      )}

      {/* Histogram strip */}
      <div
        style={{
          padding: "12px 24px",
          borderBottom: "1px solid var(--border)",
          background: "var(--panel)",
        }}
      >
        <Histogram buckets={hist} />
      </div>

      <div
        style={{
          flex: 1,
          display: "grid",
          gridTemplateColumns: "260px 1fr 360px",
          minHeight: 0,
        }}
      >
        {/* Filters */}
        <aside
          style={{
            borderRight: "1px solid var(--border)",
            overflow: "auto",
            padding: "14px 16px",
          }}
        >
          <SearchInput
            value={query}
            onChange={setQuery}
            placeholder="event, subject, id…"
          />
          <FilterGroup
            title="Category"
            value={catFilter}
            onChange={setCatFilter}
            options={[
              { id: "all", label: "All" },
              { id: "agent", label: "Agent" },
              { id: "human", label: "Human" },
              { id: "data", label: "Data" },
              { id: "external", label: "External" },
              { id: "alert", label: "Alert" },
              { id: "system", label: "System" },
            ]}
          />
          <div style={{ marginTop: 18 }}>
            <div
              style={{
                fontSize: 10.5,
                fontFamily: "var(--mono)",
                textTransform: "uppercase",
                color: "var(--text-3)",
                letterSpacing: "0.08em",
                marginBottom: 8,
              }}
            >
              Event type
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              <EventTypeRow
                active={typeFilter === "all"}
                onClick={() => setTypeFilter("all")}
                name="All event types"
                count={stream.length}
              />
              {eventTypes.map((et) => {
                const count = stream.filter((s) => s.name === et.name).length;
                return (
                  <EventTypeRow
                    key={et.name}
                    active={typeFilter === et.name}
                    onClick={() => setTypeFilter(et.name)}
                    name={et.name}
                    color={et.color}
                    count={count}
                  />
                );
              })}
            </div>
          </div>
        </aside>

        {/* Event list */}
        <div
          style={{
            overflow: "auto",
            borderRight: "1px solid var(--border)",
          }}
        >
          <div
            style={{
              position: "sticky",
              top: 0,
              background: "var(--bg)",
              borderBottom: "1px solid var(--border)",
              zIndex: "var(--z-base)" as unknown as number,
              padding: "8px 16px",
              display: "flex",
              alignItems: "center",
              gap: 10,
            }}
          >
            <span
              style={{
                fontSize: 11,
                fontFamily: "var(--mono)",
                color: "var(--text-3)",
              }}
            >
              SHOWING
            </span>
            <span
              className="mono"
              style={{ fontSize: 12, color: "var(--text)" }}
            >
              {filtered.length}
            </span>
            {typeFilter !== "all" && (
              <Badge tone="muted">
                {typeFilter}{" "}
                <span
                  onClick={() => setTypeFilter("all")}
                  style={{ cursor: "pointer", marginLeft: 4 }}
                >
                  ×
                </span>
              </Badge>
            )}
          </div>
          {eventsQuery.isError ? (
            <Empty
              title="Failed to load events"
              hint={eventsQuery.error?.message ?? "api unreachable on :3501"}
            />
          ) : eventsQuery.isLoading && stream.length === 0 ? (
            <Empty title="Loading events…" hint="" />
          ) : filtered.length === 0 ? (
            <Empty
              title={stream.length === 0 ? "No events yet" : "No events"}
              hint={
                stream.length === 0
                  ? "Events appear here as agents fire them."
                  : "Try a broader filter"
              }
            />
          ) : (
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                fontSize: 12,
              }}
            >
              <thead>
                <tr>
                  <Th>Time</Th>
                  <Th>Event</Th>
                  <Th>Source</Th>
                  <Th>Subject</Th>
                  <Th>Size</Th>
                </tr>
              </thead>
              <tbody>
                {filtered.slice(0, 80).map((e) => (
                  <tr
                    key={e.id}
                    onClick={() => setSelectedId(e.id)}
                    style={{
                      cursor: "pointer",
                      background:
                        selected?.id === e.id
                          ? "var(--panel-2)"
                          : "transparent",
                      borderLeft:
                        selected?.id === e.id
                          ? "2px solid var(--signal)"
                          : "2px solid transparent",
                      borderBottom: "1px solid var(--border)",
                    }}
                  >
                    <Td>
                      <span
                        className="mono"
                        style={{
                          color: "var(--text-3)",
                          fontSize: 10.5,
                        }}
                      >
                        {fmtTime(e.at)}
                      </span>
                    </Td>
                    <Td>
                      <Badge tone={eventTone(e.color)}>{e.name}</Badge>
                    </Td>
                    <Td>
                      <span style={{ fontSize: 11.5, color: "var(--text-2)" }}>
                        {e.sourceTitle}
                      </span>
                    </Td>
                    <Td>
                      <span
                        className="mono"
                        style={{ fontSize: 11, color: "var(--text-2)" }}
                      >
                        {e.subject}
                      </span>
                    </Td>
                    <Td>
                      <span
                        className="mono"
                        style={{
                          fontSize: 10.5,
                          color: "var(--text-3)",
                        }}
                      >
                        {e.payloadBytes != null
                          ? fmtBytes(e.payloadBytes)
                          : "—"}
                      </span>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Detail */}
        <aside
          style={{
            overflow: "auto",
            background: "var(--panel)",
          }}
        >
          {selected ? (
            <EventDetail event={selected} agents={agents} />
          ) : (
            <Empty title="Select an event" />
          )}
        </aside>
      </div>
    </div>
  );
}

function FilterGroup({
  title,
  value,
  onChange,
  options,
}: {
  title: string;
  value: string;
  onChange: (v: string) => void;
  options: { id: string; label: string }[];
}) {
  return (
    <div style={{ marginTop: 14 }}>
      <div
        style={{
          fontSize: 10.5,
          fontFamily: "var(--mono)",
          textTransform: "uppercase",
          color: "var(--text-3)",
          letterSpacing: "0.08em",
          marginBottom: 6,
        }}
      >
        {title}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
        {options.map((o) => (
          <FilterChip
            key={o.id}
            active={value === o.id}
            onClick={() => onChange(o.id)}
          >
            {o.label}
          </FilterChip>
        ))}
      </div>
    </div>
  );
}

const COLOR_MAP: Record<string, string> = {
  green: "var(--green)",
  blue: "var(--blue)",
  amber: "var(--amber)",
  red: "var(--red)",
  muted: "var(--text-3)",
};

function EventTypeRow({
  active,
  onClick,
  name,
  color,
  count,
}: {
  active: boolean;
  onClick: () => void;
  name: string;
  color?: string;
  count: number;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        width: "100%",
        padding: "4px 6px",
        fontSize: 11,
        fontFamily: "var(--mono)",
        color: active ? "var(--text)" : "var(--text-2)",
        background: active ? "var(--panel-2)" : "transparent",
        border: "1px solid " + (active ? "var(--border-2)" : "transparent"),
        borderRadius: 3,
        textAlign: "left",
      }}
    >
      {color && (
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: "50%",
            background: COLOR_MAP[color] ?? "var(--text-3)",
          }}
        />
      )}
      <span
        style={{
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          flex: 1,
        }}
      >
        {name}
      </span>
      <span style={{ color: "var(--text-3)" }}>{count}</span>
    </button>
  );
}

function Histogram({ buckets }: { buckets: number[] }) {
  const max = Math.max(1, ...buckets);
  return (
    <div>
      <div
        style={{
          display: "flex",
          alignItems: "flex-end",
          gap: 1,
          height: 38,
        }}
      >
        {buckets.map((v, i) => (
          <div
            key={i}
            style={{
              flex: 1,
              height: `${Math.max(2, (v / max) * 100)}%`,
              background:
                i === buckets.length - 1
                  ? "var(--signal)"
                  : v > 0
                    ? `rgba(208,255,0,${0.25 + (v / max) * 0.55})`
                    : "var(--border)",
            }}
          />
        ))}
      </div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          marginTop: 4,
          fontSize: 10,
          fontFamily: "var(--mono)",
          color: "var(--text-3)",
        }}
      >
        <span>60m ago</span>
        <span>events / minute · peak {max}</span>
        <span>now</span>
      </div>
    </div>
  );
}

function EventDetail({
  event,
  agents,
}: {
  event: EventItem;
  agents: DagAgent[];
}) {
  const tenant = useTenant();
  const emitters = useMemo(
    () => agents.filter((a) => a.emits.includes(event.name)),
    [agents, event.name],
  );
  const listeners = useMemo(
    () => agents.filter((a) => a.triggers.includes(event.name)),
    [agents, event.name],
  );
  const source = useMemo(
    () =>
      agents.find((a) => a.kebabId === event.source) ??
      agents.find((a) => a.name === event.source) ??
      null,
    [agents, event.source],
  );

  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      <header
        style={{
          padding: "14px 18px",
          borderBottom: "1px solid var(--border)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginBottom: 8,
          }}
        >
          <Badge tone={eventTone(event.color)}>{event.name}</Badge>
          <span
            style={{
              fontSize: 11,
              color: "var(--text-3)",
              fontFamily: "var(--mono)",
            }}
          >
            {event.category}
          </span>
        </div>
        <div className="mono" style={{ fontSize: 13, color: "var(--text)" }}>
          {event.id}
        </div>
        <div
          style={{
            marginTop: 4,
            fontSize: 11,
            color: "var(--text-3)",
          }}
        >
          {new Date(event.at).toLocaleString()} · {fmtAgo(event.at)}
        </div>
      </header>

      <Section title="Source">
        {source ? (
          <Link
            href={`/portal/${tenant}/agents/${source.kebabId}` as never}
            style={{ textDecoration: "none" }}
          >
            <button
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "8px 10px",
                width: "100%",
                background: "var(--panel-2)",
                border: "1px solid var(--border)",
                borderRadius: 4,
                textAlign: "left",
              }}
            >
              <ActorTag actor={source.actor} />
              <span style={{ fontSize: 12.5, color: "var(--text)" }}>
                {source.title}
              </span>
              <Icon
                name="external"
                size={12}
                style={{ marginLeft: "auto", color: "var(--text-3)" }}
              />
            </button>
          </Link>
        ) : (
          <span style={{ fontSize: 12, color: "var(--text-3)" }}>
            External / system
          </span>
        )}
      </Section>

      <Section title={`Emitters · ${emitters.length}`}>
        {emitters.length === 0 ? (
          <span style={{ fontSize: 11.5, color: "var(--text-3)" }}>
            No agent declared as emitter.
          </span>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {emitters.map((a) => (
              <AgentLinkRow key={a.id} agent={a} tenant={tenant} />
            ))}
          </div>
        )}
      </Section>

      <Section title={`Downstream listeners · ${listeners.length}`}>
        {listeners.length === 0 ? (
          <span style={{ fontSize: 11.5, color: "var(--text-3)" }}>
            Terminal event — no agents listen.
          </span>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {listeners.map((a) => (
              <AgentLinkRow key={a.id} agent={a} tenant={tenant} />
            ))}
          </div>
        )}
      </Section>

      <Section title="Payload">
        <CodeBlock>
          {JSON.stringify(
            {
              event_id: event.id,
              name: event.name,
              ts: new Date(event.at).toISOString(),
              tenant,
              source: source
                ? { agent_id: source.kebabId, agent: source.name }
                : "external",
              subject: event.subject,
            },
            null,
            2,
          )}
        </CodeBlock>
      </Section>

      <div
        style={{
          padding: 14,
          display: "flex",
          gap: 8,
          borderTop: "1px solid var(--border)",
        }}
      >
        <Button icon="replay" tone="primary" style={{ flex: 1 }}>
          Replay event
        </Button>
        <Button icon="external">Inngest console</Button>
      </div>
    </div>
  );
}

function AgentLinkRow({ agent, tenant }: { agent: DagAgent; tenant: string }) {
  return (
    <Link
      href={`/portal/${tenant}/agents/${agent.kebabId}` as never}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "6px 8px",
        background: "var(--panel-2)",
        border: "1px solid var(--border)",
        borderRadius: 4,
        textAlign: "left",
        textDecoration: "none",
      }}
    >
      <ActorTag actor={agent.actor} />
      <span
        style={{
          fontSize: 12,
          color: "var(--text)",
          flex: 1,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {agent.title}
      </span>
      <Icon name="chevron-right" size={11} style={{ color: "var(--text-3)" }} />
    </Link>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        padding: "12px 18px",
        borderBottom: "1px solid var(--border)",
      }}
    >
      <div
        style={{
          fontSize: 10.5,
          fontFamily: "var(--mono)",
          textTransform: "uppercase",
          color: "var(--text-3)",
          letterSpacing: "0.08em",
          marginBottom: 8,
        }}
      >
        {title}
      </div>
      {children}
    </div>
  );
}
