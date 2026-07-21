"use client";

import { useMemo, useState } from "react";
import { Badge, Button, Empty, SearchInput } from "@/app/portal/components";
import { useI18n } from "@/app/portal/lib/preferences-context";
import { useTools } from "@/lib/hooks/useTools";
import { InlineNotice, JsonValueEditor } from "./fields";
import type { StudioToolBinding } from "./model";
import { studioUi } from "./copy";

export function ToolsEditor({
  tools,
  onChange,
  disabled,
}: {
  tools: StudioToolBinding[];
  onChange: (tools: StudioToolBinding[]) => void;
  disabled?: boolean;
}) {
  const { t } = useI18n();
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
      <InlineNotice
        tone="blue"
        title={studioUi(t, "Tools let an agent take actions")}
      >
        {studioUi(t, "Search the catalog, then choose")}{" "}
        <strong>{studioUi(t, "Allow tool")}</strong>{" "}
        {studioUi(
          t,
          "only for actions this agent genuinely needs. Allowing a tool gives the model permission to call it; removing it immediately blocks future calls after publishing.",
        )}
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
          className="agent-studio-tool-catalog"
          style={{ borderRight: "1px solid var(--border)", paddingRight: 16 }}
        >
          <div style={{ marginBottom: 5 }}>
            <SearchInput
              value={query}
              onChange={setQuery}
              placeholder={studioUi(
                t,
                "Search by action, such as email or file…",
              )}
            />
          </div>
          <div
            style={{
              marginBottom: 10,
              color: "var(--text-2)",
              fontSize: 11.5,
              lineHeight: 1.5,
            }}
          >
            {studioUi(
              t,
              "The catalog description tells you what each tool can do. “Allowed” tools appear on the right.",
            )}
          </div>
          {catalog.isLoading ? (
            <Empty title={studioUi(t, "Loading tools…")} />
          ) : catalog.isError ? (
            <Empty
              title={studioUi(t, "Tool catalog unavailable")}
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
                      className="agent-studio-tool-catalog-row"
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
                          style={{
                            color: "var(--text)",
                            fontSize: 12,
                            fontWeight: 600,
                          }}
                        >
                          {tool.name}
                        </div>
                        <div
                          style={{
                            color: "var(--text-2)",
                            fontSize: 11.5,
                            marginTop: 3,
                            lineHeight: 1.5,
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
                        {enabled
                          ? studioUi(t, "Remove permission")
                          : studioUi(t, "Allow tool")}
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
              title={studioUi(t, "No tools allowed")}
              hint={studioUi(
                t,
                "Choose tools from the catalog. The allow-list is the agent's trust boundary.",
              )}
            />
          ) : (
            <div style={{ display: "grid", gap: 14 }}>
              <div>
                <div
                  className="agent-studio-tool-binding-header"
                  style={{ display: "flex", alignItems: "center", gap: 8 }}
                >
                  <h3
                    className="mono"
                    style={{
                      margin: 0,
                      color: "var(--text)",
                      fontSize: 13,
                      fontWeight: 600,
                    }}
                  >
                    {binding.name}
                  </h3>
                  <Badge tone="green">{studioUi(t, "Allowed")}</Badge>
                  {meta && <Badge tone="muted">{meta.category}</Badge>}
                </div>
                <p
                  style={{
                    color: "var(--text-2)",
                    fontSize: 12,
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
                label={studioUi(t, "Tool settings")}
                hint={studioUi(
                  t,
                  "Optional settings that apply whenever this agent uses the tool. Use only the keys listed below. Reference environment-variable names for credentials; never paste secret values here.",
                )}
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
                      color: "var(--text-2)",
                      fontSize: 11.5,
                      fontWeight: 600,
                      marginBottom: 7,
                    }}
                  >
                    {studioUi(t, "CONFIG KEYS")}
                  </div>
                  {Object.entries(meta.configSchema).map(([name, field]) => (
                    <div
                      className="agent-studio-tool-config-row"
                      key={name}
                      style={{
                        display: "grid",
                        gridTemplateColumns: "150px 70px 1fr",
                        gap: 8,
                        padding: "5px 0",
                        borderTop: "1px solid var(--border)",
                        fontSize: 11.5,
                        lineHeight: 1.45,
                      }}
                    >
                      <code
                        className="mono"
                        style={{ color: "var(--blue)", fontWeight: 600 }}
                      >
                        {name}
                      </code>
                      <span className="mono" style={{ color: "var(--text-2)" }}>
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
