"use client";

/**
 * 造工具 modal — the standalone tool-generation entry point in the tool LIBRARY.
 *
 * Two ways in (both write the SAME shared library, both runtime-executable):
 *   · 从 URL/文档：贴一个公网 API 文档地址（或直接粘文档文本）+ 这个工具要干嘛 → AI 提炼出
 *     方法/URL/入参/返回契约草稿 → 你核对/编辑 → 保存。
 *   · 手填：直接填一个声明式 HTTP 工具。
 * Saved tools land in factory_tools, show up in the catalog, and are bindable by the factory.
 */

import { useState } from "react";
import { Button, useToast } from "@/app/portal/components";
import { useGenerateToolFromDoc, useSaveTool, type ToolDraft } from "@/lib/hooks/useTools";

const lbl: React.CSSProperties = { fontSize: 10.5, textTransform: "uppercase", letterSpacing: 0.5, color: "var(--text-3)", fontFamily: "var(--mono)", display: "block", marginBottom: 3 };
const inp: React.CSSProperties = { width: "100%", padding: "6px 8px", fontSize: 12, fontFamily: "var(--mono)", background: "var(--bg)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 4, outline: "none" };

function jsonStr(v: unknown): string {
  if (v == null) return "";
  try { return JSON.stringify(v, null, 2); } catch { return ""; }
}
function parseJson(s: string): Record<string, unknown> | undefined {
  const t = s.trim();
  if (!t) return undefined;
  try { const o = JSON.parse(t); return o && typeof o === "object" ? o : undefined; } catch { return undefined; }
}

export function CreateToolModal({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const notify = (title: string, tone: "default" | "green" | "red" = "default") => toast({ tone, title });
  const gen = useGenerateToolFromDoc();
  const save = useSaveTool();

  const [intent, setIntent] = useState("");
  const [url, setUrl] = useState("");
  const [docText, setDocText] = useState("");

  // the editable tool form (filled by AI extraction or by hand)
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [method, setMethod] = useState("GET");
  const [urlTemplate, setUrlTemplate] = useState("");
  const [sideEffect, setSideEffect] = useState("read");
  const [headers, setHeaders] = useState("");
  const [bodyTemplate, setBodyTemplate] = useState("");
  const [paramsSchema, setParamsSchema] = useState("");
  const [returnsSchema, setReturnsSchema] = useState("");
  const [shared, setShared] = useState(true);
  const [notes, setNotes] = useState("");

  function applyDraft(d: ToolDraft) {
    if (d.name) setName(String(d.name));
    if (d.method) setMethod(String(d.method).toUpperCase());
    if (d.url_template) setUrlTemplate(String(d.url_template));
    if (d.side_effect) setSideEffect(String(d.side_effect));
    if (d.headers) setHeaders(jsonStr(d.headers));
    if (d.body_template) setBodyTemplate(String(d.body_template));
    if (d.params_schema) setParamsSchema(jsonStr(d.params_schema));
    if (d.returns_schema) setReturnsSchema(jsonStr(d.returns_schema));
    const meta = [d.auth_hint ? `鉴权：${d.auth_hint}` : "", d.confidence != null ? `置信度 ${d.confidence}` : "", d.notes ?? ""].filter(Boolean).join(" · ");
    setNotes(meta);
    if (!description && d.notes) setDescription(String(d.notes).slice(0, 120));
  }

  async function onExtract() {
    if (!intent.trim()) { notify("先写「这个工具要干嘛」（intent）"); return; }
    if (!url.trim() && !docText.trim()) { notify("给一个公网 API 文档 URL，或把文档文本贴进来"); return; }
    try {
      const r = await gen.mutateAsync({ intent: intent.trim(), url: url.trim() || undefined, text: docText.trim() || undefined });
      applyDraft(r.draft);
      notify("已提炼契约草稿，请核对后保存", "green");
    } catch (e) {
      notify(`提炼失败：${(e as Error).message}`, "red");
    }
  }

  async function onSave() {
    if (!name.trim()) { notify("工具名不能为空（建议带命名空间，如 acme.createTicket）"); return; }
    if (!urlTemplate.trim()) { notify("URL 模板不能为空"); return; }
    const ph = parseJson(paramsSchema), rh = parseJson(returnsSchema), hh = parseJson(headers);
    if (paramsSchema.trim() && !ph) { notify("入参 schema 不是合法 JSON"); return; }
    if (returnsSchema.trim() && !rh) { notify("返回 schema 不是合法 JSON"); return; }
    if (headers.trim() && !hh) { notify("headers 不是合法 JSON"); return; }
    try {
      await save.mutateAsync({
        name: name.trim(), description: description.trim(), method, url_template: urlTemplate.trim(),
        headers: hh as Record<string, string> | undefined, body_template: bodyTemplate.trim() || undefined,
        side_effect: sideEffect, params_schema: ph, returns_schema: rh, shared,
      });
      notify(`已保存工具「${name.trim()}」到工具库`, "green");
      onClose();
    } catch (e) {
      notify(`保存失败：${(e as Error).message}`, "red");
    }
  }

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", zIndex: "var(--z-modal)" as unknown as number, display: "flex", alignItems: "flex-start", justifyContent: "center", overflow: "auto", padding: "40px 16px" }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: "min(720px, 100%)", background: "var(--panel)", border: "1px solid var(--border)", borderRadius: 10, padding: 18, display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <h2 style={{ margin: 0, fontSize: 16, color: "var(--text)" }}>造工具 · 加入共享工具库</h2>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "var(--text-3)", fontSize: 18, cursor: "pointer" }}>✕</button>
        </div>

        {/* AI extract from a doc/URL */}
        <div style={{ border: "1px solid var(--signal)", borderRadius: 8, padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ fontSize: 12.5, fontWeight: 700, color: "var(--text)" }}>① 从 URL / 文档 让 AI 提炼（可选）</div>
          <div><label style={lbl}>这个工具要干嘛（intent）</label><input style={inp} value={intent} onChange={(e) => setIntent(e.target.value)} placeholder="如：按 jobId 拉取职位详情" /></div>
          <div><label style={lbl}>公网 API 文档 URL</label><input style={inp} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://docs.example.com/api/jobs" /></div>
          <div><label style={lbl}>或直接粘贴文档文本</label><textarea style={{ ...inp, minHeight: 56, resize: "vertical" }} value={docText} onChange={(e) => setDocText(e.target.value)} placeholder="把 API 文档相关段落贴进来…" /></div>
          <div><Button small tone="primary" onClick={onExtract} disabled={gen.isPending}>{gen.isPending ? "提炼中…" : "✦ AI 提炼契约"}</Button>{notes && <span style={{ marginLeft: 10, fontSize: 11, color: "var(--text-3)" }}>{notes}</span>}</div>
        </div>

        {/* the editable form */}
        <div style={{ fontSize: 12.5, fontWeight: 700, color: "var(--text)" }}>② 核对 / 手填工具契约</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <div><label style={lbl}>工具名（带命名空间）</label><input style={inp} value={name} onChange={(e) => setName(e.target.value)} placeholder="acme.createTicket" /></div>
          <div><label style={lbl}>方法</label><select style={inp} value={method} onChange={(e) => setMethod(e.target.value)}>{["GET", "POST", "PUT", "DELETE", "PATCH"].map((m) => <option key={m} value={m}>{m}</option>)}</select></div>
        </div>
        <div><label style={lbl}>描述</label><input style={inp} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="一句话说明这个工具干嘛" /></div>
        <div><label style={lbl}>URL 模板（可含 {"{placeholder}"}，运行时用事件 payload 填）</label><input style={inp} value={urlTemplate} onChange={(e) => setUrlTemplate(e.target.value)} placeholder="https://api.example.com/v1/jobs/{job_id}" /></div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <div><label style={lbl}>副作用</label><select style={inp} value={sideEffect} onChange={(e) => setSideEffect(e.target.value)}>{["read", "write", "dual"].map((m) => <option key={m} value={m}>{m}</option>)}</select></div>
          <div style={{ display: "flex", alignItems: "flex-end", gap: 6 }}><label style={{ fontSize: 12, color: "var(--text-2)", display: "flex", gap: 6, alignItems: "center" }}><input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} />共享（任何 domain 可绑），取消则仅本租户</label></div>
        </div>
        <div><label style={lbl}>headers（JSON，凭证可写 {"{ENV_NAME}"}，运行时从 config/env 填）</label><textarea style={{ ...inp, minHeight: 44, resize: "vertical" }} value={headers} onChange={(e) => setHeaders(e.target.value)} placeholder='{ "Authorization": "Bearer {ACME_KEY}" }' /></div>
        {method !== "GET" && <div><label style={lbl}>body 模板（可含 {"{placeholder}"}）</label><textarea style={{ ...inp, minHeight: 44, resize: "vertical" }} value={bodyTemplate} onChange={(e) => setBodyTemplate(e.target.value)} placeholder='{ "title": "{title}" }' /></div>}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <div><label style={lbl}>入参 schema（JSON）</label><textarea style={{ ...inp, minHeight: 56, resize: "vertical" }} value={paramsSchema} onChange={(e) => setParamsSchema(e.target.value)} placeholder='{ "job_id": "string · 职位ID" }' /></div>
          <div><label style={lbl}>返回 schema（JSON）</label><textarea style={{ ...inp, minHeight: 56, resize: "vertical" }} value={returnsSchema} onChange={(e) => setReturnsSchema(e.target.value)} placeholder='{ "title": "string", "salary": "number" }' /></div>
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 4 }}>
          <Button small tone="ghost" onClick={onClose}>取消</Button>
          <Button small tone="primary" onClick={onSave} disabled={save.isPending}>{save.isPending ? "保存中…" : "保存到工具库"}</Button>
        </div>
      </div>
    </div>
  );
}
