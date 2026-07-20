import { afterEach, describe, expect, it, vi } from "vitest";
import { DeployAuthoredAgentBody } from "@agentic/contracts";
import { MockAdapter, type LLMGateway } from "@agentic/llm-gateway";
import { getGlobalToolCatalogEntry, listGlobalTools } from "@agentic/tools";
import { buildOntologyQuery, ontologyQuery } from "@agentic/tools/ontology";
import { normalizeWebSearchResponse, webSearch } from "@agentic/tools/search";
import {
  getRuntimeGateway,
  lint,
  normalizeAgentForExecution,
  runAction,
  setRuntimeGateway,
  validateJsonSchemaDocument,
} from "@agentic/runtime";
import {
  buildAgentArchetypeRuntime,
  resolveAgentModelSelection,
} from "../src/services/agent-archetypes";
import {
  buildAuthoredManifestAgent,
  validateToolBindings,
} from "../src/services/agent-authoring";

const originalFetch = globalThis.fetch;
const originalUsername = process.env.TENANT_TEST_NEO4J_USERNAME;
const originalPassword = process.env.TENANT_TEST_NEO4J_PASSWORD;
const originalNeo4jUrl = process.env.NEO4J_QUERY_API_URL;
const originalSearchKey = process.env.SEARCH_API_KEY;
const originalGlobalUsername = process.env.NEO4J_USERNAME;
const originalGlobalPassword = process.env.NEO4J_PASSWORD;
const originalNeo4jDatabase = process.env.NEO4J_DATABASE;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalUsername === undefined)
    delete process.env.TENANT_TEST_NEO4J_USERNAME;
  else process.env.TENANT_TEST_NEO4J_USERNAME = originalUsername;
  if (originalPassword === undefined)
    delete process.env.TENANT_TEST_NEO4J_PASSWORD;
  else process.env.TENANT_TEST_NEO4J_PASSWORD = originalPassword;
  if (originalNeo4jUrl === undefined) delete process.env.NEO4J_QUERY_API_URL;
  else process.env.NEO4J_QUERY_API_URL = originalNeo4jUrl;
  if (originalSearchKey === undefined) delete process.env.SEARCH_API_KEY;
  else process.env.SEARCH_API_KEY = originalSearchKey;
  if (originalGlobalUsername === undefined) delete process.env.NEO4J_USERNAME;
  else process.env.NEO4J_USERNAME = originalGlobalUsername;
  if (originalGlobalPassword === undefined) delete process.env.NEO4J_PASSWORD;
  else process.env.NEO4J_PASSWORD = originalGlobalPassword;
  if (originalNeo4jDatabase === undefined) delete process.env.NEO4J_DATABASE;
  else process.env.NEO4J_DATABASE = originalNeo4jDatabase;
  vi.restoreAllMocks();
});

function authoredInput(
  template: "blank" | "classify" | "extract" | "rag" | "loop" | "human",
) {
  return DeployAuthoredAgentBody.parse({
    name: `${template === "rag" ? "deepSearch" : template}Agent`,
    title: `${template} agent`,
    description:
      "Handle the incoming event using evidence, explicit validation, and a reliable output contract.",
    actor: template === "human" ? "Human" : "Agent",
    template,
    stage: 42,
    triggers: ["WORK_REQUESTED"],
    emits: ["WORK_COMPLETED", "WORK_AUDITED"],
    systemPrompt:
      "Complete the requested work safely, preserve tenant isolation, and never fabricate missing evidence.",
    toolUse: [],
  });
}

const mockSelection = {
  provider: "mock" as const,
  model: "mock-model-v1",
  profile: "balanced" as const,
  source: "template_default" as const,
  reason: "test selection",
};

describe("complete New Agent archetypes", () => {
  it("materializes six distinct stage-free v2 manifests and exposes ontology to all", () => {
    const templates = [
      "blank",
      "classify",
      "extract",
      "rag",
      "loop",
      "human",
    ] as const;
    const agents = templates.map((template) =>
      buildAuthoredManifestAgent(authoredInput(template), {
        ...mockSelection,
        profile:
          template === "classify"
            ? "fast"
            : template === "extract"
              ? "structured"
              : template === "rag"
                ? "research"
                : template === "loop"
                  ? "tool_use"
                  : template === "human"
                    ? "human"
                    : "balanced",
      }),
    );

    expect(agents.map((agent) => agent.id)).toEqual([
      "blank-agent",
      "classify-agent",
      "extract-agent",
      "deep-search-agent",
      "loop-agent",
      "human-agent",
    ]);
    for (const agent of agents) {
      expect("stage" in agent).toBe(false);
      expect(agent.trigger).toEqual(["WORK_REQUESTED"]);
      expect(agent.triggered_event).toEqual(["WORK_COMPLETED", "WORK_AUDITED"]);
      expect((agent as { inputs?: unknown[] }).inputs).toHaveLength(2);
      expect((agent as { outputs?: unknown[] }).outputs).toHaveLength(1);
      expect(
        (agent.tool_use as Array<{ name: string }>).some(
          (tool) => tool.name === "ontology.query",
        ),
      ).toBe(true);
      const normalized = normalizeAgentForExecution(agent);
      expect(normalized.compatibilityMode).toBe("v2");
      expect(
        validateJsonSchemaDocument(
          normalized.outputSchema,
          `/agents/${agent.id}/outputs`,
        ),
      ).toEqual([]);
    }

    const actionGraphs = agents.map((agent) =>
      agent.actions.map((action) => `${action.type}:${action.name}`).join("→"),
    );
    expect(new Set(actionGraphs).size).toBe(6);
    expect(agents[3]!.actions.map((action) => action.name)).toEqual([
      "planResearch",
      "gatherEvidence",
      "synthesizeResearch",
      "verifyResearch",
    ]);
    expect(
      (agents[3]!.tool_use as Array<{ name: string }>).some(
        (tool) => tool.name === "search.web",
      ),
    ).toBe(true);
    expect(agents[5]!.actions[0]!.type).toBe("manual");

    const outputSchemas = agents.map((agent) =>
      JSON.stringify(
        (agent as { outputs: Array<{ schema: unknown }> }).outputs[0]!.schema,
      ),
    );
    expect(new Set(outputSchemas).size).toBe(6);
  });

  it("compiles all three Deep Search depths to bounded, distinct action graphs", () => {
    const counts = (["answer", "investigate", "deep_research"] as const).map(
      (searchMode) => {
        const blueprint = buildAgentArchetypeRuntime({
          template: "rag",
          searchMode,
          retries: 2,
          timeoutS: 120,
        });
        return [blueprint.actions.length, blueprint.toolLoop.max_iterations];
      },
    );
    expect(counts).toEqual([
      [2, 8],
      [3, 12],
      [4, 20],
    ]);
  });

  it("persists explicit per-step provider/model controls", () => {
    const input = DeployAuthoredAgentBody.parse({
      ...authoredInput("loop"),
      steps: [
        {
          id: "cheap-plan",
          name: "cheapPlan",
          description: "Plan quickly.",
          type: "logic",
          provider: "openai",
          model: "gpt-5.4-mini",
          temperature: 0,
          maxTokens: 512,
        },
        {
          id: "strong-execute",
          name: "strongExecute",
          description: "Execute with deeper reasoning.",
          type: "logic",
          provider: "anthropic",
          model: "claude-sonnet-5",
          reasoning: { effort: "high" },
        },
      ],
    });
    const manifest = buildAuthoredManifestAgent(input, mockSelection);
    expect(manifest.actions[0]).toMatchObject({
      provider: "openai",
      model: "gpt-5.4-mini",
      temperature: 0,
      max_tokens: 512,
    });
    expect(manifest.actions[1]).toMatchObject({
      provider: "anthropic",
      model: "claude-sonnet-5",
      reasoning: { effort: "high" },
    });
  });

  it("makes Human Approval hybrid when it has model preparation plus a durable decision", () => {
    const input = DeployAuthoredAgentBody.parse({
      ...authoredInput("human"),
      steps: [
        {
          id: "prepare",
          name: "prepareDecision",
          description: "Summarize evidence for the operator.",
          type: "logic",
        },
        {
          id: "decide",
          name: "requestDecision",
          description: "Wait for the operator decision.",
          type: "manual",
        },
      ],
    });
    const manifest = buildAuthoredManifestAgent(input, {
      ...mockSelection,
      profile: "human",
    });
    expect(manifest.actor).toEqual(["Human", "Agent"]);
    expect(manifest.generated).toBe(true);
    expect(manifest.actions.map((action) => action.type)).toEqual([
      "logic",
      "manual",
    ]);
    expect(manifest.actions[1]).toMatchObject({
      task_type: "approval",
      awaiting_role: "operator",
      form_schema: {
        required: ["decision"],
      },
    });
    expect(normalizeAgentForExecution(manifest).compatibilityMode).toBe("v2");
    const lintResult = lint([manifest], {
      llmProviders: ["mock"],
      concurrencyMax: 25,
    });
    expect(
      lintResult.conflicts.some((conflict) => conflict.type === "orphan_actor"),
    ).toBe(false);
  });

  it("selects efficient and research models by archetype and infers blank-agent purpose", () => {
    const classifier = resolveAgentModelSelection({
      template: "classify",
      description: "Route incoming support requests.",
      defaultProvider: "openai",
      defaultModel: null,
    });
    const research = resolveAgentModelSelection({
      template: "rag",
      description: "Investigate primary evidence.",
      defaultProvider: "openai",
      defaultModel: null,
    });
    const inferred = resolveAgentModelSelection({
      template: "blank",
      description:
        "Research sources and produce an evidence-backed report with citations.",
      defaultProvider: "openai",
      defaultModel: null,
    });
    expect(classifier.profile).toBe("fast");
    expect(research.profile).toBe("research");
    expect(classifier.model).not.toBe(research.model);
    expect(inferred).toMatchObject({
      profile: "research",
      source: "description_inferred",
    });
  });

  it("requires both sides of the event contract and permits multiple emits", () => {
    expect(
      DeployAuthoredAgentBody.safeParse({
        ...authoredInput("blank"),
        emits: [],
      }).success,
    ).toBe(false);
    expect(authoredInput("blank").emits).toHaveLength(2);
  });

  it("replaces catalog display schemas with canonical JSON Schema", () => {
    const manifest = buildAuthoredManifestAgent(
      DeployAuthoredAgentBody.parse({
        ...authoredInput("rag"),
        toolUse: [
          {
            name: "ontology.query",
            description: "display schema from the catalog",
            input_schema: { operation: { type: "'search_nodes'|'schema'" } },
          },
          {
            name: "search.web",
            description: "display schema from the catalog",
            input_schema: { include_domains: { type: "string[]" } },
          },
        ],
      }),
      { ...mockSelection, profile: "research" },
    );
    for (const tool of manifest.tool_use ?? []) {
      expect(
        validateJsonSchemaDocument(
          tool.input_schema ?? {},
          `/tools/${tool.name}`,
        ),
      ).toEqual([]);
    }
    expect(
      manifest.tool_use?.find((tool) => tool.name === "ontology.query"),
    ).toMatchObject({
      input_schema: { type: "object", required: ["operation"] },
    });
  });

  it("rejects invalid tool schemas from direct authoring API callers", () => {
    const input = DeployAuthoredAgentBody.parse({
      ...authoredInput("blank"),
      toolUse: [
        {
          name: "meta.ping",
          input_schema: { type: "string[]" },
        },
      ],
    });

    expect(() =>
      validateToolBindings(input, {
        tenantId: "ten-test",
        tenantSlug: "tenant-test",
      }),
    ).toThrow(/invalid_tool_schema: meta\.ping/);
  });

  it("runs every LLM-backed archetype through strict mock output validation", async () => {
    const previousGateway = getRuntimeGateway();
    setRuntimeGateway(new MockAdapter() as unknown as LLMGateway);
    try {
      for (const template of [
        "blank",
        "classify",
        "extract",
        "rag",
        "loop",
      ] as const) {
        const agent = buildAuthoredManifestAgent(authoredInput(template), {
          ...mockSelection,
          profile:
            template === "classify"
              ? "fast"
              : template === "extract"
                ? "structured"
                : template === "rag"
                  ? "research"
                  : template === "loop"
                    ? "tool_use"
                    : "balanced",
        });
        const action = agent.actions.at(-1)!;
        const result = await runAction({
          runId: `run-${template}`,
          stepId: `stp-${template}`,
          ctx: {
            agentName: agent.name,
            actionName: action.name,
            correlationId: `cor-${template}`,
            tenantSlug: "tenant-test",
            event: {
              name: "tenant-test/WORK_REQUESTED",
              data: { prompt: `Complete the ${template} test request.` },
            },
          },
          action,
          agent,
          tenantRegistry: {},
        });

        expect(result.ok, template).toBe(true);
        expect(result.meta?.outputValid, template).toBe(true);
      }
    } finally {
      if (previousGateway) setRuntimeGateway(previousGateway);
    }
  });
});

describe("global retrieval capabilities", () => {
  it("registers read-only search and ontology tools in the global catalog", () => {
    const names = listGlobalTools().map((tool) => tool.name);
    expect(names).toContain("search.web");
    expect(names).toContain("ontology.query");
    expect(getGlobalToolCatalogEntry("search.web")).toMatchObject({
      sideEffect: "read",
      testPolicy: "allow",
    });
    expect(getGlobalToolCatalogEntry("ontology.query")).toMatchObject({
      sideEffect: "read",
      testPolicy: "allow",
    });
  });

  it("generates only parameterized tenant-scoped Cypher, including every node in paths", () => {
    const malicious = "alice') MATCH (secret) DETACH DELETE secret //";
    const search = buildOntologyQuery({
      operation: "search_nodes",
      args: { query: malicious, limit: 500 },
      tenantSlug: "tenant-test",
    });
    expect(search.statement).not.toContain(malicious);
    expect(search.statement).toContain("n[$tenantProperty] = $tenantSlug");
    expect(search.statement).not.toContain("properties(n)");
    expect(search.parameters).toMatchObject({
      query: malicious,
      tenantSlug: "tenant-test",
      limit: 100,
    });

    const path = buildOntologyQuery({
      operation: "find_paths",
      args: { start_id: "a", end_id: "b", max_depth: 99 },
      tenantSlug: "tenant-test",
    });
    expect(path.statement).toContain("[*1..4]");
    expect(path.statement).toContain(
      "all(node IN nodes(p) WHERE node[$tenantProperty] = $tenantSlug)",
    );
  });

  it("calls Neo4j Query API v2 in read mode with tenant metadata", async () => {
    process.env.TENANT_TEST_NEO4J_USERNAME = "neo4j";
    process.env.TENANT_TEST_NEO4J_PASSWORD = "secret";
    process.env.NEO4J_QUERY_API_URL = "https://neo4j.example.com";
    process.env.NEO4J_DATABASE = "knowledge";
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    globalThis.fetch = vi.fn(
      async (url: string | URL | Request, init?: RequestInit) => {
        capturedUrl = String(url);
        capturedInit = init;
        return new Response(
          JSON.stringify({
            data: {
              fields: ["element_id", "labels", "properties"],
              values: [["4:abc", ["Account"], { name: "Acme" }]],
            },
          }),
          { status: 202, headers: { "Content-Type": "application/json" } },
        );
      },
    ) as typeof fetch;

    const result = await ontologyQuery.handler({
      agentName: "ontologyReader",
      actionName: "lookup",
      correlationId: "cor-1",
      tenantSlug: "tenant-test",
      event: {
        name: "tool:ontology.query",
        data: { operation: "search_nodes", query: "Acme" },
      },
      config: {
        base_url: "https://neo4j.example.com",
        database: "knowledge",
        username_env: "TENANT_TEST_NEO4J_USERNAME",
        password_env: "TENANT_TEST_NEO4J_PASSWORD",
      },
    });

    expect(capturedUrl).toBe("https://neo4j.example.com/db/knowledge/query/v2");
    const body = JSON.parse(String(capturedInit?.body)) as Record<
      string,
      unknown
    >;
    expect(body).toMatchObject({
      accessMode: "Read",
      maxExecutionTime: 15,
      parameters: { tenantSlug: "tenant-test" },
      txMetadata: {
        tenant: "tenant-test",
        agent: "ontologyReader",
        correlation_id: "cor-1",
      },
    });
    expect(result.data).toMatchObject({
      operation: "search_nodes",
      count: 1,
      records: [{ element_id: "4:abc", labels: ["Account"] }],
    });
  });

  it("never sends default credentials to author-controlled endpoints", async () => {
    process.env.NEO4J_USERNAME = "global-user";
    process.env.NEO4J_PASSWORD = "global-secret";
    process.env.SEARCH_API_KEY = "global-search-secret";
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as typeof fetch;

    await expect(
      ontologyQuery.handler({
        agentName: "reader",
        actionName: "lookup",
        correlationId: "cor-security",
        tenantSlug: "tenant-test",
        event: {
          name: "tool:ontology.query",
          data: { operation: "schema" },
        },
        config: { base_url: "https://attacker.example/query" },
      }),
    ).rejects.toThrow(/server-pinned|allow/i);

    await expect(
      webSearch.handler({
        agentName: "researcher",
        actionName: "search",
        correlationId: "cor-security",
        tenantSlug: "tenant-test",
        event: {
          name: "tool:search.web",
          data: { query: "test" },
        },
        config: {
          provider: "custom",
          base_url: "https://attacker.example/search",
        },
      }),
    ).rejects.toThrow(/provider-owned|allow/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("normalizes Tavily, Brave, and Serper evidence envelopes", () => {
    expect(
      normalizeWebSearchResponse(
        "tavily",
        {
          results: [
            {
              title: "A",
              url: "https://a.example",
              content: "Alpha",
              score: 0.9,
            },
          ],
        },
        5,
      )[0],
    ).toMatchObject({
      title: "A",
      url: "https://a.example",
      snippet: "Alpha",
      publishedAt: null,
      score: 0.9,
    });
    expect(
      normalizeWebSearchResponse(
        "brave",
        {
          web: {
            results: [
              { title: "B", url: "https://b.example", description: "Beta" },
            ],
          },
        },
        5,
      )[0],
    ).toMatchObject({ title: "B", snippet: "Beta" });
    expect(
      normalizeWebSearchResponse(
        "serper",
        {
          organic: [
            { title: "C", link: "https://c.example", snippet: "Gamma" },
          ],
        },
        5,
      )[0],
    ).toMatchObject({ title: "C", url: "https://c.example" });
  });
});
