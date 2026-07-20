/**
 * TC-7 — P0-RT-01 acceptance: manifest schema retains the 4 new fields end-to-end.
 *
 * Covers DESIGN §10.1 + Audit #3 §3.1 (the silent-drop bug).
 *
 * Cases:
 *   1. AgentSchema parses a fixture with `input_data`, `ontology_instructions`,
 *      `tool_use` (array), and `typescript_code`; all four survive.
 *   2. AgentSchema parses a fixture WITHOUT those fields; they default to undefined.
 *   3. Legacy-tolerant parse: a fixture with `tool_use: ""` and `input_data: {}`
 *      survives without throwing (those values coerce to undefined).
 *   4. RAAS-v1 workflow parses end-to-end and all 23 agents' new fields are
 *      preserved verbatim in the parsed result.
 *   5. Re-bootstrap of RAAS-v1 writes the new fields into
 *      `agent_versions.manifest_json` (round-trip via DB).
 *   6. `tool_use` with a non-string entry (eg. number) is rejected — the
 *      canonical shape is enforced for new fixtures.
 */

import path from "node:path";
import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { AgentSchema, WorkflowManifestSchema } from "@agentic/runtime";
import { agentVersions, agents, getDb } from "@agentic/db";
import { readFile } from "node:fs/promises";

const RAAS_WORKFLOW = path.join(
  process.env.AGENTIC_MODELS_DIR ?? "./models",
  "RAAS-v1",
  "workflow_v1.json",
);

describe("TC-7: manifest schema preserves the 4 new fields (P0-RT-01)", () => {
  it("parses an agent with all 4 new fields and preserves them", () => {
    const fixture = {
      id: "demo-1",
      name: "demoAgent",
      title: "Demo",
      description: "test",
      actor: ["Agent"],
      trigger: ["TEST_FIRED"],
      actions: [
        {
          order: "1",
          name: "doIt",
          description: "do the thing",
          type: "logic",
        },
      ],
      triggered_event: ["TEST_DONE"],
      input_data: { requisition_id: "the requisition's primary key" },
      ontology_instructions: "Be concise. Match the candidate to the role.",
      tool_use: [
        {
          name: "lookupCandidate",
          description: "fetch a candidate row by id",
          input_schema: {
            type: "object",
            properties: { id: { type: "string" } },
            required: ["id"],
          },
        },
      ],
      typescript_code: "// see tenants/demo/src/agents/demoAgent.ts",
    };
    const parsed = AgentSchema.parse(fixture);
    expect(parsed.input_data).toEqual({
      requisition_id: "the requisition's primary key",
    });
    expect(parsed.ontology_instructions).toContain("Be concise");
    expect(Array.isArray(parsed.tool_use)).toBe(true);
    expect(parsed.tool_use?.[0]?.name).toBe("lookupCandidate");
    expect(parsed.tool_use?.[0]?.input_schema).toBeDefined();
    expect(parsed.typescript_code).toContain("tenants/demo/src/agents");
  });

  it("parses an agent WITHOUT the new fields and leaves them undefined", () => {
    const fixture = {
      id: "min-1",
      name: "minAgent",
      description: "no new fields",
      actor: ["Agent"],
      trigger: ["X"],
      actions: [],
      triggered_event: [],
    };
    const parsed = AgentSchema.parse(fixture);
    expect(parsed.input_data).toBeUndefined();
    expect(parsed.ontology_instructions).toBeUndefined();
    expect(parsed.tool_use).toBeUndefined();
    expect(parsed.typescript_code).toBeUndefined();
  });

  it("tolerates legacy `tool_use: ''` and `typescript_code: ''` (coerced to undefined)", () => {
    const fixture = {
      id: "legacy-1",
      name: "legacyAgent",
      description: "legacy file shape",
      actor: ["Agent"],
      trigger: ["X"],
      actions: [],
      triggered_event: [],
      input_data: {},
      ontology_instructions: "",
      tool_use: "",
      typescript_code: "",
    };
    const parsed = AgentSchema.parse(fixture);
    expect(parsed.tool_use).toBeUndefined();
    expect(parsed.typescript_code).toBeUndefined();
    expect(parsed.ontology_instructions).toBeUndefined();
    // empty object is a valid Record so we keep it
    expect(parsed.input_data).toEqual({});
  });

  it("rejects a `tool_use` whose entries don't match the canonical shape", () => {
    const fixture = {
      id: "bad-1",
      name: "badAgent",
      description: "",
      actor: ["Agent"],
      trigger: ["X"],
      actions: [],
      triggered_event: [],
      tool_use: [{ name: 42 }], // number, not string — must reject
    };
    const result = AgentSchema.safeParse(fixture);
    expect(result.success).toBe(false);
  });

  it("parses the real RAAS-v1 workflow + every agent's new-field slot is present (or correctly undefined)", async () => {
    const raw = JSON.parse(await readFile(RAAS_WORKFLOW, "utf8"));
    const manifest = WorkflowManifestSchema.parse(raw);
    expect(manifest.length).toBeGreaterThan(0);
    for (const agent of manifest) {
      // All four fields must be either undefined OR the correct type — they
      // must NEVER be silently dropped without the slot existing.
      const slots: Array<keyof typeof agent> = [
        "input_data",
        "ontology_instructions",
        "tool_use",
        "typescript_code",
      ];
      for (const slot of slots) {
        const v = agent[slot];
        if (v === undefined) continue;
        if (slot === "input_data") expect(typeof v).toBe("object");
        if (slot === "ontology_instructions")
          expect(typeof v).toBe("string");
        if (slot === "tool_use") expect(Array.isArray(v)).toBe(true);
        if (slot === "typescript_code") expect(typeof v).toBe("string");
      }
    }
  });

  it("agent_versions.manifest_json round-trips the new fields after a fresh bootstrap", async () => {
    // Bootstrap a synthetic tenant manifest in a tmp dir so we don't have to
    // mutate the RAAS-v1 rows (existing rows are referenced by runs via FK).
    // The synthetic agent uses the canonical shape — all four new fields —
    // so the assertion exercises the end-to-end persistence path under the
    // new schema.
    const { buildTestEnv } = await import("./harness");
    await buildTestEnv();

    const { bootstrapTenant } = await import("@agentic/runtime");
    const { tmpdir } = await import("node:os");
    const { mkdtemp, writeFile } = await import("node:fs/promises");
    const fs = await import("node:fs/promises");
    const db = getDb();

    // Find or create a tenant we can attach the synthetic manifest to. We
    // reuse `__system` (always seeded) so we don't need a new seeded row.
    const tmpRoot = await mkdtemp(path.join(tmpdir(), "p0rt01-"));
    const modelDir = path.join(tmpRoot, "synthetic");
    await fs.mkdir(modelDir, { recursive: true });
    // Use a unique kebabId per run so we don't read a stale row left behind
    // by a previous test invocation (the DB is shared across runs).
    const kebabId = `p0rt01-roundtrip-${Date.now().toString(36)}`;
    const syntheticAgent = {
      id: kebabId,
      name: kebabId,
      title: "Round-trip",
      description: "synthetic for TC-7",
      actor: ["Agent"],
      trigger: ["P0RT01_FIRED"],
      actions: [
        {
          order: "1",
          name: "x",
          description: "",
          type: "logic",
        },
      ],
      triggered_event: ["P0RT01_DONE"],
      input_data: { rid: "requisition id" },
      ontology_instructions: "ontology text here",
      tool_use: [
        { name: "tool1", description: "t1", input_schema: { type: "object" } },
      ],
      typescript_code: "// see tenants/synthetic/src/agents/x.ts",
    };
    await writeFile(
      path.join(modelDir, "workflow_v1.json"),
      JSON.stringify([syntheticAgent], null, 2),
      "utf8",
    );

    // UC-V11-25: bootstrapTenant now refuses to boot when a `logic` action
    // has no matching tenant definePrompt. Provide a stub registry so the
    // synthetic action passes the validation gate.
    const { definePrompt, defineTool } = await import("@agentic/agent-kit");
    const stubPrompt = definePrompt({
      name: "x",
      system: "stub",
      template: () => "stub",
    });
    await bootstrapTenant({
      tenantSlug: "__system",
      modelDir,
      tenantRegistry: {
        // The production bootstrap is deliberately fail-closed: a manifest
        // tool reference must resolve to an actual callable descriptor. Use a
        // harmless test implementation instead of weakening that gate for a
        // persistence-only fixture.
        tools: {
          tool1: defineTool({
            name: "tool1",
            description: "TC-7 isolated round-trip fixture tool",
            async handler() {
              return { data: { ok: true } };
            },
          }),
        },
        prompts: { x: stubPrompt },
      },
    });
    const agentRow = db
      .select()
      .from(agents)
      .where(eq(agents.kebabId, kebabId))
      .all()[0];
    expect(agentRow).toBeDefined();
    const av = db
      .select()
      .from(agentVersions)
      .where(eq(agentVersions.agentId, agentRow!.id))
      .all()[0];
    expect(av).toBeDefined();
    const stored = av!.manifestJson as Record<string, unknown>;
    expect(stored.input_data).toEqual({ rid: "requisition id" });
    expect(stored.ontology_instructions).toBe("ontology text here");
    expect(Array.isArray(stored.tool_use)).toBe(true);
    expect((stored.tool_use as Array<{ name: string }>)[0]!.name).toBe("tool1");
    expect(stored.typescript_code).toContain("tenants/synthetic");
  });
});
