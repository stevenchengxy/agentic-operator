import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  AgentArchetypeListResponse,
  AgentNameAvailabilityQuery,
  AgentNameAvailabilityResponse,
  DeployAuthoredAgentBody,
  DeployAuthoredAgentResponse,
  GenerateAgentPromptBody,
  GenerateAgentPromptResponse,
} from "@agentic/contracts";
import { isLLMError } from "@agentic/llm-gateway";
import { requireAuth } from "../../plugins/auth";
import { writeAudit } from "../../plugins/audit";
import {
  AuthoredAgentPersistenceError,
  AuthoredAgentRuntimeError,
  deployAuthoredAgent,
  DuplicateAuthoredAgentError,
  generateAgentSystemPrompt,
  getAuthoredAgentNameAvailability,
  InvalidAuthoredToolError,
} from "../../services/agent-authoring";
import {
  BlockingIssuesError,
  OverwriteRequiredError,
  type AuditCtx,
} from "../../services/manifest-import";
import { AGENT_ARCHETYPE_SPECS } from "../../services/agent-archetypes";

function auditCtxFor(req: FastifyRequest): AuditCtx {
  return {
    log: {
      error: (obj, msg) => req.log.error(obj, msg ?? ""),
      info: (obj, msg) => req.log.info(obj, msg ?? ""),
    },
  };
}

function llmStatus(code: string): number {
  switch (code) {
    case "auth":
      return 401;
    case "rate_limit":
      return 429;
    case "timeout":
      return 504;
    case "model_not_found":
    case "bad_request":
      return 400;
    case "not_configured":
      return 503;
    default:
      return 502;
  }
}

export async function agentAuthoringRoutes(
  app: FastifyInstance,
): Promise<void> {
  app.get("/agents/archetypes", async (req, reply) => {
    requireAuth(req);
    return reply.ok(
      AgentArchetypeListResponse.parse({ archetypes: AGENT_ARCHETYPE_SPECS }),
    );
  });

  app.get("/agents/availability", async (req, reply) => {
    const auth = requireAuth(req);
    const { name } = AgentNameAvailabilityQuery.parse(req.query);
    reply.header("Cache-Control", "no-store");
    return reply.ok(
      AgentNameAvailabilityResponse.parse(
        getAuthoredAgentNameAvailability(name, auth),
      ),
    );
  });

  app.post("/agents/system-prompt", async (req, reply) => {
    const auth = requireAuth(req);
    const body = GenerateAgentPromptBody.parse(req.body);
    try {
      const result = GenerateAgentPromptResponse.parse(
        await generateAgentSystemPrompt(body, auth),
      );
      writeAudit({
        tenantId: auth.tenantId,
        action: "agent.prompt.generate",
        targetType: "agent_draft",
        targetId: body.name,
        meta: {
          provider: result.provider,
          model: result.model,
          tokens_in: result.tokensIn,
          tokens_out: result.tokensOut,
          description_chars: body.description.length,
          prompt_chars: result.systemPrompt.length,
        },
      });
      return reply.ok(result);
    } catch (err) {
      if (isLLMError(err)) {
        return reply.fail(err.code, err.message, llmStatus(err.code));
      }
      if ((err as Error).message.startsWith("prompt_generation_empty:")) {
        return reply.fail("empty_generation", (err as Error).message, 502);
      }
      if ((err as Error).message.startsWith("model_selection_unavailable:")) {
        return reply.fail(
          "model_selection_unavailable",
          (err as Error).message,
          400,
        );
      }
      throw err;
    }
  });

  app.post("/agents/deploy", async (req, reply) => {
    const auth = requireAuth(req);
    const body = DeployAuthoredAgentBody.parse(req.body);
    try {
      const result = DeployAuthoredAgentResponse.parse(
        await deployAuthoredAgent(body, auth, auditCtxFor(req)),
      );
      return reply.ok(result, 201);
    } catch (err) {
      if (err instanceof DuplicateAuthoredAgentError) {
        return reply.fail(
          "agent_conflict",
          `An agent with this ${err.field} already exists: ${err.value}`,
          409,
        );
      }
      if (err instanceof InvalidAuthoredToolError) {
        return reply.fail("invalid_tool_binding", err.message, 400);
      }
      if (err instanceof BlockingIssuesError) {
        return reply.fail(
          "invalid_agent_manifest",
          "The generated agent manifest failed runtime validation",
          400,
          err.issues
            .slice(0, 6)
            .map((issue) => `${issue.path}: ${issue.message}`)
            .join("; "),
        );
      }
      if (err instanceof OverwriteRequiredError) {
        return reply.fail(
          "overwrite_required",
          "Deploying this agent would unexpectedly replace live workflow content",
          409,
        );
      }
      if (err instanceof AuthoredAgentPersistenceError) {
        return reply.fail("manifest_not_saved", err.message, 500);
      }
      if (err instanceof AuthoredAgentRuntimeError) {
        return reply.fail(
          "runtime_not_loaded",
          err.message,
          503,
          "The manifest is persisted; retry deployment or restart the API to reconcile the live registry.",
        );
      }
      if ((err as Error).message.startsWith("duplicate_tool:")) {
        return reply.fail("duplicate_tool", (err as Error).message, 400);
      }
      if ((err as Error).message.startsWith("model_selection_unavailable:")) {
        return reply.fail(
          "model_selection_unavailable",
          (err as Error).message,
          400,
        );
      }
      throw err;
    }
  });
}
