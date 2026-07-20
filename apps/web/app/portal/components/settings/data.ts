/**
 * Settings navigation + enumerated allow-lists; no runtime records live here.
 *
 * Section labels/hints are i18n keys resolved at render time
 * (`settings.section.<id>` / `settings.sectionHint.<id>`), so this registry
 * stays icon-only. TIMEZONES / LOCALES are intentional enumerations for
 * select fields (Workspace section), not synthesized data.
 */

export const SETTINGS_SECTIONS = [
  { id: "workspace", icon: "settings" as const },
  { id: "appearance", icon: "moon" as const },
  { id: "people", icon: "human" as const },
  // AI & models — LLM gateway settings, routing, providers, live tests.
  { id: "ai", icon: "spark" as const },
  { id: "models", icon: "spark" as const },
  // Programmatic access + outbound integrations (real /v1/api-tokens and
  // /v1/integrations surfaces).
  { id: "tokens", icon: "code" as const },
  { id: "integrations", icon: "external" as const },
  { id: "billing", icon: "deploy" as const },
  // P3-FE-03 — cost dashboard. Lives at its own sub-route so deep-links
  // and tab-state survive a reload.
  { id: "usage", icon: "dashboard" as const },
  { id: "audit", icon: "logs" as const },
] as const;

export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]["id"];

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
