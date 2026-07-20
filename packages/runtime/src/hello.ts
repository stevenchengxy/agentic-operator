/**
 * Platform Inngest liveness function. A real `system/PING` event exercises
 * broker routing, durable sleep and function execution on the `__system` app.
 */

import { inngest } from "./client";
import type { InngestFunction } from "inngest";

/**
 * Explicit `InngestFunction.Any` annotation — TS 6 (TS2883) refuses to infer
 * function types that reference Inngest v4 internal symbols across package
 * boundaries. Runtime registration supplies the concrete event contract.
 */
export const helloFn: InngestFunction.Any = inngest.createFunction(
  {
    id: "system.hello",
    name: "System liveness probe",
    triggers: [{ event: "system/PING" }],
  },
  async ({ event, step, logger }) => {
    const data = (event.data ?? {}) as { from?: string };
    logger.info("[system-liveness] received PING", { from: data.from });
    await step.sleep("durable-liveness-sleep", "200ms");
    return { ok: true, at: Date.now(), from: data.from ?? "anonymous" };
  },
);
