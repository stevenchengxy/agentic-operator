/** Real RAAS publication actions: configured API delivery, persisted helper page, and durable status. */

import { z } from "zod";
import { defineTool, type ToolContext } from "@agentic/agent-kit";
import { fs as fsTools, records as recordTools } from "@agentic/tools";

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

function eventData(ctx: ToolContext): Record<string, unknown> {
  return asRecord(ctx.event?.data) ?? {};
}

function resultRecords(ctx: ToolContext): Record<string, unknown>[] {
  const values = Object.values(ctx.results ?? {}).map(asRecord).filter(
    (value): value is Record<string, unknown> => value !== null,
  );
  const previous = asRecord(ctx.lastResult);
  if (previous) values.push(previous);
  return values;
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function externalTimeout(): number {
  const raw = Number(process.env.RAAS_EXTERNAL_TIMEOUT_MS ?? 30_000);
  return Number.isFinite(raw) && raw > 0 ? raw : 30_000;
}

async function postJson(url: string, token: string | undefined, payload: unknown): Promise<Record<string, unknown>> {
  let endpoint: URL;
  try {
    endpoint = new URL(url);
  } catch {
    throw new Error(`RAAS publication endpoint is not a valid URL: ${url}`);
  }
  if (!/^https?:$/.test(endpoint.protocol)) {
    throw new Error(`RAAS publication endpoint must use http(s), got ${endpoint.protocol}`);
  }
  const response = await fetch(endpoint, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(externalTimeout()),
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(token?.trim() ? { Authorization: `Bearer ${token.trim()}` } : {}),
    },
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  let body: unknown = text;
  try { body = JSON.parse(text); } catch { /* preserve text for diagnostics */ }
  if (!response.ok) {
    throw new Error(`RAAS publication API HTTP ${response.status}: ${String(text).slice(0, 200)}`);
  }
  const receipt = asRecord(body);
  if (!receipt) throw new Error("RAAS publication API returned no JSON receipt");
  if (receipt.success === false || receipt.ok === false) {
    throw new Error(`RAAS publication API rejected the request: ${String(receipt.error ?? receipt.message ?? "explicit failure")}`);
  }
  if (receipt.success !== true && receipt.ok !== true) {
    throw new Error(
      "RAAS publication API returned an ambiguous 2xx receipt (expected success:true or ok:true)",
    );
  }
  return receipt;
}

export const executeAutomatedPublication = defineTool({
  name: "executeAutomatedPublication",
  description:
    "Publish a JD through the operator-configured RAAS publication API. Requires RAAS_PUBLICATION_API_URL whenever an API channel is requested; performs a real POST and requires a JSON success receipt.",
  output: z.record(z.string(), z.unknown()),
  async handler(ctx) {
    const payload = eventData(ctx);
    const apiChannels = stringList(payload.api_channels);
    const explicitSupport =
      typeof payload.supports_publication_api === "boolean"
        ? payload.supports_publication_api
        : typeof payload.api_channel_supported === "boolean"
          ? payload.api_channel_supported
          : undefined;
    const endpoint = process.env.RAAS_PUBLICATION_API_URL?.trim();
    const requested = explicitSupport === true || (apiChannels?.length ?? 0) > 0 || Boolean(endpoint);
    if (!requested) {
      return {
        data: {
          automated_attempted: false,
          success: false,
          api_channels: apiChannels ?? [],
          reason: "No API publication channel was explicitly declared; automated delivery was not attempted",
        },
      };
    }
    if (!endpoint) {
      throw new Error(
        "executeAutomatedPublication: API publication was requested but RAAS_PUBLICATION_API_URL is not configured",
      );
    }
    const receipt = await postJson(
      endpoint,
      process.env.RAAS_PUBLICATION_API_TOKEN,
      { ...payload, api_channels: apiChannels ?? payload.api_channels },
    );
    return {
      data: {
        automated_attempted: true,
        success: true,
        api_channels: apiChannels ?? [],
        api_publish_result: receipt,
      },
      meta: { endpointHost: new URL(endpoint).host, receipt: true },
    };
  },
});

export const generatePublishHelperPage = defineTool({
  name: "generatePublishHelperPage",
  description:
    "Generate and persist a real tenant-scoped HTML helper page for manual channel publication. Returns the actual archive path; never claims the channel was published.",
  output: z.record(z.string(), z.unknown()),
  async handler(ctx) {
    const payload = eventData(ctx);
    const manualChannels = stringList(payload.manual_channels);
    const apiChannels = stringList(payload.api_channels);
    if (manualChannels?.length === 0 && (apiChannels?.length ?? 0) > 0) {
      return { data: { helper_generated: false, manual_channels: [], reason: "No manual channel declared" } };
    }
    const source = {
      trigger: payload,
      completed_steps: Object.fromEntries(Object.entries(ctx.results ?? {})),
    };
    const serialized = JSON.stringify(source, null, 2);
    if (serialized === "{\n  \"trigger\": {},\n  \"completed_steps\": {}\n}") {
      throw new Error("generatePublishHelperPage: no JD/publication data is available for the helper page");
    }
    const title =
      typeof payload.title === "string" && payload.title.trim()
        ? `JD 发布助手 · ${payload.title.trim()}`
        : "JD 发布助手";
    const html = `<main><h1>${escapeHtml(title)}</h1><p>此页面仅用于人工复制发布；生成页面不代表渠道已发布。</p><pre>${escapeHtml(serialized)}</pre></main>`;
    const archived = await fsTools.writeHtmlToArchive.handler({
      ...ctx,
      actionName: "fs.writeHtmlToArchive",
      event: { name: ctx.event?.name ?? "RAAS_PUBLICATION_HELPER", data: { html, title } },
      config: { subdir: "publication-helpers", id_prefix: "publish-helper", lang: "zh-CN" },
    });
    return {
      data: {
        helper_generated: true,
        manual_channels: manualChannels ?? [],
        helper_page: archived.data,
      },
      meta: archived.meta,
    };
  },
});

export const updatePublicationStatus = defineTool({
  name: "updatePublicationStatus",
  description:
    "Persist the real publication outcome to business_records. Marks published only after an explicit API success receipt; a helper page becomes manual_action_required and routes to CHANNEL_PUBLISHED_FAILED.",
  output: z.record(z.string(), z.unknown()),
  async handler(ctx) {
    const stepResults = resultRecords(ctx);
    const automated = stepResults.find((result) => typeof result.automated_attempted === "boolean");
    const helper = stepResults.find((result) => typeof result.helper_generated === "boolean");
    const published = automated?.automated_attempted === true && automated.success === true;
    const helperGenerated = helper?.helper_generated === true;
    if (!published && !helperGenerated) {
      throw new Error("updatePublicationStatus: neither an API success receipt nor a persisted helper page exists");
    }

    const status = published ? "published" : "manual_action_required";
    const now = new Date().toISOString();
    const snapshot = {
      ...eventData(ctx),
      publication_status: status,
      publication_updated_at: now,
      ...(published ? { published_at: now, api_publish_result: automated?.api_publish_result } : {}),
      ...(helperGenerated ? { publication_helper_page: helper?.helper_page } : {}),
    };
    const persisted = await recordTools.recordsUpsert.handler({
      ...ctx,
      actionName: "records.upsert",
      lastResult: snapshot,
      config: { record_type: "job_posting" },
    });
    return {
      data: {
        ...(asRecord(persisted.data) ?? {}),
        publication_status: status,
        publication_updated_at: now,
        _emit: published ? "CHANNEL_PUBLISHED" : "CHANNEL_PUBLISHED_FAILED",
      },
      meta: { ...persisted.meta, publicationStatus: status },
    };
  },
});
