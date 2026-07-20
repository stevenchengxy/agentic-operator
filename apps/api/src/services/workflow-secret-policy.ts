/**
 * Canonical workflow persistence policy for credentials and secret references.
 *
 * Authoring and direct manifest import both call this module before writing a
 * manifest or actions payload. Keeping the policy here prevents one surface
 * from accepting a value that the other rejects.
 */

import net from "node:net";

export interface WorkflowSecretPolicyIssue {
  path: string;
  code:
    | "literal_secret"
    | "invalid_secret_reference"
    | "tenant_secret_scope"
    | "endpoint_policy";
  severity: "error";
  message: string;
}

export interface WorkflowSecretPolicyContext {
  tenantSlug: string;
}

const SECRET_KEY_PATTERN =
  /(?:api[-_ .]?key|private[-_ .]?key|secret|password|passphrase|access[-_ .]?token|refresh[-_ .]?token|auth(?:entication)?[-_ .]?token|authorization|proxy[-_ .]?authorization|client[-_ .]?secret|credential|cookie)/i;
const GENERIC_SECRET_KEY_PATTERN = /(?:^|[-_. ])(?:token|auth)(?:$|[-_. ])/i;
const SECRET_REFERENCE_KEY_PATTERN = /(_env|_ref|_secret_name)$/i;
const SECRET_NAME_CONFIG_KEYS = new Set([
  "auth_scheme",
  "auth_header_name",
  "auth_query_name",
]);
const SECRET_VALUE_PATTERN =
  /^(?:(?:bearer|basic)\s+\S+|(?:sk|pk|ao_live|gh[pousr]|xox[baprs])_[A-Za-z0-9_-]{8,}|AKIA[A-Z0-9]{12,}|[a-z][a-z0-9+.-]*:\/\/[^\s/:]+:[^\s/@]+@)/i;
const SENSITIVE_ENDPOINT_PARAMETER_PATTERN =
  /(?:^|[-_.])(?:api[-_.]?key|private[-_.]?key|secret|password|passphrase|access[-_.]?token|refresh[-_.]?token|auth(?:entication)?[-_.]?token|authorization|credential|cookie|token|auth)(?:$|[-_.])/i;
const ENV_REFERENCE_PATTERN = /^[A-Z_][A-Z0-9_]{0,127}$/;
const NAMED_REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/#@-]{0,255}$/;

function csv(value: string | undefined): Set<string> {
  return new Set(
    (value ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean),
  );
}

export function workflowTenantKeyPrefix(tenantSlug: string): string {
  return tenantSlug.toUpperCase().replace(/[^A-Z0-9]/g, "_");
}

export function isTenantOwnedWorkflowEnvReference(
  reference: string,
  tenantSlug: string,
): boolean {
  const prefix = workflowTenantKeyPrefix(tenantSlug);
  const candidate = `TENANT_${prefix}_`;
  return reference.startsWith(candidate) && reference.length > candidate.length;
}

export function isTenantOwnedWorkflowNamedReference(
  reference: string,
  tenantSlug: string,
): boolean {
  if (reference.includes("..")) return false;
  const normalized = workflowTenantKeyPrefix(tenantSlug);
  const slug = tenantSlug.toLowerCase();
  const lower = reference.toLowerCase();
  const lowerPrefixes = [
    `${slug}:`,
    `${slug}/`,
    `tenant:${slug}:`,
    `tenant/${slug}/`,
    `secret:${slug}:`,
    `secret/${slug}/`,
    `vault:${slug}:`,
    `vault/${slug}/`,
  ];
  if (
    lowerPrefixes.some(
      (prefix) => lower.startsWith(prefix) && lower.length > prefix.length,
    )
  ) {
    return true;
  }
  const prefix = `TENANT_${normalized}_`;
  return reference.startsWith(prefix) && reference.length > prefix.length;
}

function childPath(parent: string, child: string): string {
  return parent ? `${parent}.${child}` : child;
}

function arrayPath(parent: string, index: number): string {
  return `${parent}[${index}]`;
}

function referenceIssue(
  key: string,
  value: unknown,
  path: string,
  context?: WorkflowSecretPolicyContext,
): WorkflowSecretPolicyIssue | null {
  if (typeof value !== "string" || !value.trim()) {
    return {
      path,
      code: "invalid_secret_reference",
      severity: "error",
      message: `${key} must contain a non-empty secret reference name`,
    };
  }
  const reference = value.trim();
  const valid = key.toLowerCase().endsWith("_env")
    ? ENV_REFERENCE_PATTERN.test(reference)
    : NAMED_REFERENCE_PATTERN.test(reference);
  if (!valid || SECRET_VALUE_PATTERN.test(reference)) {
    return {
      path,
      code: "invalid_secret_reference",
      severity: "error",
      message: key.toLowerCase().endsWith("_env")
        ? `${key} must be an uppercase environment-variable name`
        : `${key} must be a credential-free named reference`,
    };
  }
  if (context) {
    const explicitlyShared = csv(
      process.env.AGENTIC_WORKFLOW_SHARED_ENV_ALLOWLIST,
    ).has(reference);
    const tenantOwned = key.toLowerCase().endsWith("_env")
      ? isTenantOwnedWorkflowEnvReference(reference, context.tenantSlug)
      : isTenantOwnedWorkflowNamedReference(reference, context.tenantSlug);
    if (!tenantOwned && !explicitlyShared) {
      return {
        path,
        code: "tenant_secret_scope",
        severity: "error",
        message: `${key} must be namespaced for tenant ${context.tenantSlug} or exactly listed in AGENTIC_WORKFLOW_SHARED_ENV_ALLOWLIST`,
      };
    }
  }
  return null;
}

function scanValue(
  value: unknown,
  path: string,
  sensitiveAncestor: boolean,
  issues: WorkflowSecretPolicyIssue[],
  seen: WeakSet<object>,
  context?: WorkflowSecretPolicyContext,
): void {
  if (typeof value === "string") {
    const candidate = value.trim();
    if (
      candidate &&
      (sensitiveAncestor || SECRET_VALUE_PATTERN.test(candidate))
    ) {
      issues.push({
        path: path || "manifest",
        code: "literal_secret",
        severity: "error",
        message:
          "literal credentials are not allowed in workflow manifests or actions; use a validated *_env, *_ref, or *_secret_name field",
      });
    }
    return;
  }
  if (value === null || value === undefined) return;
  if (typeof value !== "object") {
    if (sensitiveAncestor) {
      issues.push({
        path: path || "manifest",
        code: "literal_secret",
        severity: "error",
        message:
          "credential fields must use a validated string reference instead of a literal value",
      });
    }
    return;
  }
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      scanValue(
        entry,
        arrayPath(path, index),
        sensitiveAncestor,
        issues,
        seen,
        context,
      ),
    );
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const nextPath = childPath(path, key);
    if (SECRET_REFERENCE_KEY_PATTERN.test(key)) {
      const issue = referenceIssue(key, child, nextPath, context);
      if (issue) issues.push(issue);
      continue;
    }
    scanValue(
      child,
      nextPath,
      sensitiveAncestor ||
        (!SECRET_NAME_CONFIG_KEYS.has(key.toLowerCase()) &&
          (SECRET_KEY_PATTERN.test(key) ||
            GENERIC_SECRET_KEY_PATTERN.test(key))),
      issues,
      seen,
      context,
    );
  }
}

function isLoopbackAddress(address: string): boolean {
  const normalized = address.replace(/^\[|\]$/g, "").split("%")[0]!;
  if (net.isIPv4(normalized)) {
    return normalized.split(".")[0] === "127";
  }
  if (!net.isIPv6(normalized)) return false;
  const lower = normalized.toLowerCase();
  return lower === "::1" || lower === "0:0:0:0:0:0:0:1";
}

function isBlockedLiteralAddress(address: string): boolean {
  const normalized = address.replace(/^\[|\]$/g, "").split("%")[0]!;
  if (net.isIPv4(normalized)) {
    const parts = normalized.split(".").map(Number);
    const [a, b, c] = parts as [number, number, number, number];
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0 && (c === 0 || c === 2)) ||
      (a === 192 && b === 88 && c === 99) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113) ||
      a >= 224
    );
  }
  if (!net.isIPv6(normalized)) return false;
  const lower = normalized.toLowerCase();
  return (
    isLoopbackAddress(lower) ||
    lower === "::" ||
    /^f[cd]/.test(lower) ||
    /^fe[89ab]/.test(lower) ||
    /^ff/.test(lower) ||
    /^2001:db8(?::|$)/.test(lower) ||
    /^::ffff:/.test(lower)
  );
}

function isLocalHostname(hostname: string): boolean {
  const host = hostname
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "")
    .toLowerCase();
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "host.docker.internal" ||
    host === "metadata.google.internal" ||
    host === "kubernetes.default" ||
    host.endsWith(".internal") ||
    host.endsWith(".local") ||
    host.endsWith(".lan")
  );
}

function devLocalhostAllowed(): boolean {
  return (
    process.env.NODE_ENV !== "production" &&
    process.env.AGENTIC_FETCH_ALLOW_HTTP_LOCALHOST === "1"
  );
}

function isExplicitDevLocalhost(hostname: string): boolean {
  const host = hostname
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "")
    .toLowerCase();
  return (
    devLocalhostAllowed() && (host === "localhost" || isLoopbackAddress(host))
  );
}

function endpointHasSensitiveQuery(url: URL): boolean {
  for (const key of url.searchParams.keys()) {
    if (SENSITIVE_ENDPOINT_PARAMETER_PATTERN.test(key)) return true;
  }
  return false;
}

function workflowAgents(workflow: unknown): unknown[] {
  if (Array.isArray(workflow)) return workflow;
  if (!workflow || typeof workflow !== "object") return [];
  const agents = (workflow as { agents?: unknown }).agents;
  return Array.isArray(agents) ? agents : [];
}

function endpointUrl(
  raw: unknown,
  path: string,
  issues: WorkflowSecretPolicyIssue[],
): URL | null {
  if (typeof raw !== "string" || !raw.trim()) {
    issues.push({
      path,
      code: "endpoint_policy",
      severity: "error",
      message: "base_url must be a non-empty absolute HTTP(S) URL",
    });
    return null;
  }
  try {
    const url = new URL(raw);
    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      url.username ||
      url.password ||
      url.hash
    ) {
      throw new Error("unsafe endpoint");
    }
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    const explicitDevLocalhost = isExplicitDevLocalhost(hostname);
    if (url.protocol !== "https:" && !explicitDevLocalhost) {
      throw new Error("plaintext endpoint");
    }
    if (
      (isLocalHostname(hostname) || isBlockedLiteralAddress(hostname)) &&
      !explicitDevLocalhost
    ) {
      throw new Error("internal endpoint");
    }
    if (endpointHasSensitiveQuery(url)) {
      issues.push({
        path,
        code: "endpoint_policy",
        severity: "error",
        message:
          "base_url must not contain credential-bearing query parameters; bind credentials with a tenant-owned *_env reference",
      });
    }
    return url;
  } catch {
    issues.push({
      path,
      code: "endpoint_policy",
      severity: "error",
      message:
        "base_url must be a public absolute HTTPS URL without credentials or fragments (development localhost requires AGENTIC_FETCH_ALLOW_HTTP_LOCALHOST=1)",
    });
    return null;
  }
}

function endpointIsAllowlisted(url: URL): boolean {
  for (const entry of csv(process.env.AGENTIC_WORKFLOW_ENDPOINT_ALLOWLIST)) {
    try {
      const allowed = new URL(entry);
      const allowedPath = allowed.pathname.replace(/\/$/, "");
      const targetPath = url.pathname.replace(/\/$/, "");
      if (
        url.origin === allowed.origin &&
        (!allowedPath ||
          targetPath === allowedPath ||
          targetPath.startsWith(`${allowedPath}/`))
      ) {
        return true;
      }
    } catch {
      if (url.host === entry || url.hostname === entry) return true;
    }
  }
  return false;
}

function stringArray(value: unknown): string[] {
  if (typeof value === "string") return [value];
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function normalizeExactAllowedHost(value: string): string | null {
  const raw = value.trim();
  if (!raw || raw.includes("*") || raw.includes("/") || raw.includes("@")) {
    return null;
  }
  const unbracketed = raw.replace(/^\[|\]$/g, "");
  if (net.isIP(unbracketed)) return unbracketed.toLowerCase();
  if (raw.includes(":")) return null;
  const host = raw.replace(/\.$/, "").toLowerCase();
  if (
    host.length > 253 ||
    !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host) ||
    host.split(".").some((label) => !label || label.length > 63)
  ) {
    return null;
  }
  return host;
}

function inspectHttpFetchEndpoint(
  config: Record<string, unknown>,
  basePath: string,
  issues: WorkflowSecretPolicyIssue[],
): void {
  const url = endpointUrl(config.base_url, `${basePath}.base_url`, issues);
  const rawAllowedHosts = stringArray(config.allow_host);
  if (rawAllowedHosts.length === 0) {
    issues.push({
      path: `${basePath}.allow_host`,
      code: "endpoint_policy",
      severity: "error",
      message:
        "http.fetch requires config.allow_host with the exact base_url hostname",
    });
    return;
  }

  const normalizedHosts: string[] = [];
  for (const [index, entry] of rawAllowedHosts.entries()) {
    const normalized = normalizeExactAllowedHost(entry);
    const path = Array.isArray(config.allow_host)
      ? `${basePath}.allow_host[${index}]`
      : `${basePath}.allow_host`;
    if (!normalized) {
      issues.push({
        path,
        code: "endpoint_policy",
        severity: "error",
        message:
          "http.fetch allow_host entries must be exact hostnames without schemes, ports, paths, or wildcards",
      });
      continue;
    }
    if (
      (isLocalHostname(normalized) || isBlockedLiteralAddress(normalized)) &&
      !isExplicitDevLocalhost(normalized)
    ) {
      issues.push({
        path,
        code: "endpoint_policy",
        severity: "error",
        message: `http.fetch allow_host ${normalized} is internal or non-public`,
      });
      continue;
    }
    normalizedHosts.push(normalized);
  }

  if (!url) return;
  const baseHostname = url.hostname
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "")
    .toLowerCase();
  if (!isExplicitDevLocalhost(baseHostname) && !endpointIsAllowlisted(url)) {
    issues.push({
      path: `${basePath}.base_url`,
      code: "endpoint_policy",
      severity: "error",
      message:
        "http.fetch base_url must match AGENTIC_WORKFLOW_ENDPOINT_ALLOWLIST; manifest allow_host is necessary but is not server authorization",
    });
  }
  if (!normalizedHosts.includes(baseHostname)) {
    issues.push({
      path: `${basePath}.allow_host`,
      code: "endpoint_policy",
      severity: "error",
      message: `http.fetch base_url host ${baseHostname} must exactly match config.allow_host`,
    });
  }
}

function inspectEndpointPolicy(
  workflow: unknown,
  context: WorkflowSecretPolicyContext,
  issues: WorkflowSecretPolicyIssue[],
): void {
  const providerHosts: Record<string, string> = {
    robohire: "api.robohire.io",
    gohire: "api.gohire.io",
  };
  for (const [agentIndex, rawAgent] of workflowAgents(workflow).entries()) {
    if (!rawAgent || typeof rawAgent !== "object") continue;
    const toolUse = (rawAgent as { tool_use?: unknown }).tool_use;
    if (!Array.isArray(toolUse)) continue;
    for (const [toolIndex, rawTool] of toolUse.entries()) {
      if (!rawTool || typeof rawTool !== "object") continue;
      const tool = rawTool as {
        name?: unknown;
        config?: unknown;
      };
      if (typeof tool.name !== "string") continue;
      const basePath = `agents[${agentIndex}].tool_use[${toolIndex}].config`;
      const config =
        tool.config &&
        typeof tool.config === "object" &&
        !Array.isArray(tool.config)
          ? (tool.config as Record<string, unknown>)
          : {};

      if (tool.name.toLowerCase() === "http.fetch") {
        inspectHttpFetchEndpoint(config, basePath, issues);
        continue;
      }

      if (!("base_url" in config)) continue;
      const url = endpointUrl(config.base_url, `${basePath}.base_url`, issues);
      if (!url) continue;

      const category = tool.name.toLowerCase().startsWith("gohire")
        ? "gohire"
        : /robohire|parsejdapi|parseresumeapi|matchresumeapi|invitecandidateapi/i.test(
              tool.name,
            )
          ? "robohire"
          : null;
      const providerOwned =
        category &&
        url.protocol === "https:" &&
        !url.port &&
        url.hostname === providerHosts[category];
      if (!category || providerOwned) continue;
      if (!endpointIsAllowlisted(url)) {
        issues.push({
          path: `${basePath}.base_url`,
          code: "endpoint_policy",
          severity: "error",
          message: `${tool.name} custom base_url must match AGENTIC_WORKFLOW_ENDPOINT_ALLOWLIST`,
        });
      }
      const envName = config.api_key_env;
      if (
        typeof envName !== "string" ||
        !isTenantOwnedWorkflowEnvReference(envName, context.tenantSlug)
      ) {
        issues.push({
          path: `${basePath}.api_key_env`,
          code: "tenant_secret_scope",
          severity: "error",
          message: `${tool.name} custom base_url requires an explicit tenant-owned api_key_env and may not fall back to a shared or global credential`,
        });
      }
    }
  }
}

/** Find every persistence-blocking secret policy issue in a workflow pair. */
export function findWorkflowSecretPolicyIssues(
  workflow: unknown,
  actions?: unknown,
  context?: WorkflowSecretPolicyContext,
): WorkflowSecretPolicyIssue[] {
  const issues: WorkflowSecretPolicyIssue[] = [];
  scanValue(
    workflow,
    Array.isArray(workflow) ? "agents" : "",
    false,
    issues,
    new WeakSet(),
    context,
  );
  if (actions !== undefined && actions !== null) {
    scanValue(actions, "actions", false, issues, new WeakSet(), context);
  }
  if (context) inspectEndpointPolicy(workflow, context, issues);
  return issues;
}

export function isWorkflowSecretPolicyIssueCode(code: string): boolean {
  return (
    code === "literal_secret" ||
    code === "invalid_secret_reference" ||
    code === "tenant_secret_scope" ||
    code === "endpoint_policy"
  );
}
