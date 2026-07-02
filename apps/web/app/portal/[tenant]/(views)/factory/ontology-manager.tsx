"use client";

/**
 * Agent 工厂 — 本地本体管理（FullModal 内容，由左栏「业务域」的 本地本体 入口打开）。
 *
 * 不想让工厂读内置/在线本体时：上传自己的 ontology JSON（actions/events/rules/
 * dataObjects，多文件自动合并）→ 立即成为可选业务域（读取优先级本就是
 * uploaded > local > Allmeta）；这里还能查看/删除已上传的本体。
 * 上传合并逻辑与 composer 📎 一致；坏文件会累积列出，绝不被成功提示吞掉。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/app/portal/components";
import { tenantHeader } from "@/lib/hooks/tenant-header";

async function apiGet<T>(path: string): Promise<T | null> {
  try {
    const r = await fetch(path, { credentials: "same-origin", headers: { Accept: "application/json", ...tenantHeader() } });
    const b = await r.json();
    return b?.ok ? (b.data as T) : null;
  } catch {
    return null;
  }
}
async function apiSend<T = unknown>(path: string, method: "POST" | "DELETE", body?: unknown): Promise<{ ok: boolean; data?: T; message?: string }> {
  try {
    const headers: Record<string, string> = { Accept: "application/json", ...tenantHeader() };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const r = await fetch(path, { method, credentials: "same-origin", headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    const b = await r.json();
    return b?.ok ? { ok: true, data: b.data as T } : { ok: false, message: b?.error?.message };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}

interface UploadRow {
  id: string;
  name: string;
  counts?: { actions?: number; events?: number; rules?: number; objects?: number };
  updatedAt?: string | number;
}

export function OntologyManager({ currentDomain, onDomainsChanged }: { currentDomain: string; onDomainsChanged: () => void }) {
  const [uploads, setUploads] = useState<UploadRow[]>([]);
  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const fileRef = useRef<HTMLInputElement | null>(null);

  const refresh = useCallback(() => {
    void apiGet<{ uploads: UploadRow[] }>("/v1/agent-factory/ontology-uploads").then((d) => setUploads(d?.uploads ?? []));
  }, []);
  useEffect(() => {
    refresh();
  }, [refresh]);

  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    setNote("");
    const bundle: Record<"actions" | "events" | "rules" | "dataObjects", unknown[]> = { actions: [], events: [], rules: [], dataObjects: [] };
    const put = (k: keyof typeof bundle, v: unknown) => {
      if (Array.isArray(v)) bundle[k].push(...v);
    };
    const skipped: string[] = [];
    for (const f of Array.from(files)) {
      const text = await f.text().catch(() => "");
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        skipped.push(f.name);
        continue;
      }
      if (Array.isArray(json)) {
        const n = f.name.toLowerCase();
        const k = /event/.test(n) ? "events" : /rule/.test(n) ? "rules" : /object|entit|dataobject/.test(n) ? "dataObjects" : "actions";
        put(k, json);
      } else if (json && typeof json === "object") {
        const o = json as Record<string, unknown>;
        put("actions", o.actions ?? o.action);
        put("events", o.events ?? o.event);
        put("rules", o.rules ?? o.rule);
        put("dataObjects", o.dataObjects ?? o.objects ?? o.entities);
      }
    }
    if (fileRef.current) fileRef.current.value = "";
    const skipNote = skipped.length ? `注意：${skipped.map((n) => `「${n}」`).join("、")}不是合法 JSON，已跳过。` : "";
    if (!bundle.actions.length) {
      setNote(`上传的文件里没有任何 action，无法作为业务域。${skipNote}`);
      return;
    }
    const nm = name.trim() || files[0]!.name.replace(/\.[^.]+$/, "");
    const r = await apiSend<{ uploaded: UploadRow }>("/v1/agent-factory/ontology-upload", "POST", { name: nm, ontology: bundle });
    if (!r.ok) {
      setNote(`上传失败：${r.message ?? ""}${skipNote ? ` ${skipNote}` : ""}`);
      return;
    }
    setName("");
    setNote(`✓ 已创建本地业务域「${r.data?.uploaded?.name ?? nm}」（${bundle.actions.length} 动作 · ${bundle.events.length} 事件 · ${bundle.rules.length} 规则），左侧业务域列表可选。${skipNote}`);
    refresh();
    onDomainsChanged();
  };

  const remove = async (id: string, nm: string) => {
    if (!window.confirm(`删除本地本体「${nm}」？其业务域将从列表消失。`)) return;
    await apiSend(`/v1/agent-factory/ontology-uploads/${encodeURIComponent(id)}`, "DELETE");
    refresh();
    onDomainsChanged();
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, minWidth: 420 }}>
      <div style={{ fontSize: 12, color: "var(--text-3)", lineHeight: 1.6 }}>
        不想让工厂读内置/在线本体？上传你自己的 ontology JSON（actions / events / rules / dataObjects，可多文件合并），立即成为可选业务域，工厂将优先读取它。
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <input ref={fileRef} type="file" multiple accept=".json,application/json" style={{ display: "none" }} onChange={(e) => void upload(e.target.files)} />
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="业务域名字（可留空，默认取文件名）" style={{ flex: 1, fontSize: 12, padding: "7px 10px", background: "var(--panel-2)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 8 }} />
        <Button icon="plus" tone="primary" onClick={() => fileRef.current?.click()}>选择文件上传</Button>
      </div>
      {note && <div style={{ fontSize: 11.5, color: note.startsWith("✓") ? "var(--green)" : "var(--red)", lineHeight: 1.5 }}>{note}</div>}
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {uploads.map((u) => (
          <div key={u.id} style={{ display: "flex", alignItems: "center", gap: 8, border: "1px solid var(--border)", borderRadius: 9, padding: "8px 10px", background: u.id === currentDomain ? "var(--panel-3)" : "var(--panel-2)" }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12, color: "var(--text)" }}>
                📦 {u.name}
                {u.id === currentDomain && <span style={{ marginLeft: 6, fontSize: 10, color: "var(--signal)" }}>当前业务域</span>}
              </div>
              <div style={{ fontSize: 10.5, color: "var(--text-3)", fontFamily: "var(--mono)" }}>
                {u.counts ? `${u.counts.actions ?? 0} 动作 · ${u.counts.events ?? 0} 事件 · ${u.counts.rules ?? 0} 规则` : u.id}
              </div>
            </div>
            <button onClick={() => void remove(u.id, u.name)} title="删除本地本体" style={{ background: "none", border: "none", color: "var(--text-3)", cursor: "pointer", fontSize: 14 }}>🗑</button>
          </div>
        ))}
        {uploads.length === 0 && <div style={{ fontSize: 11.5, color: "var(--text-4)", padding: 6 }}>还没有上传过本体。</div>}
      </div>
    </div>
  );
}
