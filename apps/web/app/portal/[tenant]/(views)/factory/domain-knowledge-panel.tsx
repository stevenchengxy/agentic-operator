"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/app/portal/components";
import { tenantHeader } from "@/lib/hooks/tenant-header";
import {
  containsDomainKnowledgeSecret,
  parseHumanDomainMemories,
  type HumanDomainMemory,
} from "./domain-knowledge";
import {
  decodeFactoryResponse,
  factoryNetworkFailure,
  type FactoryApiResult,
} from "./factory-api";

interface DomainKnowledgePanelProps {
  tenant: string;
  domain: string;
}

const KIND_LABEL: Record<HumanDomainMemory["kind"], string> = {
  clarify: "澄清回答",
  boundary: "边界决定",
  test_approval: "测试决定",
  directive: "人工指令",
};

function tenantHeaders(tenant: string): Record<string, string> {
  return { ...tenantHeader(), "x-agentic-tenant": tenant };
}

async function factoryRequest<T>(
  tenant: string,
  path: string,
  init: RequestInit = {},
): Promise<FactoryApiResult<T>> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...tenantHeaders(tenant),
    ...(init.headers as Record<string, string> | undefined),
  };
  try {
    const response = await fetch(path, {
      credentials: "same-origin",
      ...init,
      headers,
    });
    return await decodeFactoryResponse<T>(response);
  } catch (error) {
    return factoryNetworkFailure(error);
  }
}

const formatUpdatedAt = (value: string): string =>
  new Date(value).toLocaleString("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

/** Human-only domain knowledge. It deliberately does not render the API's AI
 * reflection list and has no surface for entering integration credentials. */
export function DomainKnowledgePanel({
  tenant,
  domain,
}: DomainKnowledgePanelProps) {
  const [memories, setMemories] = useState<HumanDomainMemory[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [answerDraft, setAnswerDraft] = useState("");
  const [contextDraft, setContextDraft] = useState("");

  const load = useCallback(async () => {
    if (!tenant || !domain) {
      setMemories([]);
      return;
    }
    setLoading(true);
    const result = await factoryRequest<unknown>(
      tenant,
      `/v1/agent-factory/memories?domain=${encodeURIComponent(domain)}&limit=200`,
    );
    setLoading(false);
    if (!result.ok) {
      setError(`领域知识读取失败：${result.message}`);
      return;
    }
    setError("");
    setMemories(parseHumanDomainMemories(result.data, domain));
  }, [domain, tenant]);

  useEffect(() => {
    setEditingId(null);
    setError("");
    void load();
  }, [load]);

  const beginEdit = (memory: HumanDomainMemory) => {
    setEditingId(memory.id);
    setAnswerDraft(memory.answer);
    setContextDraft(memory.context ?? "");
    setError("");
  };

  const togglePin = async (memory: HumanDomainMemory) => {
    setBusyId(memory.id);
    setError("");
    const result = await factoryRequest<{ updated: boolean }>(
      tenant,
      `/v1/agent-factory/memories/${encodeURIComponent(memory.id)}/pin`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domain, pinned: !memory.pinned }),
      },
    );
    setBusyId(null);
    if (!result.ok || result.data.updated !== true) {
      setError(
        `更新置顶状态失败：${result.ok ? "服务端未确认更新" : result.message}`,
      );
      return;
    }
    await load();
  };

  const saveEdit = async (memory: HumanDomainMemory) => {
    const answer = answerDraft.trim();
    const context = contextDraft.trim();
    if (!answer) {
      setError("人工结论不能为空。");
      return;
    }
    if (
      containsDomainKnowledgeSecret(answer) ||
      containsDomainKnowledgeSecret(context)
    ) {
      setError(
        "这里不能保存密钥、Token、密码或数据库连接串。请把凭证放进密钥管理，再只写业务结论。",
      );
      return;
    }
    setBusyId(memory.id);
    setError("");
    const result = await factoryRequest<{ memory: unknown }>(
      tenant,
      `/v1/agent-factory/memories/${encodeURIComponent(memory.id)}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          domain,
          answer,
          context: context || null,
        }),
      },
    );
    setBusyId(null);
    if (!result.ok) {
      setError(`保存人工结论失败：${result.message}`);
      return;
    }
    setEditingId(null);
    await load();
  };

  const deleteMemory = async (memory: HumanDomainMemory) => {
    if (
      !window.confirm(
        `确认删除这条人工领域知识？\n\n${memory.question}\n\n删除后，新会话不会再自动读取它。`,
      )
    ) {
      return;
    }
    setBusyId(memory.id);
    setError("");
    const result = await factoryRequest<{ deleted: boolean }>(
      tenant,
      `/v1/agent-factory/memories/${encodeURIComponent(memory.id)}?domain=${encodeURIComponent(domain)}`,
      { method: "DELETE" },
    );
    setBusyId(null);
    if (!result.ok || result.data.deleted !== true) {
      setError(
        `删除人工结论失败：${result.ok ? "服务端未确认删除" : result.message}`,
      );
      return;
    }
    if (editingId === memory.id) setEditingId(null);
    await load();
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
      <div
        style={{
          padding: "7px 9px",
          border: "1px solid var(--border)",
          borderRadius: 7,
          background: "var(--panel-2)",
          color: "var(--text-3)",
          fontSize: 10.5,
          lineHeight: 1.5,
        }}
      >
        只显示人确认过的业务知识。密钥、Token、密码和连接串不会显示，也不能在这里保存。
      </div>

      {error && (
        <div
          role="alert"
          style={{ color: "var(--red)", fontSize: 10.5, lineHeight: 1.45 }}
        >
          {error}
        </div>
      )}
      {loading && memories.length === 0 && (
        <div style={{ color: "var(--text-4)", fontSize: 11 }}>正在读取…</div>
      )}
      {!loading && memories.length === 0 && !error && (
        <div style={{ color: "var(--text-4)", fontSize: 11, lineHeight: 1.5 }}>
          还没有人工确认的领域知识。工厂在 ask_user 后会把可复用的业务答案记录在这里。
        </div>
      )}

      {memories.map((memory) => {
        const editing = editingId === memory.id;
        const busy = busyId === memory.id;
        return (
          <article
            key={memory.id}
            style={{
              padding: "8px 9px",
              border: `1px solid ${
                memory.pinned ? "var(--signal)" : "var(--border)"
              }`,
              borderRadius: 8,
              background: "var(--panel-2)",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 5,
                marginBottom: 5,
                fontSize: 9.5,
                color: "var(--text-3)",
              }}
            >
              {memory.pinned && <span style={{ color: "var(--signal)" }}>置顶</span>}
              <span>{KIND_LABEL[memory.kind]}</span>
              <span>· 来源：人工</span>
              <span style={{ marginLeft: "auto" }}>
                更新 {formatUpdatedAt(memory.updatedAt)}
              </span>
            </div>
            <div
              style={{
                color: "var(--text)",
                fontSize: 11.5,
                fontWeight: 600,
                lineHeight: 1.45,
                overflowWrap: "anywhere",
              }}
            >
              {memory.question}
            </div>

            {editing ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 7 }}>
                <label style={{ color: "var(--text-3)", fontSize: 10.5 }}>
                  人工结论
                  <textarea
                    value={answerDraft}
                    onChange={(event) => setAnswerDraft(event.target.value)}
                    rows={4}
                    style={{
                      display: "block",
                      width: "100%",
                      boxSizing: "border-box",
                      marginTop: 3,
                      padding: 7,
                      resize: "vertical",
                      border: "1px solid var(--border)",
                      borderRadius: 6,
                      background: "var(--panel-3)",
                      color: "var(--text)",
                      fontSize: 11,
                    }}
                  />
                </label>
                <label style={{ color: "var(--text-3)", fontSize: 10.5 }}>
                  补充上下文（可空）
                  <textarea
                    value={contextDraft}
                    onChange={(event) => setContextDraft(event.target.value)}
                    rows={2}
                    style={{
                      display: "block",
                      width: "100%",
                      boxSizing: "border-box",
                      marginTop: 3,
                      padding: 7,
                      resize: "vertical",
                      border: "1px solid var(--border)",
                      borderRadius: 6,
                      background: "var(--panel-3)",
                      color: "var(--text)",
                      fontSize: 11,
                    }}
                  />
                </label>
                <div style={{ display: "flex", gap: 6 }}>
                  <Button small disabled={busy} onClick={() => void saveEdit(memory)}>
                    {busy ? "保存中…" : "保存"}
                  </Button>
                  <Button
                    small
                    tone="ghost"
                    disabled={busy}
                    onClick={() => setEditingId(null)}
                  >
                    取消
                  </Button>
                </div>
              </div>
            ) : (
              <>
                <div
                  style={{
                    marginTop: 5,
                    color: "var(--text-2)",
                    fontSize: 11,
                    lineHeight: 1.55,
                    whiteSpace: "pre-wrap",
                    overflowWrap: "anywhere",
                  }}
                >
                  {memory.answer}
                </div>
                {memory.context && (
                  <div
                    style={{
                      marginTop: 5,
                      paddingTop: 5,
                      borderTop: "1px dashed var(--border)",
                      color: "var(--text-3)",
                      fontSize: 10,
                      lineHeight: 1.45,
                      whiteSpace: "pre-wrap",
                      overflowWrap: "anywhere",
                    }}
                  >
                    上下文：{memory.context}
                  </div>
                )}
                <div style={{ display: "flex", gap: 9, marginTop: 7 }}>
                  <button
                    disabled={busy}
                    onClick={() => void togglePin(memory)}
                    style={{
                      padding: 0,
                      border: "none",
                      background: "none",
                      color: "var(--signal)",
                      cursor: busy ? "wait" : "pointer",
                      fontSize: 10.5,
                    }}
                  >
                    {memory.pinned ? "取消置顶" : "置顶"}
                  </button>
                  <button
                    disabled={busy}
                    onClick={() => beginEdit(memory)}
                    style={{
                      padding: 0,
                      border: "none",
                      background: "none",
                      color: "var(--text-3)",
                      cursor: busy ? "wait" : "pointer",
                      fontSize: 10.5,
                    }}
                  >
                    编辑
                  </button>
                  <button
                    disabled={busy}
                    onClick={() => void deleteMemory(memory)}
                    style={{
                      padding: 0,
                      border: "none",
                      background: "none",
                      color: "var(--red)",
                      cursor: busy ? "wait" : "pointer",
                      fontSize: 10.5,
                    }}
                  >
                    删除
                  </button>
                </div>
              </>
            )}
          </article>
        );
      })}
    </div>
  );
}
