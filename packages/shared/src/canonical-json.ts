/** Canonical JSON used by cross-package integrity identities. Object keys are
 * sorted; array order remains significant because workflows and plans are
 * ordered inputs. Undefined object properties are omitted. */
function canonicalize(value: unknown): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : String(value);
  }
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  if (typeof value === "object") {
    const input = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(input).sort()) {
      if (input[key] !== undefined) out[key] = canonicalize(input[key]);
    }
    return out;
  }
  return String(value);
}

export function canonicalEvidenceJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}
