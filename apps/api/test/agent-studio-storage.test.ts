import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  AgentDefinitionV2Schema,
  AgentRunRecordSchema,
  CancelRunResponse,
  RunOutputResponseSchema,
} from "@agentic/contracts";
import {
  agentRunSessions,
  agents,
  agentVersions,
  artifacts,
  getDb,
  runMessages,
  runs,
  tenants,
  workflows,
  workflowVersions,
} from "@agentic/db";
import { makeId } from "@agentic/shared";
import { inngest } from "@agentic/runtime";
import { createDbArtifactSink } from "../src/services/studio-observability";
import { reserveStudioRun } from "../src/services/studio-runner";
import { buildTestEnv, type TestEnv } from "./harness";

const SUFFIX = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const TENANT = `studio-store-${SUFFIX}`.slice(0, 32);
const OTHER_TENANT = `studio-store-other-${SUFFIX}`.slice(0, 32);
const tenantId = makeId("ten");
const otherTenantId = makeId("ten");
const workflowId = makeId("wf");
const workflowVersionId = makeId("wfv");
const agentId = makeId("agt");
const agentVersionId = makeId("agv");
const sessionId = makeId("ars");
const storageRunId = `run-storage-${SUFFIX}`;
const failedRunId = `run-failed-${SUFFIX}`;
const cancelRunId = `run-cancel-${SUFFIX}`;

const definition = AgentDefinitionV2Schema.parse({
  id: `storage-agent-${SUFFIX}`,
  name: `storageAgent${SUFFIX}`,
  title: "Storage boundary agent",
  actor: ["Agent"],
  trigger: [],
  inputs: [
    {
      id: "prompt",
      kind: "prompt",
      required: true,
      schema: { type: "string", minLength: 1 },
    },
    {
      id: "document",
      kind: "file",
      required: false,
      schema: { type: "object" },
      file: { media_types: ["text/plain"], max_bytes: 1_024 },
    },
  ],
  actions: [],
  outputs: [
    {
      id: "result",
      required: true,
      schema: {
        type: "object",
        required: ["summary"],
        properties: { summary: { type: "string" } },
        additionalProperties: false,
      },
    },
  ],
  observability: { retention_days: 7 },
});

interface Envelope<T> {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string };
}

describe("Agent Studio terminal storage boundaries", () => {
  let env: TestEnv;
  let artifactRoot: string;
  let outsideRoot: string;
  let previousArtifactRoot: string | undefined;
  const queuedAt = new Date();
  const retentionUntil = new Date(
    queuedAt.getTime() + 7 * 24 * 60 * 60 * 1_000,
  );

  beforeAll(async () => {
    artifactRoot = await mkdtemp(
      path.join(os.tmpdir(), "agent-studio-artifacts-"),
    );
    outsideRoot = await mkdtemp(
      path.join(os.tmpdir(), "agent-studio-outside-"),
    );
    previousArtifactRoot = process.env.AGENTIC_ARTIFACTS_DIR;
    process.env.AGENTIC_ARTIFACTS_DIR = artifactRoot;

    const db = getDb();
    db.insert(tenants)
      .values([
        { id: tenantId, slug: TENANT, name: "Studio storage test" },
        {
          id: otherTenantId,
          slug: OTHER_TENANT,
          name: "Studio storage other tenant",
        },
      ])
      .run();
    db.insert(workflows)
      .values({
        id: workflowId,
        tenantId,
        slug: `storage-${SUFFIX}`,
        name: "Storage workflow",
      })
      .run();
    db.insert(workflowVersions)
      .values({
        id: workflowVersionId,
        workflowId,
        version: "1.0.0",
        manifestJson: { agents: [definition] },
      })
      .run();
    db.insert(agents)
      .values({
        id: agentId,
        tenantId,
        workflowId,
        kebabId: definition.id,
        name: definition.name,
        title: definition.title,
        actor: "Agent",
        // This fixture exercises the manifest-only Studio runner. Code agents
        // use their registered source runtime and cannot be run from metadata.
        kind: "manifest",
        enabled: true,
        lifecycle: "active",
        createdAt: queuedAt,
        updatedAt: queuedAt,
      })
      .run();
    db.insert(agentVersions)
      .values({
        id: agentVersionId,
        agentId,
        workflowVersionId,
        manifestJson: definition,
        definitionSchemaVersion: 2,
        contentHash: `sha256:${SUFFIX}`,
        publishedAt: queuedAt,
      })
      .run();
    db.insert(agentRunSessions)
      .values({
        id: sessionId,
        tenantId,
        agentId,
        title: "Cancellation evidence",
        createdAt: queuedAt,
        updatedAt: queuedAt,
      })
      .run();
    db.insert(runs)
      .values([
        {
          id: storageRunId,
          tenantId,
          agentId,
          agentVersionId,
          status: "ok",
          queuedAt,
          startedAt: queuedAt,
          endedAt: queuedAt,
          correlationId: `cor-storage-${SUFFIX}`,
          invocationSource: "studio",
          definitionHash: `sha256:${SUFFIX}`,
          outputValid: true,
          sideEffectMode: "safe",
          isTest: true,
        },
        {
          id: failedRunId,
          tenantId,
          agentId,
          agentVersionId,
          status: "failed",
          queuedAt,
          startedAt: queuedAt,
          endedAt: queuedAt,
          correlationId: `cor-failed-${SUFFIX}`,
          invocationSource: "studio",
          definitionHash: `sha256:${SUFFIX}`,
          outputValid: false,
          sideEffectMode: "safe",
          isTest: true,
        },
        {
          id: cancelRunId,
          tenantId,
          agentId,
          agentVersionId,
          sessionId,
          status: "queued",
          queuedAt,
          correlationId: `cor-cancel-${SUFFIX}`,
          invocationSource: "studio",
          definitionHash: `sha256:${SUFFIX}`,
          sideEffectMode: "safe",
          isTest: true,
        },
      ])
      .run();

    await createDbArtifactSink(tenantId, cancelRunId, retentionUntil).persist({
      role: "definition",
      logicalName: "agent-definition.json",
      contentType: "application/json",
      payload: definition,
    });
    env = await buildTestEnv();
  });

  afterAll(async () => {
    getDb().delete(tenants).where(eq(tenants.id, tenantId)).run();
    getDb().delete(tenants).where(eq(tenants.id, otherTenantId)).run();
    if (previousArtifactRoot === undefined) {
      delete process.env.AGENTIC_ARTIFACTS_DIR;
    } else {
      process.env.AGENTIC_ARTIFACTS_DIR = previousArtifactRoot;
    }
    await Promise.all([
      rm(artifactRoot, { recursive: true, force: true }),
      rm(outsideRoot, { recursive: true, force: true }),
    ]);
  });

  it("rejects aggregate filenames reserved for terminal run evidence", () => {
    const parsed = AgentDefinitionV2Schema.safeParse({
      ...definition,
      output_config: {
        ...definition.output_config,
        artifact: {
          ...definition.output_config.artifact,
          filename: "Run-Record.json",
        },
      },
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0]?.message).toMatch(/reserved/i);
    }
  });

  it("persists uploaded bytes and passes only an artifact reference to execution", async () => {
    const send = vi
      .spyOn(inngest, "send")
      .mockResolvedValue({ ids: [`evt-${SUFFIX}`] } as never);
    let reserved: Awaited<ReturnType<typeof reserveStudioRun>>;
    try {
      reserved = await reserveStudioRun(
        { tenantId, tenantSlug: TENANT, via: "dev" },
        agentId,
        {
          target: { kind: "live", agentVersionId },
          prompt: "Summarize the attachment.",
          inputs: {
            document: {
              name: "note.txt",
              type: "text/plain",
              dataUrl: "data:text/plain;base64,SGVsbG8=",
              text: "must not be injected into the model prompt",
            },
          },
          toolPolicy: "safe",
        },
      );
    } finally {
      send.mockRestore();
    }

    const uploadArtifacts = getDb()
      .select()
      .from(artifacts)
      .where(eq(artifacts.runId, reserved!.runId))
      .all();
    const attachment = uploadArtifacts.find(
      (row) => row.role === "attachment",
    )!;
    expect(await readFile(attachment.path, "utf8")).toBe("Hello");
    expect(attachment.retentionUntil).not.toBeNull();

    const inputArtifact = uploadArtifacts.find((row) => row.role === "input")!;
    const storedInput = JSON.parse(
      await readFile(inputArtifact.path, "utf8"),
    ) as Record<string, unknown>;
    expect(storedInput.document).toEqual({
      artifactId: attachment.id,
      name: "note.txt",
      contentType: "text/plain",
      size: 5,
      sha256: attachment.sha256,
    });
    expect(JSON.stringify(storedInput)).not.toContain("dataUrl");
    expect(JSON.stringify(storedInput)).not.toContain("must not be injected");
  });

  it("suffixes true filename collisions and upserts a retried logical artifact", async () => {
    const sink = createDbArtifactSink(tenantId, storageRunId, retentionUntil);
    const individual = await sink.persist({
      role: "output",
      logicalName: "output.json",
      contentType: "application/json",
      payload: { summary: "individual" },
      schemaId: "agent-output:result",
    });
    const aggregate = await sink.persist({
      role: "output",
      logicalName: "output.json",
      contentType: "application/json",
      payload: { result: { summary: "aggregate" } },
      schemaId: "agent-output:aggregate",
      metadata: { aggregate: true },
    });
    const retry = await sink.persist({
      role: "output",
      logicalName: "output.json",
      contentType: "application/json",
      payload: { result: { summary: "aggregate retry" } },
      schemaId: "agent-output:aggregate",
      metadata: { aggregate: true },
    });
    const protectedArtifact = await sink.persist({
      role: "attachment",
      logicalName: "RUN-RECORD.JSON",
      contentType: "application/json",
      payload: { source: "upload" },
      schemaId: "agent-input:file",
    });

    expect(individual.logicalName).toBe("output.json");
    expect(aggregate.logicalName).toBe("output-2.json");
    expect(retry.id).toBe(aggregate.id);
    expect(retry.logicalName).toBe("output-2.json");
    expect(protectedArtifact.logicalName).toBe("attachment-RUN-RECORD.JSON");

    const outputRows = getDb()
      .select()
      .from(artifacts)
      .where(
        and(eq(artifacts.runId, storageRunId), eq(artifacts.role, "output")),
      )
      .all();
    expect(outputRows).toHaveLength(2);
    expect(
      outputRows.every(
        (row) => row.retentionUntil?.getTime() === retentionUntil.getTime(),
      ),
    ).toBe(true);

    const outputRes = await env.fetch(`/v1/runs/${storageRunId}/output`, {
      headers: { "x-agentic-tenant": TENANT },
    });
    const outputBody = (await outputRes.json()) as Envelope<unknown>;
    const output = RunOutputResponseSchema.parse(outputBody.data);
    expect(output.output).toEqual({
      result: { summary: "aggregate retry" },
    });
    expect(output.artifact?.schemaId).toBe("agent-output:aggregate");
  });

  it("does not expose a persisted output from a failed run", async () => {
    await createDbArtifactSink(tenantId, failedRunId, retentionUntil).persist({
      role: "output",
      logicalName: "output.json",
      contentType: "application/json",
      payload: { result: { summary: "must stay hidden" } },
      schemaId: "agent-output:aggregate",
    });
    const res = await env.fetch(`/v1/runs/${failedRunId}/output`, {
      headers: { "x-agentic-tenant": TENANT },
    });
    const body = (await res.json()) as Envelope<unknown>;
    const output = RunOutputResponseSchema.parse(body.data);
    expect(output.status).toBe("failed");
    expect(output.output).toBeNull();
  });

  it("atomically cancels Studio runs and persists one retained terminal record", async () => {
    const send = vi
      .spyOn(inngest, "send")
      .mockResolvedValue({ ids: [`cancel-${SUFFIX}`] } as never);
    const first = await env
      .fetch(`/v1/runs/${cancelRunId}/cancel`, {
        method: "POST",
        headers: { "x-agentic-tenant": TENANT },
      })
      .finally(() => send.mockRestore());
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as Envelope<unknown>;
    const cancellation = CancelRunResponse.parse(firstBody.data);
    expect(cancellation).toMatchObject({
      runId: cancelRunId,
      status: "cancelled",
      cancelled: true,
    });

    const recordRows = getDb()
      .select()
      .from(artifacts)
      .where(
        and(eq(artifacts.runId, cancelRunId), eq(artifacts.role, "run_record")),
      )
      .all();
    expect(recordRows).toHaveLength(1);
    expect(recordRows[0]?.retentionUntil?.getTime()).toBe(
      retentionUntil.getTime(),
    );
    const record = AgentRunRecordSchema.parse(
      JSON.parse(await readFile(recordRows[0]!.path, "utf8")),
    );
    expect(record.status).toBe("cancelled");
    expect(record.error).toEqual({
      code: "run_cancelled",
      message: "Studio run cancelled by operator.",
    });

    const second = await env.fetch(`/v1/runs/${cancelRunId}/cancel`, {
      method: "POST",
      headers: { "x-agentic-tenant": TENANT },
    });
    const secondBody = (await second.json()) as Envelope<unknown>;
    const duplicate = CancelRunResponse.parse(secondBody.data);
    expect(duplicate.cancelled).toBe(false);
    expect(
      getDb()
        .select()
        .from(artifacts)
        .where(
          and(
            eq(artifacts.runId, cancelRunId),
            eq(artifacts.role, "run_record"),
          ),
        )
        .all(),
    ).toHaveLength(1);
    expect(
      getDb()
        .select()
        .from(runMessages)
        .where(
          and(
            eq(runMessages.runId, cancelRunId),
            eq(runMessages.role, "assistant"),
          ),
        )
        .all(),
    ).toHaveLength(1);
  });

  it("scopes downloads, enforces retention, and rejects paths outside the artifact root", async () => {
    const rows = getDb()
      .select()
      .from(artifacts)
      .where(eq(artifacts.runId, storageRunId))
      .all();
    const aggregate = rows.find(
      (row) => row.schemaId === "agent-output:aggregate",
    )!;
    const own = await env.fetch(`/v1/artifacts/${aggregate.id}`, {
      headers: { "x-agentic-tenant": TENANT },
    });
    expect(own.status).toBe(200);
    expect(await own.json()).toEqual({
      result: { summary: "aggregate retry" },
    });

    const otherTenant = await env.fetch(`/v1/artifacts/${aggregate.id}`, {
      headers: { "x-agentic-tenant": OTHER_TENANT },
    });
    expect(otherTenant.status).toBe(404);
    expect(
      await env.fetch("/v1/runs/run-does-not-exist/artifacts", {
        headers: { "x-agentic-tenant": TENANT },
      }),
    ).toMatchObject({ status: 404 });

    const runDir = path.join(artifactRoot, storageRunId);
    await mkdir(runDir, { recursive: true });
    const expiredPath = path.join(runDir, "expired.json");
    await writeFile(expiredPath, "{}", "utf8");
    const expiredId = makeId("art");
    getDb()
      .insert(artifacts)
      .values({
        id: expiredId,
        tenantId,
        runId: storageRunId,
        kind: "application/json",
        role: "other",
        logicalName: "expired.json",
        contentType: "application/json",
        path: expiredPath,
        size: 2,
        retentionUntil: new Date(Date.now() - 1_000),
      })
      .run();
    expect(
      await env.fetch(`/v1/artifacts/${expiredId}`, {
        headers: { "x-agentic-tenant": TENANT },
      }),
    ).toMatchObject({ status: 410 });

    const outsidePath = path.join(outsideRoot, "outside.json");
    await writeFile(outsidePath, "{}", "utf8");
    const outsideId = makeId("art");
    getDb()
      .insert(artifacts)
      .values({
        id: outsideId,
        tenantId,
        runId: storageRunId,
        kind: "application/json",
        role: "other",
        logicalName: "outside.json",
        contentType: "application/json",
        path: outsidePath,
        size: 2,
        retentionUntil,
      })
      .run();
    expect(
      await env.fetch(`/v1/artifacts/${outsideId}`, {
        headers: { "x-agentic-tenant": TENANT },
      }),
    ).toMatchObject({ status: 410 });

    const headerPath = path.join(runDir, "header.json");
    await writeFile(headerPath, "{}", "utf8");
    const headerId = makeId("art");
    getDb()
      .insert(artifacts)
      .values({
        id: headerId,
        tenantId,
        runId: storageRunId,
        kind: "application/json",
        role: "other",
        logicalName: '../evil"\r\nX-Test: injected.json',
        contentType: "application/json",
        path: headerPath,
        size: 2,
        retentionUntil,
      })
      .run();
    const headerRes = await env.fetch(`/v1/artifacts/${headerId}`, {
      headers: { "x-agentic-tenant": TENANT },
    });
    expect(headerRes.status).toBe(200);
    const disposition = headerRes.headers.get("content-disposition") ?? "";
    expect(disposition).not.toMatch(/[\r\n]/);
    expect(disposition).not.toContain("../");
    expect(disposition).not.toContain('evil"');
  });
});
