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
 *   - POST   /v1/tenants/:slug/manifest-import/fetch-repo            → 501 (still auth'd)
 *   - DELETE /v1/tenants/:slug/manifest-import/:deployment_id        → 200 (release pending lock)
 *
 * `fetch-url` is SSRF-guarded via `services/ssrf-guard.ts` (review S1). All
 * endpoints run `requireAuth` BEFORE any body parse and assert
 * `auth.tenantSlug === req.params.slug` — even the 501 stub still auths so
 * tenant existence doesn't leak.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { ManifestImportBody } from "@agentic/contracts";
import { requireAuth } from "../../plugins/auth";
import { requirePermission } from "../../plugins/rbac";
import { writeAudit } from "../../plugins/audit";
import {
  validate,
  commit,
  cancel,
  OverwriteRequiredError,
  BlockingIssuesError,
  PendingImportConflictError,
  type AuditCtx,
} from "../../services/manifest-import";
import { safeFetch, SsrfError } from "../../services/ssrf-guard";

const FETCH_URL_MAX_BYTES = Number(
  process.env.AGENTIC_FETCH_URL_MAX_BYTES ?? String(5 * 1024 * 1024),
);
const FETCH_URL_ALLOW_CONTENT_TYPES = new Set([
  "application/json",
  "text/plain",
  "application/octet-stream",
]);

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

export async function manifestImportRoutes(app: FastifyInstance) {
  // -------------------------------------------------------------- main route
  app.post<{
    Params: { slug: string };
    Querystring: { confirm?: string };
  }>(
    "/tenants/:slug/manifest-import",
    async (req, reply) => {
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
      // Per review A4 the canonical confirm surface is `?confirm=1`. The
      // body field is still honoured for v1 wizard parity, but the query
      // string takes precedence when both are present.
      const confirmFromQuery = req.query?.confirm === "1" || req.query?.confirm === "true";
      const confirmOverwrite = confirmFromQuery || parsed.confirm_overwrite === true;
      const ctx = { tenantId: auth.tenantId, tenantSlug: auth.tenantSlug };
      const audit = auditCtxFor(req);

      if (parsed.mode === "validate") {
        try {
          const preview = await validate(parsed, ctx, audit);
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
          throw err;
        }
      }

      // commit
      try {
        const out = await commit({ ...parsed, confirm_overwrite: confirmOverwrite }, ctx, audit);
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
              message:
                "commit refused — fix the listed issues and re-validate",
              hint: err.issues
                .slice(0, 6)
                .map((i) => `${i.path}: ${i.message}`)
                .join("; "),
            },
            issues: err.issues,
          });
        }
        throw err;
      }
    },
  );

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
        const out = await cancel(req.params.deployment_id, ctx, auditCtxFor(req));
        return reply.ok(out);
      } catch (err) {
        const code = (err as Error).message;
        if (code === "not_found") {
          return reply.fail("not_found", "pending import not found", 404);
        }
        if (code === "forbidden") {
          return reply.fail("forbidden", "cannot cancel another tenant's import", 403);
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
  }>(
    "/tenants/:slug/manifest-import/fetch-url",
    async (req, reply) => {
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
          try {
            writeAudit({
              tenantId: auth.tenantId,
              action: "manifest.import.fetch_url.blocked",
              targetType: "url",
              targetId: url.slice(0, 200),
              meta: { code: err.code, message: err.message },
            });
          } catch {
            /* audit best-effort */
          }
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
      if (
        json &&
        typeof json === "object" &&
        !Array.isArray(json) &&
        "workflow" in (json as Record<string, unknown>)
      ) {
        const obj = json as { workflow: unknown; actions?: unknown[] };
        return reply.ok({
          workflow: obj.workflow,
          actions: Array.isArray(obj.actions) ? obj.actions : undefined,
        });
      }
      return reply.ok({ workflow: json });
    },
  );

  // -------------------------------------------------------- fetch-repo stub
  // PRD: v1 ships the stub at 501; SPA shows "coming soon" banner. The auth
  // check runs BEFORE the 501 so the slug existence doesn't leak via
  // differential response timing.
  app.post<{ Params: { slug: string } }>(
    "/tenants/:slug/manifest-import/fetch-repo",
    async (req, reply) => {
      const auth = requirePermission(req, "workflows.write");
      const slug = req.params.slug;
      if (auth.tenantSlug !== slug) {
        return reply.fail(
          "forbidden",
          "cannot import into another tenant's workflow",
          403,
        );
      }
      return reply
        .status(501)
        .send({
          ok: false,
          error: {
            code: "not_implemented",
            message:
              "git-repo fetch is not available in v1; paste the manifest or upload a file",
          },
        });
    },
  );
}
