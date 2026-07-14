import { afterEach, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { DeployAuthoredAgentBody } from "@agentic/contracts";
import { eventTypes, getDb, tenants } from "@agentic/db";
import { ensureAuthoredEventTypes } from "../src/services/agent-authoring";

const eventNames = [
  "CODEX_NEW_EVENT_REQUESTED",
  "CODEX_NEW_EVENT_COMPLETED",
];

function systemTenant() {
  const row = getDb()
    .select({ id: tenants.id, slug: tenants.slug })
    .from(tenants)
    .where(eq(tenants.slug, "__system"))
    .all()[0];
  if (!row) throw new Error("test tenant __system is missing");
  return { tenantId: row.id, tenantSlug: row.slug };
}

function cleanup(): void {
  const ctx = systemTenant();
  getDb()
    .delete(eventTypes)
    .where(
      and(
        eq(eventTypes.tenantId, ctx.tenantId),
        inArray(eventTypes.name, eventNames),
      ),
    )
    .run();
}

afterEach(cleanup);

describe("TC-98: agent wizard event creation", () => {
  it("creates missing tenant event types once and preserves them on repeat deploys", () => {
    cleanup();
    const ctx = systemTenant();
    const input = DeployAuthoredAgentBody.parse({
      name: "eventCreationProbe",
      title: "Event Creation Probe",
      description: "Verifies event types created by the agent deployment wizard.",
      actor: "Agent",
      template: "blank",
      stage: 1,
      triggers: [eventNames[0]],
      emits: [eventNames[1]],
      systemPrompt:
        "Process the requested event safely and emit the completed event with structured output.",
      toolUse: [],
      retries: 1,
      timeoutS: 60,
      concurrency: 1,
    });

    expect(ensureAuthoredEventTypes(input, ctx)).toEqual(eventNames);
    expect(ensureAuthoredEventTypes(input, ctx)).toEqual([]);

    const rows = getDb()
      .select({
        tenantId: eventTypes.tenantId,
        name: eventTypes.name,
        category: eventTypes.category,
        description: eventTypes.description,
      })
      .from(eventTypes)
      .where(
        and(
          eq(eventTypes.tenantId, ctx.tenantId),
          inArray(eventTypes.name, eventNames),
        ),
      )
      .orderBy(eventTypes.name)
      .all();

    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.tenantId === ctx.tenantId)).toBe(true);
    expect(rows.every((row) => row.category === "agent")).toBe(true);
    expect(rows.every((row) => row.description?.includes("Event Creation Probe"))).toBe(true);
  });
});
