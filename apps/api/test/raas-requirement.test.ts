import { describe, expect, it } from "vitest";
import type { RaasPgSession } from "../../../tenants/zhaopin/src/tools/raas-pg";
import { loadRaasRequirementSnapshot } from "../../../tenants/zhaopin/src/tools/raas-requirement";
import { resolveRaasRequisitionFromPosting } from "../../../tenants/zhaopin/src/tools/raas-requirement";
import { resolveRaasRequirementAnchors } from "../../../tenants/zhaopin/src/tools/raas-requirement";
import { loadRaasJdSnapshot } from "../../../tenants/zhaopin/src/tools/jd-store";

describe("authoritative RAAS requirement loading", () => {
  it("resolves flat legacy entity anchors without confusing a rejected posting for a requisition", () => {
    expect(
      resolveRaasRequirementAnchors({
        eventName: "raas/REQUIREMENT_LOGGED",
        incoming: { entity_id: "JR-FLAT" },
      }),
    ).toEqual({ jobRequisitionId: "JR-FLAT", jobPostingId: "" });
    expect(
      resolveRaasRequirementAnchors({
        eventName: "raas/JD_REJECTED",
        incoming: { entity_id: "JP-FLAT" },
      }),
    ).toEqual({ jobRequisitionId: "", jobPostingId: "JP-FLAT" });
    expect(
      resolveRaasRequirementAnchors({
        eventName: "raas/JD_REJECTED",
        incoming: {
          entity_id: "JR-EXPLICIT-TYPE",
          __raas: { entity_type: "Job_Requisition" },
        },
      }),
    ).toEqual({ jobRequisitionId: "JR-EXPLICIT-TYPE", jobPostingId: "" });
  });

  it("loads the requisition/specification and ordered clarification context", async () => {
    const queries: string[] = [];
    const client: RaasPgSession = {
      async query<T>(sql: string) {
        queries.push(sql);
        if (sql.includes("FROM job_requisition r")) {
          return {
            rows: [
              {
                requirement_json: {
                  job_requisition_id: "JR-1",
                  client_job_title: "高级平台工程师",
                  client_id: "client-1",
                },
                specification_json: { degree_requirement: "本科" },
              } as T,
            ],
            rowCount: 1,
          };
        }
        return {
          rows: [
            {
              content: "必须熟悉 TypeScript",
              clarification_type: "skill",
            } as T,
          ],
          rowCount: 1,
        };
      },
    };
    await expect(
      loadRaasRequirementSnapshot(client, "JR-1"),
    ).resolves.toMatchObject({
      job_requisition_id: "JR-1",
      client_job_title: "高级平台工程师",
      specification: { degree_requirement: "本科" },
      clarifications: [{ content: "必须熟悉 TypeScript" }],
      requirement_source: "raas-postgres",
    });
    expect(queries).toHaveLength(2);
  });

  it("fails instead of generating from an unknown requisition id", async () => {
    const client: RaasPgSession = {
      async query<T>() {
        return { rows: [] as T[], rowCount: 0 };
      },
    };
    await expect(
      loadRaasRequirementSnapshot(client, "missing"),
    ).rejects.toThrow(/does not exist/);
  });

  it("resolves a JD_REJECTED JobPosting anchor back to its requisition", async () => {
    const client: RaasPgSession = {
      async query<T>(sql: string, values?: unknown[]) {
        expect(sql).toContain("LEFT JOIN job_posting");
        expect(values).toEqual(["JP-REJECTED"]);
        return {
          rows: [{ job_requisition_id: "JR-ORIGINAL" } as T],
          rowCount: 1,
        };
      },
    };
    await expect(
      resolveRaasRequisitionFromPosting(client, "JP-REJECTED"),
    ).resolves.toBe("JR-ORIGINAL");
  });

  it("reconstructs matching text from a historical RAAS JobPosting", async () => {
    const client: RaasPgSession = {
      async query<T>(sql: string, values?: unknown[]) {
        expect(sql).toContain("LEFT JOIN LATERAL");
        expect(values).toEqual(["JR-HISTORY"]);
        return {
          rows: [
            {
              posting_json: {
                job_posting_id: "JP-HISTORY",
                posting_title: "高级平台工程师",
                posting_description: "建设招聘平台",
              },
              requirement_json: {
                job_responsibility: "负责核心服务",
                hard_requirements: "TypeScript 与 PostgreSQL",
              },
            } as T,
          ],
          rowCount: 1,
        };
      },
    };
    await expect(loadRaasJdSnapshot(client, "JR-HISTORY")).resolves.toEqual({
      job_posting_id: "JP-HISTORY",
      job_requisition_id: "JR-HISTORY",
      title: "高级平台工程师",
      jd_content:
        "# 高级平台工程师\n\n## 职位描述\n建设招聘平台\n\n## 岗位职责\n负责核心服务\n\n## 硬性要求\nTypeScript 与 PostgreSQL",
    });
  });
});
