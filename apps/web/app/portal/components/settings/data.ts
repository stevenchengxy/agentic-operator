/** Settings navigation; no runtime records live here. */

export const SETTINGS_SECTIONS = [
  { id: "workspace", icon: "settings" as const },
  { id: "appearance", icon: "moon" as const },
  { id: "people", icon: "human" as const },
  { id: "models", icon: "spark" as const },
  { id: "billing", icon: "deploy" as const },
  // P3-FE-03 — cost dashboard. Lives at its own sub-route so deep-links
  // and tab-state survive a reload.
  { id: "usage", icon: "dashboard" as const },
  { id: "audit", icon: "logs" as const },
] as const;

export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]["id"];
