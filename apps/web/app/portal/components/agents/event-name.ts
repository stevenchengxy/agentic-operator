const MAX_EVENT_NAME_LENGTH = 160;

/**
 * Convert free-form authoring input into the event-name format accepted by
 * the shared deploy contract. Keeping this separate from the picker makes
 * the previewed name exactly match the name persisted in the manifest.
 */
export function normalizeAuthoredEventName(value: string): string {
  const cleaned = value
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "_")
    .replace(/[^A-Z0-9_.:-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!cleaned) return "";
  const named = /^[A-Z]/.test(cleaned) ? cleaned : `EVENT_${cleaned}`;
  return named.slice(0, MAX_EVENT_NAME_LENGTH);
}
