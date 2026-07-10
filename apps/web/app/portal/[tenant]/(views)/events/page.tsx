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
  StatusDot,
  ViewHeader,
  SearchInput,
  FilterChip,
  CodeBlock,
  Th,
  Td,
  eventTone,
  useToast,
} from "@/app/portal/components";
import { fmtAgo, fmtBytes, fmtTime } from "@/app/portal/lib/format";
import { useTenant } from "@/app/portal/lib/use-tenant";
import { useI18n } from "@/app/portal/lib/preferences-context";
import {
  useEvent,
  useEvents,
  useReplayEvent,
  type EventRow,
} from "@/lib/hooks/useEvents";
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
  const { t } = useI18n();
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
      if (!names.has(e.name)) names.set(e.name, { name: e.name, color: e.color });
    }
    for (const a of agents) {
      for (const n of [...a.triggers, ...a.emits]) {
        if (!names.has(n)) names.set(n, { name: n, color: "muted" });
      }
    }
    return Array.from(names.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [stream, agents]);

  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [catFilter, setCatFilter] = useState<string>("all");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);

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

  // `selected` is what the LIST highlights (explicit click, else the first
  // filtered row). `explicitSel` is ONLY a real click — used by the detail
  // panel so that selecting an event TYPE (no instance) can show the
  // type-level producer→consumer summary instead of falling back to row[0].
  const explicitSel = selectedId
    ? stream.find((e) => e.id === selectedId)
    : null;
  const selected = explicitSel ?? filtered[0];

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <ViewHeader
        title={t("nav.events")}
        subtitle={t("events.subtitle", {
          count: filtered.length,
          types: eventTypes.length,
          state: liveStream ? t("events.liveTail") : t("events.paused"),
        })}
        badge={
          liveStream ? (
            <Badge tone="signal">
              <span className="live-dot" style={{ width: 5, height: 5 }} />{" "}
              {t("events.live")}
            </Badge>
          ) : null
        }
        action={
          <div style={{ display: "flex", gap: 6 }}>
            <Button icon="replay" small>
              {t("events.replayWindow")}
            </Button>
            <Button
              icon="run"
              tone="primary"
              small
              onClick={() => setPublishOpen(true)}
            >
              {t("events.publishEvent")}
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
            placeholder={t("events.searchPlaceholder")}
          />
          <FilterGroup
            title={t("events.category")}
            value={catFilter}
            onChange={setCatFilter}
            options={[
              { id: "all", label: t("events.catAll") },
              { id: "agent", label: t("events.catAgent") },
              { id: "human", label: t("events.catHuman") },
              { id: "data", label: t("events.catData") },
              { id: "external", label: t("events.catExternal") },
              { id: "alert", label: t("events.catAlert") },
              { id: "system", label: t("events.catSystem") },
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
              {t("events.eventType")}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              <EventTypeRow
                active={typeFilter === "all"}
                onClick={() => {
                  setTypeFilter("all");
                  setSelectedId(null);
                }}
                name={t("events.allEventTypes")}
                count={stream.length}
              />
              {eventTypes.map((et) => {
                const count = stream.filter((s) => s.name === et.name).length;
                return (
                  <EventTypeRow
                    key={et.name}
                    active={typeFilter === et.name}
                    // Selecting a TYPE clears any instance selection so the
                    // right panel shows the type-level producer→consumer
                    // summary; click a firing in the list for its payload.
                    onClick={() => {
                      setTypeFilter(et.name);
                      setSelectedId(null);
                    }}
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
              {t("events.showing")}
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
              title={t("events.loadFailed")}
              hint={eventsQuery.error?.message ?? t("events.apiUnreachable")}
            />
          ) : eventsQuery.isLoading && stream.length === 0 ? (
            <Empty title={t("events.loading")} hint="" />
          ) : filtered.length === 0 ? (
            <Empty
              title={stream.length === 0 ? t("events.noneYet") : t("events.none")}
              hint={
                stream.length === 0
                  ? t("events.noneYetHint")
                  : t("events.broaderFilter")
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
                  <Th>{t("events.colTime")}</Th>
                  <Th>{t("events.colEvent")}</Th>
                  <Th>{t("events.colSource")}</Th>
                  <Th>{t("events.colSubject")}</Th>
                  <Th>{t("events.colSize")}</Th>
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
                      <span
                        style={{ fontSize: 11.5, color: "var(--text-2)" }}
                      >
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
          {explicitSel ? (
            <EventDetail event={explicitSel} agents={agents} />
          ) : typeFilter !== "all" ? (
            <EventTypeSummary
              eventName={typeFilter}
              agents={agents}
              stream={stream}
            />
          ) : selected ? (
            <EventDetail event={selected} agents={agents} />
          ) : (
            <Empty title={t("events.selectAnEvent")} />
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
  const { t } = useI18n();
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
                    ? `color-mix(in srgb, var(--signal) ${(0.25 + (v / max) * 0.55) * 100}%, transparent)`
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
        <span>{t("events.histStart")}</span>
        <span>{t("events.histAxis", { max })}</span>
        <span>{t("events.histNow")}</span>
      </div>
    </div>
  );
}

/**
 * Type-level producer→event→consumer summary. Shown when an event TYPE is
 * selected in the left rail but no specific instance — surfaces, at a glance,
 * who PRODUCES (emits) the event, who CONSUMES (triggers on) it, how many times
 * it has fired (in the loaded window), and the most recent firings. Producers /
 * consumers are derived from the live DAG (declared emits/triggers).
 */
function EventTypeSummary({
  eventName,
  agents,
  stream,
}: {
  eventName: string;
  agents: DagAgent[];
  stream: EventItem[];
}) {
  const { t } = useI18n();
  const tenant = useTenant();
  const emitters = useMemo(
    () => agents.filter((a) => a.emits.includes(eventName)),
    [agents, eventName],
  );
  const listeners = useMemo(
    () => agents.filter((a) => a.triggers.includes(eventName)),
    [agents, eventName],
  );
  const instances = useMemo(
    () => stream.filter((e) => e.name === eventName),
    [stream, eventName],
  );
  const recent = instances.slice(0, 6);
  const color = instances[0]?.color ?? "muted";
  const category = instances[0]?.category ?? "";

  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      <header style={{ padding: "14px 18px", borderBottom: "1px solid var(--border)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
          <Badge tone={eventTone(color)}>{eventName}</Badge>
          {category && (
            <span style={{ fontSize: 11, color: "var(--text-3)", fontFamily: "var(--mono)" }}>
              {category}
            </span>
          )}
        </div>
        <div style={{ fontSize: 11.5, color: "var(--text-3)", lineHeight: 1.5 }}>
          {t("events.typeSummaryHint")}
        </div>
        <div style={{ marginTop: 10, display: "flex", gap: 18 }}>
          <TypeStat label={t("events.statProducers")} value={emitters.length} />
          <TypeStat label={t("events.statConsumers")} value={listeners.length} />
          <TypeStat label={t("events.statFired")} value={instances.length} />
        </div>
      </header>

      <Section title={t("events.sectionEmitters", { count: emitters.length })}>
        {emitters.length === 0 ? (
          <span style={{ fontSize: 11.5, color: "var(--text-3)" }}>{t("events.noEmitter")}</span>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {emitters.map((a) => (
              <AgentLinkRow key={a.id} agent={a} tenant={tenant} />
            ))}
          </div>
        )}
      </Section>

      <Section title={t("events.sectionListeners", { count: listeners.length })}>
        {listeners.length === 0 ? (
          <span style={{ fontSize: 11.5, color: "var(--text-3)" }}>{t("events.noListeners")}</span>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {listeners.map((a) => (
              <AgentLinkRow key={a.id} agent={a} tenant={tenant} />
            ))}
          </div>
        )}
      </Section>

      <Section title={t("events.sectionRecentFirings", { count: instances.length })}>
        {recent.length === 0 ? (
          <span style={{ fontSize: 11.5, color: "var(--text-3)" }}>{t("events.noFirings")}</span>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            {recent.map((e) => (
              <div
                key={e.id}
                style={{
                  display: "flex",
                  gap: 10,
                  fontSize: 11,
                  fontFamily: "var(--mono)",
                  color: "var(--text-3)",
                  padding: "3px 0",
                }}
              >
                <span title={new Date(e.at).toLocaleString()}>{fmtAgo(e.at)}</span>
                <span style={{ color: "var(--text-2)" }}>{e.subject || "—"}</span>
              </div>
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}

function TypeStat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <div style={{ fontSize: 18, fontFamily: "var(--mono)", color: "var(--text)" }}>{value}</div>
      <div
        style={{
          fontSize: 9.5,
          fontFamily: "var(--mono)",
          textTransform: "uppercase",
          letterSpacing: "0.08em",
          color: "var(--text-3)",
        }}
      >
        {label}
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
  const { t } = useI18n();
  const tenant = useTenant();
  // Fetch the REAL payload + actual consumers (the runs this instance fired).
  const detail = useEvent(event.id);
  const realPayload = detail.data?.payload;
  const consumers = detail.data?.consumers ?? [];
  const replay = useReplayEvent();
  const toast = useToast();
  async function handleReplay() {
    try {
      const r = await replay.mutateAsync(event.id);
      toast({
        tone: "signal",
        title: t("events.replayQueued"),
        description: r.new_event_id,
      });
    } catch (e) {
      toast({
        tone: "red",
        title: t("events.replayFailed"),
        description: e instanceof Error ? e.message : "",
      });
    }
  }
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
        <div
          className="mono"
          style={{ fontSize: 13, color: "var(--text)" }}
        >
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

      <Section title={t("events.sectionSource")}>
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
            {t("events.externalSystem")}
          </span>
        )}
      </Section>

      <Section title={t("events.sectionEmitters", { count: emitters.length })}>
        {emitters.length === 0 ? (
          <span style={{ fontSize: 11.5, color: "var(--text-3)" }}>
            {t("events.noEmitter")}
          </span>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {emitters.map((a) => (
              <AgentLinkRow key={a.id} agent={a} tenant={tenant} />
            ))}
          </div>
        )}
      </Section>

      <Section
        title={t("events.sectionListeners", { count: listeners.length })}
      >
        {listeners.length === 0 ? (
          <span style={{ fontSize: 11.5, color: "var(--text-3)" }}>
            {t("events.noListeners")}
          </span>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {listeners.map((a) => (
              <AgentLinkRow key={a.id} agent={a} tenant={tenant} />
            ))}
          </div>
        )}
      </Section>

      {/* Actual consumption — the runs this specific event instance fired
          (real data), distinct from the DAG-declared listeners above. */}
      <Section title={t("events.sectionConsumedBy", { count: consumers.length })}>
        {consumers.length === 0 ? (
          <span style={{ fontSize: 11.5, color: "var(--text-3)" }}>
            {detail.isLoading ? t("events.loadingDetail") : t("events.noConsumers")}
          </span>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {consumers.map((c) => (
              <Link
                key={c.runId}
                href={`/portal/${tenant}/runs/${c.runId}` as never}
                style={{ textDecoration: "none" }}
              >
                <button
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "7px 10px",
                    width: "100%",
                    background: "var(--panel-2)",
                    border: "1px solid var(--border)",
                    borderRadius: 4,
                    textAlign: "left",
                  }}
                >
                  <StatusDot status={(c.status as never) ?? "idle"} size={6} />
                  <span style={{ fontSize: 12, color: "var(--text)" }}>
                    {c.agentTitle || c.agentName || c.runId}
                  </span>
                  <span
                    className="mono"
                    style={{ marginLeft: "auto", fontSize: 10.5, color: "var(--text-3)" }}
                  >
                    {c.status}
                  </span>
                  <Icon name="external" size={11} style={{ color: "var(--text-3)" }} />
                </button>
              </Link>
            ))}
          </div>
        )}
      </Section>

      {/* The REAL payload (resolved from the ledger), not a reconstruction. */}
      <Section title={t("events.sectionPayload")}>
        {detail.isLoading ? (
          <span style={{ fontSize: 11.5, color: "var(--text-3)" }}>
            {t("events.loadingDetail")}
          </span>
        ) : realPayload == null ? (
          <span style={{ fontSize: 11.5, color: "var(--text-3)" }}>
            {t("events.noPayload")}
          </span>
        ) : (
          <CodeBlock>{JSON.stringify(realPayload, null, 2)}</CodeBlock>
        )}
      </Section>

      <div
        style={{
          padding: 14,
          display: "flex",
          gap: 8,
          borderTop: "1px solid var(--border)",
        }}
      >
        <Button
          icon="replay"
          tone="primary"
          style={{ flex: 1 }}
          onClick={handleReplay}
          disabled={replay.isPending}
        >
          {replay.isPending ? t("events.replaying") : t("events.replayEvent")}
        </Button>
        <Button icon="external">{t("events.inngestConsole")}</Button>
      </div>
    </div>
  );
}

function AgentLinkRow({
  agent,
  tenant,
}: {
  agent: DagAgent;
  tenant: string;
}) {
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
      <Icon
        name="chevron-right"
        size={11}
        style={{ color: "var(--text-3)" }}
      />
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
