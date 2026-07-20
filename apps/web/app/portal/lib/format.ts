/**
 * Format helpers ported from v1_1 components.jsx (window.fmtAgo / fmtDur / etc.).
 *
 * Pure functions — safe to import from server or client components. Time
 * formatters use local TZ today (matches prototype); see audit §7 R-10 for
 * the multi-tenant TZ follow-up.
 */

export function fmtAgo(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  const d = Math.max(0, Date.now() - ms);
  if (d < 60_000) return `${Math.max(1, Math.floor(d / 1000))}s ago`;
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`;
  return `${Math.floor(d / 86_400_000)}d ago`;
}

export function fmtDur(ms: number | null | undefined): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)}s`;
  if (ms < 3_600_000) {
    return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;
  }
  return `${Math.floor(ms / 3_600_000)}h ${Math.floor((ms % 3_600_000) / 60_000)}m`;
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function fmtNum(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1000) return (n / 1000).toFixed(1) + "K";
  return String(n);
}

export function fmtTime(ms: number): string {
  const d = new Date(ms);
  return d.toTimeString().slice(0, 8);
}
