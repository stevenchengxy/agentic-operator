import path from "node:path";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentMemoryLong, and, eq, getDb, tenants } from "@agentic/db";
import raasRegistry from "@tenants/raas";
import zhaopinRegistry, {
  persistRaasExternal,
  stableUuid,
} from "@tenants/zhaopin";
import { candidateDedupLookup as raasDedup } from "../../../tenants/raas/src/tools/candidate-dedup";
import { routeInterviewInvitation as routeRaasInvitation } from "../../../tenants/raas/src/tools/route-interview-invitation";
import { candidateDedupLookup as zhaopinDedup } from "../../../tenants/zhaopin/src/tools/candidate-dedup";
import {
  loadJd,
  persistJdTool,
} from "../../../tenants/zhaopin/src/tools/jd-store";
import { routeInterviewInvitation as routeZhaopinInvitation } from "../../../tenants/zhaopin/src/tools/route-interview-invitation";
import { routeResumeProcessed } from "../../../tenants/zhaopin/src/tools/route-resume-processed";

const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const tenantId = `ten-realness-${suffix}`;
const tenantSlug = `realness-${suffix}`;
const unknownTenant = `missing-${suffix}`;

function toolContext(args: {
  tenantSlug?: string;
  actionName: string;
  lastResult?: unknown;
  eventData?: Record<string, unknown>;
}) {
  return {
    agentName: "tenantRealnessTest",
    actionName: args.actionName,
    correlationId: `cor-${suffix}`,
    tenantSlug: args.tenantSlug ?? tenantSlug,
    lastResult: args.lastResult,
    event: {
      name: "TEST_EVENT",
      data: args.eventData ?? {},
    },
  };
}

describe("tenant business tools fail closed instead of fabricating success", () => {
  beforeAll(() => {
    const now = new Date();
    getDb()
      .insert(tenants)
      .values({
        id: tenantId,
        slug: tenantSlug,
        name: "Tenant realness test",
        createdAt: now,
        updatedAt: now,
      })
      .run();
  });

  afterAll(() => {
    getDb().delete(tenants).where(eq(tenants.id, tenantId)).run();
  });

  it("never turns an unknown tenant into a new candidate", async () => {
    for (const tool of [raasDedup, zhaopinDedup]) {
      await expect(
        tool.handler(
          toolContext({
            tenantSlug: unknownTenant,
            actionName: "candidateDedupLookup",
            lastResult: {
              name: "真实候选人",
              phone: "13800138000",
              email: "real@example.com",
            },
          }),
        ),
      ).rejects.toThrow(/unknown tenant/);
    }
  });

  it("rejects unidentifiable candidates instead of minting an id", async () => {
    for (const tool of [raasDedup, zhaopinDedup]) {
      await expect(
        tool.handler(
          toolContext({
            actionName: "candidateDedupLookup",
            lastResult: { parsed: true },
          }),
        ),
      ).rejects.toThrow(/no usable name, phone, or email/);
    }
  });

  it("returns a new candidate id only after every identity index is durable", async () => {
    const numeric = String(Date.now()).slice(-8);
    const identity = {
      name: `候选人-${suffix}`,
      phone: `139${numeric}`,
      email: `${suffix}@example.com`,
    };
    const first = await raasDedup.handler(
      toolContext({
        actionName: "candidateDedupLookup",
        lastResult: identity,
      }),
    );
    expect(first.data).toMatchObject({ is_new: true });
    const candidateId = String(first.data.candidate_id);
    expect(candidateId).toMatch(/^cand-[a-f0-9]{12}$/);

    const rows = getDb()
      .select({ key: agentMemoryLong.key, value: agentMemoryLong.valueJson })
      .from(agentMemoryLong)
      .where(
        and(
          eq(agentMemoryLong.tenantId, tenantId),
          eq(agentMemoryLong.agentName, "candidateDedupLookup"),
          eq(agentMemoryLong.subject, "registry"),
        ),
      )
      .all();
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(JSON.parse(row.value)).toMatchObject({ candidateId });
    }

    const second = await raasDedup.handler(
      toolContext({
        actionName: "candidateDedupLookup",
        lastResult: identity,
      }),
    );
    expect(second.data).toMatchObject({
      candidate_id: candidateId,
      is_new: false,
      tier: "phone",
    });
  });

  it("rejects a corrupt dedup index rather than treating it as no match", async () => {
    const phone = `137${String(Date.now() + 1).slice(-8)}`;
    getDb()
      .insert(agentMemoryLong)
      .values({
        tenantId,
        agentName: "candidateDedupLookup",
        subject: "registry",
        key: `phone:${phone}`,
        valueJson: "{not-json",
      })
      .run();

    await expect(
      zhaopinDedup.handler(
        toolContext({
          actionName: "candidateDedupLookup",
          lastResult: { name: `损坏索引-${suffix}`, phone },
        }),
      ),
    ).rejects.toThrow(/corrupt registry row/);
  });

  it("persists only real generated JD content and reports success after the write", async () => {
    const jobRequisitionId = `JR-${suffix}`;
    const jdContent = `## ${suffix}\n真实模型生成的完整 JD`;
    const result = await persistJdTool.handler(
      toolContext({
        actionName: "persistJd",
        lastResult: {
          title: "高级工程师",
          jd_content: jdContent,
        },
        eventData: { job_requisition_id: jobRequisitionId },
      }),
    );
    expect(result.data).toEqual({
      jd_content: jdContent,
      job_posting_id: "",
      job_requisition_id: jobRequisitionId,
      title: "高级工程师",
      jd_persisted: true,
    });

    const row = getDb()
      .select({ value: agentMemoryLong.valueJson })
      .from(agentMemoryLong)
      .where(
        and(
          eq(agentMemoryLong.tenantId, tenantId),
          eq(agentMemoryLong.agentName, "recruitmentJdStore"),
          eq(agentMemoryLong.subject, "registry"),
          eq(agentMemoryLong.key, `jd:${jobRequisitionId}`),
        ),
      )
      .all()[0];
    expect(row).toBeDefined();
    expect(JSON.parse(row!.value)).toMatchObject({
      job_requisition_id: jobRequisitionId,
      jd_content: jdContent,
    });
    expect(
      loadJd(toolContext({ actionName: "loadJd" }), jobRequisitionId),
    ).toBe(jdContent);
  });

  it("rejects missing JD fields and unknown tenant storage", async () => {
    await expect(
      persistJdTool.handler(
        toolContext({
          actionName: "persistJd",
          lastResult: { title: "不能拿标题拼占位 JD" },
          eventData: {
            job_requisition_id: `JR-missing-content-${suffix}`,
            requirements: "也不能拿需求字段拼接",
          },
        }),
      ),
    ).rejects.toThrow(/generated jd_content is required/);

    await expect(
      persistJdTool.handler(
        toolContext({
          actionName: "persistJd",
          lastResult: { jd_content: "有正文但没有真实需求 id" },
        }),
      ),
    ).rejects.toThrow(/job_requisition_id is required/);

    await expect(
      persistJdTool.handler(
        toolContext({
          tenantSlug: unknownTenant,
          actionName: "persistJd",
          lastResult: { jd_content: "正文" },
          eventData: { job_requisition_id: `JR-unknown-${suffix}` },
        }),
      ),
    ).rejects.toThrow(/unknown tenant/);

    expect(() =>
      loadJd(
        toolContext({ actionName: "loadJd" }),
        `JR-not-persisted-${suffix}`,
      ),
    ).toThrow(/no persisted JD/);
  });

  it("derives each resume id from a real file identity instead of candidate_id", async () => {
    const routed = await routeResumeProcessed.handler(
      toolContext({
        actionName: "routeResumeProcessed",
        lastResult: {
          candidate_id: `C-${suffix}`,
          resume: "real parsed resume",
          job_requisition_id: `JR-${suffix}`,
        },
        eventData: { jd: "real JD" },
      }),
    );
    expect(routed.data.resume_id).toBe("");

    const objectKey = `resumes/${suffix}/candidate.pdf`;
    const receipt = await persistRaasExternal({
      tenantSlug: "zhaopin",
      phase: "candidate_resume",
      snapshot: {
        candidate_id: `C-${suffix}`,
        object_key: objectKey,
      },
      env: {},
    });
    expect(receipt.ids.resume_id).toBe(
      stableUuid(`zhaopin:resume:C-${suffix}:${objectKey}`),
    );

    await expect(
      persistRaasExternal({
        tenantSlug: "zhaopin",
        phase: "candidate_resume",
        snapshot: { candidate_id: `C-${suffix}` },
        env: {},
      }),
    ).rejects.toThrow(/resume identity/);
  });

  it("routes recruiter lock conflicts without requiring a JD", async () => {
    const routed = await routeResumeProcessed.handler(
      toolContext({
        actionName: "routeResumeProcessed",
        lastResult: {
          candidate_id: `C-locked-${suffix}`,
          lock_conflict: true,
        },
      }),
    );
    expect(routed.data).toMatchObject({
      _emit: "RESUME_LOCKED_CONFLICT",
      candidate_id: `C-locked-${suffix}`,
      lock_conflict: true,
      jd: "",
    });
  });

  it("fans a pre-filtered requisition list out with the correct persisted JD per job", async () => {
    const jr1 = `JR-fanout-a-${suffix}`;
    const jr2 = `JR-fanout-b-${suffix}`;
    for (const [jobRequisitionId, jdContent] of [
      [jr1, "JD A"],
      [jr2, "JD B"],
    ]) {
      await persistJdTool.handler(
        toolContext({
          actionName: "persistJd",
          lastResult: { title: jobRequisitionId, jd_content: jdContent },
          eventData: { job_requisition_id: jobRequisitionId },
        }),
      );
    }

    const routed = await routeResumeProcessed.handler(
      toolContext({
        actionName: "routeResumeProcessed",
        lastResult: {
          candidate_id: `C-fanout-${suffix}`,
          resume: "parsed resume",
          job_requisition_ids: [jr1, jr2, jr1, ""],
        },
      }),
    );

    expect(routed.data._emits).toEqual([
      {
        event: "RESUME_PROCESSED",
        payload: expect.objectContaining({
          job_requisition_id: jr1,
          jd: "JD A",
        }),
      },
      {
        event: "RESUME_PROCESSED",
        payload: expect.objectContaining({
          job_requisition_id: jr2,
          jd: "JD B",
        }),
      },
    ]);
  });
});

describe("interview invitations use one real sender and deterministic routing", () => {
  it("removes the obsolete second email sender from both live registries", () => {
    expect(raasRegistry.tools?.sendInvitationEmail).toBeUndefined();
    expect(zhaopinRegistry.tools?.sendInvitationEmail).toBeUndefined();
    expect(raasRegistry.tools?.routeInterviewInvitation).toBeDefined();
    expect(zhaopinRegistry.tools?.routeInterviewInvitation).toBeDefined();
  });

  it("RAAS live workflow sends once, persists the receipt, then routes", () => {
    const modelsRoot =
      process.env.AGENTIC_MODELS_DIR ??
      path.resolve(process.cwd(), "../../models");
    const manifest = JSON.parse(
      readFileSync(
        path.join(modelsRoot, "RAAS-v1", "workflow_v5.json"),
        "utf8",
      ),
    ) as Array<{
      name: string;
      actions: Array<{ name: string }>;
      triggered_event: string[];
      tool_use?: Array<{ name: string }>;
    }>;
    const invite = manifest.find(
      (agent) => agent.name === "inviteInternalInterview",
    );
    expect(invite).toBeDefined();
    expect(invite!.actions.map((action) => action.name)).toEqual([
      "inviteCandidateApi",
      "records.upsert",
      "routeInterviewInvitation",
    ]);
    expect(invite!.triggered_event).toEqual([
      "INTERVIEW_INVITATION_SENT",
      "INTERVIEW_INVITATION_FAILED",
    ]);
    expect(invite!.tool_use?.map((entry) => entry.name)).toEqual([
      "inviteCandidateApi",
      "records.upsert",
      "routeInterviewInvitation",
    ]);
  });

  it("routes SENT only for explicit success:true and fails closed otherwise", async () => {
    for (const route of [routeRaasInvitation, routeZhaopinInvitation]) {
      const sent = await route.handler(
        toolContext({
          actionName: "routeInterviewInvitation",
          lastResult: {
            success: true,
            login_url: "https://robohire.example/interview/receipt",
            _record: { upserted: true },
          },
        }),
      );
      expect(sent.data).toMatchObject({
        _emit: "INTERVIEW_INVITATION_SENT",
        invitation_sent: true,
      });

      for (const receipt of [
        { success: false },
        {},
        { request_id: "no-success" },
      ]) {
        const failed = await route.handler(
          toolContext({
            actionName: "routeInterviewInvitation",
            lastResult: receipt,
          }),
        );
        expect(failed.data).toMatchObject({
          _emit: "INTERVIEW_INVITATION_FAILED",
          invitation_sent: false,
        });
      }
    }
  });
});
