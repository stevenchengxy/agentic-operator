/**
 * Strict decoder for the v1 `{ ok, data | error }` response envelope.
 *
 * A payload that merely contains `{ ok: true }` is not proof that an
 * operation succeeded: proxies and broken handlers can return that body with
 * a non-2xx status, omit `data`, or send HTML instead of JSON. All production
 * hooks go through this decoder so the UI never reports success for those
 * responses.
 */

/**
 * Client-owned failure categories. These are intentionally stable identifiers,
 * not display copy: React surfaces translate them at render time while server
 * supplied `message` / `hint` values remain untouched.
 */
export type ApiClientErrorKind =
  | "invalidJson"
  | "networkFailure"
  | "requestFailed"
  | "invalidEnvelope"
  | "invalidHealthReport"
  | "passwordChangeUnconfirmed"
  | "logoutUnconfirmed"
  | "taskResolutionUnconfirmed";

export interface ApiResponseErrorOptions {
  /** Present only when the prose was created by this web client. */
  clientKind?: ApiClientErrorKind;
  /** Unmodified server-provided hint. */
  hint?: string;
  /** Unmodified response text/status detail useful for diagnosis. */
  detail?: string;
  /** Whether `message` came from the API response envelope. */
  serverMessage?: boolean;
}

export class ApiResponseError extends Error {
  readonly path: string;
  readonly code: string;
  readonly status: number;
  readonly clientKind: ApiClientErrorKind | null;
  readonly hint: string | null;
  readonly detail: string | null;
  readonly serverMessage: boolean;
  readonly serverText: string | null;

  constructor(
    path: string,
    status: number,
    code: string,
    message: string,
    options: ApiResponseErrorOptions = {},
  ) {
    const hint = options.hint?.trim() || null;
    const detail = options.detail?.trim() || null;
    const serverMessage = options.serverMessage === true;
    const serverText = serverMessage
      ? `${message}${hint ? ` ${hint}` : ""}`
      : null;
    const diagnostic = serverMessage
      ? `${path}: ${code} — ${serverText}`
      : `${path}: ${code} (HTTP ${status})${detail ? ` — ${detail}` : ""}`;
    super(diagnostic);
    this.name = "ApiResponseError";
    this.path = path;
    this.code = code;
    this.status = status;
    this.clientKind = options.clientKind ?? null;
    this.hint = hint;
    this.detail = detail;
    this.serverMessage = serverMessage;
    this.serverText = serverText;
  }
}

type ErrorTranslate = (
  key: string,
  vars?: Record<string, string | number>,
) => string;

const CLIENT_ERROR_KEYS: Record<ApiClientErrorKind, string> = {
  invalidJson: "apiError.invalidJson",
  networkFailure: "apiError.networkFailure",
  requestFailed: "apiError.requestFailed",
  invalidEnvelope: "apiError.invalidEnvelope",
  invalidHealthReport: "apiError.invalidHealthReport",
  passwordChangeUnconfirmed: "apiError.passwordChangeUnconfirmed",
  logoutUnconfirmed: "apiError.logoutUnconfirmed",
  taskResolutionUnconfirmed: "apiError.taskResolutionUnconfirmed",
};

/**
 * Turn an API error into current-language UI copy without hiding diagnostics.
 * API-authored messages and hints are passed through verbatim; only prose
 * authored by this web client is translated.
 */
export function formatApiError(
  error: unknown,
  t: ErrorTranslate,
  fallbackKey = "apiError.unknown",
): string {
  if (!(error instanceof ApiResponseError)) {
    return error instanceof Error ? error.message : t(fallbackKey);
  }

  const message = error.serverMessage
    ? (error.serverText ?? "")
    : t(
        error.clientKind
          ? CLIENT_ERROR_KEYS[error.clientKind]
          : "apiError.requestFailed",
      );
  const detail =
    !error.serverMessage && error.detail
      ? t("apiError.rawDetail", { detail: error.detail })
      : "";
  return t(
    error.status > 0 ? "apiError.withContext" : "apiError.withoutStatus",
    {
      message: detail ? `${message} ${detail}` : message,
      path: error.path,
      code: error.code,
      status: error.status,
    },
  );
}

/** Fetch while converting browser-authored network text into a stable code. */
export async function fetchApiResponse(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  try {
    return await fetch(path, init);
  } catch {
    throw new ApiResponseError(path, 0, "network_error", "", {
      clientKind: "networkFailure",
    });
  }
}

/** Fetch and decode a canonical v1 `{ ok, data }` response. */
export async function fetchApiData<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  return readApiData<T>(await fetchApiResponse(path, init), path);
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
  let raw: string;
  try {
    raw = await response.text();
  } catch {
    throw new ApiResponseError(
      path,
      response.status,
      "response_read_error",
      "",
      { clientKind: "requestFailed" },
    );
  }
  let body: unknown;
  try {
    body = raw ? JSON.parse(raw) : null;
  } catch {
    throw new ApiResponseError(
      path,
      response.status,
      `http_${response.status}`,
      "",
      {
        clientKind: "invalidJson",
        detail: normalizeText(raw) || response.statusText,
      },
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
    const serverMessage =
      error && typeof error.message === "string" ? error.message : null;
    const hint =
      error && typeof error.hint === "string" ? error.hint : undefined;
    throw new ApiResponseError(
      path,
      response.status,
      code,
      serverMessage ?? "",
      {
        clientKind: serverMessage ? undefined : "requestFailed",
        detail: serverMessage
          ? undefined
          : normalizeText(raw) || response.statusText,
        hint,
        serverMessage: serverMessage !== null,
      },
    );
  }

  if (
    !isRecord(body) ||
    body.ok !== true ||
    !Object.prototype.hasOwnProperty.call(body, "data")
  ) {
    throw new ApiResponseError(path, response.status, "invalid_response", "", {
      clientKind: "invalidEnvelope",
    });
  }

  return body.data as T;
}
