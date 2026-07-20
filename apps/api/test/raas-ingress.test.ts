import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { events, getDb, tenants, users } from "@agentic/db";
import { makeId } from "@agentic/shared";
import { inngest } from "@agentic/runtime";
import {
  materializeRemoteResume,
  zhaopinReadFromInbox,
  RemoteResumeError,
} from "@tenants/zhaopin";
import {
  normalizeEventIngestBody,
  RaasIngressError,
} from "../src/services/raas-ingress";
import { buildTestEnv, type TestEnv } from "./harness";

const PDF = Buffer.from("%PDF-1.4\n% RAAS contract fixture\n%%EOF\n", "utf8");

function canonical(eventId = "raas-event-1") {
  return {
    name: "RESUME_DOWNLOADED",
    data: {
      entity_type: "Candidate",
      entity_id: "candidate-1",
      event_id: eventId,
      source_action: "raas.resume.download",
      payload: {
        upload_id: "upload-1",
        bucket: "recruit-resume-raw",
        object_key: "2026/07/张三.pdf",
        filename: "张三.pdf",
        etag: "etag-1",
        employee_id: "0000199059",
        job_requisition_id: "jr-1",
      },
      trace: { trace_id: "trace-1", request_id: "request-1" },
    },
  };
}

describe("RAAS ingress normalization", () => {
  it("flattens the canonical envelope and preserves lineage + old aliases", () => {
    const normalized = normalizeEventIngestBody(canonical(), "zhaopin");
    expect(normalized.raasTenant).toBe(true);
    expect(normalized.legacyShape).toBe(true);
    expect(normalized.idempotencyKey).toBe(
      "raas:RESUME_DOWNLOADED:event:raas-event-1",
    );
    expect(normalized.body).toMatchObject({
      name: "RESUME_DOWNLOADED",
      subject: "candidate-1",
      source: "external",
      payload: {
        upload_id: "upload-1",
        uploadId: "upload-1",
        object_key: "2026/07/张三.pdf",
        objectKey: "2026/07/张三.pdf",
        employee_id: "0000199059",
        employeeId: "0000199059",
        recruiter_id: "0000199059",
        __correlationId: "trace-1",
        __raas: {
          protocol: "raas-v1",
          external_event_id: "raas-event-1",
          entity_type: "Candidate",
          entity_id: "candidate-1",
          source_action: "raas.resume.download",
          trace: { trace_id: "trace-1" },
        },
      },
    });
  });

  it("recovers a thin JD event's requisition id and trace from the canonical envelope", () => {
    const normalized = normalizeEventIngestBody(
      {
        name: "REQUIREMENT_LOGGED",
        data: {
          entity_type: "JobRequisition",
          entity_id: "jr-thin-1",
          event_id: "evt-jd-thin-1",
          payload: {},
          trace: { trace_id: "trace-jd-thin-1" },
        },
      },
      "zhaopin",
    );
    expect(normalized.body).toMatchObject({
      subject: "jr-thin-1",
      payload: {
        job_requisition_id: "jr-thin-1",
        requirement_id: "jr-thin-1",
        __correlationId: "trace-jd-thin-1",
      },
    });
  });

  it("does not reinterpret a rejected JobPosting id as a requisition id", () => {
    const normalized = normalizeEventIngestBody(
      {
        name: "JD_REJECTED",
        data: {
          entity_type: "Job_Posting",
          entity_id: "jp-rejected-1",
          event_id: "evt-jd-rejected-1",
          payload: { reason: "内容需重写" },
        },
      },
      "zhaopin",
    );
    expect(normalized.body).toMatchObject({
      subject: "jp-rejected-1",
      payload: {
        job_posting_id: "jp-rejected-1",
        reason: "内容需重写",
      },
    });
    expect(
      (normalized.body as { payload: Record<string, unknown> }).payload
        .job_requisition_id,
    ).toBeUndefined();
  });

  it("accepts flat legacy data and falls back etag then upload_id for idempotency", () => {
    const flat = normalizeEventIngestBody(
      {
        name: "zhaopin/RESUME_DOWNLOADED",
        data: {
          uploadId: "upload-flat",
          bucket: "recruit-resume-raw",
          objectKey: "2026/07/flat.pdf",
          filename: "flat.pdf",
          etag: '"etag-flat"',
        },
      },
      "zhaopin",
    );
    expect(flat.idempotencyKey).toBe("raas:RESUME_DOWNLOADED:etag:etag-flat");
    expect(flat.body).toMatchObject({
      name: "RESUME_DOWNLOADED",
      payload: { upload_id: "upload-flat", object_key: "2026/07/flat.pdf" },
    });
  });

  it("does not coerce another tenant's generic contract", () => {
    const body = { name: "EVENT", payload: { value: 1 } };
    expect(normalizeEventIngestBody(body, "finance")).toEqual({
      body,
      raasTenant: false,
      idempotencyKey: null,
      legacyShape: false,
    });
  });

  it("rejects cross-tenant names, partial transport, and encoded traversal", () => {
    expect(() =>
      normalizeEventIngestBody(
        { name: "raas/RESUME_DOWNLOADED", payload: {} },
        "zhaopin",
      ),
    ).toThrowError(RaasIngressError);
    expect(() =>
      normalizeEventIngestBody(
        {
          name: "RESUME_DOWNLOADED",
          payload: { upload_id: "u", bucket: "recruit-resume-raw" },
        },
        "zhaopin",
      ),
    ).toThrow(/upload_id, bucket, and object_key/);
    expect(() =>
      normalizeEventIngestBody(
        {
          name: "RESUME_DOWNLOADED",
          payload: {
            upload_id: "u",
            bucket: "recruit-resume-raw",
            object_key: "2026/%2e%2e/secrets.pdf",
          },
        },
        "zhaopin",
      ),
    ).toThrow(/traversal/);
  });
});

describe("shared remote resume materializer", () => {
  it("downloads through a configured RAAS HTTP template and reuses its cache", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "ao-raas-http-"));
    const calls: Array<{ url: string; auth: string | null }> = [];
    const fetchImpl = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        calls.push({ url: String(input), auth: headers.get("authorization") });
        return new Response(PDF, {
          status: 200,
          headers: {
            "content-length": String(PDF.length),
            "content-type": "application/pdf",
          },
        });
      },
    ) as typeof fetch;
    const env = {
      AGENTIC_DATA_ROOT: root,
      RAAS_RESUME_FETCH_URL_TEMPLATE:
        "https://raas.internal/api/v1/resumes/uploads/{upload_id}/raw?bucket={bucket}&key={object_key}",
      RAAS_RESUME_FETCH_TOKEN: "test-token",
    };
    const payload = (
      normalizeEventIngestBody(canonical(), "zhaopin").body as {
        payload: Record<string, unknown>;
      }
    ).payload;
    try {
      const first = await materializeRemoteResume("zhaopin", payload, {
        env,
        fetchImpl,
      });
      const second = await materializeRemoteResume("zhaopin", payload, {
        env,
        fetchImpl,
      });
      expect(calls).toHaveLength(1);
      expect(calls[0]?.url).toContain("/uploads/upload-1/raw");
      expect(calls[0]?.url).toContain("key=2026%2F07%2F%E5%BC%A0%E4%B8%89.pdf");
      expect(calls[0]?.auth).toBe("Bearer test-token");
      expect(first.filename).toMatch(/^[a-f0-9]{16}-张三\.pdf$/);
      expect(first.resume_file_path).toBe(first.filename);
      expect(first.object_key).toBe("2026/07/张三.pdf");
      expect(first.objectKey).toBe("2026/07/张三.pdf");
      expect(second).toMatchObject({
        __raas: { resume_materialization: { source: "cache" } },
      });
      expect(
        readFileSync(
          path.join(
            root,
            "resumes",
            "zhaopin",
            "inbox",
            String(first.filename),
          ),
        ),
      ).toEqual(PDF);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses signed MinIO GET and never accepts a payload-selected URL", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "ao-raas-minio-"));
    let captured: { url: string; authorization: string | null } | null = null;
    const fetchImpl = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        captured = {
          url: String(input),
          authorization: headers.get("authorization"),
        };
        return new Response(PDF, { status: 200 });
      },
    ) as typeof fetch;
    try {
      await materializeRemoteResume(
        "zhaopin",
        {
          upload_id: "minio-upload",
          bucket: "recruit-resume-raw",
          object_key: "2026/07/minio.pdf",
          filename: "minio.pdf",
          resume_url: "http://attacker.invalid/ignored.pdf",
        },
        {
          env: {
            AGENTIC_DATA_ROOT: root,
            MINIO_ENDPOINT: "minio.internal",
            MINIO_PORT: "9000",
            MINIO_USE_SSL: "false",
            MINIO_ACCESS_KEY: "access",
            MINIO_SECRET_KEY: "secret",
          },
          fetchImpl,
        },
      );
      expect(captured).not.toBeNull();
      expect(captured!.url).toBe(
        "http://minio.internal:9000/recruit-resume-raw/2026/07/minio.pdf",
      );
      expect(captured!.authorization).toMatch(
        /^AWS4-HMAC-SHA256 Credential=access\//,
      );
      expect(captured!.url).not.toContain("attacker.invalid");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails loudly when remote coordinates have no configured transport", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "ao-raas-unconfigured-"));
    try {
      await expect(
        materializeRemoteResume(
          "zhaopin",
          {
            upload_id: "u",
            bucket: "recruit-resume-raw",
            object_key: "2026/07/a.pdf",
            filename: "a.pdf",
          },
          { env: { AGENTIC_DATA_ROOT: root } },
        ),
      ).rejects.toMatchObject<Partial<RemoteResumeError>>({
        code: "raas_resume_fetch_not_configured",
        statusCode: 503,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("times out a response that sends headers but stalls its body", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "ao-raas-stalled-"));
    const fetchImpl = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) => {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            init?.signal?.addEventListener(
              "abort",
              () => controller.error(new DOMException("aborted", "AbortError")),
              { once: true },
            );
          },
        });
        return new Response(stream, { status: 200 });
      },
    ) as typeof fetch;
    try {
      await expect(
        materializeRemoteResume(
          "zhaopin",
          {
            upload_id: "stalled",
            bucket: "recruit-resume-raw",
            object_key: "2026/07/stalled.pdf",
            filename: "stalled.pdf",
          },
          {
            env: {
              AGENTIC_DATA_ROOT: root,
              RAAS_RESUME_FETCH_URL_TEMPLATE:
                "https://raas.internal/uploads/{upload_id}/raw",
              RAAS_RESUME_FETCH_TIMEOUT_MS: "20",
            },
            fetchImpl,
          },
        ),
      ).rejects.toMatchObject<Partial<RemoteResumeError>>({
        code: "raas_resume_fetch_failed",
        statusCode: 502,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("lets fs.readFromInbox materialize a canonical event that bypassed HTTP ingress", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "ao-raas-tool-"));
    const old = {
      root: process.env.AGENTIC_DATA_ROOT,
      template: process.env.RAAS_RESUME_FETCH_URL_TEMPLATE,
      token: process.env.RAAS_RESUME_FETCH_TOKEN,
    };
    process.env.AGENTIC_DATA_ROOT = root;
    process.env.RAAS_RESUME_FETCH_URL_TEMPLATE =
      "https://raas.internal/uploads/{upload_id}/raw";
    process.env.RAAS_RESUME_FETCH_TOKEN = "tool-token";
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(PDF, { status: 200 }));
    try {
      const result = await zhaopinReadFromInbox.handler({
        agentName: "processResume",
        actionName: "fs.readFromInbox",
        correlationId: "cor-1",
        tenantSlug: "zhaopin",
        event: canonical().data
          ? { name: "RESUME_DOWNLOADED", data: canonical().data }
          : undefined,
        config: { subdir: "resumes" },
      });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(Buffer.from(result.data.base64, "base64")).toEqual(PDF);
      expect(result.data.filename).toMatch(/^[a-f0-9]{16}-张三\.pdf$/);
    } finally {
      fetchSpy.mockRestore();
      if (old.root === undefined) delete process.env.AGENTIC_DATA_ROOT;
      else process.env.AGENTIC_DATA_ROOT = old.root;
      if (old.template === undefined)
        delete process.env.RAAS_RESUME_FETCH_URL_TEMPLATE;
      else process.env.RAAS_RESUME_FETCH_URL_TEMPLATE = old.template;
      if (old.token === undefined) delete process.env.RAAS_RESUME_FETCH_TOKEN;
      else process.env.RAAS_RESUME_FETCH_TOKEN = old.token;
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("POST /v1/events RAAS boundary", () => {
  let env: TestEnv;
  afterAll(async () => env?.cleanup());

  it("uses the bootstrapped tenant wire name, materializes, dispatches once, and deduplicates by envelope event_id", async () => {
    // This focused test also runs against a freshly migrated empty DB. Seed
    // only the auth identities the Fastify boot guard needs; bootstrap owns
    // the workflow rows.
    const db = getDb();
    db.insert(tenants)
      .values([
        { id: "ten-raas-ingress-system", slug: "__system", name: "System" },
        { id: "ten-raas-ingress-zhaopin", slug: "zhaopin", name: "RAAS-v1" },
      ])
      .onConflictDoNothing()
      .run();
    db.insert(users)
      .values({
        id: "usr-raas-ingress-admin",
        email: "raas-ingress-test@agentic.local",
        name: "RAAS Ingress Test",
        platformRole: "superadmin",
        status: "active",
      })
      .onConflictDoNothing()
      .run();
    const oldDevTenant = process.env.AGENTIC_DEV_TENANT;
    const oldDevUser = process.env.AGENTIC_DEV_USER_EMAIL;
    process.env.AGENTIC_DEV_TENANT = "zhaopin";
    process.env.AGENTIC_DEV_USER_EMAIL = "raas-ingress-test@agentic.local";
    env = await buildTestEnv();
    const root = mkdtempSync(path.join(os.tmpdir(), "ao-raas-route-"));
    const eventId = `raas-${makeId("evt")}`;
    const body = canonical(eventId);
    const oldRoot = process.env.AGENTIC_DATA_ROOT;
    const oldTemplate = process.env.RAAS_RESUME_FETCH_URL_TEMPLATE;
    process.env.AGENTIC_DATA_ROOT = root;
    process.env.RAAS_RESUME_FETCH_URL_TEMPLATE =
      "https://raas.internal/uploads/{upload_id}/raw";

    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(PDF, { status: 200 }));
    const sent: Array<{
      id?: string;
      name: string;
      data: Record<string, unknown>;
    }> = [];
    const proto = Object.getPrototypeOf(inngest) as {
      send: typeof inngest.send;
    };
    const originalSend = proto.send;
    proto.send = (async (event: {
      name: string;
      data: Record<string, unknown>;
    }) => {
      sent.push(event);
      return { ids: [makeId("ing")] };
    }) as typeof inngest.send;
    try {
      const request = () =>
        env.fetch("/v1/events", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-agentic-tenant": "zhaopin",
          },
          body: JSON.stringify(body),
        });
      const first = await request();
      const second = await request();
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      const firstBody = (await first.json()) as {
        data: { event_id: string; name: string };
      };
      const secondBody = (await second.json()) as {
        data: { event_id: string; name: string };
      };
      expect(firstBody.data).toEqual(secondBody.data);
      expect(firstBody.data.name).toBe("RESUME_DOWNLOADED");
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({
        id: firstBody.data.event_id,
        name: "RESUME_DOWNLOADED",
        data: {
          entity_id: "candidate-1",
          upload_id: "upload-1",
          object_key: "2026/07/张三.pdf",
          objectKey: "2026/07/张三.pdf",
          __raas: { external_event_id: eventId },
        },
      });
      expect(sent[0]?.data.resume_file_path).toMatch(
        /^[a-f0-9]{16}-张三\.pdf$/,
      );
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      proto.send = originalSend;
      fetchSpy.mockRestore();
      if (oldRoot === undefined) delete process.env.AGENTIC_DATA_ROOT;
      else process.env.AGENTIC_DATA_ROOT = oldRoot;
      if (oldTemplate === undefined)
        delete process.env.RAAS_RESUME_FETCH_URL_TEMPLATE;
      else process.env.RAAS_RESUME_FETCH_URL_TEMPLATE = oldTemplate;
      if (oldDevTenant === undefined) delete process.env.AGENTIC_DEV_TENANT;
      else process.env.AGENTIC_DEV_TENANT = oldDevTenant;
      if (oldDevUser === undefined) delete process.env.AGENTIC_DEV_USER_EMAIL;
      else process.env.AGENTIC_DEV_USER_EMAIL = oldDevUser;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("retries only a pending broker hand-off after enqueue failure", async () => {
    env ??= await buildTestEnv();
    const root = mkdtempSync(path.join(os.tmpdir(), "ao-raas-pending-"));
    const eventId = `raas-${makeId("evt")}`;
    const body = canonical(eventId);
    body.data.entity_id = `candidate-retry-${eventId}`;
    body.data.payload.upload_id = `upload-retry-${eventId}`;
    body.data.payload.object_key = `2026/07/${eventId}.pdf`;
    body.data.payload.filename = `${eventId}.pdf`;
    body.data.payload.etag = `etag-${eventId}`;

    const oldRoot = process.env.AGENTIC_DATA_ROOT;
    const oldTemplate = process.env.RAAS_RESUME_FETCH_URL_TEMPLATE;
    const oldDevTenant = process.env.AGENTIC_DEV_TENANT;
    const oldDevUser = process.env.AGENTIC_DEV_USER_EMAIL;
    process.env.AGENTIC_DATA_ROOT = root;
    process.env.RAAS_RESUME_FETCH_URL_TEMPLATE =
      "https://raas.internal/uploads/{upload_id}/raw";
    process.env.AGENTIC_DEV_TENANT = "zhaopin";
    process.env.AGENTIC_DEV_USER_EMAIL = "raas-ingress-test@agentic.local";

    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(PDF, { status: 200 }));
    const attempts: Array<{
      id?: string;
      name: string;
      data: Record<string, unknown>;
    }> = [];
    const proto = Object.getPrototypeOf(inngest) as {
      send: typeof inngest.send;
    };
    const originalSend = proto.send;
    proto.send = (async (event: {
      id?: string;
      name: string;
      data: Record<string, unknown>;
    }) => {
      attempts.push(event);
      if (attempts.length === 1) throw new Error("shared Inngest unavailable");
      return { ids: [event.id ?? makeId("ing")] };
    }) as typeof inngest.send;
    try {
      const request = () =>
        env.fetch("/v1/events", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-agentic-tenant": "zhaopin",
          },
          body: JSON.stringify(body),
        });
      const first = await request();
      const second = await request();
      expect(first.status).toBe(502);
      expect(second.status).toBe(200);
      const replayed = (await second.json()) as {
        data: { event_id: string; name: string };
      };
      expect(attempts).toHaveLength(2);
      expect(attempts[0]?.id).toBe(replayed.data.event_id);
      expect(attempts[1]?.id).toBe(replayed.data.event_id);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(
        getDb()
          .select()
          .from(events)
          .all()
          .filter((row) => row.subject === body.data.entity_id),
      ).toHaveLength(1);
    } finally {
      proto.send = originalSend;
      fetchSpy.mockRestore();
      if (oldRoot === undefined) delete process.env.AGENTIC_DATA_ROOT;
      else process.env.AGENTIC_DATA_ROOT = oldRoot;
      if (oldTemplate === undefined)
        delete process.env.RAAS_RESUME_FETCH_URL_TEMPLATE;
      else process.env.RAAS_RESUME_FETCH_URL_TEMPLATE = oldTemplate;
      if (oldDevTenant === undefined) delete process.env.AGENTIC_DEV_TENANT;
      else process.env.AGENTIC_DEV_TENANT = oldDevTenant;
      if (oldDevUser === undefined) delete process.env.AGENTIC_DEV_USER_EMAIL;
      else process.env.AGENTIC_DEV_USER_EMAIL = oldDevUser;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
