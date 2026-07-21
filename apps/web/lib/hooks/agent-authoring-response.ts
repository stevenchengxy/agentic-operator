interface ApiOk<T> {
  ok: true;
  data: T;
}

interface ApiErr {
  ok: false;
  error: { code?: string; message?: string };
}

type ApiEnvelope<T> = ApiOk<T> | ApiErr;

export type AgentAuthoringOperation =
  | "promptGeneration"
  | "publishing"
  | "idCheck"
  | "request";

export type AgentAuthoringClientErrorCode =
  | "unreachable"
  | "unreadable"
  | "failed"
  | "unavailable"
  | "invalidResponse";

export class AgentAuthoringClientError extends Error {
  readonly code: AgentAuthoringClientErrorCode;
  readonly operation: AgentAuthoringOperation;
  readonly status?: number;

  constructor(args: {
    code: AgentAuthoringClientErrorCode;
    operation: AgentAuthoringOperation;
    fallback: string;
    status?: number;
  }) {
    super(args.fallback);
    this.name = "AgentAuthoringClientError";
    this.code = args.code;
    this.operation = args.operation;
    this.status = args.status;
  }
}

type AgentAuthoringTranslate = (
  key: string,
  vars?: Record<string, string | number>,
) => string;

export function formatAgentAuthoringError(
  error: unknown,
  t?: AgentAuthoringTranslate,
): string {
  if (!(error instanceof AgentAuthoringClientError) || !t) {
    return error instanceof Error ? error.message : String(error);
  }
  return t(`agentAuthoringError.${error.code}`, {
    operation: t(`agentAuthoringError.operation.${error.operation}`),
    status: error.status ?? "—",
  });
}

export function agentAuthoringOperation(path: string): AgentAuthoringOperation {
  if (path.includes("/system-prompt")) return "promptGeneration";
  if (path.includes("/deploy")) return "publishing";
  if (path.includes("/availability")) return "idCheck";
  return "request";
}

function operationLabel(operation: AgentAuthoringOperation): string {
  if (operation === "promptGeneration") return "Prompt generation";
  if (operation === "publishing") return "Agent publishing";
  if (operation === "idCheck") return "Agent ID check";
  return "Agent authoring request";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isApiEnvelope<T>(value: unknown): value is ApiEnvelope<T> {
  if (!isRecord(value) || typeof value.ok !== "boolean") return false;
  if (value.ok) return "data" in value;
  return (
    isRecord(value.error) &&
    (value.error.message === undefined ||
      typeof value.error.message === "string")
  );
}

/**
 * Decode the API envelope without assuming that proxies and upstream servers
 * always return JSON. In particular, Next's rewrite can return a plain-text
 * "Internal Server Error" when the API process is restarting or unavailable.
 */
export async function readAgentAuthoringResponse<T>(
  response: Response,
  path: string,
): Promise<T> {
  const operation = agentAuthoringOperation(path);
  const label = operationLabel(operation);
  let rawBody: string;
  try {
    rawBody = await response.text();
  } catch {
    throw new AgentAuthoringClientError({
      code: "unreadable",
      operation,
      status: response.status,
      fallback: `${label} returned an unreadable response (HTTP ${response.status}). Please retry.`,
    });
  }

  let decoded: unknown;
  if (rawBody.trim()) {
    try {
      decoded = JSON.parse(rawBody);
    } catch {
      decoded = undefined;
    }
  }

  if (isApiEnvelope<T>(decoded)) {
    if (!decoded.ok) {
      if (decoded.error.message) throw new Error(decoded.error.message);
      throw new AgentAuthoringClientError({
        code: "failed",
        operation,
        status: response.status,
        fallback: `${label} failed (HTTP ${response.status}). Please retry.`,
      });
    }
    if (!response.ok) {
      throw new AgentAuthoringClientError({
        code: "failed",
        operation,
        status: response.status,
        fallback: `${label} failed (HTTP ${response.status}). Please retry.`,
      });
    }
    return decoded.data;
  }

  if (!response.ok) {
    const unavailable = response.status >= 500;
    throw new AgentAuthoringClientError({
      code: unavailable ? "unavailable" : "failed",
      operation,
      status: response.status,
      fallback: `${label}${unavailable ? " is temporarily unavailable" : " failed"} (HTTP ${response.status}). Please retry.`,
    });
  }

  throw new AgentAuthoringClientError({
    code: "invalidResponse",
    operation,
    status: response.status,
    fallback: `${label} returned an invalid response (HTTP ${response.status}). Please retry.`,
  });
}
