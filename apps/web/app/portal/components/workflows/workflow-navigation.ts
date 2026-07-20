const RETURN_PREFIX = "agentic:workflow-return:v1:";
const RETURN_TTL_MS = 12 * 60 * 60 * 1_000;

export interface WorkflowReturnState {
  tenant: string;
  workflowSlug: string;
  workflowVersionId: string | null;
  selectedAgent: string;
  editing: boolean;
  tool: "select" | "connect" | "add";
  zoom: number;
  scrollLeft: number;
  scrollTop: number;
  createdAt: number;
}

function browserStorage(): Storage | null {
  return typeof window === "undefined" ? null : window.sessionStorage;
}

function validToken(value: string): boolean {
  return /^[A-Za-z0-9_-]{8,160}$/.test(value);
}

function newToken(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function storeWorkflowReturnState(
  state: Omit<WorkflowReturnState, "createdAt">,
  storage: Storage | null = browserStorage(),
): string | null {
  if (!storage) return null;
  const token = newToken();
  storage.setItem(
    `${RETURN_PREFIX}${token}`,
    JSON.stringify({ ...state, createdAt: Date.now() }),
  );
  return token;
}

export function readWorkflowReturnState(
  token: string | null | undefined,
  tenant: string,
  options: { storage?: Storage | null; now?: number } = {},
): WorkflowReturnState | null {
  if (!token || !validToken(token)) return null;
  const storage = options.storage ?? browserStorage();
  if (!storage) return null;
  const raw = storage.getItem(`${RETURN_PREFIX}${token}`);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<WorkflowReturnState>;
    const now = options.now ?? Date.now();
    if (
      parsed.tenant !== tenant ||
      typeof parsed.workflowSlug !== "string" ||
      typeof parsed.selectedAgent !== "string" ||
      typeof parsed.createdAt !== "number" ||
      now - parsed.createdAt > RETURN_TTL_MS ||
      !["select", "connect", "add"].includes(String(parsed.tool)) ||
      typeof parsed.zoom !== "number" ||
      typeof parsed.scrollLeft !== "number" ||
      typeof parsed.scrollTop !== "number"
    ) {
      storage.removeItem(`${RETURN_PREFIX}${token}`);
      return null;
    }
    return parsed as WorkflowReturnState;
  } catch {
    storage.removeItem(`${RETURN_PREFIX}${token}`);
    return null;
  }
}

export function agentStudioWorkflowHref(input: {
  tenant: string;
  agentId: string;
  workflowSlug: string;
  resumeToken?: string | null;
  agentDraftId?: string | null;
}): string {
  const query = new URLSearchParams({
    edit: "1",
    from: "workflow",
    workflow: input.workflowSlug,
  });
  if (input.resumeToken) query.set("resume", input.resumeToken);
  if (input.agentDraftId) query.set("draftId", input.agentDraftId);
  return `/portal/${encodeURIComponent(input.tenant)}/agents/${encodeURIComponent(
    input.agentId,
  )}?${query.toString()}`;
}

export function workflowCanvasHref(input: {
  tenant: string;
  workflowSlug: string;
  agentId?: string | null;
  resumeToken?: string | null;
  agentDraftId?: string | null;
}): string {
  const query = new URLSearchParams({
    workflow: input.workflowSlug,
    mode: "edit",
  });
  if (input.agentId) query.set("agent", input.agentId);
  if (input.resumeToken) query.set("resume", input.resumeToken);
  if (input.agentDraftId) query.set("agentDraft", input.agentDraftId);
  return `/portal/${encodeURIComponent(input.tenant)}/workflows?${query.toString()}`;
}
