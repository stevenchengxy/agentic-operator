/**
 * sendInvitationEmail — 招聘-v1 (zhaopin) tenant tool (migrated from the old
 * InterviewInviter delivery leg). RoboHire's inviteCandidateApi only GENERATES
 * the invitation body; it does not send it. This tool delivers the invitation
 * (recipient + subject + body produced by the previous step) by POSTing to a
 * configured webhook / email-relay endpoint.
 *
 * Config (tool_use[].config or env):
 *   - webhook_url      — direct delivery endpoint, OR
 *   - webhook_url_env  — env var holding it (default RAAS_INVITE_WEBHOOK_URL)
 *
 * If no transport is configured it returns {delivered:false, mode:"unconfigured"}
 * WITHOUT throwing, so the run still completes; the downstream notifyRecruiter
 * step routes INTERVIEW_INVITATION_SENT / INTERVIEW_INVITATION_FAILED on the
 * delivery status. A real outage is reported, never thrown.
 */

import { z } from "zod";
import { defineTool, type ToolContext } from "@agentic/agent-kit";

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function resolveWebhook(config: ToolContext["config"]): string {
  const direct = str(config?.webhook_url);
  if (direct) return direct;
  const envKey = str(config?.webhook_url_env) || "RAAS_INVITE_WEBHOOK_URL";
  return process.env[envKey] ?? "";
}

export const sendInvitationEmail = defineTool({
  name: "sendInvitationEmail",
  description:
    "Deliver an interview-invitation email/message. Takes the recipient + " +
    "subject + body from the previous step (generateInterviewInvitation / " +
    "inviteCandidateApi) and POSTs them to a configured webhook " +
    "(tool_use.config.webhook_url or env). If no transport is configured it " +
    "returns delivered:false (mode:unconfigured) without throwing, so the run " +
    "still completes.",
  output: z.record(z.string(), z.unknown()),
  async handler(ctx) {
    try {
      const prev = (ctx.lastResult ?? {}) as Record<string, unknown>;
      const d = ((prev.data ?? prev) ?? {}) as Record<string, unknown>;
      const to = str(d.email) || str(d.to) || str(d.recipient) || str(d.candidate_email);
      const subject = str(d.subject) || "面试邀请";
      const body =
        str(d.body) ||
        str(d.content) ||
        str(d.invitation) ||
        str(d.message) ||
        JSON.stringify(d);

      const webhook = resolveWebhook(ctx.config);
      if (!webhook) {
        return {
          data: {
            delivered: false,
            mode: "unconfigured",
            to,
            subject,
            note: "未配置投递通道（设置 tool_use.config.webhook_url 或 RAAS_INVITE_WEBHOOK_URL）",
          },
        };
      }

      const res = await fetch(webhook, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          channel: "email",
          to,
          subject,
          body,
          source: "zhaopin/inviteInternalInterview",
          subject_ref: ctx.subject ?? null,
        }),
      });
      let preview = "";
      try {
        preview = (await res.text()).slice(0, 500);
      } catch {
        // ignore body read errors
      }
      return {
        data: {
          delivered: res.ok,
          mode: "webhook",
          status: res.status,
          to,
          subject,
          response_preview: preview,
        },
      };
    } catch (err) {
      // Delivery failure must not fail the run — report and let the agent emit.
      return {
        data: {
          delivered: false,
          mode: "error",
          error: String((err as Error)?.message ?? err),
        },
      };
    }
  },
});
