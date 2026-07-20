import { describe, expect, it, vi } from "vitest";
import {
  ONTOLOGY_WRITE_INSTANCE_PROBE_SAFETY,
  OntologyWriteInstanceError,
  ontologyWriteInstance,
  writeAllmetaInstance,
} from "./write-instance";
import { prepareWriteProbeCanary } from "@agentic/shared";

const env = {
  TENANT_ALLMETA_URL: "http://allmeta.test",
  TENANT_ALLMETA_KEY: "top-secret",
};
const config = {
  base_url_env: "TENANT_ALLMETA_URL",
  api_key_env: "TENANT_ALLMETA_KEY",
  domain: "Agents-generation",
  action: "processResume",
  allowed_tenants: ["zhaopin"],
  allowed_domains: ["Agents-generation"],
  allowed_objects: ["Candidate", "Resume"],
  allowed_actions: ["processResume"],
};
const context = {
  tenantSlug: "zhaopin",
  tenantId: "ten-zhaopin",
  actionName: "processResume",
};
const schema = {
  id: "Candidate",
  primary_key: "candidate_id",
  properties: [
    { name: "candidate_id", type: "string", is_required: true },
    { name: "name", type: "string", is_required: true },
    { name: "score", type: "number" },
    { name: "skills", type: "string[]" },
  ],
};

function successHarness(receipt: Record<string, unknown> = { upserted: ["cand-1"], count: 1 }) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.includes("/objects/")) {
      return new Response(JSON.stringify(schema), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify(receipt), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

describe("ontology.writeInstance", () => {
  it("fetches the live schema, validates, and sends a strict idempotent Allmeta write", async () => {
    const h = successHarness();
    const args = {
      object_type: "Candidate",
      properties: { candidate_id: "cand-1", name: "Wei Zhang", score: 92, skills: ["TypeScript"] },
    };
    const result = await writeAllmetaInstance(args, config, context, { env, fetchImpl: h.fetchImpl });
    expect(result).toMatchObject({
      domain: "Agents-generation",
      object_type: "Candidate",
      primary_key: "candidate_id",
      primary_value: "cand-1",
      upserted: ["cand-1"],
      count: 1,
    });
    expect(result.idempotency_key).toMatch(/^allmeta-[a-f0-9]{64}$/);
    expect(h.calls.map((call) => call.url)).toEqual([
      "http://allmeta.test/api/v1/ontology/objects/Candidate?domain=Agents-generation",
      "http://allmeta.test/api/v1/ontology/instances/Candidate?domain=Agents-generation&validate=strict",
    ]);
    const headers = new Headers(h.calls[1]!.init?.headers);
    expect(headers.get("authorization")).toBe("Bearer top-secret");
    expect(headers.get("idempotency-key")).toBe(result.idempotency_key);
    expect(JSON.parse(String(h.calls[1]!.init?.body))).toEqual({
      candidate_id: "cand-1",
      name: "Wei Zhang",
      score: 92,
      skills: ["TypeScript"],
      domainId: "Agents-generation",
    });

    const h2 = successHarness();
    const retry = await writeAllmetaInstance(args, config, context, { env, fetchImpl: h2.fetchImpl });
    expect(retry.idempotency_key).toBe(result.idempotency_key);
  });

  it("rejects model-supplied URL/token fields and literal trusted config before network", async () => {
    const h = successHarness();
    await expect(writeAllmetaInstance(
      { object_type: "Candidate", properties: { candidate_id: "cand-1", name: "Wei" }, url: "http://evil" },
      config,
      context,
      { env, fetchImpl: h.fetchImpl },
    )).rejects.toMatchObject({ code: "untrusted_allmeta_parameter" });
    await expect(writeAllmetaInstance(
      { object_type: "Candidate", properties: { candidate_id: "cand-1", name: "Wei" } },
      { ...config, api_key: "inline-secret" },
      context,
      { env, fetchImpl: h.fetchImpl },
    )).rejects.toMatchObject({ code: "untrusted_allmeta_config" });
    expect(h.fetchImpl).not.toHaveBeenCalled();
  });

  it("enforces tenant/domain/object/action allowlists before schema discovery", async () => {
    const h = successHarness();
    await expect(writeAllmetaInstance(
      { object_type: "Candidate", properties: { candidate_id: "cand-1", name: "Wei" } },
      config,
      { ...context, tenantSlug: "other" },
      { env, fetchImpl: h.fetchImpl },
    )).rejects.toMatchObject({ code: "tenant_not_allowed" });
    await expect(writeAllmetaInstance(
      { object_type: "Job_Posting", properties: { job_id: "job-1" } },
      config,
      context,
      { env, fetchImpl: h.fetchImpl },
    )).rejects.toMatchObject({ code: "object_not_allowed" });
    expect(h.fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects a profile for a different current ontology action before network", async () => {
    const h = successHarness();
    await expect(writeAllmetaInstance(
      { object_type: "Candidate", properties: { candidate_id: "cand-1", name: "Wei" } },
      config,
      { ...context, actionName: "ruleCheckForMatchResume" },
      { env, fetchImpl: h.fetchImpl },
    )).rejects.toMatchObject({ code: "action_scope_mismatch" });
    expect(h.fetchImpl).not.toHaveBeenCalled();
  });

  it("fails closed with a typed dependency error when env references are unset", async () => {
    const h = successHarness();
    await expect(writeAllmetaInstance(
      { object_type: "Candidate", properties: { candidate_id: "cand-1", name: "Wei" } },
      config,
      context,
      { env: {}, fetchImpl: h.fetchImpl },
    )).rejects.toMatchObject({ code: "allmeta_dependency_missing", terminal: true, retryable: false });
    expect(h.fetchImpl).not.toHaveBeenCalled();
  });

  it("fails closed on unknown/missing/wrong-typed fields before POST", async () => {
    for (const properties of [
      { candidate_id: "cand-1", name: "Wei", made_up: true },
      { candidate_id: "cand-1" },
      { candidate_id: "cand-1", name: "Wei", score: "ninety" },
    ]) {
      const h = successHarness();
      await expect(writeAllmetaInstance(
        { object_type: "Candidate", properties },
        config,
        context,
        { env, fetchImpl: h.fetchImpl },
      )).rejects.toMatchObject({ code: "instance_schema_validation_failed" });
      expect(h.fetchImpl).toHaveBeenCalledOnce();
    }
  });

  it("does not claim success for a malformed 2xx receipt", async () => {
    const h = successHarness({ ok: true });
    await expect(writeAllmetaInstance(
      { object_type: "Candidate", properties: { candidate_id: "cand-1", name: "Wei" } },
      config,
      context,
      { env, fetchImpl: h.fetchImpl },
    )).rejects.toMatchObject({ code: "malformed_allmeta_receipt", terminal: true });
  });

  it("surfaces typed retryable status on Allmeta outage", async () => {
    const fetchImpl = vi.fn(async () => new Response("unavailable", { status: 503 })) as typeof fetch;
    await expect(writeAllmetaInstance(
      { object_type: "Candidate", properties: { candidate_id: "cand-1", name: "Wei" } },
      config,
      context,
      { env, fetchImpl },
    )).rejects.toMatchObject({
      name: "OntologyWriteInstanceError",
      code: "allmeta_http_error",
      status: 503,
      retryable: true,
      terminal: false,
    } satisfies Partial<OntologyWriteInstanceError>);
  });

  it("creates, retries, reads, exactly deletes and proves absence only in a dedicated probe object", async () => {
    const probeConfig = {
      ...config,
      probe_domain: "Agent-Factory-Canary",
      probe_action: "verifyOntologyWriteIntegration",
      probe_object: "Agent_Factory_Write_Probe",
      probe_namespace: "agent-factory-production-canary",
      probe_primary_key_field: "probe_id",
      probe_marker_field: "probe_marker",
      probe_namespace_field: "probe_namespace",
      probe_idempotency_field: "idempotency_key",
    };
    const probeSchema = {
      id: probeConfig.probe_object,
      primary_key: probeConfig.probe_primary_key_field,
      properties: [
        { name: probeConfig.probe_primary_key_field, type: "string", is_required: true },
        { name: probeConfig.probe_marker_field, type: "string", is_required: true },
        { name: probeConfig.probe_namespace_field, type: "string", is_required: true },
        { name: probeConfig.probe_idempotency_field, type: "string", is_required: true },
      ],
    };
    const prepared = prepareWriteProbeCanary({
      args: {},
      contract: ONTOLOGY_WRITE_INSTANCE_PROBE_SAFETY,
      seed: "a".repeat(64),
    });
    if (!prepared.ok) throw new Error(prepared.reason);
    let row: Record<string, unknown> | undefined;
    let writes = 0;
    let deletes = 0;
    const fetchImpl = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = String(input);
      if (url.includes(`/ontology/objects/${probeConfig.probe_object}`)) {
        return new Response(JSON.stringify(probeSchema), { status: 200 });
      }
      if (url.includes(`/ontology/instances/${probeConfig.probe_object}/`)) {
        if (init?.method === "DELETE") {
          if (!row) return new Response(JSON.stringify({ error: "instance-not-found" }), { status: 404 });
          row = undefined;
          deletes += 1;
          return new Response(JSON.stringify({ deleted: 1 }), { status: 200 });
        }
        return row
          ? new Response(JSON.stringify(row), { status: 200 })
          : new Response(JSON.stringify({ error: "instance-not-found" }), { status: 404 });
      }
      if (url.includes(`/ontology/instances/${probeConfig.probe_object}?`)) {
        writes += 1;
        row = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({
          upserted: [row[probeConfig.probe_primary_key_field]],
          count: 1,
        }), { status: 200 });
      }
      throw new Error(`unexpected URL ${url}`);
    }) as typeof fetch;
    vi.stubGlobal("fetch", fetchImpl);
    vi.stubEnv("TENANT_ALLMETA_URL", env.TENANT_ALLMETA_URL);
    vi.stubEnv("TENANT_ALLMETA_KEY", env.TENANT_ALLMETA_KEY);
    try {
      const execution = {
        agentName: "agent-factory-probe" as const,
        actionName: "ontology.writeInstance",
        correlationId: `probe:${"b".repeat(12)}`,
        tenantSlug: `af-probe-${"c".repeat(24)}`,
        eventName: "probe:ontology.writeInstance",
      };
      const created = await ontologyWriteInstance.handler({
        ...execution,
        event: { name: execution.eventName, data: prepared.canary.args },
        config: probeConfig,
      });
      expect(writes).toBe(2);
      expect(created.data).toMatchObject({
        object_type: probeConfig.probe_object,
        primary_key: probeConfig.probe_primary_key_field,
        primary_value: prepared.canary.target,
      });
      expect(row).toMatchObject({
        [probeConfig.probe_primary_key_field]: prepared.canary.target,
        [probeConfig.probe_marker_field]: prepared.canary.marker,
        [probeConfig.probe_idempotency_field]: prepared.canary.idempotencyKey,
      });
      const lifecycleInput = {
        toolName: "ontology.writeInstance",
        args: prepared.canary.args,
        config: probeConfig,
        contract: ONTOLOGY_WRITE_INSTANCE_PROBE_SAFETY,
        canary: prepared.canary,
        execution,
        createResult: created.data,
      };
      await expect(ontologyWriteInstance.factoryWriteProbeLifecycle!.cleanup(lifecycleInput))
        .resolves.toMatchObject({ completed: true, evidence: { matched: true, deleted: true } });
      expect(deletes).toBe(1);
      await expect(ontologyWriteInstance.factoryWriteProbeLifecycle!.readback(lifecycleInput))
        .resolves.toMatchObject({ absent: true, evidence: { rowAbsent: true } });
      expect(row).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });

  it("refuses a missing/dangerous probe profile before any Allmeta I/O", async () => {
    const prepared = prepareWriteProbeCanary({
      args: {},
      contract: ONTOLOGY_WRITE_INSTANCE_PROBE_SAFETY,
      seed: "d".repeat(64),
    });
    if (!prepared.ok) throw new Error(prepared.reason);
    const fetchImpl = vi.fn();
    vi.stubGlobal("fetch", fetchImpl);
    try {
      await expect(ontologyWriteInstance.handler({
        agentName: "agent-factory-probe",
        actionName: "ontology.writeInstance",
        correlationId: `probe:${"e".repeat(12)}`,
        tenantSlug: `af-probe-${"f".repeat(24)}`,
        event: { name: "probe:ontology.writeInstance", data: prepared.canary.args },
        config,
      })).rejects.toMatchObject({ code: "invalid_probe_config" });
      await expect(ontologyWriteInstance.handler({
        agentName: "agent-factory-probe",
        actionName: "ontology.writeInstance",
        correlationId: `probe:${"e".repeat(12)}`,
        tenantSlug: `af-probe-${"f".repeat(24)}`,
        event: { name: "probe:ontology.writeInstance", data: prepared.canary.args },
        config: {
          ...config,
          probe_domain: "Agent-Factory-Canary",
          probe_action: "verifyOntologyWriteIntegration",
          probe_object: "Candidate",
          probe_namespace: "agent-factory-production-canary",
          probe_primary_key_field: "candidate_id",
          probe_marker_field: "probe_marker",
          probe_namespace_field: "probe_namespace",
          probe_idempotency_field: "idempotency_key",
        },
      })).rejects.toMatchObject({ code: "probe_object_not_dedicated" });
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
