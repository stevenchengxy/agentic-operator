import { createHash, randomBytes } from "node:crypto";
import * as http from "node:http";
import { createRequire } from "node:module";
import { PassThrough, type Readable, type Writable } from "node:stream";

import { codeActExecutionGate, type CodeActRpcMethod } from "./codeact-worker";
import { GENERATED_CODE_ALLOWLIST } from "./module-runner";

const DEFAULT_SOCKET_PATH = "/var/run/docker.sock";
const DEFAULT_API_VERSION = "v1.45";
const CANDIDATE_ENTRYPOINT = "/opt/agentic/codeact-candidate-bootstrap.cjs";
const MAX_PROTOCOL_BYTES = 8 * 1024 * 1024;
const MAX_RPC_CALLS = 512;
const IMAGE_DIGEST = /^(?:[a-z0-9][a-z0-9._/-]*@)?sha256:[a-f0-9]{64}$/;
const SECRET_ENV_NAME = /(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH|DATABASE|COOKIE|SESSION)/i;

export interface CodeActContainerIdentity {
  agentName: string;
  tenantSlug: string;
  correlationId: string;
  subject?: string;
}

export interface CodeActContainerPolicy {
  memoryMb: number;
  cpus: number;
  pidsLimit: number;
}

export interface CodeActContainerExecutionEvidence {
  schema: "agentic-codeact-container-execution/v1";
  attemptId?: string;
  containerIdHash: string;
  codeSha256: string;
  candidateImageDigest: string;
  imageId: string;
  policyHash: string;
  isolation: "isolated_container";
  startedAt: string;
  completedAt: string;
  removedAt: string;
  exitCode: number;
  oomKilled: boolean;
  rpcCount: number;
  removed: true;
  absenceVerified: true;
}

export interface CodeActCandidateImageInspect {
  Id: string;
  RepoDigests?: string[];
}

export interface CodeActOrphanCandidate {
  id: string;
  createdAtMs: number;
  state: string;
  labels: Record<string, string>;
}

/** Launcher-only Docker administration. Generated candidates never receive
 * this interface or the daemon socket. */
export interface CodeActDockerAdmin {
  ping(): Promise<void>;
  inspectImage(image: string): Promise<CodeActCandidateImageInspect | null>;
  listCandidates(executionPlane: "factory-sandbox" | "production-codeact"): Promise<CodeActOrphanCandidate[]>;
  inspectContainer(id: string): Promise<DockerCandidateInspect | null>;
  removeContainer(id: string): Promise<void>;
}

export type CodeActContainerFailure =
  | "execution_disabled"
  | "isolation_not_allowed"
  | "kill_switch"
  | "candidate_image_not_pinned"
  | "candidate_image_not_allowed"
  | "production_executor_rejected"
  | "production_executor_unavailable"
  | "candidate_payload_invalid"
  | "container_create_failed"
  | "container_policy_mismatch"
  | "container_attach_failed"
  | "container_start_failed"
  | "container_timeout"
  | "container_crashed"
  | "candidate_failed"
  | "rpc_failed"
  | "protocol_failed"
  | "container_cleanup_failed";

interface ContainerResultBase {
  isolation: "isolated_container";
  durationMs: number;
  executorStarted: boolean;
  candidateImageDigest: string | null;
  evidence?: CodeActContainerExecutionEvidence;
}

export type CodeActContainerResult =
  | (ContainerResultBase & {
      ok: true;
      result: Record<string, unknown>;
      emitted: Array<{ event: string; payload: Record<string, unknown> }>;
    })
  | (ContainerResultBase & {
      ok: false;
      failure: CodeActContainerFailure;
      error: string;
      timedOut?: boolean;
      crashed?: boolean;
    });

export interface DockerCandidateCreateConfig {
  Image: string;
  Entrypoint: string[];
  Cmd: string[];
  User: string;
  WorkingDir: string;
  Env: string[];
  AttachStdin: true;
  AttachStdout: true;
  AttachStderr: true;
  OpenStdin: true;
  StdinOnce: true;
  Tty: false;
  Labels: Record<string, string>;
  HostConfig: {
    AutoRemove: false;
    NetworkMode: "none";
    ReadonlyRootfs: true;
    Privileged: false;
    CapDrop: ["ALL"];
    SecurityOpt: ["no-new-privileges"];
    PidsLimit: number;
    Memory: number;
    MemorySwap: number;
    NanoCpus: number;
    Binds: [];
    Mounts: [];
    Tmpfs: Record<string, never>;
    LogConfig: { Type: "none"; Config: Record<string, never> };
  };
}

export interface DockerCandidateInspect {
  Id: string;
  Image: string;
  Config: {
    Image: string;
    User: string;
    Env?: string[] | null;
    Entrypoint?: string[] | null;
  };
  HostConfig: {
    NetworkMode: string;
    ReadonlyRootfs: boolean;
    Privileged: boolean;
    CapDrop?: string[] | null;
    SecurityOpt?: string[] | null;
    PidsLimit: number;
    Memory: number;
    MemorySwap: number;
    NanoCpus: number;
    Binds?: string[] | null;
    Mounts?: unknown[] | null;
    Tmpfs?: Record<string, string> | null;
  };
  Mounts?: unknown[];
  State: { OOMKilled?: boolean; ExitCode?: number };
}

export interface DockerCandidateAttach {
  input: Writable;
  stdout: Readable;
  stderr: Readable;
  closed: Promise<void>;
}

export interface CodeActDockerTransport {
  create(name: string, config: DockerCandidateCreateConfig): Promise<{ id: string }>;
  inspect(id: string): Promise<DockerCandidateInspect | null>;
  attach(id: string): Promise<DockerCandidateAttach>;
  start(id: string): Promise<void>;
  wait(id: string): Promise<{ statusCode: number; error?: string }>;
  kill(id: string): Promise<void>;
  remove(id: string): Promise<void>;
}

interface DockerSocketTransportOptions {
  socketPath?: string;
  apiVersion?: string;
  requestTimeoutMs?: number;
}

function limitedJson(value: unknown, label: string): unknown {
  const encoded = JSON.stringify(value === undefined ? null : value);
  if (encoded === undefined) throw new TypeError(`${label} has no JSON representation`);
  if (Buffer.byteLength(encoded, "utf8") > MAX_PROTOCOL_BYTES) {
    throw new TypeError(`${label} exceeds ${MAX_PROTOCOL_BYTES} bytes`);
  }
  return JSON.parse(encoded) as unknown;
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
    .join(",")}}`;
}

export function isPinnedCodeActCandidateImage(image: string): boolean {
  return IMAGE_DIGEST.test(image.trim());
}

export function codeActCandidateImageAllowlistIssue(
  image: string,
  raw = process.env.FACTORY_CODEACT_ALLOWED_IMAGE_DIGESTS,
  production = process.env.NODE_ENV === "production",
): string | null {
  if (!raw?.trim()) {
    return production
      ? "FACTORY_CODEACT_ALLOWED_IMAGE_DIGESTS is required in production"
      : null;
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { return "FACTORY_CODEACT_ALLOWED_IMAGE_DIGESTS must be a JSON array"; }
  if (
    !Array.isArray(parsed)
    || parsed.length < 1
    || parsed.length > 64
    || parsed.some((entry) => typeof entry !== "string" || !isPinnedCodeActCandidateImage(entry))
    || new Set(parsed).size !== parsed.length
  ) {
    return "FACTORY_CODEACT_ALLOWED_IMAGE_DIGESTS must contain 1-64 unique immutable image identities";
  }
  return parsed.includes(image)
    ? null
    : "configured CodeAct candidate image is not in the reviewed allowlist";
}

export function buildCodeActContainerConfig(input: {
  image: string;
  policy: CodeActContainerPolicy;
  attemptId?: string;
  codeSha256: string;
  executionPlane?: "factory-sandbox" | "production-codeact";
}): DockerCandidateCreateConfig {
  const memoryBytes = input.policy.memoryMb * 1024 * 1024;
  return {
    Image: input.image,
    Entrypoint: ["node", CANDIDATE_ENTRYPOINT],
    Cmd: [],
    User: "65532:65532",
    WorkingDir: "/",
    Env: [],
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    OpenStdin: true,
    StdinOnce: true,
    Tty: false,
    Labels: {
      "io.agentic.role": "codeact-candidate",
      "io.agentic.code-sha256": input.codeSha256,
      "io.agentic.execution-plane": input.executionPlane ?? "factory-sandbox",
      ...(input.attemptId ? { "io.agentic.attempt-id-hash": `sha256:${digest(input.attemptId)}` } : {}),
    },
    HostConfig: {
      AutoRemove: false,
      NetworkMode: "none",
      ReadonlyRootfs: true,
      Privileged: false,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges"],
      PidsLimit: input.policy.pidsLimit,
      Memory: memoryBytes,
      MemorySwap: memoryBytes,
      NanoCpus: Math.floor(input.policy.cpus * 1_000_000_000),
      Binds: [],
      Mounts: [],
      Tmpfs: {},
      LogConfig: { Type: "none", Config: {} },
    },
  };
}

function containerPolicyIssues(
  inspected: DockerCandidateInspect,
  expected: DockerCandidateCreateConfig,
): string[] {
  const issues: string[] = [];
  const host = inspected.HostConfig;
  if (inspected.Config.Image !== expected.Image) issues.push("candidate image reference changed");
  if (inspected.Config.User !== expected.User) issues.push("candidate is not the configured non-root uid/gid");
  if (host.NetworkMode !== "none") issues.push("network mode is not none");
  if (host.ReadonlyRootfs !== true) issues.push("root filesystem is writable");
  if (host.Privileged !== false) issues.push("container is privileged");
  if (!(host.CapDrop ?? []).map((entry) => entry.toUpperCase()).includes("ALL")) issues.push("not all capabilities are dropped");
  if (!(host.SecurityOpt ?? []).some((entry) => entry.startsWith("no-new-privileges"))) issues.push("no-new-privileges is missing");
  if (host.PidsLimit !== expected.HostConfig.PidsLimit) issues.push("pid limit changed");
  if (host.Memory !== expected.HostConfig.Memory || host.MemorySwap !== expected.HostConfig.MemorySwap) issues.push("memory limit changed");
  if (host.NanoCpus !== expected.HostConfig.NanoCpus) issues.push("cpu limit changed");
  if ((host.Binds ?? []).length || (host.Mounts ?? []).length || (inspected.Mounts ?? []).length) issues.push("candidate has a mount");
  if (Object.keys(host.Tmpfs ?? {}).length) issues.push("candidate has a tmpfs mount");
  if ((inspected.Config.Entrypoint ?? []).join("\u0000") !== expected.Entrypoint.join("\u0000")) issues.push("candidate entrypoint changed");
  const unsafeEnv = (inspected.Config.Env ?? []).map((entry) => entry.split("=", 1)[0] ?? "").filter((name) => SECRET_ENV_NAME.test(name));
  if (unsafeEnv.length) issues.push("candidate image exposes secret-shaped environment variables");
  if (!/^sha256:[a-f0-9]{64}$/.test(inspected.Image)) issues.push("daemon image id is not content-addressed");
  return issues;
}

class DockerMultiplexDecoder {
  private pending = Buffer.alloc(0);

  constructor(
    private readonly stdout: PassThrough,
    private readonly stderr: PassThrough,
  ) {}

  push(chunk: Buffer): void {
    this.pending = Buffer.concat([this.pending, chunk]);
    while (this.pending.length >= 8) {
      const stream = this.pending[0];
      const size = this.pending.readUInt32BE(4);
      if (size > MAX_PROTOCOL_BYTES) throw new Error("Docker attach frame exceeds protocol limit");
      if (this.pending.length < 8 + size) return;
      const payload = this.pending.subarray(8, 8 + size);
      this.pending = this.pending.subarray(8 + size);
      if (stream === 1) this.stdout.write(payload);
      else if (stream === 2) this.stderr.write(payload);
    }
  }

  end(): void {
    this.stdout.end();
    this.stderr.end();
  }
}

/** Minimal Docker Engine client. The workload mounts only the daemon socket;
 * no docker CLI or host filesystem path is injected into the candidate. */
export class DockerSocketCodeActTransport implements CodeActDockerTransport, CodeActDockerAdmin {
  private readonly socketPath: string;
  private readonly apiVersion: string;
  private readonly requestTimeoutMs: number;

  constructor(options: DockerSocketTransportOptions = {}) {
    this.socketPath = options.socketPath ?? process.env.FACTORY_CODEACT_DOCKER_SOCKET ?? DEFAULT_SOCKET_PATH;
    this.apiVersion = options.apiVersion ?? process.env.FACTORY_CODEACT_DOCKER_API_VERSION ?? DEFAULT_API_VERSION;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
  }

  private path(pathname: string): string {
    return `/${this.apiVersion.replace(/^\//, "")}${pathname}`;
  }

  private request(input: {
    method: string;
    path: string;
    body?: unknown;
    accepted?: number[];
  }): Promise<{ statusCode: number; body: string }> {
    const encoded = input.body === undefined ? undefined : JSON.stringify(input.body);
    return new Promise((resolve, reject) => {
      const request = http.request({
        socketPath: this.socketPath,
        method: input.method,
        path: this.path(input.path),
        headers: encoded === undefined
          ? { accept: "application/json" }
          : {
              accept: "application/json",
              "content-type": "application/json",
              "content-length": Buffer.byteLength(encoded),
            },
      });
      const chunks: Buffer[] = [];
      let total = 0;
      request.setTimeout(this.requestTimeoutMs, () => request.destroy(new Error("Docker API request timed out")));
      request.on("response", (response) => {
        response.on("data", (chunk: Buffer) => {
          total += chunk.length;
          if (total <= 2 * 1024 * 1024) chunks.push(chunk);
        });
        response.on("end", () => {
          const statusCode = response.statusCode ?? 0;
          const body = Buffer.concat(chunks).toString("utf8");
          if (!(input.accepted ?? [200, 201, 204]).includes(statusCode)) {
            reject(new Error(`Docker API ${input.method} ${input.path} returned ${statusCode}: ${body.slice(0, 800)}`));
            return;
          }
          resolve({ statusCode, body });
        });
      });
      request.on("error", reject);
      if (encoded !== undefined) request.write(encoded);
      request.end();
    });
  }

  async ping(): Promise<void> {
    const response = await this.request({ method: "GET", path: "/_ping", accepted: [200] });
    if (response.body.trim() !== "OK") throw new Error("Docker daemon ping did not return OK");
  }

  async inspectImage(image: string): Promise<CodeActCandidateImageInspect | null> {
    const response = await this.request({
      method: "GET",
      path: `/images/${encodeURIComponent(image)}/json`,
      accepted: [200, 404],
    });
    if (response.statusCode === 404) return null;
    const parsed = JSON.parse(response.body) as CodeActCandidateImageInspect;
    if (!/^sha256:[a-f0-9]{64}$/.test(parsed.Id)) {
      throw new Error("Docker candidate image has no immutable local image id");
    }
    return parsed;
  }

  async listCandidates(
    executionPlane: "factory-sandbox" | "production-codeact",
  ): Promise<CodeActOrphanCandidate[]> {
    const filters = encodeURIComponent(JSON.stringify({
      label: [
        "io.agentic.role=codeact-candidate",
      ],
    }));
    const response = await this.request({
      method: "GET",
      path: `/containers/json?all=1&filters=${filters}`,
      accepted: [200],
    });
    const parsed = JSON.parse(response.body) as Array<{
      Id?: unknown;
      Created?: unknown;
      State?: unknown;
      Labels?: unknown;
    }>;
    if (!Array.isArray(parsed)) throw new Error("Docker candidate list is not an array");
    return parsed.map((entry) => {
      if (typeof entry.Id !== "string" || !/^[a-f0-9]{12,64}$/.test(entry.Id)) {
        throw new Error("Docker candidate list contains an invalid container id");
      }
      const labels = entry.Labels && typeof entry.Labels === "object" && !Array.isArray(entry.Labels)
        ? Object.fromEntries(Object.entries(entry.Labels as Record<string, unknown>)
          .filter((pair): pair is [string, string] => typeof pair[1] === "string"))
        : {};
      return {
        id: entry.Id,
        createdAtMs: typeof entry.Created === "number" ? entry.Created * 1_000 : 0,
        state: typeof entry.State === "string" ? entry.State : "unknown",
        labels,
      };
    }).filter((entry) => {
      const plane = entry.labels["io.agentic.execution-plane"];
      return plane === executionPlane || (executionPlane === "factory-sandbox" && !plane);
    });
  }

  inspectContainer(id: string): Promise<DockerCandidateInspect | null> {
    return this.inspect(id);
  }

  removeContainer(id: string): Promise<void> {
    return this.remove(id);
  }

  async create(name: string, config: DockerCandidateCreateConfig): Promise<{ id: string }> {
    const response = await this.request({
      method: "POST",
      path: `/containers/create?name=${encodeURIComponent(name)}`,
      body: config,
      accepted: [201],
    });
    const parsed = JSON.parse(response.body) as { Id?: unknown };
    if (typeof parsed.Id !== "string" || !/^[a-f0-9]{12,64}$/.test(parsed.Id)) {
      throw new Error("Docker create returned no canonical container id");
    }
    return { id: parsed.Id };
  }

  async inspect(id: string): Promise<DockerCandidateInspect | null> {
    const response = await this.request({
      method: "GET",
      path: `/containers/${encodeURIComponent(id)}/json`,
      accepted: [200, 404],
    });
    if (response.statusCode === 404) return null;
    return JSON.parse(response.body) as DockerCandidateInspect;
  }

  attach(id: string): Promise<DockerCandidateAttach> {
    return new Promise((resolve, reject) => {
      const request = http.request({
        socketPath: this.socketPath,
        method: "POST",
        path: this.path(`/containers/${encodeURIComponent(id)}/attach?stream=1&stdin=1&stdout=1&stderr=1`),
        headers: { connection: "Upgrade", upgrade: "tcp" },
      });
      request.setTimeout(this.requestTimeoutMs, () => request.destroy(new Error("Docker attach timed out")));
      request.once("upgrade", (_response, socket, head) => {
        const stdout = new PassThrough();
        const stderr = new PassThrough();
        const decoder = new DockerMultiplexDecoder(stdout, stderr);
        let closedResolve!: () => void;
        const closed = new Promise<void>((done) => { closedResolve = done; });
        let ended = false;
        const finish = () => {
          if (ended) return;
          ended = true;
          decoder.end();
          closedResolve();
        };
        socket.on("data", (chunk: Buffer) => {
          try { decoder.push(chunk); }
          catch (error) { socket.destroy(error as Error); }
        });
        socket.once("end", finish);
        socket.once("close", finish);
        socket.once("error", finish);
        if (head.length) decoder.push(head);
        resolve({ input: socket, stdout, stderr, closed });
      });
      request.once("response", (response) => {
        reject(new Error(`Docker attach did not upgrade (status=${response.statusCode ?? 0})`));
        response.resume();
      });
      request.once("error", reject);
      request.end();
    });
  }

  async start(id: string): Promise<void> {
    await this.request({ method: "POST", path: `/containers/${encodeURIComponent(id)}/start`, accepted: [204] });
  }

  async wait(id: string): Promise<{ statusCode: number; error?: string }> {
    const response = await this.request({
      method: "POST",
      path: `/containers/${encodeURIComponent(id)}/wait?condition=not-running`,
      accepted: [200],
    });
    const parsed = JSON.parse(response.body) as { StatusCode?: unknown; Error?: { Message?: unknown } };
    if (!Number.isInteger(parsed.StatusCode)) throw new Error("Docker wait returned no exit code");
    return {
      statusCode: parsed.StatusCode as number,
      ...(typeof parsed.Error?.Message === "string" ? { error: parsed.Error.Message } : {}),
    };
  }

  async kill(id: string): Promise<void> {
    await this.request({
      method: "POST",
      path: `/containers/${encodeURIComponent(id)}/kill?signal=SIGKILL`,
      accepted: [204, 304, 404, 409],
    });
  }

  async remove(id: string): Promise<void> {
    await this.request({
      method: "DELETE",
      path: `/containers/${encodeURIComponent(id)}?force=1&v=1`,
      accepted: [204, 404],
    });
  }
}

interface AttemptEvidenceRegistry {
  executions: CodeActContainerExecutionEvidence[];
}

const attemptEvidence = new Map<string, AttemptEvidenceRegistry>();

export function beginCodeActContainerAttempt(attemptId: string): void {
  if (!attemptId.trim()) throw new Error("CodeAct container attempt id is required");
  if (attemptEvidence.has(attemptId)) throw new Error(`CodeAct container attempt '${attemptId}' is already active`);
  attemptEvidence.set(attemptId, { executions: [] });
}

export function finishCodeActContainerAttempt(attemptId: string): CodeActContainerExecutionEvidence[] {
  const registry = attemptEvidence.get(attemptId);
  attemptEvidence.delete(attemptId);
  return registry ? [...registry.executions] : [];
}

function recordAttemptEvidence(evidence: CodeActContainerExecutionEvidence): void {
  if (!evidence.attemptId) return;
  attemptEvidence.get(evidence.attemptId)?.executions.push(evidence);
}

function transpileCandidate(code: string): string {
  const ts = createRequire(import.meta.url)("typescript") as typeof import("typescript");
  const output = ts.transpileModule(code, {
    reportDiagnostics: true,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  });
  const errors = (output.diagnostics ?? []).filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
  if (errors.length) {
    throw new Error(errors.slice(0, 5).map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")).join("; "));
  }
  return output.outputText;
}

interface ProtocolResult {
  ok: boolean;
  result?: Record<string, unknown>;
  emitted?: Array<{ event: string; payload: Record<string, unknown> }>;
  failure?: string;
  error?: string;
  rpcCount?: number;
}

export interface CodeActContainerOptions {
  timeoutMs: number;
  memoryMb: number;
  cpus?: number;
  pidsLimit?: number;
  image?: string;
  attemptId?: string;
  executionPlane?: "factory-sandbox" | "production-codeact";
  signal?: AbortSignal;
  identity: CodeActContainerIdentity;
  onRpc(method: CodeActRpcMethod, args: unknown[]): Promise<unknown>;
  onLog?(level: "info" | "warn" | "error", message: string, data?: unknown): void;
  transport?: CodeActDockerTransport;
}

function safeContainerName(identity: CodeActContainerIdentity): string {
  const random = randomBytes(6).toString("hex");
  const agent = identity.agentName.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^[^a-z0-9]+/, "").slice(0, 40) || "agent";
  return `agentic-codeact-${agent}-${random}`.slice(0, 100);
}

/** Execute exact generated handler bytes in a one-shot, no-mount/no-network
 * container and return only after Docker confirms removal. Never falls back to
 * worker/vm/process. */
export async function executeCodeActContainer(
  code: string,
  input: Record<string, unknown>,
  options: CodeActContainerOptions,
): Promise<CodeActContainerResult> {
  const startedClock = Date.now();
  const duration = () => Date.now() - startedClock;
  if (options.signal?.aborted) {
    return {
      ok: false,
      isolation: "isolated_container",
      failure: "kill_switch",
      error: "candidate execution was aborted by its trusted launcher before start",
      durationMs: duration(),
      executorStarted: false,
      candidateImageDigest: null,
    };
  }
  const gate = codeActExecutionGate("isolated_container");
  if (!gate.allowed) {
    return {
      ok: false,
      isolation: "isolated_container",
      failure: gate.failure,
      error: gate.reason,
      durationMs: duration(),
      executorStarted: false,
      candidateImageDigest: null,
    };
  }
  const image = (options.image ?? process.env.FACTORY_CODEACT_CANDIDATE_IMAGE ?? "").trim();
  if (!isPinnedCodeActCandidateImage(image)) {
    return {
      ok: false,
      isolation: "isolated_container",
      failure: "candidate_image_not_pinned",
      error: "FACTORY_CODEACT_CANDIDATE_IMAGE must be an exact sha256 image id or repository@sha256 digest",
      durationMs: duration(),
      executorStarted: false,
      candidateImageDigest: image || null,
    };
  }
  const allowlistIssue = codeActCandidateImageAllowlistIssue(image);
  if (allowlistIssue) {
    return {
      ok: false,
      isolation: "isolated_container",
      failure: "candidate_image_not_allowed",
      error: allowlistIssue,
      durationMs: duration(),
      executorStarted: false,
      candidateImageDigest: image,
    };
  }

  const codeSha256 = digest(code);
  let javascript: string;
  let wireInput: unknown;
  try {
    javascript = transpileCandidate(code);
    wireInput = limitedJson(input, "candidate input");
    limitedJson(javascript, "compiled candidate code");
  } catch (error) {
    return {
      ok: false,
      isolation: "isolated_container",
      failure: "candidate_payload_invalid",
      error: String((error as Error)?.message ?? error).slice(0, 800),
      durationMs: duration(),
      executorStarted: false,
      candidateImageDigest: image,
    };
  }

  const policy: CodeActContainerPolicy = {
    memoryMb: Math.max(64, Math.min(4_096, Math.floor(options.memoryMb))),
    cpus: Math.max(0.1, Math.min(8, options.cpus ?? 1)),
    pidsLimit: Math.max(16, Math.min(256, Math.floor(options.pidsLimit ?? 64))),
  };
  const createConfig = buildCodeActContainerConfig({
    image,
    policy,
    attemptId: options.attemptId,
    codeSha256,
    executionPlane: options.executionPlane,
  });
  const policyHash = `sha256:${digest(stableJson(createConfig.HostConfig))}`;
  const transport = options.transport ?? new DockerSocketCodeActTransport();
  const name = safeContainerName(options.identity);
  let containerId: string | undefined;
  let attach: DockerCandidateAttach | undefined;
  let inspected: DockerCandidateInspect | null = null;
  let executorStarted = false;
  let completion: CodeActContainerResult | undefined;
  let exitCode = -1;
  let rpcCount = 0;
  let protocolResult: ProtocolResult | undefined;
  let rpcFailure: string | undefined;
  let stderrTail = "";
  let startedAt = new Date().toISOString();
  let completedAt = startedAt;
  let timedOut = false;
  let killSwitchActivated = false;
  let hostAbortActivated = false;
  let rejectHostAbort: ((error: Error) => void) | undefined;
  const abortHandler = (): void => {
    hostAbortActivated = true;
    rejectHostAbort?.(new Error("__CODEACT_CONTAINER_HOST_ABORT__"));
    if (containerId) void transport.kill(containerId).catch(() => undefined);
  };

  try {
    const created = await transport.create(name, createConfig);
    containerId = created.id;
    options.signal?.addEventListener("abort", abortHandler, { once: true });
    // AbortSignal does not replay an abort event to listeners attached after
    // the transition. Close the create→listener race explicitly so shutdown
    // cannot leave a newly-created candidate running until its normal timeout.
    if (options.signal?.aborted) abortHandler();
  } catch (error) {
    return {
      ok: false,
      isolation: "isolated_container",
      failure: "container_create_failed",
      error: String((error as Error)?.message ?? error).slice(0, 800),
      durationMs: duration(),
      executorStarted: false,
      candidateImageDigest: image,
    };
  }

  try {
    inspected = await transport.inspect(containerId);
    if (!inspected) throw new Error("created candidate container disappeared before policy inspection");
    const issues = containerPolicyIssues(inspected, createConfig);
    if (issues.length) {
      completion = {
        ok: false,
        isolation: "isolated_container",
        failure: "container_policy_mismatch",
        error: issues.join("; "),
        durationMs: duration(),
        executorStarted: false,
        candidateImageDigest: image,
      };
    } else {
      try {
        attach = await transport.attach(containerId);
      } catch (error) {
        completion = {
          ok: false,
          isolation: "isolated_container",
          failure: "container_attach_failed",
          error: String((error as Error)?.message ?? error).slice(0, 800),
          durationMs: duration(),
          executorStarted: false,
          candidateImageDigest: image,
        };
      }
    }

    if (!completion && hostAbortActivated) {
      completion = {
        ok: false,
        isolation: "isolated_container",
        failure: "kill_switch",
        error: "candidate execution was aborted by its trusted launcher",
        durationMs: duration(),
        executorStarted: false,
        candidateImageDigest: image,
      };
    }

    if (!completion && attach) {
      let stdoutBuffer = "";
      attach.stdout.on("data", (chunk: Buffer | string) => {
        stdoutBuffer += chunk.toString();
        if (Buffer.byteLength(stdoutBuffer, "utf8") > MAX_PROTOCOL_BYTES * 2) {
          rpcFailure = "candidate stdout exceeded protocol limit";
          void transport.kill(containerId!);
          return;
        }
        while (true) {
          const newline = stdoutBuffer.indexOf("\n");
          if (newline < 0) break;
          const line = stdoutBuffer.slice(0, newline);
          stdoutBuffer = stdoutBuffer.slice(newline + 1);
          if (!line.trim()) continue;
          let message: Record<string, unknown>;
          try { message = JSON.parse(line) as Record<string, unknown>; }
          catch { continue; }
          if (message.kind === "result") {
            protocolResult = message as unknown as ProtocolResult;
            continue;
          }
          if (message.kind === "log") {
            try {
              options.onLog?.(
                message.level === "warn" || message.level === "error" ? message.level : "info",
                String(message.message ?? "").slice(0, 2_000),
                message.data,
              );
            } catch { /* observability cannot alter execution */ }
            continue;
          }
          if (message.kind !== "rpc") continue;
          const id = message.id;
          const method = message.method;
          if (!Number.isSafeInteger(id) || typeof method !== "string" || ![
            "reason", "tool", "memory.get", "memory.put", "memory.delete",
            "memory.search", "invoke", "spawn",
          ].includes(method)) {
            rpcFailure = "candidate sent a malformed RPC request";
            void transport.kill(containerId!);
            continue;
          }
          rpcCount += 1;
          if (rpcCount > MAX_RPC_CALLS) {
            rpcFailure = `candidate exceeded ${MAX_RPC_CALLS} RPC calls`;
            void transport.kill(containerId!);
            continue;
          }
          void options.onRpc(method as CodeActRpcMethod, Array.isArray(message.args) ? message.args : [])
            .then((value) => {
              if (rpcFailure) return;
              let wire: unknown;
              try { wire = limitedJson(value, `RPC ${method} result`); }
              catch (error) {
                rpcFailure = String((error as Error)?.message ?? error).slice(0, 800);
                void transport.kill(containerId!);
                return;
              }
              attach?.input.write(`${JSON.stringify({ kind: "rpc_result", id, ok: true, value: wire })}\n`);
            })
            .catch((error) => {
              rpcFailure = `RPC ${method} failed: ${String((error as Error)?.message ?? error).slice(0, 700)}`;
              try {
                attach?.input.write(`${JSON.stringify({ kind: "rpc_result", id, ok: false, error: rpcFailure })}\n`);
              } catch { /* container is being terminated */ }
              void transport.kill(containerId!);
            });
        }
      });
      attach.stderr.on("data", (chunk: Buffer | string) => {
        stderrTail = `${stderrTail}${chunk.toString()}`.slice(-4_000);
      });

      try {
        await transport.start(containerId);
        executorStarted = true;
        startedAt = new Date().toISOString();
      } catch (error) {
        completion = {
          ok: false,
          isolation: "isolated_container",
          failure: "container_start_failed",
          error: String((error as Error)?.message ?? error).slice(0, 800),
          durationMs: duration(),
          executorStarted: false,
          candidateImageDigest: image,
        };
      }

      if (!completion) {
        const command = limitedJson({
          kind: "execute",
          javascript,
          input: wireInput,
          identity: options.identity,
          allowlist: [...GENERATED_CODE_ALLOWLIST],
        }, "candidate command");
        attach.input.write(`${JSON.stringify(command)}\n`);

        let timeout: ReturnType<typeof setTimeout> | undefined;
        let killSwitchPoll: ReturnType<typeof setInterval> | undefined;
        const hostAbortPromise = new Promise<never>((_resolve, reject) => {
          rejectHostAbort = reject;
          if (hostAbortActivated || options.signal?.aborted) {
            reject(new Error("__CODEACT_CONTAINER_HOST_ABORT__"));
          }
        });
        const timeoutPromise = new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error("__CODEACT_CONTAINER_TIMEOUT__")), options.timeoutMs);
          timeout.unref?.();
        });
        const killSwitchPromise = new Promise<never>((_resolve, reject) => {
          killSwitchPoll = setInterval(() => {
            if (process.env.FACTORY_EXEC_GENERATED !== "1") {
              reject(new Error("__CODEACT_CONTAINER_KILL_SWITCH__"));
            }
          }, 100);
          killSwitchPoll.unref?.();
        });
        try {
          const waited = await Promise.race([
            transport.wait(containerId),
            timeoutPromise,
            killSwitchPromise,
            hostAbortPromise,
          ]);
          exitCode = waited.statusCode;
          if (waited.error) rpcFailure ??= waited.error;
          await Promise.race([
            attach.closed,
            new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, 1_000);
              timer.unref?.();
            }),
          ]);
        } catch (error) {
          if (String((error as Error)?.message ?? error) === "__CODEACT_CONTAINER_TIMEOUT__") {
            timedOut = true;
            await transport.kill(containerId).catch(() => undefined);
            const waited = await transport.wait(containerId).catch(() => ({ statusCode: 137 }));
            exitCode = waited.statusCode;
          } else if (String((error as Error)?.message ?? error) === "__CODEACT_CONTAINER_KILL_SWITCH__") {
            killSwitchActivated = true;
            await transport.kill(containerId).catch(() => undefined);
            const waited = await transport.wait(containerId).catch(() => ({ statusCode: 137 }));
            exitCode = waited.statusCode;
          } else if (String((error as Error)?.message ?? error) === "__CODEACT_CONTAINER_HOST_ABORT__") {
            hostAbortActivated = true;
            await transport.kill(containerId).catch(() => undefined);
            const waited = await transport.wait(containerId).catch(() => ({ statusCode: 137 }));
            exitCode = waited.statusCode;
          } else {
            rpcFailure ??= String((error as Error)?.message ?? error).slice(0, 800);
            await transport.kill(containerId).catch(() => undefined);
            const waited = await transport.wait(containerId).catch(() => ({ statusCode: 137 }));
            exitCode = waited.statusCode;
          }
        } finally {
          if (timeout) clearTimeout(timeout);
          if (killSwitchPoll) clearInterval(killSwitchPoll);
          rejectHostAbort = undefined;
        }
        completedAt = new Date().toISOString();
        inspected = await transport.inspect(containerId).catch(() => inspected);

        if (hostAbortActivated) {
          completion = {
            ok: false,
            isolation: "isolated_container",
            failure: "kill_switch",
            error: "candidate execution was aborted by its trusted launcher and SIGKILLed",
            durationMs: duration(),
            executorStarted: true,
            candidateImageDigest: image,
          };
        } else if (killSwitchActivated) {
          completion = {
            ok: false,
            isolation: "isolated_container",
            failure: "kill_switch",
            error: "FACTORY_EXEC_GENERATED is no longer exactly 1; candidate container was SIGKILLed",
            durationMs: duration(),
            executorStarted: true,
            candidateImageDigest: image,
          };
        } else if (timedOut) {
          completion = {
            ok: false,
            isolation: "isolated_container",
            failure: "container_timeout",
            error: `candidate exceeded ${options.timeoutMs}ms and was SIGKILLed`,
            timedOut: true,
            durationMs: duration(),
            executorStarted: true,
            candidateImageDigest: image,
          };
        } else if (rpcFailure) {
          completion = {
            ok: false,
            isolation: "isolated_container",
            failure: "rpc_failed",
            error: rpcFailure,
            durationMs: duration(),
            executorStarted: true,
            candidateImageDigest: image,
          };
        } else if (!protocolResult) {
          completion = {
            ok: false,
            isolation: "isolated_container",
            failure: exitCode === 0 ? "protocol_failed" : "container_crashed",
            error: `candidate exited without a result (code=${exitCode})${stderrTail ? `: ${stderrTail}` : ""}`,
            crashed: exitCode !== 0,
            durationMs: duration(),
            executorStarted: true,
            candidateImageDigest: image,
          };
        } else if (exitCode !== 0 || protocolResult.ok !== true) {
          completion = {
            ok: false,
            isolation: "isolated_container",
            failure: protocolResult.failure === "candidate_failed" ? "candidate_failed" : "container_crashed",
            error: protocolResult.error ?? `candidate exited with code ${exitCode}`,
            crashed: exitCode !== 0,
            durationMs: duration(),
            executorStarted: true,
            candidateImageDigest: image,
          };
        } else if (!protocolResult.result || typeof protocolResult.result !== "object") {
          completion = {
            ok: false,
            isolation: "isolated_container",
            failure: "protocol_failed",
            error: "candidate result is missing or malformed",
            durationMs: duration(),
            executorStarted: true,
            candidateImageDigest: image,
          };
        } else {
          completion = {
            ok: true,
            isolation: "isolated_container",
            result: protocolResult.result,
            emitted: Array.isArray(protocolResult.emitted) ? protocolResult.emitted : [],
            durationMs: duration(),
            executorStarted: true,
            candidateImageDigest: image,
          };
        }
      }
    }
  } catch (error) {
    completion = {
      ok: false,
      isolation: "isolated_container",
      failure: "container_policy_mismatch",
      error: String((error as Error)?.message ?? error).slice(0, 800),
      durationMs: duration(),
      executorStarted,
      candidateImageDigest: image,
    };
  } finally {
    try { attach?.input.end(); } catch { /* cleanup below is authoritative */ }
  }

  let removed = false;
  let absenceVerified = false;
  try {
    await transport.remove(containerId);
    removed = true;
    absenceVerified = (await transport.inspect(containerId)) === null;
  } catch (error) {
    completion = {
      ok: false,
      isolation: "isolated_container",
      failure: "container_cleanup_failed",
      error: `candidate container removal failed: ${String((error as Error)?.message ?? error).slice(0, 600)}`,
      durationMs: duration(),
      executorStarted,
      candidateImageDigest: image,
    };
  }
  options.signal?.removeEventListener("abort", abortHandler);
  if (!removed || !absenceVerified) {
    return {
      ok: false,
      isolation: "isolated_container",
      failure: "container_cleanup_failed",
      error: "Docker did not prove candidate container removal and absence",
      durationMs: duration(),
      executorStarted,
      candidateImageDigest: image,
    };
  }

  if (executorStarted && inspected && exitCode >= 0) {
    const evidence: CodeActContainerExecutionEvidence = {
      schema: "agentic-codeact-container-execution/v1",
      ...(options.attemptId ? { attemptId: options.attemptId } : {}),
      containerIdHash: `sha256:${digest(containerId)}`,
      codeSha256,
      candidateImageDigest: image,
      imageId: inspected.Image,
      policyHash,
      isolation: "isolated_container",
      startedAt,
      completedAt,
      removedAt: new Date().toISOString(),
      exitCode,
      oomKilled: inspected.State.OOMKilled === true,
      rpcCount: protocolResult?.rpcCount ?? rpcCount,
      removed: true,
      absenceVerified: true,
    };
    recordAttemptEvidence(evidence);
    return { ...(completion ?? {
      ok: false,
      isolation: "isolated_container",
      failure: "protocol_failed",
      error: "candidate execution produced no completion",
      durationMs: duration(),
      executorStarted: true,
      candidateImageDigest: image,
    }), evidence } as CodeActContainerResult;
  }

  return completion ?? {
    ok: false,
    isolation: "isolated_container",
    failure: "protocol_failed",
    error: "candidate container was removed before execution began",
    durationMs: duration(),
    executorStarted: false,
    candidateImageDigest: image,
  };
}
