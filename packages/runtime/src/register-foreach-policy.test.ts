import { describe, expect, it } from "vitest";
import { ActionSchema } from "./manifest";
import { resolveForeachContainerFailure } from "./register";

function foreachAction(extra: Record<string, unknown> = {}) {
  return ActionSchema.parse({
    order: "1",
    name: "each",
    type: "foreach",
    items_from: "input.items",
    item_key_from: "id",
    foreach_actions: [{ order: "1", name: "work", type: "logic" }],
    ...extra,
  });
}

describe("top-level foreach container failure policy", () => {
  it("applies the foreach's own soft/default result instead of bypassing it", () => {
    const output = resolveForeachContainerFailure(
      foreachAction({ on_error: "soft", default_result: { skipped: true } }),
      new Error("body failed"),
    );
    expect(output).toMatchObject({
      ok: true,
      data: { skipped: true },
      meta: {
        softFailed: true,
        failureResolution: { disposition: "continue" },
      },
    });
  });

  it("lets an explicit container policy catch a terminal child", () => {
    const terminalChild = Object.assign(new Error("child terminal"), {
      name: "NonRetriableError",
    });
    expect(
      resolveForeachContainerFailure(
        foreachAction({
          on_error: [
            { when: "true", do: "continue", default_result: [] },
            { default: "terminal" },
          ],
        }),
        terminalChild,
      ),
    ).toMatchObject({ ok: true, data: [] });
  });

  it("preserves terminal child control flow when the container has no policy", () => {
    const terminalChild = Object.assign(new Error("child terminal"), {
      name: "NonRetriableError",
    });
    expect(() =>
      resolveForeachContainerFailure(foreachAction(), terminalChild),
    ).toThrow(terminalChild);
  });
});
