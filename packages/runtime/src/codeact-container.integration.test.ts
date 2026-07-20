import { describe, expect, it } from "vitest";

import {
  DockerSocketCodeActTransport,
  executeCodeActContainer,
} from "./codeact-container";

const enabled = process.env.FACTORY_CODEACT_REAL_DOCKER === "1";

describe.skipIf(!enabled)("real one-shot CodeAct Docker boundary", () => {
  it("runs through stdio RPC without inheriting host secrets or mounts and removes itself", async () => {
    const image = process.env.FACTORY_CODEACT_CANDIDATE_IMAGE!;
    const socketPath = process.env.FACTORY_CODEACT_DOCKER_SOCKET!;
    process.env.FACTORY_EXEC_GENERATED = "1";
    process.env.ROBOHIRE_API_KEY = "must-not-enter-candidate";

    const result = await executeCodeActContainer(`
      import { defineAgent } from "@agentic/runtime";
      export default defineAgent({ handler: async (input: any, ctx: any) => {
        const key = ["con", "structor"].join("");
        const hostConstructor = Reflect.get(Object.getPrototypeOf(input), key);
        const hostFunction = Reflect.get(hostConstructor, key);
        const proc = hostFunction("return process")();
        const fs = proc.getBuiltinModule("fs");
        const tool = await ctx.tool("fixture.echo", { value: input.value });
        ctx.emit("DONE", { ok: true });
        return {
          tool,
          uid: proc.getuid(),
          leakedSecret: proc.env.ROBOHIRE_API_KEY || null,
          secretMountPresent: fs.existsSync("/run/secrets"),
          rootEntries: fs.readdirSync("/").sort(),
        };
      }});
    `, { value: 7 }, {
      timeoutMs: 10_000,
      memoryMb: 128,
      image,
      attemptId: "real-docker-integration",
      identity: {
        agentName: "real-docker-probe",
        tenantSlug: "real-docker-sb",
        correlationId: "real-docker-correlation",
      },
      onRpc: async (method, args) => ({ method, args }),
      transport: new DockerSocketCodeActTransport({ socketPath }),
    });

    if (!result.ok) throw new Error(JSON.stringify(result));

    expect(result).toMatchObject({
      ok: true,
      isolation: "isolated_container",
      result: {
        uid: 65532,
        leakedSecret: null,
        secretMountPresent: false,
        tool: { method: "tool" },
      },
      evidence: {
        candidateImageDigest: image,
        isolation: "isolated_container",
        exitCode: 0,
        removed: true,
        absenceVerified: true,
      },
    });
    if (result.ok) {
      expect(result.result.rootEntries).not.toContain("workspace");
      expect(result.result.rootEntries).not.toContain("sandbox");
    }
  }, 30_000);
});
