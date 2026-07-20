/** Real client-portal submission with an explicit API or durable human-task path. */

import { z } from "zod";
import { defineTool } from "@agentic/agent-kit";
import { getDb, tasks, tenants, eq } from "@agentic/db";
import { makeId } from "@agentic/shared";

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

function timeoutMs(): number {
  const raw = Number(process.env.RAAS_EXTERNAL_TIMEOUT_MS ?? 30_000);
  return Number.isFinite(raw) && raw > 0 ? raw : 30_000;
}

export const submitToClientSystem = defineTool({
  name: "submitToClientSystem",
  description:
    "Submit the prepared package to the configured client API, or create a durable manual-submission task when the payload explicitly declares manual mode. API mode requires a real JSON receipt; unknown mode fails closed.",
  output: z.record(z.string(), z.unknown()),
  async handler(ctx) {
    const trigger = asRecord(ctx.event?.data) ?? {};
    const prepared = asRecord(ctx.lastResult) ?? {};
    const rawMode =
      typeof prepared.submission_mode === "string"
        ? prepared.submission_mode
        : typeof trigger.submission_mode === "string"
          ? trigger.submission_mode
          : "";
    const explicitApiSupport =
      typeof trigger.client_api_supported === "boolean"
        ? trigger.client_api_supported
        : typeof prepared.client_api_supported === "boolean"
          ? prepared.client_api_supported
          : undefined;
    const endpoint = process.env.RAAS_CLIENT_SUBMISSION_API_URL?.trim();
    const manual = /^manual$/i.test(rawMode) || explicitApiSupport === false;
    const api = /^api$/i.test(rawMode) || explicitApiSupport === true || Boolean(endpoint);

    if (manual) {
      const tenant = getDb()
        .select({ id: tenants.id })
        .from(tenants)
        .where(eq(tenants.slug, ctx.tenantSlug))
        .all()[0];
      if (!tenant) throw new Error(`submitToClientSystem: unknown tenant '${ctx.tenantSlug}'`);
      const taskId = makeId("tsk");
      getDb().insert(tasks).values({
        id: taskId,
        tenantId: tenant.id,
        runId: ctx.runId ?? null,
        type: "client_submission_manual",
        title: `人工提交客户系统 · ${ctx.subject ?? "未命名申请"}`,
        awaitingRole: "delivery_manager",
        priority: "high",
        status: "open",
        payloadJson: {
          subject: ctx.subject ?? null,
          correlation_id: ctx.correlationId,
          prepared_submission: prepared,
          trigger,
        },
      }).run();
      return {
        data: {
          submitted: false,
          success: false,
          manual_required: true,
          task_id: taskId,
          client_response: null,
          _emit: "SUBMISSION_FAILED",
        },
        meta: { durableTask: true, taskId },
      };
    }
    if (!api) {
      throw new Error(
        "submitToClientSystem: submission mode is unknown; set submission_mode=api|manual or client_api_supported",
      );
    }
    if (!endpoint) {
      throw new Error(
        "submitToClientSystem: API submission was requested but RAAS_CLIENT_SUBMISSION_API_URL is not configured",
      );
    }
    let url: URL;
    try { url = new URL(endpoint); } catch { throw new Error("RAAS_CLIENT_SUBMISSION_API_URL is invalid"); }
    if (!/^https?:$/.test(url.protocol)) throw new Error("RAAS_CLIENT_SUBMISSION_API_URL must use http(s)");
    const body = asRecord(prepared.payload) ?? prepared;
    if (Object.keys(body).length === 0) throw new Error("submitToClientSystem: prepared submission payload is empty");
    const token = process.env.RAAS_CLIENT_SUBMISSION_API_TOKEN?.trim();
    const response = await fetch(url, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs()),
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { throw new Error("submitToClientSystem: client API returned a non-JSON receipt"); }
    if (!response.ok) throw new Error(`submitToClientSystem: client API HTTP ${response.status}: ${text.slice(0, 200)}`);
    const receipt = asRecord(parsed);
    if (!receipt || receipt.success === false || receipt.ok === false) {
      throw new Error(`submitToClientSystem: client API rejected submission: ${String(receipt?.error ?? receipt?.message ?? "explicit failure")}`);
    }
    const applicationId = [receipt.application_id, receipt.request_id, receipt.id]
      .find((value): value is string => typeof value === "string" && value.trim().length > 0);
    if (receipt.success !== true && receipt.ok !== true && !applicationId) {
      throw new Error("submitToClientSystem: ambiguous receipt (missing success:true/ok:true/application id)");
    }
    return {
      data: {
        submitted: true,
        success: true,
        manual_required: false,
        application_id: applicationId ?? null,
        client_response: receipt,
        _emit: "APPLICATION_SUBMITTED",
      },
      meta: { endpointHost: url.host, receipt: true },
    };
  },
});
