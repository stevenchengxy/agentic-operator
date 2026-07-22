/**
 * POST /v1/tenants/:slug/manifest-import — the 6-step wizard backend.
 *
 * One main route, two modes (selected by `body.mode`):
 *
 *   - `validate` → 200 ManifestImportPreview
 *                  423 LOCKED when another import is in flight (the body
 *                  echoes the in-flight `deployment_id` so the SPA can
 *                  offer "resume or cancel")
 *   - `commit`   → 200 ManifestImportCommit on success
 *                  409 ManifestImportOverwriteRequired when the guard trips
 *                  400 when blocking issues are present
 *
 * The v0 `stage` mode is gone per principal-engineer review C3 — `validate`
 * itself inserts the `deployments(status='pending')` lock row (the
 * deployment row's `id` IS the session id, per review A2).
 *
 * Plus auxiliary endpoints:
 *
 *   - POST   /v1/tenants/:slug/manifest-import/fetch-url   { url }   → 200 { workflow, actions? }
 *   - POST   /v1/tenants/:slug/manifest-import/fetch-repo            → fetch a public GitHub/GitLab manifest
 *   - DELETE /v1/tenants/:slug/manifest-import/:deployment_id        → 200 (release pending lock)
 *
 * `fetch-url` is SSRF-guarded via `services/ssrf-guard.ts` (review S1). All
 * endpoints run `requireAuth` BEFORE any body parse and assert
 * `auth.tenantSlug === req.params.slug`.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { ManifestImportBody } from "@agentic/contracts";
import { isSandboxTenant } from "@agentic/runtime";
import { requirePermission } from "../../plugins/rbac";
import { writeAudit } from "../../plugins/audit";
import {
  validate,
  commit,
  cancel,
  OverwriteRequiredError,
  BlockingIssuesError,
  PendingImportConflictError,
  InvalidPendingImportError,
  type AuditCtx,
} from "../../services/manifest-import";
import { safeFetch, SsrfError } from "../../services/ssrf-guard";
import { withTenantWorkflowMutationLease } from "../../services/tenant-workflow-mutation";

const FETCH_URL_MAX_BYTES = Number(
  process.env.AGENTIC_FETCH_URL_MAX_BYTES ?? String(5 * 1024 * 1024),
);
const FETCH_URL_ALLOW_CONTENT_TYPES = new Set([
  "application/json",
  "text/plain",
  "application/octet-stream",
]);

/**
 * Reduce a fetch-url to just its origin for the audit log. A blocked SSRF
 * attempt must never persist credential-bearing components (userinfo, path,
 * query, fragment) into `audit_log`. Returns "[invalid-url]" for unparseable
 * input so the audit write can never throw.
 */
export function redactManifestImportUrlForAudit(raw: string): string {
  try {
    return new URL(raw).origin.slice(0, 200);
  } catch {
    return "[invalid-url]";
  }
}

/** Build an AuditCtx from the Fastify request so the service can `req.log.error(...)` failures. */
function auditCtxFor(req: FastifyRequest, actorUserId?: string): AuditCtx {
  return {
    log: {
      error: (obj, msg) => req.log.error(obj, msg ?? ""),
      info: (obj, msg) => req.log.info(obj, msg ?? ""),
    },
    actorUserId,
  };
}

function normalizeFetchedManifest(json: unknown): {
  workflow: unknown;
  actions?: unknown[];
} {
  if (
    json &&
    typeof json === "object" &&
    !Array.isArray(json) &&
    "workflow" in (json as Record<string, unknown>)
  ) {
    const obj = json as { workflow: unknown; actions?: unknown[] };
    return {
      workflow: obj.workflow,
      actions: Array.isArray(obj.actions) ? obj.actions : undefined,
    };
  }
  return { workflow: json };
}

function publicRepoRawUrl(
  repository: string,
  ref: string,
  manifestPath: string,
): string {
  let repo: URL;
  try {
    repo = new URL(repository);
  } catch {
    throw new Error("repository must be a valid HTTPS GitHub or GitLab URL");
  }
  if (
    repo.protocol !== "https:" ||
    repo.username ||
    repo.password ||
    repo.search ||
    repo.hash
  ) {
    throw new Error("repository must be a credential-free HTTPS URL");
  }
  if (!/^[A-Za-z0-9._/-]{1,200}$/.test(ref) || ref.includes("..")) {
    throw new Error("ref contains unsupported characters");
  }
  const cleanPath = manifestPath.replace(/^\/+/, "");
  if (
    !cleanPath ||
    cleanPath.includes("..") ||
    cleanPath.includes("\\") ||
    cleanPath.length > 500
  ) {
    throw new Error(
      "path must be a repository-relative manifest file without '..'",
    );
  }
  const segments = repo.pathname
    .replace(/^\/+|\/+$/g, "")
    .replace(/\.git$/i, "")
    .split("/")
    .filter(Boolean);
  const refPart = ref.split("/").map(encodeURIComponent).join("/");
  const pathPart = cleanPath.split("/").map(encodeURIComponent).join("/");
  if (repo.hostname === "github.com") {
    if (segments.length !== 2)
      throw new Error(
        "GitHub repository URL must be https://github.com/<owner>/<repo>",
      );
    return `https://raw.githubusercontent.com/${segments.map(encodeURIComponent).join("/")}/${refPart}/${pathPart}`;
  }
  if (repo.hostname === "gitlab.com") {
    if (segments.length < 2)
      throw new Error("GitLab repository URL is missing its namespace/project");
    return `https://gitlab.com/${segments.map(encodeURIComponent).join("/")}/-/raw/${refPart}/${pathPart}`;
  }
  throw new Error(
    "only public github.com and gitlab.com repositories are supported",
  );
}

export async function manifestImportRoutes(app: FastifyInstance) {
  // -------------------------------------------------------------- main route
  app.post<{
    Params: { slug: string };
    Querystring: { confirm?: string };
  }>("/tenants/:slug/manifest-import", async (req, reply) => {
    const auth = requirePermission(req, "workflows.write");
    const slug = req.params.slug;
    if (auth.tenantSlug !== slug) {
      return reply.fail(
        "forbidden",
        "cannot import into another tenant's workflow",
        403,
      );
    }
    const parsed = ManifestImportBody.parse(req.body);
    // The `target` enum was widened to `["staging","production"]` for the
    // in-process sandbox deployer, which calls the validate/commit service
    // functions directly. Over HTTP, only a sandbox tenant may select the
    // staging lane; a real tenant asking for staging is rejected before any
    // pending session is created, so it cannot skip the production CodeAct
    // authorization gate keyed on `target === "production"`.
    if (parsed.target === "staging" && !isSandboxTenant(auth.tenantSlug)) {
      return reply.fail(
        "invalid_target",
        "staging deployments are not available for this tenant; use target=production",
        400,
      );
    }
    // Per review A4 the canonical confirm surface is `?confirm=1`. The
    // body field is still honoured for v1 wizard parity, but the query
    // string takes precedence when both are present.
    const confirmFromQuery =
      req.query?.confirm === "1" || req.query?.confirm === "true";
    const confirmOverwrite =
      confirmFromQuery || parsed.confirm_overwrite === true;
    const ctx = { tenantId: auth.tenantId, tenantSlug: auth.tenantSlug };
    const audit = auditCtxFor(req);

    if (parsed.mode === "validate") {
      try {
        const preview = await withTenantWorkflowMutationLease({
          tenantId: auth.tenantId,
          kind: "manifest_import_validate",
          workId: parsed.deployment_id ?? null,
          fn: async (lease) => {
            lease.assertOwned();
            const value = await validate(parsed, ctx, audit);
            lease.assertOwned();
            return value;
          },
        });
        return reply.ok(preview);
      } catch (err) {
        if (err instanceof PendingImportConflictError) {
          // 423 LOCKED — another import is in flight. Per review A2 the
          // in-flight identifier is the `dpl-` deployment id; the SPA
          // surfaces it as the "Resume or cancel" banner.
          return reply.status(423).send({
            ok: false,
            error: {
              code: "pending_import",
              message:
                "another manifest import is already in flight for this tenant",
              hint: `deployment_id=${err.deploymentId}`,
            },
            deployment_id: err.deploymentId,
            // Backwards-compat alias for the SPA's legacy `in_flight_session_id` field.
            in_flight_session_id: err.deploymentId,
          });
        }
        if (err instanceof InvalidPendingImportError) {
          return reply.fail(
            `pending_import_${err.reason}`,
            "pending import is no longer active; validate again without the stale deployment id",
            err.reason === "not_found" ? 404 : 409,
          );
        }
        if (err instanceof BlockingIssuesError) {
          return reply.status(400).send({
            ok: false,
            error: {
              code: "blocking_issues",
              message:
                "validation refused — credentials must use valid secret references",
              hint: err.issues
                .slice(0, 6)
                .map((issue) => `${issue.path}: ${issue.message}`)
                .join("; "),
            },
            issues: err.issues,
          });
        }
        throw err;
      }
    }

    // commit
    try {
      const out = await withTenantWorkflowMutationLease({
        tenantId: auth.tenantId,
        kind: "manifest_import_commit",
        workId: parsed.deployment_id ?? null,
        fn: async (lease) => {
          lease.assertOwned();
          const value = await commit(
            { ...parsed, confirm_overwrite: confirmOverwrite },
            ctx,
            audit,
          );
          lease.assertOwned();
          return value;
        },
      });
      return reply.ok(out);
    } catch (err) {
      if (err instanceof OverwriteRequiredError) {
        return reply.status(409).send(err.payload);
      }
      if (err instanceof BlockingIssuesError) {
        return reply.status(400).send({
          ok: false,
          error: {
            code: "blocking_issues",
            message: "commit refused — fix the listed issues and re-validate",
            hint: err.issues
              .slice(0, 6)
              .map((i) => `${i.path}: ${i.message}`)
              .join("; "),
          },
          issues: err.issues,
        });
      }
      if (err instanceof InvalidPendingImportError) {
        const status = err.reason === "not_found" ? 404 : 409;
        return reply.fail(
          `pending_import_${err.reason}`,
          err.reason === "workflow_mismatch"
            ? "pending import belongs to a different workflow"
            : err.reason === "expired"
              ? "pending import has expired; validate again"
              : "pending import not found",
          status,
        );
      }
      throw err;
    }
  });

  // ----------------------------------------------------- DELETE cancel hook
  // Per review C5: manually release the pending lock when an operator
  // abandons a wizard mid-flow. Without this the 1-hour TTL gates further
  // imports for an hour. Requires the same tenant auth.
  app.delete<{ Params: { slug: string; deployment_id: string } }>(
    "/tenants/:slug/manifest-import/:deployment_id",
    async (req, reply) => {
      const auth = requirePermission(req, "workflows.write");
      const slug = req.params.slug;
      if (auth.tenantSlug !== slug) {
        return reply.fail(
          "forbidden",
          "cannot cancel another tenant's import",
          403,
        );
      }
      const ctx = { tenantId: auth.tenantId, tenantSlug: auth.tenantSlug };
      try {
        const out = await withTenantWorkflowMutationLease({
          tenantId: auth.tenantId,
          kind: "manifest_import_cancel",
          workId: req.params.deployment_id,
          fn: async (lease) => {
            lease.assertOwned();
            const value = await cancel(
              req.params.deployment_id,
              ctx,
              auditCtxFor(req),
            );
            lease.assertOwned();
            return value;
          },
        });
        return reply.ok(out);
      } catch (err) {
        const code = (err as Error).message;
        if (code === "not_found") {
          return reply.fail("not_found", "pending import not found", 404);
        }
        if (code === "forbidden") {
          return reply.fail(
            "forbidden",
            "cannot cancel another tenant's import",
            403,
          );
        }
        if (code === "not_pending") {
          return reply.fail(
            "not_pending",
            "deployment is not pending; cannot cancel",
            409,
          );
        }
        throw err;
      }
    },
  );

  // ------------------------------------------------------- fetch-url helper
  app.post<{
    Params: { slug: string };
    Body: { url?: string };
  }>("/tenants/:slug/manifest-import/fetch-url", async (req, reply) => {
    const auth = requirePermission(req, "workflows.write");
    const slug = req.params.slug;
    if (auth.tenantSlug !== slug) {
      return reply.fail(
        "forbidden",
        "cannot import into another tenant's workflow",
        403,
      );
    }
    const url = typeof req.body?.url === "string" ? req.body.url.trim() : "";
    if (!url) {
      return reply.fail("bad_request", "body.url is required", 400);
    }
    // Per review S1 (BLOCKER): assertSafeOutboundUrl + manual-redirect +
    // streaming body cap lives in `services/ssrf-guard.ts`. The route just
    // maps SsrfError → 400 (or 502 for upstream issues).
    let fetched;
    try {
      fetched = await safeFetch(url, {
        maxBytes: FETCH_URL_MAX_BYTES,
        allowedContentTypes: FETCH_URL_ALLOW_CONTENT_TYPES,
        headers: { accept: "application/json, text/plain" },
      });
    } catch (err) {
      if (err instanceof SsrfError) {
        // Audit policy decisions — never silently drop attempts to fetch
        // private targets.
        writeAudit({
          tenantId: auth.tenantId,
          actorUserId: auth.userId ?? undefined,
          action: "manifest.import.fetch_url.blocked",
          targetType: "url",
          targetId: redactManifestImportUrlForAudit(url),
          meta: { code: err.code, message: err.message },
        });
        // 400 for policy violations; 504 for timeouts.
        const status = err.code === "timeout" ? 504 : 400;
        return reply.status(status).send({
          ok: false,
          error: { code: err.code, message: err.message },
        });
      }
      const m = (err as Error).message;
      const upstream = m.match(/^upstream_status_(\d+)$/);
      if (upstream) {
        return reply.fail(
          "fetch_failed",
          `upstream returned ${upstream[1]}`,
          502,
        );
      }
      if (m.startsWith("content_type_not_allowed")) {
        return reply.fail("fetch_failed", m, 415);
      }
      return reply.fail("fetch_failed", `fetch failed: ${m}`, 502);
    }
    let json: unknown;
    try {
      json = JSON.parse(fetched.body.toString("utf8"));
    } catch (err) {
      return reply.fail(
        "bad_json",
        `upstream payload is not valid JSON: ${(err as Error).message}`,
        400,
      );
    }
    // Convention: the upstream MAY return either a bare workflow (array or
    // v2 wrapper) or `{ workflow, actions? }`. Normalize both shapes.
    return reply.ok(normalizeFetchedManifest(json));
  });

  // -------------------------------------------------------- fetch-repo
  // Public repositories are fetched through the same DNS/redirect/size SSRF
  // guard as fetch-url. We intentionally do not shell out to `git`, accept
  // credentials in URLs, or clone arbitrary code onto the API host.
  app.post<{
    Params: { slug: string };
    Body: { repository?: string; ref?: string; path?: string };
  }>("/tenants/:slug/manifest-import/fetch-repo", async (req, reply) => {
    const auth = requirePermission(req, "workflows.write");
    const slug = req.params.slug;
    if (auth.tenantSlug !== slug) {
      return reply.fail(
        "forbidden",
        "cannot import into another tenant's workflow",
        403,
      );
    }
    const repository = String(req.body?.repository ?? "").trim();
    const ref = String(req.body?.ref ?? "").trim();
    const manifestPath = String(req.body?.path ?? "").trim();
    if (!repository || !ref || !manifestPath) {
      return reply.fail(
        "bad_request",
        "repository, ref and path are required",
        400,
      );
    }
    let rawUrl: string;
    try {
      rawUrl = publicRepoRawUrl(repository, ref, manifestPath);
    } catch (err) {
      return reply.fail("bad_request", (err as Error).message, 400);
    }
    try {
      const fetched = await safeFetch(rawUrl, {
        maxBytes: FETCH_URL_MAX_BYTES,
        allowedContentTypes: FETCH_URL_ALLOW_CONTENT_TYPES,
        headers: { accept: "application/json, text/plain" },
      });
      const json = JSON.parse(fetched.body.toString("utf8")) as unknown;
      writeAudit({
        tenantId: auth.tenantId,
        actorUserId: auth.userId ?? undefined,
        action: "manifest.import.fetch_repo",
        targetType: "repository",
        targetId: repository.slice(0, 200),
        meta: {
          ref,
          path: manifestPath,
          finalUrl: fetched.finalUrl.toString(),
        },
      });
      return reply.ok({
        ...normalizeFetchedManifest(json),
        source: { repository, ref, path: manifestPath },
      });
    } catch (err) {
      if (err instanceof SsrfError) {
        return reply.fail(
          err.code,
          err.message,
          err.code === "timeout" ? 504 : 400,
        );
      }
      const message = (err as Error).message;
      if (message.startsWith("upstream_status_")) {
        return reply.fail("fetch_failed", message, 502);
      }
      if (message.startsWith("content_type_not_allowed")) {
        return reply.fail("fetch_failed", message, 415);
      }
      if (err instanceof SyntaxError) {
        return reply.fail(
          "bad_json",
          `repository manifest is not valid JSON: ${message}`,
          400,
        );
      }
      return reply.fail("fetch_failed", message, 502);
    }
  });
}
