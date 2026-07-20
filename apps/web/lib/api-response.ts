/**
 * Strict decoder for the v1 `{ ok, data | error }` response envelope.
 *
 * A payload that merely contains `{ ok: true }` is not proof that an
 * operation succeeded: proxies and broken handlers can return that body with
 * a non-2xx status, omit `data`, or send HTML instead of JSON. All production
 * hooks go through this decoder so the UI never reports success for those
 * responses.
 */

export class ApiResponseError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(path: string, status: number, code: string, message: string) {
    super(`${path}: ${code} — ${message}`);
    this.name = "ApiResponseError";
    this.code = code;
    this.status = status;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 240);
}

export async function readApiData<T>(
  response: Response,
  path: string,
): Promise<T> {
  const raw = await response.text();
  let body: unknown;
  try {
    body = raw ? JSON.parse(raw) : null;
  } catch {
    throw new ApiResponseError(
      path,
      response.status,
      `http_${response.status}`,
      normalizeText(raw) || response.statusText || "invalid JSON response",
    );
  }

  const error =
    isRecord(body) && body.ok === false && isRecord(body.error)
      ? body.error
      : null;
  if (!response.ok || error) {
    const code =
      error && typeof error.code === "string"
        ? error.code
        : `http_${response.status}`;
    const message =
      error && typeof error.message === "string"
        ? error.message
        : normalizeText(raw) || response.statusText || "request failed";
    throw new ApiResponseError(path, response.status, code, message);
  }

  if (
    !isRecord(body) ||
    body.ok !== true ||
    !Object.prototype.hasOwnProperty.call(body, "data")
  ) {
    throw new ApiResponseError(
      path,
      response.status,
      "invalid_response",
      "expected a successful API envelope with a data field",
    );
  }

  return body.data as T;
}
