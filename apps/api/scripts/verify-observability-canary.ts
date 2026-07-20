/**
 * End-to-end observability canary for the running local stack.
 *
 * It deliberately uses the authenticated HTTP surface (through Next on
 * :3599), opens the same SSE feed as the portal, enqueues a TEST-labelled run
 * through the real Inngest broker and configured provider/model, then
 * cross-checks SSE → SQLite → file log → per-run log API → activity backfill
 * → usage/observability aggregates. Set CANARY_ASYNC_INNGEST=0 only when
 * deliberately diagnosing the synchronous HTTP execution path.
 *
 * The run remains in the database as `is_test=1` so operators can inspect the
 * evidence in the UI. It refuses to run when health reports a mock or
 * unconfigured gateway; a successful canary therefore spends a small amount
 * of real model quota and proves the actual inference/accounting path.
 */

import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { getDb, llmCalls, runs, users } from "@agentic/db";
import { and, eq } from "drizzle-orm";
import { initialsFor, signSessionJwt } from "../src/plugins/auth";

type JsonRecord = Record<string, unknown>;

interface ApiEnvelope<T> {
  ok: boolean;
  data?: T;
  error?: { code?: string; message?: string };
}

function invariant(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${ms}ms`)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function parseSseFrame(frame: string): {
  event: string;
  data: string;
} | null {
  let event = "message";
  const data: string[] = [];
  for (const line of frame.replace(/\r/g, "").split("\n")) {
    if (line.startsWith(":")) continue;
    if (line.startsWith("event:")) event = line.slice(6).trim();
    if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
  }
  return data.length ? { event, data: data.join("\n") } : null;
}

function openLiveFeed(baseUrl: string, cookie: string, tenant: string) {
  const controller = new AbortController();
  const events: JsonRecord[] = [];
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  const done = (async () => {
    const response = await fetch(
      `${baseUrl}/livefeed?tenant=${encodeURIComponent(tenant)}`,
      {
        headers: {
          Accept: "text/event-stream",
          Cookie: cookie,
        },
        signal: controller.signal,
      },
    );
    invariant(response.ok, `livefeed returned HTTP ${response.status}`);
    invariant(response.body, "livefeed returned no response body");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let sawReady = false;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        let split = buffer.indexOf("\n\n");
        while (split >= 0) {
          const raw = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          const parsed = parseSseFrame(raw);
          if (parsed) {
            if (parsed.event === "ready") {
              sawReady = true;
              resolveReady();
            }
            try {
              const payload = JSON.parse(parsed.data) as JsonRecord;
              if (payload && typeof payload === "object") events.push(payload);
            } catch {
              // `info`/heartbeat frames may intentionally contain plain text.
            }
          }
          split = buffer.indexOf("\n\n");
        }
      }
      if (!sawReady) rejectReady(new Error("livefeed closed before ready"));
    } finally {
      reader.releaseLock();
    }
  })().catch((error: unknown) => {
    if (controller.signal.aborted) return;
    const normalized =
      error instanceof Error ? error : new Error(String(error));
    rejectReady(normalized);
    throw normalized;
  });

  return {
    events,
    ready,
    done,
    close: () => controller.abort(),
  };
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started >= timeoutMs) {
      throw new Error(`${label} timed out after ${timeoutMs}ms`);
    }
    await delay(50);
  }
}

async function main(): Promise<void> {
  invariant(
    process.env.NODE_ENV !== "production",
    "This canary is local/test-only and refuses to run in production.",
  );
  const tenant = process.env.CANARY_TENANT ?? process.env.AGENTIC_DEV_TENANT;
  invariant(tenant, "Set CANARY_TENANT (or AGENTIC_DEV_TENANT) explicitly");
  const agent = process.env.CANARY_AGENT ?? "reportGenerator";
  const baseUrl = process.env.CANARY_BASE_URL ?? "http://localhost:3599";
  const asyncInngest = process.env.CANARY_ASYNC_INNGEST !== "0";
  const operatorEmail = process.env.AGENTIC_DEV_USER_EMAIL;
  invariant(operatorEmail, "Set AGENTIC_DEV_USER_EMAIL explicitly for the canary session");
  const db = getDb();
  const operator = db
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(eq(users.email, operatorEmail))
    .all()[0];
  invariant(operator, `operator user ${operatorEmail} is not seeded`);

  const session = await signSessionJwt({
    sub: operator.id,
    name: operator.name,
    initials: initialsFor(operator.name),
    tenant,
  });
  const cookie = `agentic_session=${session}`;
  const headers = {
    Accept: "application/json",
    Cookie: cookie,
    "Content-Type": "application/json",
    "x-agentic-tenant": tenant,
  };

  async function api<T>(pathname: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`${baseUrl}${pathname}`, {
      ...init,
      headers: { ...headers, ...(init.headers ?? {}) },
    });
    const text = await response.text();
    let body: ApiEnvelope<T>;
    try {
      body = JSON.parse(text) as ApiEnvelope<T>;
    } catch {
      throw new Error(
        `${pathname} returned non-JSON HTTP ${response.status}: ${text.slice(0, 300)}`,
      );
    }
    if (!response.ok || !body.ok) {
      throw new Error(
        `${pathname} failed HTTP ${response.status}: ${body.error?.code ?? "unknown"} ${body.error?.message ?? ""}`,
      );
    }
    return body.data as T;
  }

  const healthResponse = await fetch(`${baseUrl}/health`, {
    headers: { Accept: "application/json" },
  });
  invariant(healthResponse.ok, `health returned HTTP ${healthResponse.status}`);
  const health = (await healthResponse.json()) as {
    ok: boolean;
    sqlite: { ok: boolean; journalMode?: string };
    llmGateway?: {
      ok: boolean;
      mock?: boolean;
      defaultProvider?: string;
      defaultModel?: string;
    };
  };
  invariant(health.ok, "health: stack is degraded");
  invariant(health.sqlite.ok, "health: database is not connected");
  invariant(
    health.sqlite.journalMode?.toLowerCase() === "wal",
    "health: SQLite WAL mode is not enabled",
  );
  invariant(health.llmGateway?.ok, "health: LLM gateway is not operational");
  invariant(!health.llmGateway?.mock, "canary refuses to run against a mock LLM gateway");
  const configuredProvider = health.llmGateway.defaultProvider;
  const configuredModel = health.llmGateway.defaultModel;
  invariant(configuredProvider, "health: default LLM provider is missing");
  invariant(configuredModel, "health: default LLM model is missing");
  invariant(configuredProvider !== "mock", "canary refuses the mock provider");
  const providerProbe = await api<{
    ok: boolean;
    statusCode: number | null;
    latencyMs: number;
    modelCount: number | null;
    message: string;
  }>(`/v1/llm/providers/${encodeURIComponent(configuredProvider)}/test`, {
    method: "POST",
    body: "{}",
  });
  invariant(
    providerProbe.ok && providerProbe.statusCode === 200,
    `configured ${configuredProvider} LLM gateway probe failed: ${providerProbe.message}`,
  );

  const startedAt = Date.now();
  const usageBefore = await api<{
    totals: {
      runs: number;
      tokensIn: number;
      tokensOut: number;
      testRuns: number;
    };
  }>(`/v1/usage?since=${startedAt}`);
  const live = openLiveFeed(baseUrl, cookie, tenant);
  await withTimeout(live.ready, 5_000, "livefeed ready");

  const subject = `OBS-CANARY-${startedAt}`;
  const invocation = await api<{
    runId: string;
    status: string;
    provider?: string;
    model?: string;
    tokensIn?: number | null;
    tokensOut?: number | null;
    testRun: boolean;
  }>(`/v1/agents/${encodeURIComponent(agent)}/invoke?testRun=1`, {
    method: "POST",
    body: JSON.stringify({
      input: {
        subject,
        title: "Observability wiring canary",
        data: { purpose: "end-to-end runtime and log verification" },
      },
      async: asyncInngest,
    }),
  });
  invariant(
    invocation.status === (asyncInngest ? "queued" : "ok"),
    asyncInngest
      ? "canary was not durably accepted by the Inngest enqueue path"
      : "canary run did not complete successfully",
  );
  invariant(
    invocation.testRun === true,
    "invoke response did not preserve testRun=true",
  );
  if (!asyncInngest) {
    invariant(
      invocation.provider === configuredProvider,
      `canary used ${invocation.provider}, expected configured provider ${configuredProvider}`,
    );
    invariant(
      invocation.model === configuredModel,
      `canary used ${invocation.model}, expected configured model ${configuredModel}`,
    );
    invariant(
      (invocation.tokensIn ?? 0) > 0 && (invocation.tokensOut ?? 0) > 0,
      "real inference returned no token usage",
    );
  }

  await waitFor(
    () => {
      const durable = db
        .select({ status: runs.status, errorMessage: runs.errorMessage })
        .from(runs)
        .where(eq(runs.id, invocation.runId))
        .all()[0];
      if (durable && ["failed", "cancelled"].includes(durable.status)) {
        throw new Error(
          `canary run became ${durable.status}: ${durable.errorMessage ?? "no error detail"}`,
        );
      }
      const forRun = live.events.filter(
        (event) => event.runId === invocation.runId,
      );
      return (
        forRun.some((event) => event.type === "run.started") &&
        forRun.some((event) => event.type === "run.step.completed") &&
        forRun.filter((event) => event.type === "log.line").length >= 3 &&
        forRun.some((event) => event.type === "run.completed")
      );
    },
    asyncInngest ? 180_000 : 8_000,
    "live lifecycle/log events",
  );
  live.close();
  await Promise.race([live.done, delay(500)]);

  const run = db
    .select({
      id: runs.id,
      tenantId: runs.tenantId,
      status: runs.status,
      isTest: runs.isTest,
      logPath: runs.logPath,
      model: runs.model,
      tokensIn: runs.tokensIn,
      tokensOut: runs.tokensOut,
    })
    .from(runs)
    .where(eq(runs.id, invocation.runId))
    .all()[0];
  invariant(run, "canary run is missing from SQLite");
  invariant(run.status === "ok", `SQLite run status is ${run.status}`);
  invariant(run.isTest === true, "SQLite run is not marked is_test=1");
  invariant(
    run.model === configuredModel,
    `SQLite run used ${run.model ?? "no model"}, expected configured model ${configuredModel}`,
  );
  invariant(
    (run.tokensIn ?? 0) > 0 && (run.tokensOut ?? 0) > 0,
    "SQLite run is missing real token usage",
  );
  const callRows = db
    .select({
      provider: llmCalls.provider,
      servedModel: llmCalls.servedModel,
      tokensIn: llmCalls.approxTokensIn,
      tokensOut: llmCalls.approxTokensOut,
      tokenSource: llmCalls.tokenSource,
      ok: llmCalls.ok,
      purpose: llmCalls.purpose,
    })
    .from(llmCalls)
    .where(
      and(
        eq(llmCalls.tenantId, run.tenantId),
        eq(llmCalls.runId, invocation.runId),
      ),
    )
    .all();
  const realCall = callRows.find(
    (call) =>
      call.ok === true &&
      call.provider === configuredProvider &&
      call.servedModel === configuredModel &&
      // The canonical multi-turn runner records the exact turn so operators
      // can attribute every model call. Accept that richer production tag
      // while retaining compatibility with a single-turn caller.
      (call.purpose === `agent:${agent}` ||
        call.purpose?.startsWith(`agent:${agent}/turn:`)) &&
      call.tokenSource === "provider" &&
      (call.tokensIn ?? 0) > 0 &&
      (call.tokensOut ?? 0) > 0,
  );
  invariant(
    realCall,
    "llm_calls is missing an exact run-linked, provider-measured successful real model call",
  );
  invariant(run.logPath, "SQLite run.log_path is empty");
  const absoluteLogPath = path.isAbsolute(run.logPath)
    ? run.logPath
    : path.resolve(process.cwd(), run.logPath);
  await access(absoluteLogPath);
  const logText = await readFile(absoluteLogPath, "utf8");
  for (const marker of ["run.start", "llm.call", "run.ok"]) {
    invariant(logText.includes(marker), `file log is missing ${marker}`);
  }

  const logResponse = await fetch(
    `${baseUrl}/v1/runs/${encodeURIComponent(invocation.runId)}/logs`,
    { headers },
  );
  invariant(
    logResponse.ok,
    `per-run log API returned HTTP ${logResponse.status}`,
  );
  invariant(
    logResponse.headers.get("content-type")?.includes("text/event-stream"),
    "per-run log API is not SSE",
  );
  const logSse = await logResponse.text();
  invariant(
    logSse.includes("event: log"),
    "per-run log API emitted no log frames",
  );
  for (const marker of ["run.start", "llm.call", "run.ok"]) {
    invariant(logSse.includes(marker), `per-run log API is missing ${marker}`);
  }

  const activity = await api<Array<JsonRecord>>("/v1/activity?limit=100");
  const activityForRun = activity.filter(
    (event) => event.runId === invocation.runId,
  );
  for (const type of ["run.started", "run.step.completed", "run.completed"]) {
    invariant(
      activityForRun.some((event) => event.type === type),
      `activity backfill is missing ${type}`,
    );
  }

  const usageAfter = await api<{
    totals: {
      runs: number;
      tokensIn: number;
      tokensOut: number;
      testRuns: number;
    };
  }>(`/v1/usage?since=${startedAt}`);
  invariant(
    usageAfter.totals.runs >= usageBefore.totals.runs + 1,
    "usage aggregation did not count the canary run",
  );
  invariant(
    usageAfter.totals.testRuns >= usageBefore.totals.testRuns + 1,
    "usage aggregation did not count the canary as a test run",
  );
  invariant(
    usageAfter.totals.tokensIn > usageBefore.totals.tokensIn &&
      usageAfter.totals.tokensOut > usageBefore.totals.tokensOut,
    "usage aggregation did not increase real input/output tokens",
  );

  const summary = await api<{
    totals: {
      runs: number;
      testRuns: number;
      llmCalls: number;
      tokens: number;
    };
    byAgent: Array<{ agentName: string; runs: number }>;
  }>(`/v1/observability/summary?since=${startedAt}&bucketMs=60000`);
  invariant(
    summary.totals.runs >= 1,
    "observability summary missed the canary run",
  );
  invariant(
    summary.totals.testRuns >= 1,
    "observability summary missed test-run provenance",
  );
  invariant(summary.totals.llmCalls >= 1, "observability summary missed the real LLM call");
  invariant(summary.totals.tokens >= 1, "observability summary missed real token usage");
  invariant(
    summary.byAgent.some((row) => row.agentName === agent && row.runs >= 1),
    "observability by-agent aggregation missed the canary",
  );

  const liveTypes = [
    ...new Set(
      live.events
        .filter((event) => event.runId === invocation.runId)
        .map((event) => String(event.type)),
    ),
  ];
  console.log(
    JSON.stringify(
      {
        ok: true,
        runId: invocation.runId,
        tenant,
        agent,
        executionPath: asyncInngest ? "inngest" : "sync-http",
        configuredRuntime: health.llmGateway ?? null,
        configuredProviderProbe: providerProbe,
        canaryProvider: realCall.provider,
        canaryModel: realCall.servedModel,
        tokenSource: realCall.tokenSource,
        tokens: {
          in: run.tokensIn,
          out: run.tokensOut,
        },
        sqlite: { status: run.status, isTest: run.isTest },
        fileLog: absoluteLogPath,
        fileMarkers: ["run.start", "llm.call", "run.ok"],
        perRunLogApi: "text/event-stream",
        liveTypes,
        activityTypes: activityForRun.map((event) => String(event.type)),
        usageDelta: {
          runs: usageAfter.totals.runs - usageBefore.totals.runs,
          testRuns: usageAfter.totals.testRuns - usageBefore.totals.testRuns,
          tokensIn: usageAfter.totals.tokensIn - usageBefore.totals.tokensIn,
          tokensOut: usageAfter.totals.tokensOut - usageBefore.totals.tokensOut,
        },
        observability: summary.totals,
      },
      null,
      2,
    ),
  );
}

main().catch((error: unknown) => {
  const message =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  console.error(message);
  process.exitCode = 1;
});
