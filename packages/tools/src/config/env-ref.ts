/**
 * Resolve server-owned environment references without allowing a tool call to
 * choose an arbitrary environment key. The reference itself comes from the
 * manifest's trusted `tool_use[].config`, never from `ctx.event.data`.
 */

const ENV_REF_RE = /^[A-Z_][A-Z0-9_]{0,127}$/;

export function assertEnvironmentReference(
  value: unknown,
  field: string,
): string {
  if (typeof value !== "string" || !ENV_REF_RE.test(value)) {
    throw new Error(
      `${field} must be a server environment variable name (for example AGENTIC_VENDOR_URL).`,
    );
  }
  return value;
}

export function readEnvironmentReference(
  env: Record<string, string | undefined>,
  reference: unknown,
  field: string,
): string {
  const name = assertEnvironmentReference(reference, field);
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(
      `${field} references an unset or empty server environment variable.`,
    );
  }
  return value;
}

export function readOptionalEnvironmentReference(
  env: Record<string, string | undefined>,
  reference: unknown,
  field: string,
): string | undefined {
  if (reference === undefined || reference === null || reference === "")
    return undefined;
  return readEnvironmentReference(env, reference, field);
}
