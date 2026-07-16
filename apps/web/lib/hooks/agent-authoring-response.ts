interface ApiOk<T> {
  ok: true;
  data: T;
}

interface ApiErr {
  ok: false;
  error: { code?: string; message?: string };
}

type ApiEnvelope<T> = ApiOk<T> | ApiErr;

function operationLabel(path: string): string {
  if (path.includes("/system-prompt")) return "Prompt generation";
  if (path.includes("/deploy")) return "Agent publishing";
  if (path.includes("/availability")) return "Agent ID check";
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
  const label = operationLabel(path);
  let rawBody: string;
  try {
    rawBody = await response.text();
  } catch {
    throw new Error(
      `${label} returned an unreadable response (HTTP ${response.status}). Please retry.`,
    );
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
      throw new Error(
        decoded.error.message ||
          `${label} failed (HTTP ${response.status}). Please retry.`,
      );
    }
    if (!response.ok) {
      throw new Error(
        `${label} failed (HTTP ${response.status}). Please retry.`,
      );
    }
    return decoded.data;
  }

  if (!response.ok) {
    const availability =
      response.status >= 500 ? " is temporarily unavailable" : " failed";
    throw new Error(
      `${label}${availability} (HTTP ${response.status}). Please retry.`,
    );
  }

  throw new Error(
    `${label} returned an invalid response (HTTP ${response.status}). Please retry.`,
  );
}
