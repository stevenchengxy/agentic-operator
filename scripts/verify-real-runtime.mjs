#!/usr/bin/env node

/**
 * Read-only verification of the running production data path.
 *
 * It intentionally does not create an event, run or external side effect.
 * Set AGENTIC_VERIFY_LLM_PROBE=1 to also ask the configured provider's own
 * discovery endpoint to validate connectivity. The probe never prints keys.
 */

const apiUrl = (process.env.AGENTIC_VERIFY_API_URL ?? "http://localhost:3540").replace(/\/$/, "");
const tenant = process.env.AGENTIC_VERIFY_TENANT ?? process.env.AGENTIC_DEV_TENANT ?? "";
const token = process.env.AGENTIC_API_TOKEN?.trim() ?? "";
const sessionCookie = process.env.AGENTIC_VERIFY_SESSION_COOKIE?.trim() ?? "";

const headers = {
  Accept: "application/json",
  ...(tenant ? { "x-agentic-tenant": tenant } : {}),
  ...(token ? { Authorization: `Bearer ${token}` } : {}),
  ...(sessionCookie ? { Cookie: sessionCookie } : {}),
};

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

async function jsonRequest(path, init = {}) {
  const response = await fetch(`${apiUrl}${path}`, {
    ...init,
    headers: { ...headers, ...(init.headers ?? {}) },
  });
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`${path} returned non-JSON HTTP ${response.status}: ${text.slice(0, 160)}`);
  }
  return { response, body };
}

const checks = [];

const healthResult = await jsonRequest("/health");
invariant(healthResult.response.ok, `/health returned HTTP ${healthResult.response.status}`);
const health = healthResult.body;
invariant(health?.ok === true, "/health reports ok=false");
invariant(health?.sqlite?.ok === true, "/health reports SQLite unavailable");
invariant(health?.inngest?.ok === true, "/health reports Inngest unavailable");
invariant(health?.llmGateway?.ok === true, "/health reports LLM gateway unavailable");
invariant(health?.llmGateway?.mock === false, "/health reports a mock-backed LLM gateway");
invariant(
  typeof health?.llmGateway?.defaultProvider === "string" && health.llmGateway.defaultProvider !== "mock",
  "/health does not expose a real default provider",
);
invariant(
  typeof health?.llmGateway?.defaultModel === "string" && health.llmGateway.defaultModel.length > 0,
  "/health does not expose a served model id",
);
checks.push({
  check: "health",
  ok: true,
  provider: health.llmGateway.defaultProvider,
  model: health.llmGateway.defaultModel,
  sqlite: health.sqlite.journalMode,
  inngest: health.inngest.note ?? "ok",
});

const providersResult = await jsonRequest("/v1/llm/providers");
invariant(providersResult.response.ok && providersResult.body?.ok === true, "provider catalog is unavailable");
const providers = Array.isArray(providersResult.body.data) ? providersResult.body.data : [];
const providerIds = providers.map((provider) => provider?.id).filter(Boolean);
for (const unavailable of ["mock", "bedrock", "vertex"]) {
  invariant(!providerIds.includes(unavailable), `non-operational provider ${unavailable} is exposed by the runtime catalog`);
}
invariant(providerIds.includes(health.llmGateway.defaultProvider), "health default provider is absent from the runtime catalog");
checks.push({ check: "provider-catalog", ok: true, providers: providerIds.length });

const mockProbeResult = await jsonRequest("/v1/llm/providers/mock/test", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: "{}",
});
invariant(
  mockProbeResult.response.status >= 400,
  "the running API still permits the mock provider outside the isolated test process",
);
checks.push({ check: "mock-fail-closed", ok: true, status: mockProbeResult.response.status });

const activityResult = await jsonRequest("/v1/activity?limit=5");
invariant(activityResult.response.ok && activityResult.body?.ok === true, "persisted activity API is unavailable");
invariant(Array.isArray(activityResult.body.data), "persisted activity API returned an invalid payload");
checks.push({ check: "activity-history", ok: true, records: activityResult.body.data.length });

const until = Date.now();
const since = until - 24 * 60 * 60 * 1000;
const summaryResult = await jsonRequest(`/v1/observability/summary?since=${since}&until=${until}`);
invariant(summaryResult.response.ok && summaryResult.body?.ok === true, "observability summary API is unavailable");
invariant(typeof summaryResult.body.data?.totals?.runs === "number", "observability summary returned invalid totals");
checks.push({
  check: "observability",
  ok: true,
  runs: summaryResult.body.data.totals.runs,
  llmCalls: summaryResult.body.data.totals.llmCalls,
  tokens: summaryResult.body.data.totals.tokens,
});

const streamController = new AbortController();
const streamTimer = setTimeout(() => streamController.abort(), 3_000);
try {
  const streamResponse = await fetch(`${apiUrl}/v1/stream`, {
    headers,
    signal: streamController.signal,
  });
  invariant(streamResponse.ok, `SSE stream returned HTTP ${streamResponse.status}`);
  invariant(
    streamResponse.headers.get("content-type")?.includes("text/event-stream"),
    "SSE stream has the wrong content type",
  );
  const first = await streamResponse.body?.getReader().read();
  invariant(first && first.value && first.value.length > 0, "SSE stream did not flush an opening frame");
  checks.push({ check: "sse", ok: true });
} finally {
  clearTimeout(streamTimer);
  streamController.abort();
}

if (process.env.AGENTIC_VERIFY_LLM_PROBE === "1") {
  const id = encodeURIComponent(health.llmGateway.defaultProvider);
  const result = await jsonRequest(`/v1/llm/providers/${id}/test`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  invariant(result.response.ok && result.body?.ok === true, "provider connectivity route is unavailable");
  invariant(result.body.data?.ok === true, `provider connectivity failed: ${result.body.data?.message ?? "unknown error"}`);
  checks.push({
    check: "provider-connectivity",
    ok: true,
    status: result.body.data.statusCode,
    latencyMs: result.body.data.latencyMs,
    models: result.body.data.modelCount,
  });
}

console.log(JSON.stringify({ ok: true, apiUrl, tenant: tenant || null, checks }, null, 2));
