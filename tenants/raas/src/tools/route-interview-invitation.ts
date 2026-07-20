/**
 * Deterministic terminal routing for RoboHire's real send-and-invite endpoint.
 *
 * `inviteCandidateApi` is the sole delivery side effect. This tool only reads
 * its persisted receipt after `records.upsert`; it never sends another email
 * and never asks an LLM to decide whether delivery succeeded.
 */

import { z } from "zod";
import { defineTool } from "@agentic/agent-kit";

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const text = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

function find(root: Record<string, unknown>, keys: string[]): unknown {
  const nested = asRecord(root.data);
  for (const source of [root, nested].filter(
    (value): value is Record<string, unknown> => value !== null,
  )) {
    for (const key of keys) {
      if (source[key] !== undefined && source[key] !== null) return source[key];
    }
  }
  return undefined;
}

const routeReceiptSchema = z.object({
  _emit: z.enum([
    "INTERVIEW_INVITATION_SENT",
    "INTERVIEW_INVITATION_FAILED",
  ]),
  invitation_sent: z.boolean(),
  interview_link: z.string().nullable(),
  reason: z.string().min(1),
}).passthrough();

export const routeInterviewInvitation = defineTool({
  name: "routeInterviewInvitation",
  description:
    "Fail-closed routing for the persisted RoboHire invitation receipt. " +
    "Only an explicit success:true becomes INTERVIEW_INVITATION_SENT; missing, " +
    "invalid, or failed receipts become INTERVIEW_INVITATION_FAILED. No LLM " +
    "and no second delivery side effect.",
  output: routeReceiptSchema,
  // eslint-disable-next-line @typescript-eslint/require-await
  async handler(ctx) {
    const previous = asRecord(ctx.lastResult) ?? {};
    const sent = find(previous, ["success"]) === true;
    const loginUrl = text(
      find(previous, ["login_url", "loginUrl", "meeting_link"]),
    );
    const reason =
      text(find(previous, ["error_message", "error", "message"])) ||
      (sent
        ? "RoboHire invitation sent and receipt persisted"
        : "RoboHire receipt did not contain explicit success:true");

    return {
      data: {
        ...previous,
        _emit: sent
          ? "INTERVIEW_INVITATION_SENT" as const
          : "INTERVIEW_INVITATION_FAILED" as const,
        invitation_sent: sent,
        interview_link: loginUrl || null,
        reason,
      },
    };
  },
});
