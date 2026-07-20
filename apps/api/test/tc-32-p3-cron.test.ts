/**
 * TC-32 — P3-RT-01: real manifest scheduled triggers.
 *
 * Verifies:
 *   1. AgentSchema accepts the `cron` + `cron_timezone` fields.
 *   2. registerCronTriggers produces one Inngest function per cron-enabled
 *      agent, and zero for agents without `cron`.
 *   3. Malformed cron expressions are rejected by runtime validation.
 */

import { describe, it, expect, beforeAll } from "vitest";
import {
  AgentSchema,
  InvalidCronExpressionError,
  registerCronTriggers,
} from "@agentic/runtime";
import { buildTestEnv } from "./harness";

describe("TC-32: scheduled triggers (P3-RT-01)", () => {
  beforeAll(async () => {
    await buildTestEnv();
  });

  describe("P3-RT-01: manifest schema accepts cron + cron_timezone", () => {
    it("AgentSchema parses an agent with cron + cron_timezone", () => {
      const parsed = AgentSchema.parse({
        id: "cron-1",
        name: "dailyReport",
        actor: ["Agent"],
        trigger: ["MANUAL"],
        actions: [],
        triggered_event: [],
        cron: "0 9 * * *",
        cron_timezone: "America/New_York",
      });
      expect(parsed.cron).toBe("0 9 * * *");
      expect(parsed.cron_timezone).toBe("America/New_York");
    });

    it("cron field is optional; absent value parses as undefined", () => {
      const parsed = AgentSchema.parse({
        id: "no-cron",
        name: "noCronAgent",
        actor: ["Agent"],
        trigger: ["X"],
        actions: [],
        triggered_event: [],
      });
      expect(parsed.cron).toBeUndefined();
      expect(parsed.cron_timezone).toBeUndefined();
    });

    it("empty-string cron coerces to undefined (legacy migration)", () => {
      const parsed = AgentSchema.parse({
        id: "empty-cron",
        name: "emptyCronAgent",
        actor: ["Agent"],
        trigger: ["X"],
        actions: [],
        triggered_event: [],
        cron: "",
        cron_timezone: "",
      });
      expect(parsed.cron).toBeUndefined();
      expect(parsed.cron_timezone).toBeUndefined();
    });
  });

  describe("P3-RT-01: registerCronTriggers", () => {
    it("registers one Inngest function per cron-enabled agent", () => {
      const result = registerCronTriggers({
        tenantSlug: "testtenant",
        manifest: [
          {
            id: "a1",
            name: "scheduledAgent",
            actor: ["Agent"],
            trigger: ["DUMMY"],
            actions: [],
            triggered_event: [],
            cron: "*/5 * * * *",
            description: "",
          } as never,
          {
            id: "a2",
            name: "noCronAgent",
            actor: ["Agent"],
            trigger: ["X"],
            actions: [],
            triggered_event: [],
            description: "",
          } as never,
        ],
      });
      expect(result.cronAgents).toBe(1);
      expect(result.invalidCron).toBe(0);
      expect(result.functions).toHaveLength(1);
    });

    it("fails fast when an agent declares malformed cron", () => {
      expect(() =>
        registerCronTriggers({
          tenantSlug: "testtenant",
          manifest: [
            {
              id: "bad-1",
              name: "badCronAgent",
              actor: ["Agent"],
              trigger: ["X"],
              actions: [],
              triggered_event: [],
              cron: "1 2 3", // only 3 fields
              description: "",
            } as never,
          ],
        }),
      ).toThrow(InvalidCronExpressionError);
    });

    it("rejects five-word prose instead of treating field count as validity", () => {
      expect(() =>
        registerCronTriggers({
          tenantSlug: "testtenant",
          manifest: [
            {
              id: "bad-prose",
              name: "proseCronAgent",
              actor: ["Agent"],
              trigger: ["X"],
              actions: [],
              triggered_event: [],
              cron: "garbage cron words look valid",
              description: "",
            } as never,
          ],
        }),
      ).toThrow(/field 1 contains unsupported cron syntax/);
    });

    it("accepts @hourly / @daily shorthand", () => {
      const result = registerCronTriggers({
        tenantSlug: "testtenant",
        manifest: [
          {
            id: "h-1",
            name: "hourlyAgent",
            actor: ["Agent"],
            trigger: ["X"],
            actions: [],
            triggered_event: [],
            cron: "@hourly",
            description: "",
          } as never,
        ],
      });
      expect(result.functions).toHaveLength(1);
    });
  });
});
