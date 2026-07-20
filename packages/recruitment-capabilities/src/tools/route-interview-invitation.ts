/** Deterministic terminal routing for RoboHire's send-and-invite endpoint. */

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

export const routeInterviewInvitation = defineTool({
  name: "routeInterviewInvitation",
  description:
    "Deterministically route the already-sent RoboHire invitation after its " +
    "RAAS/Allmeta write-through. Never sends a second email and never asks an LLM.",
  factory: {
    category: "workflow-routing",
    sideEffect: "call",
    operation: "compute",
    effectScope: "none",
    sandboxPolicy: "pure",
    capabilities: [
      {
        systems: ["Agent_Runtime", "AO_Internal"],
        kinds: ["compute", "internal_runtime"],
        roles: ["route", "execute"],
        operations: ["interview_invitation.route", "compute"],
        objectTypes: ["Interview_Invitation", "Communication_Log"],
        probeRequired: false,
      },
    ],
    source: {
      modulePath:
        "packages/recruitment-capabilities/src/tools/route-interview-invitation.ts",
      exportName: "routeInterviewInvitation",
    },
  },
  output: z.record(z.string(), z.unknown()),
  async handler(ctx) {
    const previous = asRecord(ctx.lastResult) ?? {};
    // Fail closed: missing/invalid receipt data is not proof of delivery.
    const sent = find(previous, ["success"]) === true;
    const loginUrl = text(
      find(previous, ["login_url", "loginUrl", "meeting_link"]),
    );
    const reason =
      text(find(previous, ["error_message", "error", "message"])) ||
      (sent
        ? "RoboHire invitation sent and external persistence completed"
        : "RoboHire receipt did not contain explicit success:true");
    const errorCode =
      text(find(previous, ["error_code"])) || (sent ? "" : "UNKNOWN");
    const persistenceWarning = text(
      find(previous, ["persistence_warning", "persistenceWarning"]),
    );
    const base = {
      ...previous,
      invitation_sent: sent,
      interview_link: loginUrl || null,
      reason,
    };
    if (sent && persistenceWarning) {
      return {
        data: {
          ...base,
          _emit: "INTERVIEW_INVITATION_SENT",
          _emits: [
            {
              event: "INTERVIEW_INVITATION_FAILED",
              payload: {
                ...base,
                success: false,
                error_code: "PERSISTENCE_WARNING",
                error_message: persistenceWarning,
              },
            },
            { event: "INTERVIEW_INVITATION_SENT", payload: base },
          ],
        },
      };
    }
    return {
      data: {
        ...base,
        _emit: sent
          ? "INTERVIEW_INVITATION_SENT"
          : "INTERVIEW_INVITATION_FAILED",
        error_code: sent ? null : errorCode,
      },
    };
  },
});
