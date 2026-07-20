import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ChatRequest, ChatResponse } from "@agentic/llm-gateway";

import { appendToLedger } from "./event-ledger";
import { writeArtifact } from "./artifacts";
import { runGeneratedCode } from "./codeact";
import { makeGeneratedAgentPrompt } from "./generated-agent";
import { setRuntimeGateway } from "./llm-host";
import { runAction } from "./step-engine";

let logsRoot = "";
let originalLogsRoot: string | undefined;
let originalArtifactsRoot: string | undefined;

beforeEach(async () => {
  originalLogsRoot = process.env.AGENTIC_LOGS_DIR;
  originalArtifactsRoot = process.env.AGENTIC_ARTIFACTS_DIR;
  logsRoot = await mkdtemp(path.join(tmpdir(), "runtime-ledger-truth-"));
  process.env.AGENTIC_LOGS_DIR = logsRoot;
  process.env.AGENTIC_ARTIFACTS_DIR = logsRoot;
});

afterEach(async () => {
  if (originalLogsRoot === undefined) delete process.env.AGENTIC_LOGS_DIR;
  else process.env.AGENTIC_LOGS_DIR = originalLogsRoot;
  if (originalArtifactsRoot === undefined) delete process.env.AGENTIC_ARTIFACTS_DIR;
  else process.env.AGENTIC_ARTIFACTS_DIR = originalArtifactsRoot;
  await rm(logsRoot, { recursive: true, force: true });
});

describe.sequential("runtime persistence truth", () => {
  it("returns a unique, correct byte offset for every concurrent ledger append", async () => {
    const records = Array.from({ length: 32 }, (_, index) => ({
      id: `evt-${index}`,
      name: "truth.event",
      data: { index },
      ts: index,
    }));
    const refs = await Promise.all(
      records.map((record) => appendToLedger("truth", record)),
    );

    expect(new Set(refs).size).toBe(records.length);
    const bytes = await readFile(refs[0]!.slice(0, refs[0]!.lastIndexOf("#")));
    for (let index = 0; index < refs.length; index++) {
      const ref = refs[index]!;
      const offset = Number(ref.slice(ref.lastIndexOf("#") + 1));
      const newline = bytes.indexOf(0x0a, offset);
      const line = bytes.subarray(offset, newline).toString("utf8");
      expect(JSON.parse(line)).toMatchObject({ id: `evt-${index}` });
    }
  });

  it("writes artifacts atomically and rejects unsafe or non-JSON paths", async () => {
    const filePath = await writeArtifact("run-truth", "step-1-output.json", {
      ok: true,
    });
    expect(JSON.parse(await readFile(filePath, "utf8"))).toEqual({ ok: true });
    expect(await readdir(path.dirname(filePath))).toEqual(["step-1-output.json"]);

    await expect(
      writeArtifact("../escape", "step-1-output.json", { ok: true }),
    ).rejects.toThrow(/run id must be a safe leaf name/);
    await expect(
      writeArtifact("run-truth", "../escape.json", { ok: true }),
    ).rejects.toThrow(/must be a safe leaf name/);
    await expect(
      writeArtifact("run-truth", "step-2-output.json", undefined),
    ).rejects.toThrow(/not JSON-serializable/);
  });

  it("rejects a generated-agent event that cannot be represented as JSON", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const prompt = makeGeneratedAgentPrompt("truth");

    expect(() =>
      prompt.template({ event: { name: "truth", data: circular } } as never),
    ).toThrow(/circular|JSON/i);
  });

  it("fails closed when a production manifest still claims executable generated code", async () => {
    const result = await runAction({
      action: { name: "reason", type: "logic", description: "reason" },
      ctx: {
        agentName: "legacy-agent",
        actionName: "reason",
        correlationId: "cor-legacy",
        tenantSlug: "production",
        event: { name: "truth", data: {} },
      },
      agent: {
        name: "legacy-agent",
        generated: true,
        codeExecuted: true,
        typescriptCode:
          "export const agent = defineAgent({ async handler() { return { ok: true }; } });",
      },
    });

    expect(result).toMatchObject({
      ok: false,
      meta: {
        error: "generated_code_requires_sandbox",
        codeExecuted: false,
        tenantSlug: "production",
      },
    });
  });

  it("rejects undeclared CodeAct imports instead of injecting an empty module", async () => {
    const warn = console.warn;
    const originalExec = process.env.FACTORY_EXEC_GENERATED;
    console.warn = () => undefined;
    process.env.FACTORY_EXEC_GENERATED = "1";
    try {
      const result = await runGeneratedCode(
        'import value from "undeclared-package"; export const agent = defineAgent({ async handler() { return { value }; } });',
        {},
        { tenantSlug: "truth-sb" },
      );
      expect(result).toBeNull();
    } finally {
      console.warn = warn;
      if (originalExec === undefined) delete process.env.FACTORY_EXEC_GENERATED;
      else process.env.FACTORY_EXEC_GENERATED = originalExec;
    }
  });

  it("marks an unserialisable tool observation as an explicit tool error", async () => {
    const requests: ChatRequest[] = [];
    const replies: ChatResponse[] = [
      {
        text: "",
        provider: "openai",
        model: "truth-model",
        tokensIn: 2,
        tokensOut: 1,
        finishReason: "tool_calls",
        latencyMs: 1,
        toolCalls: [{ id: "call-1", name: "circular", input: {} }],
      },
      {
        text: "recovered",
        provider: "openai",
        model: "truth-model",
        tokensIn: 3,
        tokensOut: 1,
        finishReason: "stop",
        latencyMs: 1,
      },
    ];
    setRuntimeGateway({
      defaultProvider: "openai",
      defaultModel: "truth-model",
      async chat(request: ChatRequest) {
        requests.push(request);
        return replies.shift()!;
      },
    } as never);

    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const result = await runAction({
      action: { name: "reason", type: "logic", description: "reason" },
      ctx: {
        agentName: "truth-agent",
        actionName: "reason",
        correlationId: "cor-truth",
        tenantSlug: "truth",
        event: { name: "truth", data: {} },
      },
      agent: {
        name: "truth-agent",
        tool_use: [{ name: "circular" }],
      },
      tenantRegistry: {
        prompts: {
          reason: {
            kind: "prompt",
            name: "reason",
            template: () => "reason",
          },
        },
        tools: {
          circular: {
            kind: "tool",
            name: "circular",
            description: "returns a circular value",
            handler: async () => ({ data: circular }),
          },
        },
      } as never,
    });

    expect(result.ok).toBe(true);
    expect(requests).toHaveLength(2);
    const trace = (result.meta?.toolCalls as Array<Record<string, unknown>>)[0];
    expect(trace).toMatchObject({ name: "circular", isError: true });
    expect(trace?.output).toMatchObject({
      error: expect.stringMatching(/not JSON-serializable/),
    });
    const toolMessage = requests[1]!.messages.at(-1);
    expect(toolMessage?.role).toBe("tool");
    expect(JSON.stringify(toolMessage)).toContain("not JSON-serializable");
  });
});
