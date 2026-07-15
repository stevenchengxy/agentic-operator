"use client";

import { useMemo, useState } from "react";
import { Badge, Button, Empty, SearchInput } from "@/app/portal/components";
import { useTools } from "@/lib/hooks/useTools";
import { InlineNotice, JsonValueEditor } from "./fields";
import type { StudioToolBinding } from "./model";

export function ToolsEditor({
  tools,
  onChange,
  disabled,
}: {
  tools: StudioToolBinding[];
  onChange: (tools: StudioToolBinding[]) => void;
  disabled?: boolean;
}) {
  const catalog = useTools();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(tools[0]?.name ?? "");
  const catalogItems = useMemo(() => {
    const q = query.toLowerCase().trim();
    return (catalog.data?.tools ?? []).filter(
      (tool) =>
        !q ||
        `${tool.name} ${tool.summary} ${tool.category}`
          .toLowerCase()
          .includes(q),
    );
  }, [catalog.data, query]);
  const binding = tools.find((tool) => tool.name === selected) ?? tools[0];
  const meta = catalog.data?.tools.find((tool) => tool.name === binding?.name);

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <InlineNotice tone="blue" title="Tools let an agent take actions">
        Search the catalog, then choose <strong>Allow tool</strong> only for
        actions this agent genuinely needs. Allowing a tool gives the model
        permission to call it; removing it immediately blocks future calls after
        publishing.
      </InlineNotice>
      <div
        className="agent-studio-tools-grid"
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(250px, 0.8fr) minmax(300px, 1.2fr)",
          gap: 16,
          minHeight: 460,
        }}
      >
        <div
          style={{ borderRight: "1px solid var(--border)", paddingRight: 16 }}
        >
          <div style={{ marginBottom: 5 }}>
            <SearchInput
              value={query}
              onChange={setQuery}
              placeholder="Search by action, such as email or file…"
            />
          </div>
          <div
            style={{
              marginBottom: 10,
              color: "var(--text-3)",
              fontSize: 10,
              lineHeight: 1.4,
            }}
          >
            The catalog description tells you what each tool can do. “Allowed”
            tools appear on the right.
          </div>
          {catalog.isLoading ? (
            <Empty title="Loading tools…" />
          ) : catalog.isError ? (
            <Empty
              title="Tool catalog unavailable"
              hint={catalog.error.message}
            />
          ) : (
            <div
              style={{
                display: "grid",
                gap: 6,
                maxHeight: 420,
                overflow: "auto",
              }}
            >
              {catalogItems.map((tool) => {
                const enabled = tools.some((item) => item.name === tool.name);
                return (
                  <div
                    key={tool.name}
                    style={{
                      padding: "9px 10px",
                      border: "1px solid var(--border)",
                      borderRadius: 5,
                      background: "var(--panel-2)",
                    }}
                  >
                    <div
                      style={{ display: "flex", gap: 8, alignItems: "center" }}
                    >
                      <button
                        type="button"
                        aria-pressed={enabled && selected === tool.name}
                        onClick={() => enabled && setSelected(tool.name)}
                        style={{ minWidth: 0, flex: 1, textAlign: "left" }}
                      >
                        <div
                          className="mono"
                          style={{ color: "var(--text)", fontSize: 11 }}
                        >
                          {tool.name}
                        </div>
                        <div
                          style={{
                            color: "var(--text-3)",
                            fontSize: 10.5,
                            marginTop: 3,
                            lineHeight: 1.35,
                          }}
                        >
                          {tool.summary}
                        </div>
                      </button>
                      <Button
                        small
                        disabled={disabled}
                        tone={enabled ? "danger" : "default"}
                        onClick={() => {
                          if (enabled)
                            onChange(
                              tools.filter((item) => item.name !== tool.name),
                            );
                          else {
                            onChange([
                              ...tools,
                              {
                                name: tool.name,
                                description: tool.summary,
                                config: tool.configExample ?? {},
                              },
                            ]);
                            setSelected(tool.name);
                          }
                        }}
                      >
                        {enabled ? "Remove permission" : "Allow tool"}
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
        <div>
          {!binding ? (
            <Empty
              title="No tools allowed"
              hint="Choose tools from the catalog. The allow-list is the agent's trust boundary."
            />
          ) : (
            <div style={{ display: "grid", gap: 14 }}>
              <div>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <h3
                    className="mono"
                    style={{ margin: 0, color: "var(--text)", fontSize: 13 }}
                  >
                    {binding.name}
                  </h3>
                  <Badge tone="green">Allowed</Badge>
                  {meta && <Badge tone="muted">{meta.category}</Badge>}
                </div>
                <p
                  style={{
                    color: "var(--text-3)",
                    fontSize: 11.5,
                    lineHeight: 1.55,
                  }}
                >
                  {meta?.description ?? meta?.summary ?? binding.description}
                </p>
              </div>
              <JsonValueEditor
                value={binding.config ?? {}}
                onChange={(config) =>
                  onChange(
                    tools.map((item) =>
                      item === binding
                        ? { ...item, config: config as Record<string, unknown> }
                        : item,
                    ),
                  )
                }
                height={220}
                label="Tool settings"
                hint="Optional settings that apply whenever this agent uses the tool. Use only the keys listed below. Reference environment-variable names for credentials; never paste secret values here."
                example={'{"subdir":"support-archive"}'}
                readOnly={disabled}
              />
              {meta?.configSchema && (
                <div
                  style={{
                    padding: 10,
                    border: "1px solid var(--border)",
                    borderRadius: 5,
                    background: "var(--bg-2)",
                  }}
                >
                  <div
                    className="mono"
                    style={{
                      color: "var(--text-3)",
                      fontSize: 10,
                      marginBottom: 7,
                    }}
                  >
                    CONFIG KEYS
                  </div>
                  {Object.entries(meta.configSchema).map(([name, field]) => (
                    <div
                      key={name}
                      style={{
                        display: "grid",
                        gridTemplateColumns: "150px 70px 1fr",
                        gap: 8,
                        padding: "5px 0",
                        borderTop: "1px solid var(--border)",
                        fontSize: 10.5,
                      }}
                    >
                      <code style={{ color: "var(--blue)" }}>{name}</code>
                      <span style={{ color: "var(--text-3)" }}>
                        {field.type}
                      </span>
                      <span style={{ color: "var(--text-2)" }}>
                        {field.description}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
