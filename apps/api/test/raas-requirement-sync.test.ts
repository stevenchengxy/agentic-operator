import path from "node:path";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolContext } from "@agentic/agent-kit";
import {
  and,
  businessRecords,
  eq,
  getDb,
  tenants,
} from "@agentic/db";
import { globalToolRegistry } from "@agentic/tools";
import {
  __resetRuntimeScheduleHealthForTests,
  AgentSchema,
  lint,
  registerAgent,
  registerCronTriggers,
  runtimeScheduleHealth,
  type AgentSpec,
} from "@agentic/runtime";
import raasRegistry from "@tenants/raas";

const monitor = raasRegistry.tools?.monitorAndFetchRequirement;
const deduplicate = raasRegistry.tools?.checkDeduplicatedRequisition;
const persist = raasRegistry.tools?.persistRequisitionData;
if (!monitor || !deduplicate || !persist) {
  throw new Error("RAAS requirement-sync tools are not fully registered");
}

const baseContext: ToolContext = {
  tenantSlug: "raas",
  agentName: "syncFromClientSystem",
  actionName: "monitorAndFetchRequirement",
  correlationId: "cor-requirement-sync",
  subject: "scheduled-sync",
  event: { name: "SCHEDULED_SYNC", data: {} },
  results: {},
  config: {
    api_url_env: "RAAS_CLIENT_REQUIREMENTS_API_URL",
    token_env: "RAAS_CLIENT_REQUIREMENTS_API_TOKEN",
    auth_scheme: "bearer",
  },
};

const createdKeys = new Set<string>();

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  __resetRuntimeScheduleHealthForTests();
  if (createdKeys.size === 0) return;
  const db = getDb();
  const tenant = db
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.slug, "raas"))
    .all()[0];
  if (tenant) {
    for (const key of createdKeys) {
      db.delete(businessRecords)
        .where(
          and(
            eq(businessRecords.tenantId, tenant.id),
            eq(businessRecords.recordType, "job_posting"),
            eq(businessRecords.recordKey, key),
          ),
        )
        .run();
    }
  }
  createdKeys.clear();
});

describe("RAAS real requirement sync", () => {
  it("fails closed when the real endpoint is not configured", async () => {
    vi.stubEnv("RAAS_CLIENT_REQUIREMENTS_API_URL", "");
    vi.stubEnv("RAAS_CLIENT_REQUIREMENTS_API_TOKEN", "secret-for-test");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await expect(monitor.handler(baseContext)).rejects.toThrow(
      /required endpoint environment variable/i,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects an ambiguous 2xx response instead of manufacturing requirements", async () => {
    vi.stubEnv(
      "RAAS_CLIENT_REQUIREMENTS_API_URL",
      "https://requirements.invalid/v1/changes",
    );
    vi.stubEnv("RAAS_CLIENT_REQUIREMENTS_API_TOKEN", "secret-for-test");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ ok: true, requirements: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    await expect(monitor.handler(baseContext)).rejects.toThrow(
      /ambiguous or invalid receipt/i,
    );
  });

  it("fetches, deduplicates, and atomically persists an acknowledged real batch", async () => {
    const key = `sync-test-${process.pid}-${Date.now()}`;
    createdKeys.add(key);
    vi.stubEnv(
      "RAAS_CLIENT_REQUIREMENTS_API_URL",
      "https://requirements.invalid/v1/changes",
    );
    vi.stubEnv("RAAS_CLIENT_REQUIREMENTS_API_TOKEN", "secret-for-test");
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          schema_version: 1,
          ok: true,
          request_id: "req-real-1",
          source_system: "client-rms",
          cursor: "cursor-2",
          requirements: [
            {
              client_role_unique_id: key,
              client_role_name: "Backend Engineer",
              operation: "upsert",
              headcount: 2,
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const fetched = await monitor.handler(baseContext);
    const fetchedData = fetched.data as Record<string, unknown>;
    const classified = await deduplicate.handler({
      ...baseContext,
      actionName: "checkDeduplicatedRequisition",
      lastResult: fetchedData,
      results: { monitorAndFetchRequirement: fetchedData },
    });
    const classifiedData = classified.data as Record<string, unknown>;
    const persisted = await persist.handler({
      ...baseContext,
      actionName: "persistRequisitionData",
      lastResult: classifiedData,
      results: {
        monitorAndFetchRequirement: fetchedData,
        checkDeduplicatedRequisition: classifiedData,
      },
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: "GET" });
    expect(persisted.data).toMatchObject({
      persisted: true,
      persisted_count: 1,
      created_count: 1,
      _emit: "REQUIREMENT_SYNCED",
    });
    const tenant = getDb()
      .select({ id: tenants.id })
      .from(tenants)
      .where(eq(tenants.slug, "raas"))
      .all()[0]!;
    const row = getDb()
      .select()
      .from(businessRecords)
      .where(
        and(
          eq(businessRecords.tenantId, tenant.id),
          eq(businessRecords.recordType, "job_posting"),
          eq(businessRecords.recordKey, key),
        ),
      )
      .all()[0];
    expect(row?.dataJson).toMatchObject({
      client_role_unique_id: key,
      client_role_name: "Backend Engineer",
      sync_status: "active",
      upstream_request_id: "req-real-1",
    });
  });

  it("keeps every rollback-capable sync manifest event-triggered and tool-backed", () => {
    for (const version of [1, 4, 5]) {
      const modelPath = path.resolve(
        __dirname,
        "../../..",
        `models/RAAS-v1/workflow_v${version}.json`,
      );
      const manifest = JSON.parse(readFileSync(modelPath, "utf8")) as Array<{
        name: string;
        trigger?: string[];
        cron_env?: string;
        cron_timezone_env?: string;
        actions?: Array<{ name: string; type: string }>;
      }>;
      const syncAgent = manifest.find(
        (agent) => agent.name === "syncFromClientSystem",
      );
      expect(syncAgent?.trigger, `workflow_v${version}`).toEqual([
        "SCHEDULED_SYNC",
      ]);
      expect(syncAgent?.cron_env, `workflow_v${version}`).toBe(
        "RAAS_REQUIREMENTS_SYNC_CRON",
      );
      expect(syncAgent?.cron_timezone_env, `workflow_v${version}`).toBe(
        "RAAS_REQUIREMENTS_SYNC_TIMEZONE",
      );
      expect(syncAgent?.actions, `workflow_v${version}`).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "monitorAndFetchRequirement",
            type: "tool",
          }),
          expect.objectContaining({
            name: "checkDeduplicatedRequisition",
            type: "tool",
          }),
          expect.objectContaining({
            name: "persistRequisitionData",
            type: "tool",
          }),
        ]),
      );
    }
  });

  it("cannot silently resolve the business sync action to the global ping probe", () => {
    expect(globalToolRegistry.has("monitorAndFetchRequirement")).toBe(false);
    expect(globalToolRegistry.get("pingProbe")?.name).toBe("meta.ping");
  });

  it("registers a real cron producer only when the env-backed schedule is configured", () => {
    const modelPath = path.resolve(
      __dirname,
      "../../..",
      "models/RAAS-v1/workflow_v5.json",
    );
    const manifest = JSON.parse(readFileSync(modelPath, "utf8")) as AgentSpec[];
    const syncAgent = manifest.find(
      (agent) => agent.name === "syncFromClientSystem",
    )!;

    const configured = registerCronTriggers({
      tenantSlug: "raas-schedule-test",
      manifest: [syncAgent],
      env: {
        RAAS_REQUIREMENTS_SYNC_CRON: "@hourly",
        RAAS_REQUIREMENTS_SYNC_TIMEZONE: "UTC",
      },
    });
    expect(configured.functions).toHaveLength(1);
    expect(runtimeScheduleHealth()).toMatchObject({
      ok: true,
      configured: 1,
      unconfigured: 0,
    });

    const missing = registerCronTriggers({
      tenantSlug: "raas-schedule-test",
      manifest: [syncAgent],
      env: {},
    });
    expect(missing.functions).toHaveLength(0);
    expect(runtimeScheduleHealth()).toMatchObject({
      ok: false,
      configured: 0,
      unconfigured: 1,
      unconfiguredAgents: ["raas-schedule-test.syncFromClientSystem"],
    });

    const disabled = registerCronTriggers({
      tenantSlug: "raas-schedule-test",
      manifest: [syncAgent],
      env: { RAAS_REQUIREMENTS_SYNC_CRON: "disabled" },
    });
    expect(disabled.functions).toHaveLength(0);
    expect(runtimeScheduleHealth()).toMatchObject({
      ok: true,
      configured: 0,
      disabled: 1,
      unconfigured: 0,
      disabledAgents: ["raas-schedule-test.syncFromClientSystem"],
    });
  });

  it("surfaces an unconfigured env-backed schedule during deployment preflight", () => {
    const modelPath = path.resolve(
      __dirname,
      "../../..",
      "models/RAAS-v1/workflow_v5.json",
    );
    const manifest = JSON.parse(readFileSync(modelPath, "utf8")) as AgentSpec[];

    const missing = lint(manifest, {
      llmProviders: ["openai"],
      concurrencyMax: 100,
      configuredEnv: new Set(),
    });
    expect(missing.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "schedule_env_unconfigured",
          severity: "warning",
          path: expect.stringContaining("cron_env"),
        }),
      ]),
    );

    const configured = lint(manifest, {
      llmProviders: ["openai"],
      concurrencyMax: 100,
      configuredEnv: new Set([
        "RAAS_REQUIREMENTS_SYNC_CRON",
        "RAAS_REQUIREMENTS_SYNC_TIMEZONE",
      ]),
    });
    expect(
      configured.issues.some(
        (issue) => issue.code === "schedule_env_unconfigured",
      ),
    ).toBe(false);

    const disabled = lint(manifest, {
      llmProviders: ["openai"],
      concurrencyMax: 100,
      configuredEnv: new Set(["RAAS_REQUIREMENTS_SYNC_CRON"]),
      disabledScheduleEnv: new Set(["RAAS_REQUIREMENTS_SYNC_CRON"]),
    });
    expect(disabled.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "schedule_env_disabled",
          severity: "info",
          path: expect.stringContaining("cron_env"),
        }),
      ]),
    );
    expect(
      disabled.issues.some(
        (issue) => issue.code === "schedule_env_unconfigured",
      ),
    ).toBe(false);
  });

  it("wires a pure scheduled producer and consumer to the same internal event", async () => {
    const agent = AgentSchema.parse({
      id: "pure-schedule",
      name: "pureScheduleAgent",
      actor: ["Agent"],
      trigger: [],
      actions: [],
      triggered_event: [],
      cron_env: "PURE_SCHEDULE_CRON",
    });
    const registered = registerAgent(agent, {
      tenantId: "ten-pure-schedule",
      tenantSlug: "pure-schedule",
      workflowVersionId: "wfv-pure-schedule",
    });

    expect(registered).not.toBeNull();
    const consumerTriggers = (registered as unknown as {
      opts: { triggers: Array<{ event: string }> };
    }).opts.triggers;
    expect(consumerTriggers).toEqual([
      { event: "pure-schedule/__schedule.pureScheduleAgent" },
    ]);

    const scheduled = registerCronTriggers({
      tenantSlug: "pure-schedule",
      manifest: [agent],
      env: { PURE_SCHEDULE_CRON: "@hourly" },
    });
    let emitted: { name?: string } | undefined;
    const producer = scheduled.functions[0] as unknown as {
      fn: (input: {
        step: {
          sendEvent: (
            id: string,
            event: { name: string },
          ) => Promise<void>;
        };
      }) => Promise<unknown>;
    };
    await producer.fn({
      step: {
        sendEvent: async (_id, event) => {
          emitted = event;
        },
      },
    });
    expect(emitted?.name).toBe(consumerTriggers[0]?.event);
  });

  it("rejects an orphan timezone instead of accepting dead schedule configuration", () => {
    const orphanTimezone = AgentSchema.parse({
      id: "orphan-timezone",
      name: "orphanTimezone",
      actor: ["Agent"],
      trigger: ["START"],
      actions: [],
      triggered_event: [],
      cron_timezone_env: "ORPHAN_TIMEZONE",
    });

    expect(() =>
      registerCronTriggers({
        tenantSlug: "schedule-validation",
        manifest: [orphanTimezone],
        env: { ORPHAN_TIMEZONE: "UTC" },
      }),
    ).toThrow(/timezone requires cron or cron_env/i);
    expect(
      lint([orphanTimezone], {
        llmProviders: ["openai"],
        concurrencyMax: 100,
        configuredEnv: new Set(["ORPHAN_TIMEZONE"]),
      }).conflicts,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "invalid_cron",
          severity: "block",
          path: expect.stringContaining("cron_timezone_env"),
        }),
      ]),
    );
  });
});
