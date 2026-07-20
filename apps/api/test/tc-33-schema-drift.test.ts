/**
 * TC-33 — schema-drift regression net.
 *
 * Catches the "silent drop" class of bug (Audit #3 §3.1, the original
 * motivation for TC-7) **without hand-listing the fields**. The hardcoded
 * slot list in TC-7 case 4 is easy to forget when adding a new field to
 * `AgentSchema`; this test introspects the generated JSON Schema properties so
 * any new key is automatically covered. `AgentSchema` now includes preprocess
 * and cross-field refinements, so reaching through it for a ZodObject `.shape`
 * would couple the test to an implementation detail that no longer exists.
 *
 * Cases:
 *   1. Every declared agent property survives a round-trip on
 *      the RAAS-v1 fixture (or is a documented normalization).
 *   2. Every raw-JSON key on every agent in the RAAS-v1 fixture appears
 *      in the parsed result (modulo documented normalizations + `.passthrough()`).
 *   3. The generated `models/workflow.schema.json` is byte-identical to
 *      what the current Zod schema would emit (mirrors `gen:schema:check`,
 *      so CI catches it even if the turbo task is skipped).
 */

import path from "node:path";
import { readFile } from "node:fs/promises";
import { describe, it, expect } from "vitest";
import {
  WorkflowManifestSchema,
  buildWorkflowJsonSchema,
  serializeWorkflowSchema,
} from "@agentic/runtime";

const RAAS_WORKFLOW = path.join(
  process.env.AGENTIC_MODELS_DIR ?? "./models",
  "RAAS-v1",
  "workflow_v1.json",
);

const WORKFLOW_SCHEMA = path.join(
  process.env.AGENTIC_MODELS_DIR ?? "./models",
  "workflow.schema.json",
);

/**
 * Keys whose `""` value is documented to coerce to `undefined` via the
 * `coerceEmptyToUndef` preprocess in `manifest.ts`. The on-disk file may
 * carry the empty-string placeholder; the parsed result will not.
 */
const EMPTY_STRING_NORMALIZED: ReadonlySet<string> = new Set([
  "ontology_instructions",
  "typescript_code",
  "model",
  "cron",
  "cron_timezone",
]);

/**
 * `tool_use` has its own normalization (`coerceToolUse`): `""` → undefined,
 * array-of-strings → array-of-objects.
 */
const TOOL_USE_NORMALIZED = "tool_use";

function declaredAgentKeys(): string[] {
  const schema = buildWorkflowJsonSchema() as {
    items?: { properties?: Record<string, unknown> };
  };
  const properties = schema.items?.properties;
  if (!properties) {
    throw new Error("generated workflow JSON Schema has no agent properties");
  }
  return Object.keys(properties);
}

describe("TC-33: schema-drift regression net", () => {
  it("introspects the canonical JSON Schema and round-trips every declared key", async () => {
    const raw = JSON.parse(await readFile(RAAS_WORKFLOW, "utf8")) as Array<
      Record<string, unknown>
    >;
    const manifest = WorkflowManifestSchema.parse(raw);
    expect(manifest.length).toBe(raw.length);

    const declaredKeys = declaredAgentKeys();
    expect(declaredKeys.length).toBeGreaterThan(0);

    for (let i = 0; i < raw.length; i++) {
      const rawAgent = raw[i]!;
      const parsedAgent = manifest[i] as Record<string, unknown>;

      for (const key of declaredKeys) {
        if (!(key in rawAgent)) continue;
        const rawVal = rawAgent[key];
        const parsedVal = parsedAgent[key];

        // Documented normalization: optional string fields with "" → undefined.
        if (EMPTY_STRING_NORMALIZED.has(key) && rawVal === "") {
          expect(parsedVal, `${key} on agent ${rawAgent.id ?? i}`).toBeUndefined();
          continue;
        }
        // tool_use: "" → undefined; array<string> → array<{name}>; otherwise preserved.
        if (key === TOOL_USE_NORMALIZED) {
          if (rawVal === "") {
            expect(parsedVal).toBeUndefined();
          } else if (Array.isArray(rawVal)) {
            expect(Array.isArray(parsedVal)).toBe(true);
            expect((parsedVal as unknown[]).length).toBe(rawVal.length);
          }
          continue;
        }
        // All other declared keys must survive parsing unchanged in shape.
        expect(
          parsedVal,
          `${key} on agent ${rawAgent.id ?? i} was silently dropped by parse`,
        ).toBeDefined();
      }
    }
  });

  it("preserves every raw-JSON key (via shape OR passthrough) on every agent", async () => {
    const raw = JSON.parse(await readFile(RAAS_WORKFLOW, "utf8")) as Array<
      Record<string, unknown>
    >;
    const manifest = WorkflowManifestSchema.parse(raw);

    for (let i = 0; i < raw.length; i++) {
      const rawAgent = raw[i]!;
      const parsedAgent = manifest[i] as Record<string, unknown>;

      for (const key of Object.keys(rawAgent)) {
        const rawVal = rawAgent[key];

        // Skip documented empty-string normalizations.
        if (EMPTY_STRING_NORMALIZED.has(key) && rawVal === "") continue;
        if (key === TOOL_USE_NORMALIZED && rawVal === "") continue;
        // `input_data: {}` is a valid empty record — parse keeps it as-is.

        const parsedVal = parsedAgent[key];
        expect(
          parsedVal,
          `raw key "${key}" on agent ${rawAgent.id ?? i} disappeared from parsed output`,
        ).toBeDefined();
      }
    }
  });

  it("models/workflow.schema.json matches the current Zod schema (no drift)", async () => {
    const expected = serializeWorkflowSchema(buildWorkflowJsonSchema());
    const actual = await readFile(WORKFLOW_SCHEMA, "utf8");
    if (actual !== expected) {
      throw new Error(
        `models/workflow.schema.json is stale. Run: pnpm --filter @agentic/runtime run gen:schema`,
      );
    }
    expect(actual).toBe(expected);
  });
});
