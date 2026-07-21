"use client";

import { memo, useMemo, useState, type CSSProperties } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { useI18n } from "@/app/portal/lib/preferences-context";

/**
 * Markdown — renders LLM-generated answers/reasoning/reports as formatted text.
 *
 * The factory brain streams answers in markdown (## headings, **bold**, - lists,
 * `code`, tables, links). They were previously dumped as a raw pre-wrap string, so
 * the syntax showed literally. This wraps react-markdown + remark-gfm in the shared
 * `.factory-md` skin (apps/web/app/global.css) — theme-aware, GFM tables/task-lists.
 *
 * Safety: react-markdown does NOT render raw HTML (no rehype-raw), so untrusted LLM
 * text can't inject markup. Links are forced to open in a new tab with noopener.
 * Memoized on `children` so streaming re-renders of unchanged prior blocks are cheap.
 *
 * #HTML-DOC-CARD — when generate_report is unavailable the brain falls back to pasting a
 * COMPLETE HTML document into chat; react-markdown (correctly) refuses raw HTML, so the
 * user saw a wall of escaped source instead of a report. Complete `<!DOCTYPE…>…</html>`
 * segments are now extracted and rendered as a SANDBOXED iframe preview card (sandbox=""
 * → no scripts, no same-origin: the document is inert, CSS-only) with a 下载 action.
 * Surrounding prose still renders as markdown. Never uses rehype-raw / dangerouslySetInnerHTML.
 */

const REMARK_PLUGINS = [remarkGfm];

const COMPONENTS: Components = {
  // Open links safely in a new tab; strip react-markdown's `node` before hitting the DOM.
  a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" />,
};

/** A complete, non-trivial HTML document embedded in the message. Requires the CLOSING
 *  </html> so a still-streaming document stays plain text until it fully arrives. */
const HTML_DOC_RE = /<!DOCTYPE\s+html[\s\S]*?<\/html\s*>|<html[\s>][\s\S]*?<\/html\s*>/gi;
const MIN_HTML_DOC_CHARS = 400;

type Segment = { kind: "md" | "html"; content: string };

function splitHtmlDocuments(text: string): Segment[] {
  const segments: Segment[] = [];
  let last = 0;
  for (const m of text.matchAll(HTML_DOC_RE)) {
    const start = m.index ?? 0;
    const doc = m[0] ?? "";
    if (doc.length < MIN_HTML_DOC_CHARS) continue; // tiny inline html → leave as text
    if (start > last) segments.push({ kind: "md", content: text.slice(last, start) });
    segments.push({ kind: "html", content: doc });
    last = start + doc.length;
  }
  if (segments.length === 0) return [{ kind: "md", content: text }];
  if (last < text.length) segments.push({ kind: "md", content: text.slice(last) });
  return segments;
}

function HtmlDocCard({ html }: { html: string }) {
  const { t } = useI18n();
  const [tall, setTall] = useState(false);
  const title =
    /<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1]?.trim() ||
    t("markdownComp.htmlDocCard.defaultTitle");
  const download = () => {
    const blob = new Blob([html], { type: "text/html;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${title.replace(/[^\w一-鿿-]+/g, "-").slice(0, 60) || "report"}.html`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5_000);
  };
  return (
    <div
      style={{
        border: "1px solid var(--border)",
        borderRadius: 8,
        background: "var(--panel-2)",
        margin: "10px 0",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "8px 12px",
          borderBottom: "1px solid var(--border)",
          fontSize: 12,
          color: "var(--text-2)",
        }}
      >
        <span style={{ fontWeight: 600, color: "var(--text)" }}>📄 {title}</span>
        <span style={{ opacity: 0.7 }}>
          {t("markdownComp.htmlDocCard.sandboxPreviewNote")}
        </span>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          onClick={() => setTall((v) => !v)}
          style={{ background: "none", border: "1px solid var(--border-2)", borderRadius: 6, color: "var(--text-2)", padding: "2px 10px", cursor: "pointer", fontSize: 12 }}
        >
          {tall
            ? t("markdownComp.htmlDocCard.collapse")
            : t("markdownComp.htmlDocCard.expand")}
        </button>
        <button
          type="button"
          onClick={download}
          style={{ background: "none", border: "1px solid var(--border-2)", borderRadius: 6, color: "var(--text-2)", padding: "2px 10px", cursor: "pointer", fontSize: 12 }}
        >
          {t("markdownComp.htmlDocCard.download")}
        </button>
      </div>
      {/* sandbox=""（无 allow-scripts / allow-same-origin）→ 文档完全惰性：只渲染 HTML/CSS，
          脚本、表单提交、弹窗、同源访问全部被浏览器拦截——LLM 生成的 HTML 不可能借此执行代码。 */}
      <iframe
        title={title}
        sandbox=""
        srcDoc={html}
        style={{ display: "block", width: "100%", height: tall ? "82vh" : 520, border: "none", background: "#fff" }}
      />
    </div>
  );
}

export const Markdown = memo(function Markdown({
  children,
  className,
  style,
}: {
  children: string | null | undefined;
  className?: string;
  style?: CSSProperties;
}) {
  const text = children ?? "";
  const segments = useMemo(() => splitHtmlDocuments(text), [text]);
  return (
    <div className={className ? `factory-md ${className}` : "factory-md"} style={style}>
      {segments.map((seg, i) =>
        seg.kind === "html" ? (
          <HtmlDocCard key={`html-${i}`} html={seg.content} />
        ) : (
          <ReactMarkdown key={`md-${i}`} remarkPlugins={REMARK_PLUGINS} components={COMPONENTS}>
            {seg.content}
          </ReactMarkdown>
        ),
      )}
    </div>
  );
});
