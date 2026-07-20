import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bootstrapAll,
  FatalRuntimeBootstrapError,
} from "@agentic/runtime";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("runtime model discovery readiness", () => {
  it("fails startup when the configured models root is unreadable", async () => {
    vi.stubEnv(
      "AGENTIC_MODELS_DIR",
      path.join(
        "/definitely-missing-agentic-model-root",
        `${process.pid}-${Date.now()}`,
      ),
    );

    await expect(bootstrapAll()).rejects.toBeInstanceOf(
      FatalRuntimeBootstrapError,
    );
  });
});
