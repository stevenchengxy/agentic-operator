export type FactoryApiResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; message: string; code?: string };

type JsonResponse = Pick<Response, "ok" | "status" | "statusText" | "json">;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function apiErrorMessage(body: unknown): string | undefined {
  if (!isRecord(body) || !isRecord(body.error)) return undefined;
  return typeof body.error.message === "string" && body.error.message.trim()
    ? body.error.message
    : undefined;
}

function apiErrorCode(body: unknown): string | undefined {
  if (!isRecord(body) || !isRecord(body.error)) return undefined;
  return typeof body.error.code === "string" && body.error.code.trim()
    ? body.error.code
    : undefined;
}

/**
 * Decode the factory API envelope without ever treating a JSON `{ ok: true }`
 * body as success when the HTTP request itself failed (or vice versa).
 */
export async function decodeFactoryResponse<T>(response: JsonResponse): Promise<FactoryApiResult<T>> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return {
      ok: false,
      status: response.status,
      message: `HTTP ${response.status} 返回了无效 JSON`,
    };
  }

  if (!response.ok) {
    const code = apiErrorCode(body);
    return {
      ok: false,
      status: response.status,
      message: apiErrorMessage(body) ?? (response.statusText || `HTTP ${response.status}`),
      ...(code ? { code } : {}),
    };
  }

  if (!isRecord(body) || body.ok !== true) {
    const code = apiErrorCode(body);
    return {
      ok: false,
      status: response.status,
      message: apiErrorMessage(body) ?? "接口未返回成功状态",
      ...(code ? { code } : {}),
    };
  }

  if (!("data" in body)) {
    return {
      ok: false,
      status: response.status,
      message: "接口成功响应缺少 data",
    };
  }

  return { ok: true, status: response.status, data: body.data as T };
}

export function factoryNetworkFailure(error: unknown): FactoryApiResult<never> {
  return {
    ok: false,
    status: 0,
    message: error instanceof Error && error.message ? error.message : "网络请求失败",
  };
}

export type HumanInteractionKind = "clarify" | "test_approval" | "boundary";

/** Keep the exact one-shot interaction coordinates in one tested transport
 * builder. Callers cannot accidentally fall back to the old text-only body. */
export function buildHumanInteractionSubmission(input: {
  conversation: string;
  interactionId: string;
  kind: HumanInteractionKind;
  text: string;
}): { conversation: string; interactionId: string; kind: HumanInteractionKind; text: string } {
  const conversation = input.conversation.trim();
  const interactionId = input.interactionId.trim();
  const text = input.text.trim();
  if (!conversation || !interactionId || !text) {
    throw new Error("当前交互缺少会话、卡片编号或回复内容，不能安全提交");
  }
  return { conversation, interactionId, kind: input.kind, text };
}
