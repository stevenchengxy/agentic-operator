import { z } from "zod";
import { defineTool } from "@agentic/agent-kit";
import { type RaasPgSession, withRaasPgConnection } from "./raas-pg";
import { profileEnvironmentValue } from "./profile-config";

const text = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function bareEventName(value: string | undefined): string {
  return (value ?? "").split("/").filter(Boolean).at(-1) ?? "";
}

function isJobRequisitionEntityType(value: unknown): boolean {
  return (
    text(value)
      .replace(/[_\s-]+/g, "")
      .toLowerCase() === "jobrequisition"
  );
}

export function resolveRaasRequirementAnchors(args: {
  eventName?: string;
  previous?: Record<string, unknown>;
  incoming?: Record<string, unknown>;
  subject?: string;
}): { jobRequisitionId: string; jobPostingId: string } {
  const previous = args.previous ?? {};
  const incoming = args.incoming ?? {};
  const explicitRequisition =
    text(previous.job_requisition_id) ||
    text(incoming.job_requisition_id) ||
    text(previous.requirement_id) ||
    text(incoming.requirement_id);
  const explicitPosting =
    text(previous.job_posting_id) || text(incoming.job_posting_id);
  if (explicitRequisition || explicitPosting) {
    return {
      jobRequisitionId: explicitRequisition,
      jobPostingId: explicitPosting,
    };
  }

  const eventName = bareEventName(args.eventName);
  const entityId =
    text(previous.entity_id) || text(incoming.entity_id) || text(args.subject);
  if (!entityId) return { jobRequisitionId: "", jobPostingId: "" };
  if (
    eventName === "REQUIREMENT_LOGGED" ||
    eventName === "CLARIFICATION_READY"
  ) {
    return { jobRequisitionId: entityId, jobPostingId: "" };
  }
  if (eventName === "JD_REJECTED") {
    const raas = record(previous.__raas ?? incoming.__raas);
    return isJobRequisitionEntityType(raas.entity_type)
      ? { jobRequisitionId: entityId, jobPostingId: "" }
      : { jobRequisitionId: "", jobPostingId: entityId };
  }
  return { jobRequisitionId: "", jobPostingId: "" };
}

export async function loadRaasRequirementSnapshot(
  client: RaasPgSession,
  jobRequisitionId: string,
): Promise<Record<string, unknown>> {
  const detail = await client.query<{
    requirement_json: Record<string, unknown>;
    specification_json: Record<string, unknown> | null;
  }>(
    `SELECT row_to_json(r.*) AS requirement_json,
            row_to_json(s.*) AS specification_json
       FROM job_requisition r
       LEFT JOIN job_requisition_specification s
         ON s.job_requisition_specification_id = r.job_requisition_specification_id
      WHERE r.job_requisition_id = $1
      LIMIT 1`,
    [jobRequisitionId],
  );
  const row = detail.rows[0];
  if (!row) {
    throw new Error(
      `loadRaasRequirement: job_requisition '${jobRequisitionId}' does not exist`,
    );
  }

  let clarifications: Record<string, unknown>[] = [];
  try {
    const result = await client.query<Record<string, unknown>>(
      `SELECT clarified_at, content, clarifier_name,
              client_clarifier_name, clarification_type
         FROM requirement_clarification_record
        WHERE job_requisition_id = $1
        ORDER BY clarified_at ASC`,
      [jobRequisitionId],
    );
    clarifications = result.rows.filter((item) => text(item.content));
  } catch {
    // Clarifications enhance the requirement but are not the source record.
    // The authoritative JR must still be usable if this optional table is
    // temporarily unavailable or absent on an older partner schema.
  }

  const requirement = record(row.requirement_json);
  return {
    ...requirement,
    job_requisition_id: jobRequisitionId,
    requirement,
    specification: row.specification_json ?? null,
    clarifications,
    requirement_source: "raas-postgres",
  };
}

export async function resolveRaasRequisitionFromPosting(
  client: RaasPgSession,
  jobPostingId: string,
): Promise<string> {
  const result = await client.query<{ job_requisition_id: string }>(
    `SELECT r.job_requisition_id
       FROM job_requisition r
       LEFT JOIN job_posting p
         ON p.job_requisition_id = r.job_requisition_id
      WHERE p.job_posting_id = $1
         OR r.job_requisition_id = $1
      ORDER BY CASE WHEN p.job_posting_id = $1 THEN 0 ELSE 1 END
      LIMIT 1`,
    [jobPostingId],
  );
  const jobRequisitionId = text(result.rows[0]?.job_requisition_id);
  if (!jobRequisitionId) {
    throw new Error(
      `loadRaasRequirement: job_posting '${jobPostingId}' does not map to a job_requisition`,
    );
  }
  return jobRequisitionId;
}

export const loadRaasRequirement = defineTool({
  name: "loadRaasRequirement",
  description:
    "Load the authoritative job_requisition, specification and clarification records from partner Postgres before generating a JD.",
  factory: {
    category: "raas-data",
    sideEffect: "read",
    operation: "read",
    effectScope: "external",
    sandboxPolicy: "live_external",
    configSchema: {
      tenant_slug: {
        type: "string",
        required: true,
        description:
          "Authenticated tenant slug confirmed by the integration profile.",
      },
      postgres_url_env: {
        type: "string",
        required: true,
        description:
          "Server env name containing the RAAS PostgreSQL URL; literal URLs are forbidden.",
      },
    },
    capabilities: [
      {
        systems: ["RAAS_System"],
        kinds: ["database"],
        roles: ["read", "reads"],
        operations: ["requirement.load", "load", "read"],
        objectTypes: [
          "Job_Requisition",
          "Job_Requisition_Specification",
          "Requirement_Clarification_Record",
        ],
        probeRequired: true,
      },
    ],
    profileScope: {
      exact: [{ configKey: "tenant_slug", source: "tenantSlug" }],
    },
    source: {
      modulePath:
        "packages/recruitment-capabilities/src/tools/raas-requirement.ts",
      exportName: "loadRaasRequirement",
    },
  },
  output: z.record(z.string(), z.unknown()),
  async handler(ctx) {
    const previous = record(ctx.lastResult);
    const incoming = record(ctx.event?.data);
    const { jobRequisitionId: suppliedJobRequisitionId, jobPostingId } =
      resolveRaasRequirementAnchors({
        eventName: ctx.event?.name,
        previous,
        incoming,
        subject: ctx.subject,
      });
    if (!suppliedJobRequisitionId && !jobPostingId) {
      throw new Error(
        "loadRaasRequirement: job_requisition_id or job_posting_id is required",
      );
    }
    const connectionString = profileEnvironmentValue(ctx, "postgres_url_env", {
      label: "loadRaasRequirement",
    });
    const snapshot = await withRaasPgConnection(
      connectionString,
      async (client) => {
        const jobRequisitionId =
          suppliedJobRequisitionId ||
          (await resolveRaasRequisitionFromPosting(client, jobPostingId));
        const loaded = await loadRaasRequirementSnapshot(
          client,
          jobRequisitionId,
        );
        return jobPostingId
          ? { ...loaded, rejected_job_posting_id: jobPostingId }
          : loaded;
      },
    );
    return { data: snapshot };
  },
});
