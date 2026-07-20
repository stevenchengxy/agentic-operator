import type { FastifyInstance } from "fastify";
import { requirePermission } from "../../plugins/rbac";
import { writeAudit } from "../../plugins/audit";
import { getLiveDeployment, listDeployments } from "../../queries/deployments";
import {
  DeploymentRollbackAlreadyLiveError,
  DeploymentRollbackForbiddenError,
  DeploymentRollbackNotFoundError,
  DeploymentRollbackPendingImportError,
  DeploymentRollbackSourceError,
  rollbackDeployment,
} from "../../services/deployment-rollback";

export async function deploymentsRoutes(app: FastifyInstance) {
  // GET /v1/deployments — list history
  app.get("/deployments", async (req, reply) => {
    const auth = requirePermission(req, "deployments.read");
    const [list, live] = await Promise.all([
      listDeployments(auth.tenantSlug),
      getLiveDeployment(auth.tenantSlug),
    ]);
    return reply.ok({ list, live });
  });

  // POST /v1/deployments/:id/rollback
  app.post<{ Params: { id: string } }>(
    "/deployments/:id/rollback",
    async (req, reply) => {
      const auth = requirePermission(req, "deployments.write");
      let result: Awaited<ReturnType<typeof rollbackDeployment>>;
      try {
        result = await rollbackDeployment({
          deploymentId: req.params.id,
          tenantId: auth.tenantId,
          tenantSlug: auth.tenantSlug,
        });
      } catch (error) {
        if (error instanceof DeploymentRollbackNotFoundError) {
          return reply.fail("not_found", "deployment not found", 404);
        }
        if (error instanceof DeploymentRollbackForbiddenError) {
          return reply.fail("forbidden", "forbidden", 403);
        }
        if (error instanceof DeploymentRollbackSourceError) {
          return reply.fail("rollback_unavailable", error.message, 409);
        }
        if (error instanceof DeploymentRollbackPendingImportError) {
          return reply.fail(
            error.code,
            "当前还有尚未提交或取消的清单导入，请先处理它再回滚",
            error.statusCode,
            `deployment_id=${error.deploymentId}`,
          );
        }
        if (error instanceof DeploymentRollbackAlreadyLiveError) {
          return reply.fail(
            error.code,
            "这个版本已经在线，无需回滚",
            error.statusCode,
          );
        }
        req.log.error(
          { err: error, deployment_id: req.params.id },
          "deployment rollback failed; last-good recovery attempted",
        );
        writeAudit({
          tenantId: auth.tenantId,
          actorUserId: auth.userId ?? undefined,
          action: "deployment.rollback.failed",
          targetType: "deployment",
          targetId: req.params.id,
          meta: {
            error: String((error as Error)?.message ?? error).slice(0, 500),
          },
        });
        throw error;
      }

      writeAudit({
        tenantId: auth.tenantId,
        actorUserId: auth.userId ?? undefined,
        action: "deployment.rollback",
        targetType: "deployment",
        targetId: req.params.id,
        meta: {
          version_id: result.versionId,
          version: result.version,
          target: result.target,
          file_written: result.fileWritten,
          actions_file_written: result.actionsFileWritten,
          inngest_fns: result.inngestFunctions,
        },
      });

      return reply.ok({
        deployment_id: req.params.id,
        status: result.status,
        target: result.target,
        version: result.version,
        file_written: result.fileWritten,
        actions_file_written: result.actionsFileWritten,
        inngest_fns: result.inngestFunctions,
        note: "rollback is live and durable; runtime hot-swapped",
      });
    },
  );
}
