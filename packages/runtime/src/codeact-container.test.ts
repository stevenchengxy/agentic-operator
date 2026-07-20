import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildCodeActContainerConfig,
  codeActCandidateImageAllowlistIssue,
  executeCodeActContainer,
  type CodeActDockerTransport,
  type DockerCandidateAttach,
  type DockerCandidateCreateConfig,
  type DockerCandidateInspect,
} from "./codeact-container";

const image = `agentic-codeact-candidate@sha256:${"a".repeat(64)}`;
const previousGenerated = process.env.FACTORY_EXEC_GENERATED;

beforeEach(() => {
  process.env.FACTORY_EXEC_GENERATED = "1";
});

afterEach(() => {
  if (previousGenerated === undefined) delete process.env.FACTORY_EXEC_GENERATED;
  else process.env.FACTORY_EXEC_GENERATED = previousGenerated;
});

class FakeDockerTransport implements CodeActDockerTransport {
  createConfig?: DockerCandidateCreateConfig;
  removed = false;
  started = false;
  killed = false;
  command?: Record<string, unknown>;
  private readonly stdin = new PassThrough();
  private readonly stdout = new PassThrough();
  private readonly stderr = new PassThrough();
  private readonly exitPromise: Promise<{ statusCode: number }>;
  private exitResolve!: (value: { statusCode: number }) => void;
  private readonly closedPromise: Promise<void>;
  private closedResolve!: () => void;

  constructor(
    private readonly cleanupFails = false,
    private readonly onCreate?: () => void,
  ) {
    this.exitPromise = new Promise((resolve) => { this.exitResolve = resolve; });
    this.closedPromise = new Promise((resolve) => { this.closedResolve = resolve; });
    let buffer = "";
    this.stdin.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      while (true) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const message = JSON.parse(line) as Record<string, unknown>;
        if (message.kind === "execute") {
          this.command = message;
          this.stdout.write(`${JSON.stringify({
            kind: "rpc",
            id: 1,
            method: "tool",
            args: ["fixture.lookup", { id: "A" }],
          })}\n`);
        } else if (message.kind === "rpc_result") {
          this.stdout.write(`${JSON.stringify({
            kind: "result",
            ok: true,
            result: { value: message.value },
            emitted: [{ event: "DONE", payload: { ok: true } }],
            rpcCount: 1,
          })}\n`);
          this.exitResolve({ statusCode: 0 });
          this.stdout.end();
          this.stderr.end();
          this.closedResolve();
        }
      }
    });
  }

  async create(_name: string, config: DockerCandidateCreateConfig): Promise<{ id: string }> {
    this.createConfig = config;
    this.onCreate?.();
    return { id: "b".repeat(64) };
  }

  async inspect(_id: string): Promise<DockerCandidateInspect | null> {
    if (this.removed) return null;
    const config = this.createConfig!;
    return {
      Id: "b".repeat(64),
      Image: `sha256:${"c".repeat(64)}`,
      Config: {
        Image: config.Image,
        User: config.User,
        Env: [],
        Entrypoint: config.Entrypoint,
      },
      HostConfig: { ...config.HostConfig },
      Mounts: [],
      State: { OOMKilled: false, ExitCode: this.started ? 0 : -1 },
    };
  }

  async attach(): Promise<DockerCandidateAttach> {
    return {
      input: this.stdin,
      stdout: this.stdout,
      stderr: this.stderr,
      closed: this.closedPromise,
    };
  }

  async start(): Promise<void> {
    this.started = true;
  }

  wait(): Promise<{ statusCode: number }> {
    return this.exitPromise;
  }

  async kill(): Promise<void> {
    this.killed = true;
    this.exitResolve({ statusCode: 137 });
    this.closedResolve();
  }

  async remove(): Promise<void> {
    if (this.cleanupFails) throw new Error("remove denied");
    this.removed = true;
  }
}

const code = `
  import { defineAgent } from "@agentic/runtime";
  export default defineAgent({
    handler: async (input: any, ctx: any) => {
      const value = await ctx.tool("fixture.lookup", { id: input.id });
      ctx.emit("DONE", { ok: true });
      return { value };
    },
  });
`;

describe("one-shot CodeAct container executor", () => {
  it("requires the exact reviewed candidate identity in production", () => {
    expect(codeActCandidateImageAllowlistIssue(image, undefined, true))
      .toMatch(/required in production/);
    expect(codeActCandidateImageAllowlistIssue(
      image,
      JSON.stringify([`sha256:${"f".repeat(64)}`]),
      true,
    )).toMatch(/not in the reviewed allowlist/);
    expect(codeActCandidateImageAllowlistIssue(image, JSON.stringify([image]), true))
      .toBeNull();
  });

  it("constructs a no-network, read-only, no-mount, non-root policy", () => {
    const config = buildCodeActContainerConfig({
      image,
      policy: { memoryMb: 128, cpus: 0.5, pidsLimit: 32 },
      attemptId: "attempt-1",
      codeSha256: "d".repeat(64),
    });

    expect(config).toMatchObject({
      Image: image,
      User: "65532:65532",
      Env: [],
      HostConfig: {
        AutoRemove: false,
        NetworkMode: "none",
        ReadonlyRootfs: true,
        Privileged: false,
        CapDrop: ["ALL"],
        SecurityOpt: ["no-new-privileges"],
        Binds: [],
        Mounts: [],
        Tmpfs: {},
        PidsLimit: 32,
        Memory: 128 * 1024 * 1024,
        MemorySwap: 128 * 1024 * 1024,
        NanoCpus: 500_000_000,
      },
    });
  });

  it("sends code/input over stdin, proxies ctx RPC, and waits for removal proof", async () => {
    const transport = new FakeDockerTransport();
    const onRpc = vi.fn(async () => ({ found: true }));

    const result = await executeCodeActContainer(code, { id: "A" }, {
      timeoutMs: 2_000,
      memoryMb: 128,
      image,
      attemptId: "attempt-1",
      identity: {
        agentName: "container-agent",
        tenantSlug: "tenant-sb-attempt",
        correlationId: "cor-1",
      },
      onRpc,
      transport,
    });

    expect(result).toMatchObject({
      ok: true,
      isolation: "isolated_container",
      executorStarted: true,
      evidence: {
        isolation: "isolated_container",
        candidateImageDigest: image,
        exitCode: 0,
        removed: true,
        absenceVerified: true,
        rpcCount: 1,
      },
    });
    expect(transport.removed).toBe(true);
    expect(transport.createConfig).not.toHaveProperty("code");
    expect(transport.createConfig).not.toHaveProperty("input");
    expect(transport.command).toMatchObject({ kind: "execute", input: { id: "A" } });
    expect(onRpc).toHaveBeenCalledWith("tool", ["fixture.lookup", { id: "A" }]);
  });

  it("rejects a mutable image tag before contacting Docker", async () => {
    const transport = new FakeDockerTransport();
    const result = await executeCodeActContainer(code, {}, {
      timeoutMs: 2_000,
      memoryMb: 128,
      image: "agentic-codeact-candidate:latest",
      identity: { agentName: "agent", tenantSlug: "tenant-sb-x", correlationId: "cor" },
      onRpc: async () => ({}),
      transport,
    });

    expect(result).toMatchObject({ ok: false, failure: "candidate_image_not_pinned", executorStarted: false });
    expect(transport.createConfig).toBeUndefined();
  });

  it("does not return a green result when container removal cannot be proven", async () => {
    const transport = new FakeDockerTransport(true);
    const result = await executeCodeActContainer(code, {}, {
      timeoutMs: 2_000,
      memoryMb: 128,
      image,
      identity: { agentName: "agent", tenantSlug: "tenant-sb-x", correlationId: "cor" },
      onRpc: async () => ({ ok: true }),
      transport,
    });

    expect(result).toMatchObject({
      ok: false,
      failure: "container_cleanup_failed",
      isolation: "isolated_container",
    });
    expect(result).not.toHaveProperty("evidence");
  });

  it("closes the create-to-listener abort race and still proves removal", async () => {
    const controller = new AbortController();
    const transport = new FakeDockerTransport(false, () => controller.abort());
    const result = await executeCodeActContainer(code, {}, {
      timeoutMs: 60_000,
      memoryMb: 128,
      image,
      signal: controller.signal,
      identity: { agentName: "agent", tenantSlug: "tenant-sb-x", correlationId: "cor" },
      onRpc: async () => ({ ok: true }),
      transport,
    });

    expect(result).toMatchObject({
      ok: false,
      failure: "kill_switch",
      isolation: "isolated_container",
      executorStarted: false,
    });
    expect(transport.killed).toBe(true);
    expect(transport.removed).toBe(true);
  });
});
