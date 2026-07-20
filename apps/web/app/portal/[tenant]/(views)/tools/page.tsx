"use client";

/**
 * Agentic Tools — comprehensive API reference for the global tool registry.
 *
 * This is the canonical "what tools can I drop into a workflow?" page.
 * Every entry in @agentic/tools's globalToolRegistry gets a full section
 * with manifest declaration, args, returns, config, and chaining notes —
 * structured so a new-tenant author can compose an entire workflow from
 * configuration alone.
 *
 * Layout:
 *   - 240px sticky left rail: search + category chips + scrollable tool list
 *     (clicking a tool scrolls the right pane to that section).
 *   - Right pane: API-docs-style scrollable surface. Each tool section has
 *     anchor-stable id="tool-<name>" so direct links work.
 *
 * Backed by `useTools()` against GET /v1/tools.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import {
  Badge,
  Button,
  Empty,
  FilterChip,
  Panel,
  ViewHeader,
  useToast,
} from "@/app/portal/components";
import {
  useTools,
  useDeleteTool,
  type ToolCatalogEntry,
  type ToolFieldSchema,
} from "@/lib/hooks/useTools";
import { useI18n } from "@/app/portal/lib/preferences-context";
import { CreateToolModal } from "./create-tool-modal";

function slugifyAnchor(name: string): string {
  return "tool-" + name.replace(/[^a-zA-Z0-9._-]/g, "-").toLowerCase();
}

export default function ToolsPage() {
  const { t } = useI18n();
  const params = useParams<{ tenant: string }>();
  const { data, isLoading, error } = useTools();
  const tools = data?.tools ?? [];
  const categories = data?.categories ?? [];

  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string | "all">("all");
  const [showCreate, setShowCreate] = useState(false);
  const scrollPaneRef = useRef<HTMLDivElement | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return tools.filter((t) => {
      if (category !== "all" && t.category !== category) return false;
      if (!q) return true;
      const hay = [
        t.name,
        t.summary,
        t.description ?? "",
        ...(t.aliases ?? []),
        t.sourcePath,
        ...Object.keys(t.argsSchema ?? {}),
        ...Object.keys(t.configSchema ?? {}),
      ]
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }, [tools, query, category]);

  // Group filtered tools by category for the right-pane TOC.
  const grouped = useMemo(() => {
    const m = new Map<string, ToolCatalogEntry[]>();
    for (const t of filtered) {
      const arr = m.get(t.category) ?? [];
      arr.push(t);
      m.set(t.category, arr);
    }
    return Array.from(m.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [filtered]);

  // Deep-link → scroll on initial load if URL has #tool-<name>.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const hash = window.location.hash.replace(/^#/, "");
    if (!hash) return;
    // Defer until DOM has the section nodes.
    requestAnimationFrame(() => {
      const el = document.getElementById(hash);
      if (el) el.scrollIntoView({ behavior: "auto", block: "start" });
    });
  }, [filtered.length]);

  function scrollToTool(name: string) {
    const id = slugifyAnchor(name);
    const el = document.getElementById(id);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
      // Persist in URL so refresh / link-sharing works.
      window.history.replaceState(null, "", `#${id}`);
    }
  }

  return (
    <div
      style={{ display: "flex", flexDirection: "column", height: "100%" }}
    >
      {showCreate && <CreateToolModal onClose={() => setShowCreate(false)} />}
      <ViewHeader
        title={t("nav.toolLibrary")}
        subtitle={t("tools.subtitle")}
        badge={
          <Badge tone="signal">
            {data
              ? t("tools.countBadge", {
                  count: data.count,
                  categories: data.categories.length,
                })
              : "—"}
          </Badge>
        }
      />

      {error && (
        <div style={{ padding: 20 }}>
          <Empty
            title={t("tools.loadFailedTitle")}
            hint={error.message || t("tools.apiUnreachable")}
          />
        </div>
      )}
      {!error && isLoading && (
        <div style={{ padding: 20 }}>
          <Empty title={t("tools.loading")} hint="" />
        </div>
      )}

      {!error && !isLoading && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "260px 1fr",
            gap: 0,
            flex: 1,
            minHeight: 0,
          }}
        >
          {/* LEFT RAIL */}
          <aside
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 10,
              padding: 16,
              borderRight: "1px solid var(--border)",
              background: "var(--panel-2)",
              overflow: "auto",
            }}
          >
            <Button tone="primary" icon="plus" onClick={() => setShowCreate(true)}>造工具</Button>
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("tools.searchPlaceholder")}
              style={{
                width: "100%",
                padding: "7px 9px",
                fontFamily: "var(--mono)",
                fontSize: 12,
                background: "var(--bg)",
                color: "var(--text)",
                border: "1px solid var(--border)",
                borderRadius: 4,
                outline: "none",
              }}
            />

            <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
              <FilterChip
                active={category === "all"}
                onClick={() => setCategory("all")}
              >
                {t("tools.allChip", { count: tools.length })}
              </FilterChip>
              {categories.map((cat) => {
                const count = tools.filter((t) => t.category === cat).length;
                return (
                  <FilterChip
                    key={cat}
                    active={category === cat}
                    onClick={() => setCategory(cat)}
                  >
                    {cat} ({count})
                  </FilterChip>
                );
              })}
            </div>

            <nav style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              {grouped.map(([cat, items]) => (
                <div key={cat}>
                  <div style={catLabelStyle}>{cat}</div>
                  <ul
                    style={{ listStyle: "none", margin: "4px 0 0", padding: 0 }}
                  >
                    {items.map((t) => (
                      <li key={t.name}>
                        <button
                          onClick={() => scrollToTool(t.name)}
                          style={navLinkStyle}
                        >
                          {t.name}
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
              {grouped.length === 0 && (
                <div style={{ color: "var(--text-3)", fontSize: 12 }}>
                  {t("tools.navNoMatch")}
                </div>
              )}
            </nav>
          </aside>

          {/* RIGHT PANE — scroll target */}
          <div
            ref={scrollPaneRef}
            style={{ overflow: "auto", padding: "24px 32px" }}
          >
            {filtered.length === 0 ? (
              <Empty
                title={t("tools.noMatchTitle")}
                hint={t("tools.noMatchHint")}
              />
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 28 }}>
                <div style={introStyle}>
                  <h2
                    style={{
                      margin: 0,
                      fontFamily: "var(--display)",
                      fontSize: 20,
                      color: "var(--text)",
                    }}
                  >
                    {t("tools.apiReference")}
                  </h2>
                  <p style={introBodyStyle}>
                    {t("tools.introPart1")}{" "}
                    <code className="mono">tool_use[]</code>{" "}
                    {t("tools.introPart2")}{" "}
                    <code className="mono">tool_use[].config</code>{" "}
                    {t("tools.introPart3")}{" "}
                    <strong>{t("tools.resolutionOrder")}</strong>;{" "}
                    {t("tools.introPart4")}
                  </p>
                </div>

                {/* P3: where tools come from + the progressive doc→tool pipeline (cross-links the factory). */}
                <Panel style={{ padding: "14px 16px", borderColor: "var(--signal)" }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text)", marginBottom: 6 }}>工具从哪来 · 不止这份目录</div>
                  <ol style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, color: "var(--text-2)", lineHeight: 1.7 }}>
                    <li><strong>全局注册表</strong>：下面这些是任何租户都能在 manifest 的 <code className="mono">tool_use[]</code> 里直接绑定的内置工具。</li>
                    <li><strong>渐进式发现</strong>：Agent 工厂的大脑会按某个 Ontology 动作的语义，用 <code className="mono">search_tools</code> 在这份库里【按需检索】最贴切的工具，而不是把整份目录背下来。</li>
                    <li><strong>文档造工具</strong>：库里没有现成的，用户给一个公网 API 文档/网址，大脑就 <code className="mono">fetch_doc</code> 抓取 → <code className="mono">extract_api_schema</code> 自动提炼出方法/URL/入参/返回契约 → 核对后 <code className="mono">create_tool</code> 落地，立刻能被 agent 绑定，并持久化供以后复用。</li>
                  </ol>
                  <div style={{ marginTop: 8, fontSize: 12 }}>
                    <Link href={`/portal/${params.tenant}/factory`} style={{ color: "var(--signal)", textDecoration: "none" }}>→ 去 Agent 工厂，让大脑按本体动作自动找/造工具</Link>
                  </div>
                </Panel>

                {grouped.map(([cat, items]) => (
                  <section
                    key={cat}
                    style={{ display: "flex", flexDirection: "column", gap: 20 }}
                  >
                    <h2 style={categoryHeadingStyle}>{cat}</h2>
                    {items.map((t) => (
                      <ToolSection key={t.name} tool={t} />
                    ))}
                  </section>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Section ────────────────────────────────────────────────────────────────

function ToolSection({ tool }: { tool: ToolCatalogEntry }) {
  const { t } = useI18n();
  const del = useDeleteTool();
  const toast = useToast();
  const isCreated = tool.origin === "created";
  const manifestSnippet = useMemo(() => {
    const entry: Record<string, unknown> = {
      name: tool.name,
      description: tool.summary,
    };
    if (tool.configExample && Object.keys(tool.configExample).length > 0) {
      entry.config = tool.configExample;
    }
    return JSON.stringify([entry], null, 2);
  }, [tool]);

  const hasArgs = tool.argsSchema && Object.keys(tool.argsSchema).length > 0;
  const hasConfig = tool.configSchema && Object.keys(tool.configSchema).length > 0;
  const hasReturns = tool.returnsSchema && Object.keys(tool.returnsSchema).length > 0;

  return (
    <article
      id={`tool-${tool.name.replace(/[^a-zA-Z0-9._-]/g, "-").toLowerCase()}`}
      style={sectionStyle}
    >
      <header style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            justifyContent: "space-between",
            gap: 12,
            flexWrap: "wrap",
          }}
        >
          <h3
            className="mono"
            style={{
              margin: 0,
              fontSize: 18,
              color: "var(--text)",
              fontWeight: 500,
            }}
          >
            {tool.name}
          </h3>
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <Badge tone="muted">{tool.category}</Badge>
            {/* #SCALE-TOOLS — empirical sandbox effectiveness: green ≥70%, red below (the ranking
                actually demotes <70% w/ ≥3 runs, so a red badge = "won't be recommended"). */}
            {typeof tool.successRate === "number" && (tool.invoked ?? 0) > 0 && (
              <span title={`沙箱里被 ${tool.invoked} 次调用，成功 ${tool.succeeded}。低于 70%（≥3 次）时排序会自动降权。`}>
                <Badge tone={tool.successRate >= 0.7 ? "green" : "red"}>
                  沙箱成功率 {Math.round(tool.successRate * 100)}% · {tool.invoked}次{tool.successRate < 0.7 && (tool.invoked ?? 0) >= 3 ? " · 已降权" : ""}
                </Badge>
              </span>
            )}
            {isCreated && <Badge tone="signal">自建</Badge>}
            {tool.chainsWith && tool.chainsWith.length > 0 && (
              <Badge tone="signal">
                {t("tools.chainsWith", { tools: tool.chainsWith.join(", ") })}
              </Badge>
            )}
            {isCreated && (
              <Button small tone="ghost" icon="trash" disabled={del.isPending} onClick={() => { if (confirm(`删除自建工具「${tool.name}」？`)) del.mutate(tool.name, { onError: (e) => toast({ tone: "red", title: `删除失败：${(e as Error).message}` }) }); }}>删除</Button>
            )}
          </div>
        </div>
        <p
          style={{
            margin: 0,
            fontSize: 13,
            color: "var(--text)",
            lineHeight: 1.5,
          }}
        >
          {tool.summary}
        </p>
        {tool.description && (
          <p
            style={{
              margin: "4px 0 0",
              fontSize: 12.5,
              color: "var(--text-2)",
              lineHeight: 1.55,
            }}
          >
            {tool.description}
          </p>
        )}
        <div
          style={{
            display: "flex",
            gap: 14,
            fontSize: 11,
            color: "var(--text-3)",
            fontFamily: "var(--mono)",
            marginTop: 4,
            flexWrap: "wrap",
          }}
        >
          {tool.aliases && tool.aliases.length > 0 && (
            <span>
              {t("tools.aliasesLabel")} {tool.aliases.join(", ")}
            </span>
          )}
          <span>
            {t("tools.sourceLabel")} {tool.sourcePath}
          </span>
        </div>
      </header>

      <SubBlock title={t("tools.manifestDeclaration")} copyText={manifestSnippet}>
        <pre style={preStyle}>{manifestSnippet}</pre>
      </SubBlock>

      {hasArgs ? (
        <SubBlock
          title={t("tools.arguments")}
          subtitle={t("tools.argumentsSubtitle")}
        >
          <SchemaTable schema={tool.argsSchema!} />
          {tool.argsExample && Object.keys(tool.argsExample).length > 0 && (
            <ExampleBlock value={tool.argsExample} label={t("tools.example")} />
          )}
        </SubBlock>
      ) : (
        <SubBlock title={t("tools.arguments")}>
          <p style={mutedNoteStyle}>
            {t("tools.noArgsPart1")}{" "}
            <code className="mono">{"{}"}</code>.
          </p>
        </SubBlock>
      )}

      {hasReturns && (
        <SubBlock title={t("tools.returns")} subtitle={t("tools.returnsSubtitle")}>
          <SchemaTable schema={tool.returnsSchema!} />
          {tool.returnsExample !== undefined && (
            <ExampleBlock value={tool.returnsExample} label={t("tools.example")} />
          )}
        </SubBlock>
      )}

      {hasConfig ? (
        <SubBlock
          title={t("tools.perTenantConfig")}
          subtitle={t("tools.perTenantConfigSubtitle")}
        >
          <SchemaTable schema={tool.configSchema!} />
          {tool.configExample && Object.keys(tool.configExample).length > 0 && (
            <ExampleBlock
              value={tool.configExample}
              label={t("tools.exampleConfig")}
            />
          )}
        </SubBlock>
      ) : (
        <SubBlock title={t("tools.perTenantConfig")}>
          <p style={mutedNoteStyle}>{t("tools.noConfig")}</p>
        </SubBlock>
      )}
    </article>
  );
}

// ─── Sub-components ─────────────────────────────────────────────────────────

function SubBlock({
  title,
  subtitle,
  copyText,
  children,
}: {
  title: string;
  subtitle?: string;
  copyText?: string;
  children: React.ReactNode;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const [copied, setCopied] = useState(false);
  async function copy() {
    if (!copyText) return;
    try {
      await navigator.clipboard.writeText(copyText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch (error) {
      toast({
        tone: "red",
        title: t("tools.copyFailed"),
        description: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return (
    <div>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          marginBottom: 6,
          gap: 12,
        }}
      >
        <div>
          <div
            style={{
              fontSize: 10.5,
              textTransform: "uppercase",
              letterSpacing: 0.6,
              color: "var(--text-3)",
              fontFamily: "var(--mono)",
              fontWeight: 600,
            }}
          >
            {title}
          </div>
          {subtitle && (
            <div
              style={{
                fontSize: 11.5,
                color: "var(--text-3)",
                marginTop: 2,
                lineHeight: 1.4,
              }}
            >
              {subtitle}
            </div>
          )}
        </div>
        {copyText && (
          <Button small tone="ghost" icon={copied ? "check" : "code"} onClick={copy}>
            {copied ? t("tools.copied") : t("tools.copy")}
          </Button>
        )}
      </div>
      {children}
    </div>
  );
}

function SchemaTable({ schema }: { schema: Record<string, ToolFieldSchema> }) {
  const { t } = useI18n();
  const entries = Object.entries(schema);
  return (
    <table style={tableStyle}>
      <thead>
        <tr>
          <th style={thStyle}>{t("tools.colField")}</th>
          <th style={thStyle}>{t("tools.colType")}</th>
          <th style={thStyle}>{t("tools.colDefault")}</th>
          <th style={thStyle}>{t("tools.colDescription")}</th>
        </tr>
      </thead>
      <tbody>
        {entries.map(([key, def]) => (
          <tr key={key} style={{ borderTop: "1px solid var(--border)" }}>
            <td style={tdMono}>
              {key}
              {def.required && (
                <span
                  style={{
                    color: "var(--red)",
                    marginLeft: 4,
                    fontFamily: "var(--mono)",
                  }}
                  title={t("tools.required")}
                >
                  *
                </span>
              )}
            </td>
            <td style={tdMono}>{def.type}</td>
            <td style={tdMono}>
              {def.default !== undefined
                ? typeof def.default === "string"
                  ? `"${def.default}"`
                  : JSON.stringify(def.default)
                : "—"}
            </td>
            <td style={td}>{def.description ?? "—"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ExampleBlock({ value, label }: { value: unknown; label: string }) {
  const { t } = useI18n();
  const toast = useToast();
  const json = useMemo(() => JSON.stringify(value, null, 2), [value]);
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(json);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch (error) {
      toast({
        tone: "red",
        title: t("tools.copyFailed"),
        description: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return (
    <div style={{ marginTop: 8 }}>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          marginBottom: 4,
        }}
      >
        <span
          style={{
            fontSize: 10.5,
            textTransform: "uppercase",
            letterSpacing: 0.6,
            color: "var(--text-3)",
            fontFamily: "var(--mono)",
          }}
        >
          {label}
        </span>
        <Button small tone="ghost" icon={copied ? "check" : "code"} onClick={copy}>
          {copied ? t("tools.copied") : t("tools.copy")}
        </Button>
      </div>
      <pre style={preStyle}>{json}</pre>
    </div>
  );
}

// ─── styles ─────────────────────────────────────────────────────────────────

const catLabelStyle: React.CSSProperties = {
  fontSize: 10.5,
  textTransform: "uppercase",
  letterSpacing: 0.6,
  color: "var(--text-3)",
  fontFamily: "var(--mono)",
  marginBottom: 2,
};

const navLinkStyle: React.CSSProperties = {
  display: "block",
  width: "100%",
  textAlign: "left",
  padding: "4px 6px",
  fontSize: 12,
  fontFamily: "var(--mono)",
  color: "var(--text-2)",
  background: "transparent",
  border: "none",
  borderRadius: 3,
  cursor: "pointer",
  lineHeight: 1.4,
};

const introStyle: React.CSSProperties = {
  paddingBottom: 8,
  borderBottom: "1px solid var(--border)",
};
const introBodyStyle: React.CSSProperties = {
  margin: "8px 0 0",
  fontSize: 12.5,
  color: "var(--text-2)",
  lineHeight: 1.55,
};

const categoryHeadingStyle: React.CSSProperties = {
  margin: 0,
  paddingBottom: 4,
  borderBottom: "1px solid var(--border)",
  fontSize: 14,
  textTransform: "uppercase",
  letterSpacing: 0.6,
  color: "var(--text-3)",
  fontFamily: "var(--mono)",
};

const sectionStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 16,
  padding: "18px 20px",
  border: "1px solid var(--border)",
  borderRadius: 6,
  background: "var(--panel)",
  scrollMarginTop: 16,
};

const preStyle: React.CSSProperties = {
  margin: 0,
  padding: 12,
  background: "var(--panel-2)",
  border: "1px solid var(--border)",
  borderRadius: 4,
  fontFamily: "var(--mono)",
  fontSize: 12,
  color: "var(--text)",
  lineHeight: 1.5,
  overflow: "auto",
  whiteSpace: "pre",
};

const tableStyle: React.CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: 12.5,
};

const thStyle: React.CSSProperties = {
  textAlign: "left",
  padding: "6px 10px",
  fontSize: 10.5,
  textTransform: "uppercase",
  letterSpacing: 0.4,
  color: "var(--text-3)",
  fontFamily: "var(--mono)",
};

const td: React.CSSProperties = {
  padding: "8px 10px",
  fontSize: 12,
  color: "var(--text-2)",
  verticalAlign: "top",
  lineHeight: 1.45,
};

const tdMono: React.CSSProperties = {
  ...td,
  fontFamily: "var(--mono)",
  color: "var(--text)",
  whiteSpace: "nowrap",
};

const mutedNoteStyle: React.CSSProperties = {
  margin: 0,
  fontSize: 12.5,
  color: "var(--text-3)",
  lineHeight: 1.5,
};
