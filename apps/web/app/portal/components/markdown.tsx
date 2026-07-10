"use client";

import { memo, type CSSProperties } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

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
 */

const REMARK_PLUGINS = [remarkGfm];

const COMPONENTS: Components = {
  // Open links safely in a new tab; strip react-markdown's `node` before hitting the DOM.
  a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" />,
};

export const Markdown = memo(function Markdown({
  children,
  className,
  style,
}: {
  children: string | null | undefined;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <div className={className ? `factory-md ${className}` : "factory-md"} style={style}>
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={COMPONENTS}>
        {children ?? ""}
      </ReactMarkdown>
    </div>
  );
});
