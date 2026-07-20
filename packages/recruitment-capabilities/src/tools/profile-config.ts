import type { ToolContext } from "@agentic/agent-kit";

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Resolve a non-secret environment reference from a reviewed tool config.
 *
 * The config carries only the environment variable name; the secret/value is
 * read inside the trusted runtime process.  A legacy default may be supplied
 * by a signed tenant adapter, but shared tools never choose a tenant or env
 * name from their own business-name heuristics.
 */
export function profileEnvironmentValue(
  ctx: ToolContext,
  configKey: string,
  options: {
    label: string;
    required?: boolean;
  },
): string {
  const configured = text(ctx.config?.[configKey]);
  const envName = configured;
  if (!envName) {
    if (options.required === false) return "";
    throw new Error(`${options.label}: config.${configKey} is required`);
  }
  if (!ENV_NAME.test(envName)) {
    throw new Error(
      `${options.label}: config.${configKey} must be a valid environment variable name`,
    );
  }
  const value = text(process.env[envName]);
  if (!value && options.required !== false) {
    throw new Error(
      `${options.label}: environment reference ${envName} is not configured`,
    );
  }
  return value;
}

/** Exact tenant binding enforced again at the dispatch boundary. */
export function assertProfileTenantScope(
  ctx: ToolContext,
  label: string,
): void {
  const configured = text(ctx.config?.tenant_slug);
  if (!configured) {
    throw new Error(`${label}: config.tenant_slug is required`);
  }
  if (configured !== ctx.tenantSlug) {
    throw new Error(
      `${label}: profile tenant '${configured}' does not match runtime tenant '${ctx.tenantSlug}'`,
    );
  }
}

export function profileText(
  ctx: ToolContext,
  configKey: string,
  label: string,
  required = true,
): string {
  const value = text(ctx.config?.[configKey]);
  if (!value && required) {
    throw new Error(`${label}: config.${configKey} is required`);
  }
  return value;
}
