"use client";

/**
 * Cmd-K command palette (P2-FE-23).
 *
 * Keyboard: ⌘+K / Ctrl+K opens the palette anywhere in the portal. ↑/↓ move
 * selection, Enter activates, Escape closes.
 *
 * Data sources: canonical TanStack Query hooks (useAgents / useEvents /
 * useRuns / useTasks). No bootstrap snapshot — every result reflects the
 * live tenant.
 *
 * Each command jumps via Next router. The palette stays alive across
 * unmounts because the host component <CommandPalette /> is mounted once
 * in the portal layout — toggling open state, not mount state.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
} from "react";
import { useRouter } from "next/navigation";
import { useI18n } from "@/app/portal/lib/preferences-context";
import { Icon } from "../Icon";
import { Kbd } from "../atoms";
import { useTenant } from "../../lib/use-tenant";
import { useAgents } from "@/lib/hooks/useAgents";
import { useEvents } from "@/lib/hooks/useEvents";
import { useRuns } from "@/lib/hooks/useRuns";
import { useTasks } from "@/lib/hooks/useTasks";

// ─── Open/close store (module-scoped so a hotkey listener can flip it) ────

let __open = false;
const __listeners = new Set<() => void>();
function notify() {
  for (const l of __listeners) l();
}
function subscribe(cb: () => void) {
  __listeners.add(cb);
  return () => __listeners.delete(cb);
}
function getSnapshot() {
  return __open;
}
function getServerSnapshot() {
  return false;
}
function setOpen(v: boolean) {
  if (__open === v) return;
  __open = v;
  notify();
}

export function useCommandPalette() {
  const open = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  return {
    open,
    setOpen,
    toggle: () => setOpen(!__open),
  };
}

// ─── Command model ────────────────────────────────────────────────────────

interface Command {
  id: string;
  group: "Jump" | "Runs" | "Agents" | "Events" | "Tasks";
  label: string;
  hint?: string;
  href: string;
}

const VIEW_LINKS: Command[] = [
  { id: "v:dashboard", group: "Jump", label: "Dashboard", href: "/portal/__TENANT__/dashboard" },
  { id: "v:workflows", group: "Jump", label: "Workflows", href: "/portal/__TENANT__/workflows" },
  { id: "v:agents", group: "Jump", label: "Agents", href: "/portal/__TENANT__/agents" },
  { id: "v:runs", group: "Jump", label: "Runs", href: "/portal/__TENANT__/runs" },
  { id: "v:events", group: "Jump", label: "Events", href: "/portal/__TENANT__/events" },
  { id: "v:tasks", group: "Jump", label: "Human tasks", href: "/portal/__TENANT__/tasks" },
  { id: "v:logs", group: "Jump", label: "Logs", href: "/portal/__TENANT__/logs" },
  { id: "v:deployments", group: "Jump", label: "Deployments", href: "/portal/__TENANT__/deployments" },
  { id: "v:settings", group: "Jump", label: "Settings", href: "/portal/__TENANT__/settings" },
];

// ─── Component ────────────────────────────────────────────────────────────

export function CommandPalette() {
  const { open, setOpen } = useCommandPalette();
  const tenant = useTenant();

  // Global keyboard listener: ⌘+K / Ctrl+K toggles.
  useEffect(() => {
    function onKey(e: globalThis.KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen(!__open);
      } else if (e.key === "Escape" && __open) {
        setOpen(false);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setOpen]);

  if (!open) return null;
  return <PaletteInner tenant={tenant} onClose={() => setOpen(false)} />;
}

function PaletteInner({
  tenant,
  onClose,
}: {
  tenant: string;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const router = useRouter();
  const [q, setQ] = useState("");
  const [cursor, setCursor] = useState(0);
  const agentsQuery = useAgents();
  const eventsQuery = useEvents({ limit: 50 });
  const runsQuery = useRuns({ limit: 50 });
  const tasksQuery = useTasks();
  const agents = agentsQuery.data ?? [];
  const events = eventsQuery.data ?? [];
  const runs = runsQuery.data ?? [];
  const tasks = tasksQuery.data ?? [];
  const dynamicSourcesUnavailable = [
    agentsQuery,
    eventsQuery,
    runsQuery,
    tasksQuery,
  ].some((query) => query.isError);

  const commands = useMemo<Command[]>(() => {
    const tenanted = VIEW_LINKS.map((c) => ({
      ...c,
      href: c.href.replace("__TENANT__", tenant),
    }));

    const agentCommands: Command[] = agents.map((a) => ({
      id: `a:${a.kebabId}`,
      group: "Agents",
      label: a.title || a.name,
      hint: a.name,
      href: `/portal/${tenant}/agents/${a.kebabId}`,
    }));

    const runCommands: Command[] = runs.slice(0, 20).map((r) => ({
      id: `r:${r.id}`,
      group: "Runs",
      label: r.id,
      hint: r.status,
      href: `/portal/${tenant}/runs/${r.id}`,
    }));

    // De-dup event names so the palette doesn't show the same EVENT_NAME
    // for each occurrence in the recent stream.
    const eventNames = Array.from(new Set(events.map((e) => e.name))).slice(0, 20);
    const eventCommands: Command[] = eventNames.map((name) => {
      const sample = events.find((e) => e.name === name);
      return {
        id: `e:${name}`,
        group: "Events",
        label: name,
        hint: sample?.category ?? undefined,
        href: `/portal/${tenant}/events?type=${encodeURIComponent(name)}`,
      };
    });

    const taskCommands: Command[] = tasks
      .filter((task) => task.status === "open")
      .slice(0, 20)
      .map((t) => ({
      id: `t:${t.id}`,
      group: "Tasks",
      label: t.id,
      hint: t.type,
      href: `/portal/${tenant}/tasks?selected=${encodeURIComponent(t.id)}`,
      }));

    return [
      ...tenanted,
      ...agentCommands,
      ...runCommands,
      ...eventCommands,
      ...taskCommands,
    ];
  }, [tenant, agents, events, runs, tasks]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return commands.slice(0, 12);
    return commands
      .filter(
        (c) =>
          c.label.toLowerCase().includes(needle) ||
          (c.hint ?? "").toLowerCase().includes(needle),
      )
      .slice(0, 30);
  }, [commands, q]);

  // Reset cursor on filter change.
  useEffect(() => {
    setCursor(0);
  }, [q]);

  const activate = useCallback(
    (cmd: Command | undefined) => {
      if (!cmd) return;
      onClose();
      router.push(cmd.href as never);
    },
    [router, onClose],
  );

  function onKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor((c) => Math.min(filtered.length - 1, c + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor((c) => Math.max(0, c - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      activate(filtered[cursor]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  }

  return (
    <div
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={t("cmdk.dialogLabel")}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: "var(--z-modal)" as unknown as number,
        background: "rgba(0,0,0,0.5)",
        display: "flex",
        justifyContent: "center",
        alignItems: "flex-start",
        paddingTop: "12vh",
        backdropFilter: "blur(2px)",
        animation: "fadein 0.14s ease",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 560,
          maxHeight: "70vh",
          display: "flex",
          flexDirection: "column",
          background: "var(--panel)",
          border: "1px solid var(--border-2)",
          borderRadius: 8,
          boxShadow: "0 24px 60px rgba(0,0,0,0.6)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "10px 14px",
            borderBottom: "1px solid var(--border)",
          }}
        >
          <Icon name="search" size={13} style={{ color: "var(--text-3)" }} />
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKey}
            placeholder={t("cmdk.searchPlaceholder")}
            aria-label={t("cmdk.searchAria")}
            style={{
              flex: 1,
              background: "transparent",
              border: "none",
              outline: "none",
              color: "var(--text)",
              fontSize: 13,
              fontFamily: "var(--sans)",
            }}
          />
          <Kbd>ESC</Kbd>
        </div>
        <div style={{ overflow: "auto", minHeight: 0 }}>
          {filtered.length === 0 ? (
            <div
              style={{
                padding: "20px 14px",
                color: "var(--text-3)",
                fontSize: 12,
                textAlign: "center",
              }}
            >
              {t("cmdk.noMatches")}
            </div>
          ) : (
            renderGrouped(filtered, cursor, activate, t)
          )}
        </div>
        {dynamicSourcesUnavailable ? (
          <div
            role="alert"
            style={{
              padding: "8px 14px",
              borderTop: "1px solid var(--border)",
              color: "var(--amber)",
              fontSize: 11,
            }}
          >
            {t("cmdk.dynamicResultsUnavailable")}
          </div>
        ) : null}
      </div>
    </div>
  );
}

// Static view-link ids → i18n key suffix (rendered at site since the const
// array is module-scoped and can't call t() at load time).
const VIEW_LABEL_KEYS: Record<string, string> = {
  "v:dashboard": "viewDashboard",
  "v:workflows": "viewWorkflows",
  "v:agents": "viewAgents",
  "v:runs": "viewRuns",
  "v:events": "viewEvents",
  "v:tasks": "viewTasks",
  "v:logs": "viewLogs",
  "v:deployments": "viewDeployments",
  "v:settings": "viewSettings",
};

function renderGrouped(
  commands: Command[],
  cursor: number,
  activate: (cmd: Command) => void,
  t: (key: string, vars?: Record<string, string | number>) => string,
) {
  const groups = new Map<string, Command[]>();
  for (const c of commands) {
    if (!groups.has(c.group)) groups.set(c.group, []);
    groups.get(c.group)!.push(c);
  }
  let idx = 0;
  return (
    <>
      {Array.from(groups.entries()).map(([group, cmds]) => (
        <div key={group}>
          <div
            style={{
              padding: "8px 14px 4px",
              fontSize: 10,
              fontFamily: "var(--mono)",
              textTransform: "uppercase",
              letterSpacing: "0.1em",
              color: "var(--text-3)",
            }}
          >
            {t(`cmdk.group${group}`)}
          </div>
          {cmds.map((cmd) => {
            const active = idx === cursor;
            const myIdx = idx++;
            return (
              <button
                key={cmd.id}
                onClick={() => activate(cmd)}
                onMouseEnter={() => {
                  /* hover doesn't bump cursor — keyboard owns the cursor */
                }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  width: "100%",
                  padding: "7px 14px",
                  gap: 10,
                  background: active ? "var(--panel-2)" : "transparent",
                  borderLeft: active
                    ? "2px solid var(--signal)"
                    : "2px solid transparent",
                  color: active ? "var(--text)" : "var(--text-2)",
                  fontSize: 12.5,
                  textAlign: "left",
                  cursor: "pointer",
                }}
                data-index={myIdx}
              >
                <span style={{ flex: 1, minWidth: 0 }}>
                  {VIEW_LABEL_KEYS[cmd.id]
                    ? t(`cmdk.${VIEW_LABEL_KEYS[cmd.id]}`)
                    : cmd.label}
                </span>
                {cmd.hint && (
                  <span
                    style={{
                      fontFamily: "var(--mono)",
                      fontSize: 10.5,
                      color: "var(--text-3)",
                    }}
                  >
                    {cmd.hint}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      ))}
    </>
  );
}
