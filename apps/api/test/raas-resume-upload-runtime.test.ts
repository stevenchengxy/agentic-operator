import { describe, expect, it, vi } from "vitest";
import {
  failResumeUploadRuntimeWithSession,
  persistPostgresWithSession,
  persistRaasExternal,
} from "@tenants/zhaopin";

describe("RAAS resume upload runtime state", () => {
  it("completes the partner upload in the Candidate/Resume transaction", async () => {
    const queries: Array<{ sql: string; values: unknown[] }> = [];
    const session = {
      query: vi.fn(async (sql: string, values: unknown[] = []) => {
        queries.push({ sql, values });
        if (
          sql.includes("SELECT candidate_id FROM candidate") ||
          sql.includes("SELECT resume_id FROM resume")
        ) {
          return { rows: [], rowCount: 0 };
        }
        // The partner owns this row. A non-RAAS upload may legitimately update
        // zero rows and must not make Candidate/Resume persistence fail.
        return { rows: [], rowCount: 0 };
      }),
    };

    const ids = await persistPostgresWithSession(
      session as never,
      "candidate_resume",
      {
        candidate_id: "C-1",
        upload_id: "UP-1",
        bucket: "resume-bucket",
        object_key: "inbox/resume-1.pdf",
        filename: "resume-1.pdf",
        parsed: { name: "王小明", email: "candidate@example.com" },
      },
      { candidate_id: "C-1", resume_id: "R-1" },
    );

    expect(ids).toEqual({ candidate_id: "C-1", resume_id: "R-1" });
    const runtimeUpdate = queries.find((query) =>
      query.sql.includes("UPDATE resume_upload_runtime"),
    );
    expect(runtimeUpdate?.sql).toContain("status        = 'completed'");
    expect(runtimeUpdate?.sql).toContain("error_message = NULL");
    expect(runtimeUpdate?.sql).not.toContain("application_id");
    expect(runtimeUpdate?.values).toEqual(["C-1", "R-1", "UP-1"]);

    const latestResume = queries.find((query) =>
      query.sql.includes("UPDATE candidate SET latest_resume_id"),
    );
    expect(queries.indexOf(runtimeUpdate!)).toBeGreaterThan(
      queries.indexOf(latestResume!),
    );
  });

  it("marks a failed Candidate/Resume save without replacing its error", async () => {
    const original = new Error("candidate write failed");
    const resumeUploadFailure = vi.fn(async () => {
      throw new Error("failure marker unavailable");
    });

    await expect(
      persistRaasExternal(
        {
          tenantSlug: "zhaopin",
          phase: "candidate_resume",
          snapshot: {
            candidate_id: "C-1",
            upload_id: "UP-1",
            bucket: "resume-bucket",
            object_key: "inbox/resume-1.pdf",
          },
          env: { RAAS_POSTGRES_URL: "postgresql://raas.test/db" },
          profile: {
            targetMode: "postgres",
            postgresUrlEnv: "RAAS_POSTGRES_URL",
          },
        },
        {
          postgres: async () => {
            throw original;
          },
          resumeUploadFailure,
        },
      ),
    ).rejects.toBe(original);
    expect(resumeUploadFailure).toHaveBeenCalledWith({
      connectionString: "postgresql://raas.test/db",
      uploadId: "UP-1",
      errorMessage: "candidate write failed",
    });
  });

  it("still persists a locked resume so the upload reaches a real terminal state", async () => {
    const postgres = vi.fn(async () => ({ resume_id: "R-LOCKED" }));
    const receipt = await persistRaasExternal(
      {
        tenantSlug: "zhaopin",
        phase: "candidate_resume",
        snapshot: {
          candidate_id: "C-LOCKED",
          upload_id: "UP-LOCKED",
          bucket: "resume-bucket",
          object_key: "inbox/locked.pdf",
          lock_conflict: true,
          locked_by_employee_id: "EMP-B",
          requesting_recruiter_id: "EMP-A",
        },
        env: { RAAS_POSTGRES_URL: "postgresql://raas.test/db" },
        profile: {
          targetMode: "postgres",
          postgresUrlEnv: "RAAS_POSTGRES_URL",
        },
      },
      { postgres },
    );

    expect(postgres).toHaveBeenCalledOnce();
    expect(receipt).toMatchObject({
      enabled: true,
      postgres: "written",
      ids: { candidate_id: "C-LOCKED", resume_id: "R-LOCKED" },
    });
    expect(receipt.skipped_reason).toBeUndefined();
  });

  it("writes a bounded failure state and tolerates a missing row", async () => {
    const queries: Array<{ sql: string; values: unknown[] }> = [];
    const session = {
      query: vi.fn(async (sql: string, values: unknown[] = []) => {
        queries.push({ sql, values });
        return { rows: [], rowCount: 0 };
      }),
    };
    const longMessage = "x".repeat(1_005);

    const updated = await failResumeUploadRuntimeWithSession(
      session as never,
      "UP-FAILED",
      longMessage,
    );

    expect(updated).toBe(false);
    expect(queries).toHaveLength(1);
    expect(queries[0]?.sql).toContain("status        = 'failed'");
    expect(queries[0]?.sql).not.toContain("candidate_id");
    expect(queries[0]?.sql).not.toContain("resume_id");
    expect(queries[0]?.values).toEqual([
      "UP-FAILED",
      longMessage.slice(0, 1000),
    ]);
  });
});
