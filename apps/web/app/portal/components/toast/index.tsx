"use client";

/**
 * Toast (P2-FE-22) — corner-anchored snackbar with auto-dismiss.
 *
 * Layout: bottom-right column of stacked cards (max 4 visible). Each toast
 * gets its own fade-in via the global `fadein` keyframe, auto-dismisses
 * after 4s, and can be dismissed manually with X. Failed mutations across
 * the app surface here so we don't fail silently (audit §7 §8 #4).
 *
 * Usage:
 *
 *   // anywhere in a client component
 *   const toast = useToast();
 *   toast({ tone: "red", title: "Deploy failed", description: err.message });
 *
 * Wiring: `<ToastRegion />` is mounted once in `app/portal/layout.tsx`.
 * It owns the queue and renders the cards; the hook only enqueues.
 *
 * Implementation: a module-scoped subscription store rather than React
 * context, so toasts can fire from outside React (e.g. a useStream onError).
 */

import {
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { Icon } from "../Icon";
import { useI18n } from "@/app/portal/lib/preferences-context";

export type ToastTone = "default" | "signal" | "green" | "amber" | "red";

interface Toast {
  id: number;
  tone: ToastTone;
  title: ReactNode;
  description?: ReactNode;
  /** Override auto-dismiss in ms. 0 disables. */
  durationMs?: number;
}

type ToastInput = Omit<Toast, "id">;

const MAX_TOASTS = 4;
const DEFAULT_DURATION_MS = 4000;

// ─── External store (singleton, lives outside React) ───────────────────────

let __nextId = 1;
let __queue: Toast[] = [];
const __listeners = new Set<() => void>();

function notify() {
  for (const l of __listeners) l();
}

function subscribe(cb: () => void) {
  __listeners.add(cb);
  return () => {
    __listeners.delete(cb);
  };
}

function getSnapshot(): Toast[] {
  return __queue;
}

// SSR safety: useSyncExternalStore wants a server snapshot. The toast queue is
// purely client-side so an empty array is correct.
const SSR_SNAPSHOT: Toast[] = [];
function getServerSnapshot(): Toast[] {
  return SSR_SNAPSHOT;
}

function dismiss(id: number) {
  __queue = __queue.filter((t) => t.id !== id);
  notify();
}

export function toast(input: ToastInput): number {
  const id = __nextId++;
  const t: Toast = {
    id,
    tone: input.tone ?? "default",
    title: input.title,
    description: input.description,
    durationMs: input.durationMs,
  };
  __queue = [...__queue, t].slice(-MAX_TOASTS);
  notify();
  const duration = input.durationMs ?? DEFAULT_DURATION_MS;
  if (duration > 0) {
    setTimeout(() => dismiss(id), duration);
  }
  return id;
}

/**
 * Hook return is the same callable as the module-level `toast` export.
 * Provided so callers can `const t = useToast(); t({ ... })` inside
 * components — closer to other toast APIs.
 */
export function useToast(): (input: ToastInput) => number {
  return toast;
}

// ─── Visual styling ────────────────────────────────────────────────────────

const TONE_STYLES: Record<
  ToastTone,
  { bg: string; border: string; accent: string; icon: "spark" | "check" | "alert" | "x" | "dot" }
> = {
  default: {
    bg: "var(--panel)",
    border: "var(--border-2)",
    accent: "var(--text-2)",
    icon: "dot",
  },
  signal: {
    bg: "color-mix(in srgb, var(--signal) 6%, transparent)",
    border: "color-mix(in srgb, var(--signal) 32%, transparent)",
    accent: "var(--signal)",
    icon: "spark",
  },
  green: {
    bg: "color-mix(in srgb, var(--green) 6%, transparent)",
    border: "color-mix(in srgb, var(--green) 30%, transparent)",
    accent: "var(--green)",
    icon: "check",
  },
  amber: {
    bg: "color-mix(in srgb, var(--amber) 6%, transparent)",
    border: "color-mix(in srgb, var(--amber) 32%, transparent)",
    accent: "var(--amber)",
    icon: "alert",
  },
  red: {
    bg: "color-mix(in srgb, var(--red) 6%, transparent)",
    border: "color-mix(in srgb, var(--red) 34%, transparent)",
    accent: "var(--red)",
    icon: "alert",
  },
};

// ─── Region (mounted once in layout) ───────────────────────────────────────

export function ToastRegion() {
  const { t } = useI18n();
  const items = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  // Avoid a hydration flicker: render an empty region during SSR; on mount,
  // start showing real toasts.
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    setHydrated(true);
  }, []);
  if (!hydrated || items.length === 0) return null;

  return (
    <div
      style={{
        position: "fixed",
        right: 16,
        bottom: 16,
        zIndex: "var(--z-toast)" as unknown as number,
        display: "flex",
        flexDirection: "column",
        gap: 8,
        maxWidth: 360,
        pointerEvents: "none",
      }}
      role="region"
      aria-label={t("toast.regionLabel")}
    >
      {items.map((t) => (
        <ToastCard key={t.id} toast={t} />
      ))}
    </div>
  );
}

function ToastCard({ toast: t }: { toast: Toast }) {
  const { t: translate } = useI18n();
  const s = TONE_STYLES[t.tone];
  return (
    <div
      role="status"
      style={{
        background: s.bg,
        border: `1px solid ${s.border}`,
        borderRadius: 6,
        padding: "10px 12px",
        display: "flex",
        gap: 10,
        alignItems: "flex-start",
        boxShadow: "0 12px 32px -16px rgba(0,0,0,0.5)",
        backdropFilter: "blur(6px)",
        animation: "fadein 0.14s ease",
        pointerEvents: "auto",
        color: "var(--text)",
        minWidth: 240,
      }}
    >
      <Icon name={s.icon} size={14} style={{ color: s.accent, marginTop: 1 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12.5, fontWeight: 500 }}>{t.title}</div>
        {t.description && (
          <div
            style={{
              marginTop: 3,
              fontSize: 11.5,
              color: "var(--text-2)",
              lineHeight: 1.45,
              wordBreak: "break-word",
            }}
          >
            {t.description}
          </div>
        )}
      </div>
      <button
        onClick={() => dismiss(t.id)}
        aria-label={translate("toast.dismiss")}
        style={{
          flexShrink: 0,
          color: "var(--text-3)",
          padding: 2,
          marginTop: -2,
        }}
      >
        <Icon name="x" size={11} />
      </button>
    </div>
  );
}
