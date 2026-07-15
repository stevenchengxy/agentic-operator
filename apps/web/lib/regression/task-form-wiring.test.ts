import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const WEB_ROOT = resolve(__dirname, "..", "..");
const page = readFileSync(
  resolve(WEB_ROOT, "app/portal/[tenant]/(views)/tasks/page.tsx"),
  "utf8",
);
const hook = readFileSync(resolve(WEB_ROOT, "lib/hooks/useTasks.ts"), "utf8");

describe("generated manual-task portal wiring", () => {
  it("falls back to authored payload role/form metadata", () => {
    expect(page).toContain(
      't.awaitingRole ?? payloadString(payload, "awaitingRole")',
    );
    expect(page).toContain("payload.formSchema ?? null");
    expect(page).toContain("payload.preparedContext ?? null");
  });

  it("submits validated form payload through the canonical resolution hook", () => {
    expect(page).toContain(
      "buildTaskResolutionPayload(definition, values, option)",
    );
    expect(page).toContain("await resolveTask.mutateAsync({");
    expect(page).toContain("decision: option.decision");
    expect(page).toContain("payload: result.payload");
    expect(hook).toContain('decision: "approve" | "reject" | "supplement"');
  });
});
