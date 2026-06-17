import type { Dict } from "./types";

/**
 * English UI strings. Scope (Rev 2 spec): chrome + Settings. Namespaces:
 * nav.* / topbar.* (settings.* and appearance.* are added when the
 * Settings → Appearance section is built). `zh.ts` MUST mirror this key
 * set exactly — enforced by `parity.test.ts`.
 */
export const en = {
  nav: {
    group: { run: "Run", observe: "Observe", manage: "Manage" },
    dashboard: "Dashboard",
    workflows: "Workflows",
    agents: "Agents",
    runs: "Runs",
    events: "Events",
    tasks: "Human tasks",
    logs: "Logs",
    deployments: "Deployments",
    tools: "Agentic Tools",
    tenants: "Tenants",
    settings: "Settings",
  },
  topbar: {
    search: "Jump to agent, event, run…",
    live: "LIVE",
    paused: "PAUSED",
    theme: "Theme",
    themeSystem: "System",
    themeLight: "Light",
    themeDark: "Dark",
    language: "Language",
  },
  settings: {
    title: "Settings",
    docs: "Settings docs",
    export: "Export config",
    section: {
      workspace: "Workspace",
      appearance: "Appearance",
      people: "People & roles",
      models: "Models",
      channels: "Channels",
      integrations: "Integrations",
      notifications: "Notifications",
      tokens: "API tokens",
      usage: "Usage & cost",
      billing: "Billing & cost caps",
      audit: "Audit log",
    },
    hint: {
      workspace: "Name, slug, timezone, locale, accent",
      appearance: "Theme, language, density",
      people: "RBAC, invites",
      models: "Fleet & fallback chain",
      channels: "Job boards & messaging",
      integrations: "GitHub, SES, ATS",
      notifications: "Routes & quiet hours",
      tokens: "Programmatic access",
      usage: "Per-agent, per-model spend",
      billing: "Per-tenant budgets",
      audit: "Recent admin actions",
    },
  },
  appearance: {
    theme: "Theme",
    themeHelp: "Light, dark, or follow your system.",
    language: "Language",
    languageHelp: "Interface language for the portal.",
    density: "Density",
    densityCompact: "Compact",
    densityDefault: "Default",
    densityComfortable: "Comfortable",
    accent: "Accent",
    accentHelp: "Signal color for live and active UI.",
  },
} satisfies Dict;

export type EnDict = typeof en;
