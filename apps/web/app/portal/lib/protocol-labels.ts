import type { Translate } from "./preferences-context";

const RUN_STATUS_KEYS: Readonly<Record<string, string>> = {
  queued: "protocol.runStatus.queued",
  running: "protocol.runStatus.running",
  ok: "protocol.runStatus.ok",
  failed: "protocol.runStatus.failed",
  waiting: "protocol.runStatus.waiting",
  cancelled: "protocol.runStatus.cancelled",
};

const WORKFLOW_TEST_STATUS_KEYS: Readonly<Record<string, string>> = {
  ok: "protocol.testStatus.ok",
  failed: "protocol.testStatus.failed",
  partial: "protocol.testStatus.partial",
  blocked: "protocol.testStatus.blocked",
  skipped: "protocol.testStatus.skipped",
};

const WORKFLOW_STATUS_KEYS: Readonly<Record<string, string>> = {
  draft: "protocol.workflowStatus.draft",
  live: "protocol.workflowStatus.live",
  superseded: "protocol.workflowStatus.superseded",
};

const AGENT_KIND_KEYS: Readonly<Record<string, string>> = {
  manifest: "protocol.agentKind.manifest",
  code: "protocol.agentKind.code",
};

function knownProtocolLabel(
  t: Translate,
  value: string,
  keys: Readonly<Record<string, string>>,
): string {
  const key = keys[value];
  return key ? t(key) : value;
}

/** Human-facing run status without changing the underlying protocol value. */
export function runStatusLabel(t: Translate, status: string): string {
  return knownProtocolLabel(t, status, RUN_STATUS_KEYS);
}

/** Human-facing bounded workflow-test status. Unknown server values stay raw. */
export function workflowTestStatusLabel(t: Translate, status: string): string {
  return knownProtocolLabel(t, status, WORKFLOW_TEST_STATUS_KEYS);
}

/** Human-facing workflow lifecycle status. Unknown server values stay raw. */
export function workflowStatusLabel(t: Translate, status: string): string {
  return knownProtocolLabel(t, status, WORKFLOW_STATUS_KEYS);
}

/** Human-facing agent implementation kind. Unknown server values stay raw. */
export function agentKindLabel(t: Translate, kind: string): string {
  return knownProtocolLabel(t, kind, AGENT_KIND_KEYS);
}
