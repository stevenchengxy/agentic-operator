import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import {
  PRODUCTION_CODEACT_PROTOCOL,
  DockerSocketCodeActTransport,
  codeActCandidateImageAllowlistIssue,
  executeCodeActContainer,
  productionCodeActBearerMatches,
  productionCodeActIdentityHash,
  productionCodeActMessageSignature,
  productionCodeActSecret,
  verifyProductionCodeActMessageSignature,
  type CodeActDockerTransport,
  type CodeActDockerAdmin,
  type ProductionCodeActExecuteCommand,
  type ProductionCodeActRpcRequest,
  type ProductionCodeActRpcResponse,
  type ProductionCodeActTerminalResponse,
} from "@agentic/runtime";

const SHA256 = /^[a-f0-9]{64}$/;
const MAX_ACTIVE_DEFAULT = 8;
const MAX_RPC_PER_EXECUTION = 4_096;
const seenExecutions = new Map<string, number>();

export interface ProductionCodeActExecutorConfig {
  host: string;
  port: number;
  executorId: string;
  buildId: string;
  callbackOrigin: string;
  token: string;
  maxActive: number;
  candidateImage: string;
  candidateImageIds: ReadonlySet<string>;
  reaperIntervalMs: number;
  orphanGraceMs: number;
  drainTimeoutMs: number;
}

function immutableImageIds(raw: string | undefined): Set<string> {
  let parsed: unknown;
  try { parsed = JSON.parse(raw ?? ""); }
  catch { throw new Error("PRODUCTION_CODEACT_ALLOWED_CANDIDATE_IMAGE_IDS must be a JSON array"); }
  if (
    !Array.isArray(parsed)
    || parsed.length < 1
    || parsed.length > 64
    || parsed.some((entry) => typeof entry !== "string" || !/^sha256:[a-f0-9]{64}$/.test(entry))
    || new Set(parsed).size !== parsed.length
  ) throw new Error("PRODUCTION_CODEACT_ALLOWED_CANDIDATE_IMAGE_IDS must contain immutable image ids");
  return new Set(parsed as string[]);
}

function boundedInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  const parsed = value === undefined || value === "" ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be ${minimum}-${maximum}`);
  }
  return parsed;
}

function requiredOrigin(
  raw: string | undefined,
  env: NodeJS.ProcessEnv,
): string {
  if (!raw?.trim()) throw new Error("PRODUCTION_CODEACT_CALLBACK_URL is required");
  const url = new URL(raw);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("PRODUCTION_CODEACT_CALLBACK_URL must be a credential-free origin");
  }
  if (url.protocol === "https:") return url.origin;
  const allowed = new Set((env.PRODUCTION_CODEACT_CALLBACK_HTTP_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean));
  if (
    url.protocol !== "http:"
    || env.AGENTIC_PROCESS_ROLE !== "production-codeact-executor"
    || !allowed.has(url.hostname.toLowerCase())
  ) {
    throw new Error("Plain HTTP CodeAct callback is allowed only to an explicitly allowlisted internal API host");
  }
  return url.origin;
}

export function loadProductionCodeActExecutorConfig(
  env: NodeJS.ProcessEnv = process.env,
): ProductionCodeActExecutorConfig {
  const port = Number(env.PRODUCTION_CODEACT_EXECUTOR_PORT ?? 3570);
  const maxActive = Number(env.PRODUCTION_CODEACT_EXECUTOR_MAX_ACTIVE ?? MAX_ACTIVE_DEFAULT);
  const executorId = env.PRODUCTION_CODEACT_EXECUTOR_ID?.trim()
    || `${env.AGENTIC_BUILD_ID?.trim() || "unverified"}:codeact-executor`;
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PRODUCTION_CODEACT_EXECUTOR_PORT is invalid");
  }
  if (!Number.isSafeInteger(maxActive) || maxActive < 1 || maxActive > 128) {
    throw new Error("PRODUCTION_CODEACT_EXECUTOR_MAX_ACTIVE must be 1-128");
  }
  if (!executorId || executorId.length > 200) throw new Error("production CodeAct executor id is invalid");
  const buildId = env.AGENTIC_BUILD_ID?.trim() ?? "";
  if (!buildId || buildId.length > 200) throw new Error("AGENTIC_BUILD_ID is required for production CodeAct");
  const candidateImage = env.FACTORY_CODEACT_CANDIDATE_IMAGE?.trim() ?? "";
  const allowlistIssue = codeActCandidateImageAllowlistIssue(
    candidateImage,
    env.FACTORY_CODEACT_ALLOWED_IMAGE_DIGESTS,
    true,
  );
  if (allowlistIssue) throw new Error(allowlistIssue);
  return {
    host: env.HOST?.trim() || "0.0.0.0",
    port,
    executorId,
    buildId,
    callbackOrigin: requiredOrigin(env.PRODUCTION_CODEACT_CALLBACK_URL, env),
    token: productionCodeActSecret(env),
    maxActive,
    candidateImage,
    candidateImageIds: immutableImageIds(env.PRODUCTION_CODEACT_ALLOWED_CANDIDATE_IMAGE_IDS),
    reaperIntervalMs: boundedInteger(
      env.PRODUCTION_CODEACT_REAPER_INTERVAL_MS,
      30_000,
      5_000,
      10 * 60_000,
      "PRODUCTION_CODEACT_REAPER_INTERVAL_MS",
    ),
    orphanGraceMs: boundedInteger(
      env.PRODUCTION_CODEACT_ORPHAN_GRACE_MS,
      120_000,
      30_000,
      20 * 60_000,
      "PRODUCTION_CODEACT_ORPHAN_GRACE_MS",
    ),
    drainTimeoutMs: boundedInteger(
      env.PRODUCTION_CODEACT_DRAIN_TIMEOUT_MS,
      15_000,
      1_000,
      60_000,
      "PRODUCTION_CODEACT_DRAIN_TIMEOUT_MS",
    ),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactCommand(
  raw: unknown,
  now: number,
): ProductionCodeActExecuteCommand {
  if (!isRecord(raw)) throw new Error("execute command must be an object");
  const command = raw as unknown as ProductionCodeActExecuteCommand;
  const codeSha256 = typeof command.code === "string"
    ? createHash("sha256").update(command.code, "utf8").digest("hex")
    : "";
  if (
    command.schema !== PRODUCTION_CODEACT_PROTOCOL.execute
    || !/^[0-9a-f-]{36}$/i.test(command.executionId)
    || !/^[0-9a-f-]{36}$/i.test(command.nonce)
    || !isRecord(command.input)
    || !isRecord(command.identity)
    || command.identityHash !== productionCodeActIdentityHash(command.identity)
    || codeSha256 !== command.identity.codeSha256
    || !SHA256.test(command.identity.codeSha256)
    || !command.identity.tenantId?.trim()
    || !command.identity.tenantSlug?.trim()
    || !command.identity.runId?.trim()
    || !command.identity.agentName?.trim()
    || !command.identity.correlationId?.trim()
    || (command.identity.subject !== undefined && typeof command.identity.subject !== "string")
    || !command.identity.promotionVersionId?.trim()
    || !/^regression-suite:v1:/.test(command.identity.regressionSuiteFingerprint)
    || !Number.isFinite(Date.parse(command.issuedAt))
    || !Number.isFinite(Date.parse(command.expiresAt))
    || Date.parse(command.issuedAt) > now + 5_000
    || Date.parse(command.expiresAt) <= now
    || Date.parse(command.expiresAt) - Date.parse(command.issuedAt) > 20 * 60_000
    || !isRecord(command.policy)
    || !Number.isSafeInteger(command.policy.timeoutMs)
    || command.policy.timeoutMs < 1_000
    || command.policy.timeoutMs > 15 * 60_000
    || !Number.isSafeInteger(command.policy.memoryMb)
    || command.policy.memoryMb < 64
    || command.policy.memoryMb > 4_096
    || !Number.isFinite(command.policy.cpus)
    || command.policy.cpus <= 0
    || command.policy.cpus > 8
    || !Number.isSafeInteger(command.policy.pidsLimit)
    || command.policy.pidsLimit < 16
    || command.policy.pidsLimit > 256
  ) {
    throw new Error("execute command identity/policy is invalid");
  }
  return command;
}

async function callbackRpc(input: {
  config: ProductionCodeActExecutorConfig;
  command: ProductionCodeActExecuteCommand;
  method: ProductionCodeActRpcRequest["method"];
  args: unknown[];
  rpcId: string;
  fetchFn: typeof fetch;
}): Promise<unknown> {
  const now = Date.now();
  const body: ProductionCodeActRpcRequest = {
    schema: PRODUCTION_CODEACT_PROTOCOL.rpc,
    executionId: input.command.executionId,
    identityHash: input.command.identityHash,
    codeSha256: input.command.identity.codeSha256,
    rpcId: input.rpcId,
    method: input.method,
    args: input.args,
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(Math.min(Date.parse(input.command.expiresAt), now + 60_000)).toISOString(),
  };
  const response = await input.fetchFn(`${input.config.callbackOrigin}/internal/production-codeact/rpc`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${input.config.token}`,
      "content-type": "application/json",
      "x-agentic-codeact-signature": productionCodeActMessageSignature(body, input.config.token),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(65_000),
  });
  const result = await response.json() as ProductionCodeActRpcResponse;
  if (
    !verifyProductionCodeActMessageSignature(
      result,
      response.headers.get("x-agentic-codeact-signature") ?? undefined,
      input.config.token,
    )
    || result.schema !== PRODUCTION_CODEACT_PROTOCOL.rpcResult
    || result.executionId !== input.command.executionId
    || result.identityHash !== input.command.identityHash
    || result.rpcId !== input.rpcId
  ) {
    throw new Error("primary API returned an invalid signed CodeAct RPC result");
  }
  if (!response.ok || result.ok !== true) throw new Error(result.error ?? "primary API rejected CodeAct RPC");
  return result.value;
}

export async function buildProductionCodeActExecutor(input: {
  config?: ProductionCodeActExecutorConfig;
  env?: NodeJS.ProcessEnv;
  transport?: CodeActDockerTransport;
  admin?: CodeActDockerAdmin;
  fetchFn?: typeof fetch;
  now?: () => Date;
} = {}): Promise<FastifyInstance> {
  const config = input.config ?? loadProductionCodeActExecutorConfig(input.env);
  const fetchFn = input.fetchFn ?? fetch;
  const now = input.now ?? (() => new Date());
  const active = new Map<string, {
    controller: AbortController;
    settled: Promise<unknown>;
  }>();
  let draining = false;
  const isActiveCandidate = (labels: Record<string, string>): boolean => {
    const attemptHash = labels["io.agentic.attempt-id-hash"];
    if (!attemptHash) return false;
    for (const executionId of active.keys()) {
      const expected = `sha256:${createHash("sha256").update(executionId, "utf8").digest("hex")}`;
      if (attemptHash === expected) return true;
    }
    return false;
  };
  const transport = input.transport ?? new DockerSocketCodeActTransport();
  const admin = input.admin ?? (
    "ping" in transport
    && "inspectImage" in transport
    && "listCandidates" in transport
      ? transport as CodeActDockerTransport & CodeActDockerAdmin
      : new DockerSocketCodeActTransport()
  );
  const health = {
    ready: false,
    checkedAt: "",
    imageId: "",
    error: "not checked",
    removedOrphans: 0,
  };
  let healthCheck: Promise<void> | undefined;

  const reconcileHealth = async (): Promise<void> => {
    if (healthCheck) return healthCheck;
    healthCheck = (async () => {
      try {
        await admin.ping();
        const image = await admin.inspectImage(config.candidateImage);
        if (!image || !config.candidateImageIds.has(image.Id)) {
          throw new Error("candidate image is absent or its local image id is outside the deployment allowlist");
        }
        const nowMs = now().getTime();
        const candidates = await admin.listCandidates("production-codeact");
        let removed = 0;
        for (const candidate of candidates) {
          if (isActiveCandidate(candidate.labels)) continue;
          const ageMs = candidate.createdAtMs > 0 ? nowMs - candidate.createdAtMs : Number.POSITIVE_INFINITY;
          if (ageMs < config.orphanGraceMs) {
            throw new Error(`orphan candidate ${candidate.id.slice(0, 12)} is awaiting its cleanup grace period`);
          }
          await admin.removeContainer(candidate.id);
          if (await admin.inspectContainer(candidate.id)) {
            throw new Error(`orphan candidate ${candidate.id.slice(0, 12)} still exists after removal`);
          }
          removed += 1;
        }
        const remaining = (await admin.listCandidates("production-codeact"))
          .filter((candidate) => !isActiveCandidate(candidate.labels));
        if (remaining.length) {
          throw new Error(`${remaining.length} production CodeAct orphan candidate(s) remain`);
        }
        health.ready = true;
        health.checkedAt = now().toISOString();
        health.imageId = image.Id;
        health.error = "";
        health.removedOrphans += removed;
      } catch (error) {
        health.ready = false;
        health.checkedAt = now().toISOString();
        health.error = String((error as Error)?.message ?? error).slice(0, 800);
      }
    })().finally(() => { healthCheck = undefined; });
    return healthCheck;
  };

  await reconcileHealth();
  const app = Fastify({ logger: false, bodyLimit: 12 * 1024 * 1024 });
  const preAuthenticate = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<unknown> => {
    if (!productionCodeActBearerMatches(request.headers.authorization, config.token)) {
      return reply.code(401).send({ error: "unauthorized production CodeAct executor request" });
    }
  };

  const reaper = setInterval(() => { void reconcileHealth(); }, config.reaperIntervalMs);
  reaper.unref?.();
  const drain = async (): Promise<void> => {
    if (draining) return;
    draining = true;
    clearInterval(reaper);
    for (const execution of active.values()) {
      execution.controller.abort(new Error("production CodeAct executor is shutting down"));
    }
    const pending = Promise.allSettled([...active.values()].map((entry) => entry.settled));
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      pending,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, config.drainTimeoutMs);
        timer.unref?.();
      }),
    ]);
    if (timer) clearTimeout(timer);
    const candidates = await admin.listCandidates("production-codeact");
    for (const candidate of candidates) {
      await admin.removeContainer(candidate.id);
      if (await admin.inspectContainer(candidate.id)) {
        throw new Error(`production candidate ${candidate.id.slice(0, 12)} remains during executor drain`);
      }
    }
    const remaining = await admin.listCandidates("production-codeact");
    if (remaining.length) {
      throw new Error(`${remaining.length} production candidate(s) remain after executor drain`);
    }
  };
  app.addHook("preClose", drain);
  app.addHook("onClose", async () => { clearInterval(reaper); });

  app.get("/health", { onRequest: preAuthenticate }, async (_request, reply) => {
    await reconcileHealth();
    const ready = health.ready && !draining;
    return reply.code(ready ? 200 : 503).send({
      schema: "agentic-production-codeact-executor-health/v1",
      ok: ready,
      draining,
      executorId: config.executorId,
      buildId: config.buildId,
      active: active.size,
      capacity: config.maxActive,
      checkedAt: health.checkedAt,
      candidateImage: config.candidateImage,
      candidateImageId: health.imageId || null,
      removedOrphans: health.removedOrphans,
      ...(health.error ? { error: health.error } : {}),
    });
  });

  app.post(
    "/internal/v1/production-codeact/execute",
    { onRequest: preAuthenticate },
    async (request, reply) => {
    const signature = request.headers["x-agentic-codeact-signature"] as string | undefined;
    if (!verifyProductionCodeActMessageSignature(request.body, signature, config.token)) {
      return reply.code(401).send({ error: "invalid execute signature" });
    }
    let command: ProductionCodeActExecuteCommand;
    try { command = exactCommand(request.body, now().getTime()); }
    catch (error) { return reply.code(400).send({ error: String((error as Error).message) }); }
    if (draining) return reply.code(503).send({ error: "executor is draining" });
    await reconcileHealth();
    if (!health.ready) {
      return reply.code(503).send({ error: `executor is not ready: ${health.error}` });
    }
    const seenUntil = seenExecutions.get(command.executionId);
    if (seenUntil && seenUntil > now().getTime()) {
      return reply.code(409).send({ error: "execution identity was already consumed" });
    }
    if (active.size >= config.maxActive) return reply.code(429).send({ error: "executor capacity exhausted" });
    seenExecutions.set(command.executionId, Date.parse(command.expiresAt) + 60_000);
    for (const [id, expiresAt] of seenExecutions) {
      if (expiresAt <= now().getTime()) seenExecutions.delete(id);
    }
    const controller = new AbortController();
    const state = {
      controller,
      settled: Promise.resolve() as Promise<unknown>,
    };
    active.set(command.executionId, state);
    let rpcOrdinal = 0;
    try {
      const execution = executeCodeActContainer(command.code, command.input, {
        timeoutMs: command.policy.timeoutMs,
        memoryMb: command.policy.memoryMb,
        cpus: command.policy.cpus,
        pidsLimit: command.policy.pidsLimit,
        attemptId: command.executionId,
        identity: {
          agentName: command.identity.agentName,
          tenantSlug: command.identity.tenantSlug,
          correlationId: command.identity.correlationId,
          subject: command.identity.subject,
        },
        transport,
        executionPlane: "production-codeact",
        signal: controller.signal,
        async onRpc(method, args) {
          rpcOrdinal += 1;
          if (rpcOrdinal > MAX_RPC_PER_EXECUTION) {
            throw new Error("production CodeAct RPC limit exceeded");
          }
          return callbackRpc({
            config,
            command,
            method,
            args,
            rpcId: `${command.executionId}:${rpcOrdinal}`,
            fetchFn,
          });
        },
      });
      state.settled = execution;
      const result = await execution;
      const terminal: ProductionCodeActTerminalResponse = {
        schema: PRODUCTION_CODEACT_PROTOCOL.terminal,
        executionId: command.executionId,
        identityHash: command.identityHash,
        codeSha256: command.identity.codeSha256,
        executorId: config.executorId,
        buildId: config.buildId,
        completedAt: now().toISOString(),
        result,
      };
      return reply
        .header("x-agentic-codeact-signature", productionCodeActMessageSignature(terminal, config.token))
        .code(200)
        .send(terminal);
    } finally {
      active.delete(command.executionId);
      await reconcileHealth();
    }
    },
  );

  return app;
}

export interface ProductionCodeActShutdownHandle {
  /** Resolves after the first signal has completed Fastify preClose/onClose. */
  closed: Promise<void>;
  readonly closing: boolean;
  dispose(): void;
}

interface ShutdownSignalHost {
  on(event: "SIGTERM" | "SIGINT", listener: () => void): unknown;
  off(event: "SIGTERM" | "SIGINT", listener: () => void): unknown;
  exitCode?: number;
  stderr?: { write(message: string): unknown };
}

/** Bridge orchestrator signals into Fastify's bounded drain. Signal event
 * emitters do not await async listeners, so expose `closed` for tests while a
 * single in-flight close promise makes repeated SIGTERM/SIGINT idempotent. */
export function installProductionCodeActShutdownHandlers(
  app: FastifyInstance,
  host: ShutdownSignalHost = process as unknown as ShutdownSignalHost,
): ProductionCodeActShutdownHandle {
  let closing = false;
  let disposed = false;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    host.off("SIGTERM", onTerminate);
    host.off("SIGINT", onInterrupt);
  };
  const close = (signal: "SIGTERM" | "SIGINT"): void => {
    if (closing) return;
    closing = true;
    void app.close()
      .catch((error) => {
        host.exitCode = 1;
        host.stderr?.write(
          `[production-codeact-executor] ${signal} drain failed: ${String((error as Error)?.message ?? error)}\n`,
        );
      })
      .finally(() => {
        dispose();
        resolveClosed();
      });
  };
  const onTerminate = (): void => close("SIGTERM");
  const onInterrupt = (): void => close("SIGINT");
  host.on("SIGTERM", onTerminate);
  host.on("SIGINT", onInterrupt);
  return {
    closed,
    get closing() { return closing; },
    dispose,
  };
}

async function main(): Promise<void> {
  const config = loadProductionCodeActExecutorConfig();
  const app = await buildProductionCodeActExecutor({ config });
  const shutdown = installProductionCodeActShutdownHandlers(app);
  try {
    await app.listen({ host: config.host, port: config.port });
  } catch (error) {
    shutdown.dispose();
    throw error;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    process.stderr.write(`[production-codeact-executor] ${String((error as Error)?.message ?? error)}\n`);
    process.exitCode = 1;
  });
}
