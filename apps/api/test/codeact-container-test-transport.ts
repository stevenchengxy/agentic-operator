import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { PassThrough } from "node:stream";

import type {
  CodeActDockerAdmin,
  CodeActDockerTransport,
  CodeActOrphanCandidate,
  DockerCandidateAttach,
  DockerCandidateCreateConfig,
  DockerCandidateInspect,
} from "@agentic/runtime";

export const TEST_CODEACT_CANDIDATE_IMAGE =
  `test/codeact-candidate@sha256:${"a".repeat(64)}`;

const bootstrap = fileURLToPath(new URL(
  "../../../packages/runtime/src/codeact-candidate-bootstrap.cjs",
  import.meta.url,
));

interface RecordState {
  id: string;
  config: DockerCandidateCreateConfig;
  input: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  child?: ChildProcessWithoutNullStreams;
  exitCode: number;
  oomKilled: boolean;
  removed: boolean;
  createdAtMs: number;
  closed: Promise<void>;
  close(): void;
  waited: Promise<{ statusCode: number }>;
  resolveWait(value: { statusCode: number }): void;
}

/** Test-only transport that exercises the exact JSON-lines bootstrap without
 * claiming OS isolation. Production code never imports files under test/. */
export class InProcessCodeActContainerTestTransport implements CodeActDockerTransport, CodeActDockerAdmin {
  private readonly records = new Map<string, RecordState>();

  async create(_name: string, config: DockerCandidateCreateConfig): Promise<{ id: string }> {
    const id = randomBytes(32).toString("hex");
    let close!: () => void;
    const closed = new Promise<void>((resolve) => { close = resolve; });
    let resolveWait!: (value: { statusCode: number }) => void;
    const waited = new Promise<{ statusCode: number }>((resolve) => { resolveWait = resolve; });
    this.records.set(id, {
      id,
      config,
      input: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exitCode: -1,
      oomKilled: false,
      removed: false,
      createdAtMs: Date.now(),
      closed,
      close,
      waited,
      resolveWait,
    });
    return { id };
  }

  async inspect(id: string): Promise<DockerCandidateInspect | null> {
    const record = this.records.get(id);
    if (!record || record.removed) return null;
    return {
      Id: id,
      Image: `sha256:${"b".repeat(64)}`,
      Config: {
        Image: record.config.Image,
        User: record.config.User,
        Env: [],
        Entrypoint: record.config.Entrypoint,
      },
      HostConfig: { ...record.config.HostConfig },
      Mounts: [],
      State: { OOMKilled: record.oomKilled, ExitCode: record.exitCode },
    };
  }

  async ping(): Promise<void> {}

  async inspectImage(): Promise<{ Id: string; RepoDigests: string[] }> {
    return {
      Id: `sha256:${"b".repeat(64)}`,
      RepoDigests: [TEST_CODEACT_CANDIDATE_IMAGE],
    };
  }

  async listCandidates(
    executionPlane: "factory-sandbox" | "production-codeact",
  ): Promise<CodeActOrphanCandidate[]> {
    return [...this.records.values()]
      .filter((record) => !record.removed && record.config.Labels["io.agentic.execution-plane"] === executionPlane)
      .map((record) => ({
        id: record.id,
        createdAtMs: record.createdAtMs,
        state: record.exitCode < 0 ? "running" : "exited",
        labels: { ...record.config.Labels },
      }));
  }

  inspectContainer(id: string): Promise<DockerCandidateInspect | null> {
    return this.inspect(id);
  }

  removeContainer(id: string): Promise<void> {
    return this.remove(id);
  }

  async attach(id: string): Promise<DockerCandidateAttach> {
    const record = this.required(id);
    return {
      input: record.input,
      stdout: record.stdout,
      stderr: record.stderr,
      closed: record.closed,
    };
  }

  async start(id: string): Promise<void> {
    const record = this.required(id);
    const child = spawn(
      process.execPath,
      [bootstrap],
      { stdio: ["pipe", "pipe", "pipe"], env: {}, cwd: "/tmp" },
    );
    record.child = child;
    record.input.pipe(child.stdin);
    child.stdout.pipe(record.stdout, { end: false });
    child.stderr.pipe(record.stderr, { end: false });
    child.once("exit", (code, signal) => {
      record.exitCode = typeof code === "number" ? code : signal === "SIGKILL" ? 137 : 1;
      record.resolveWait({ statusCode: record.exitCode });
      record.stdout.end();
      record.stderr.end();
      record.close();
    });
    child.once("error", () => {
      record.exitCode = 1;
      record.resolveWait({ statusCode: 1 });
      record.close();
    });
  }

  wait(id: string): Promise<{ statusCode: number }> {
    return this.required(id).waited;
  }

  async kill(id: string): Promise<void> {
    this.required(id).child?.kill("SIGKILL");
  }

  async remove(id: string): Promise<void> {
    const record = this.required(id);
    if (record.child && record.exitCode < 0) throw new Error("test candidate is still running");
    record.removed = true;
  }

  private required(id: string): RecordState {
    const record = this.records.get(id);
    if (!record) throw new Error(`missing test candidate ${id}`);
    return record;
  }
}

export function codeActContainerTestOptions() {
  return {
    candidateImage: TEST_CODEACT_CANDIDATE_IMAGE,
    containerTransport: new InProcessCodeActContainerTestTransport(),
  };
}
