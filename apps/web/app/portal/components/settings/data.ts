/**
 * Settings constants.
 *
 * **No mock data here.** Earlier revisions of this file shipped four
 * hardcoded arrays (`SETTINGS_MEMBERS`, `SETTINGS_KEYS`,
 * `SETTINGS_INTEGRATIONS`, `SETTINGS_AUDIT_FALLBACK`) lifted from the v1_1
 * SPA prototype. They surfaced fake names like "Liu Wei" and fake
 * integrations like "Tencent ATS · TLS cert expired" as if they were
 * backend data — actively misleading to operators.
 *
 * They are now empty. Sections that consume these arrays render proper
 * "no data yet" empty states. When the corresponding backend surfaces
 * land (`/v1/members`, `/v1/api-tokens`, `/v1/integrations`, …) the
 * consumers should switch to live hooks instead of re-importing these
 * placeholders.
 *
 * The non-empty constants below (`TIMEZONES`, `LOCALES`,
 * `SETTINGS_SECTIONS`) are intentional — they're enumerated allow-lists
 * for select fields and the section nav, not synthesized data.
 */

/** Empty member list — wire to `/v1/members` when the route lands. */
export const SETTINGS_MEMBERS: Array<{
  id: string;
  name: string;
  email: string;
  role: string;
  last: number;
  avatar: string;
  color: string;
}> = [];

export interface ApiKey {
  id: string;
  label: string;
  prefix: string;
  scopes: string[];
  created: number;
  lastUsed: number;
  author: string;
  expiring?: number;
}

/** Empty key list — wire to `/v1/api-tokens` when that route lands. The
 *  bootstrap token shown once at tenant-create lives elsewhere. */
export const SETTINGS_KEYS: ApiKey[] = [];

/** Empty integration list — `/v1/integrations` is not implemented; for
 *  LLM provider integrations specifically, the Models section
 *  (`sections/Models.tsx`) wires to the real `/v1/llm/providers` surface. */
export const SETTINGS_INTEGRATIONS: Array<{
  id: string;
  name: string;
  kind: string;
  status: "ok" | "warn" | "err";
  detail: string;
  monthly: string;
}> = [];

/** Empty fallback — Audit.tsx now renders an empty state when `/v1/audit`
 *  returns no rows instead of synthesizing fake admin actions. */
export const SETTINGS_AUDIT_FALLBACK: Array<{
  at: number;
  actor: string;
  action: string;
  target: string;
  ip: string;
}> = [];

export const TIMEZONES = [
  "Asia/Shanghai",
  "Asia/Singapore",
  "Asia/Tokyo",
  "Asia/Hong_Kong",
  "Australia/Sydney",
  "Europe/London",
  "Europe/Berlin",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "UTC",
];

export const LOCALES = [
  { value: "en-US", label: "English (US)" },
  { value: "en-GB", label: "English (UK)" },
  { value: "zh-CN", label: "Simplified Chinese" },
  { value: "zh-TW", label: "Traditional Chinese" },
  { value: "ja-JP", label: "Japanese" },
  { value: "ko-KR", label: "Korean" },
];

export const SETTINGS_SECTIONS = [
  {
    id: "workspace",
    label: "Workspace",
    icon: "settings" as const,
    hint: "Name, slug, timezone, locale, accent",
  },
  {
    id: "people",
    label: "People & roles",
    icon: "human" as const,
    hint: "Capability status",
  },
  {
    id: "ai",
    label: "AI & models",
    icon: "spark" as const,
    hint: "Routing, providers, models & tests",
  },
  {
    id: "channels",
    label: "Channels",
    icon: "git" as const,
    hint: "Not configured",
  },
  {
    id: "integrations",
    label: "Integrations",
    icon: "external" as const,
    hint: "GitHub, SES, ATS",
  },
  {
    id: "notifications",
    label: "Notifications",
    icon: "alert" as const,
    hint: "Not configured",
  },
  {
    id: "tokens",
    label: "API tokens",
    icon: "code" as const,
    hint: "Programmatic access",
  },
  {
    id: "billing",
    label: "Billing & cost caps",
    icon: "deploy" as const,
    hint: "Per-tenant budgets",
  },
  // P3-FE-03 — cost dashboard. Lives at its own sub-route so deep-links
  // and tab-state survive a reload.
  {
    id: "usage",
    label: "Usage & cost",
    icon: "dashboard" as const,
    hint: "Per-agent, per-model spend",
  },
  {
    id: "audit",
    label: "Audit log",
    icon: "logs" as const,
    hint: "Recent admin actions",
  },
] as const;

export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]["id"];
