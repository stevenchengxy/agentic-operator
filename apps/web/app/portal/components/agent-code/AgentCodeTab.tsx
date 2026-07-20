"use client";

/**
 * AgentCodeTab — read-only Code tab in agent detail.
 *
 * Includes:
 *   - D-6: Maximize toggle hides the sidebar
 *   - D-6: Per-block height splitters (ontology / input_data / tool_use)
 *   - D-6: Sidebar width splitter (default 340, range 300-900)
 *
 * Used by Agents detail (tab="code") and by Runs detail (tab="agent").
 */

import { useState } from "react";
import { useI18n } from "@/app/portal/lib/preferences-context";
import {
  Button,
  Empty,
  Icon,
  MonacoEditor,
  Panel,
  Splitter,
} from "@/app/portal/components";

interface ToolUseSchema {
  name: string;
  description?: string;
  input_schema?: {
    properties?: Record<string, { type?: string }>;
    required?: string[];
  };
}

interface AgentCodeShape {
  actor: "Agent" | "Human";
  name: string;
  typescript_code?: string | null;
  tool_use?: unknown[] | null;
  input_data?: Record<string, unknown> | null;
  ontology_instructions?: string | null;
  sourceUnavailable?: boolean;
}

export function AgentCodeTab({ agent }: { agent: AgentCodeShape }) {
  const { t } = useI18n();
  const [maximized, setMaximized] = useState(false);
  const [sidebarW, setSidebarW] = useState(340);
  const [ontologyH, setOntologyH] = useState(220);
  const [inputDataH, setInputDataH] = useState(160);
  if (agent.actor !== "Agent") {
    return (
      <Empty
        title={t("agentCodeTab.emptyTitle")}
        hint={t("agentCodeTab.emptyHint")}
      />
    );
  }
  if (agent.sourceUnavailable) {
    return (
      <Empty
        title={t("agentCodeTab.sourceUnavailableTitle")}
        hint={t("agentCodeTab.sourceUnavailableHint")}
      />
    );
  }
  const code = agent.typescript_code;
  const rawTools = agent.tool_use;
  const tools: ToolUseSchema[] =
    Array.isArray(rawTools) && rawTools.length > 0
      ? rawTools.filter(
          (tool): tool is ToolUseSchema =>
            Boolean(
              tool &&
                typeof tool === "object" &&
                "name" in tool &&
                typeof tool.name === "string",
            ),
        )
      : [];
  const inputData = agent.input_data;
  const ontology = agent.ontology_instructions;

  if (
    !code?.trim() &&
    tools.length === 0 &&
    (inputData == null || Object.keys(inputData).length === 0) &&
    !ontology?.trim()
  ) {
    return (
      <Empty
        title={t("agentCodeTab.noRecordedTitle")}
        hint={t("agentCodeTab.noRecordedHint")}
      />
    );
  }

  const codePanel = (
    <Panel
      title="typescript_code"
      subtitle={code == null ? t("agentCodeTab.fieldNotRecorded") : `${agent.name}.ts`}
      padded={false}
      style={{
        flex: 1,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
      }}
      action={
        <div style={{ display: "flex", gap: 4, alignItems: "center", flexShrink: 0 }}>
          <Button
            small
            tone="ghost"
            icon={maximized ? "x" : "code"}
            onClick={() => setMaximized(!maximized)}
          >
            {maximized ? t("agentCodeTab.restore") : t("agentCodeTab.maximize")}
          </Button>
        </div>
      }
    >
      {code == null ? (
        <Empty
          title={t("agentCodeTab.codeNotRecorded")}
          hint={t("agentCodeTab.fieldNotRecorded")}
        />
      ) : (
        <MonacoEditor value={code} language="typescript" height="100%" readOnly />
      )}
    </Panel>
  );

  if (maximized) {
    return (
      <div
        style={{
          height: "100%",
          minHeight: 480,
          display: "flex",
          flexDirection: "column",
        }}
      >
        {codePanel}
      </div>
    );
  }

  return (
    <div
      style={{
        height: "100%",
        minHeight: 480,
        display: "flex",
        flexDirection: "row",
      }}
    >
      {/* LEFT: TypeScript code (flex grows to fill) */}
      <div style={{ flex: 1, minWidth: 280, display: "flex", flexDirection: "column" }}>
        {codePanel}
      </div>

      <Splitter axis="x" getValue={() => sidebarW} setValue={setSidebarW} min={300} max={900} invert />

      {/* RIGHT sidebar: stacked, individually-resizable panels */}
      <div
        style={{
          width: sidebarW,
          flexShrink: 0,
          display: "flex",
          flexDirection: "column",
          minHeight: 0,
        }}
      >
        <div style={{ height: ontologyH, flexShrink: 0, minHeight: 0 }}>
          <Panel
            title="ontology_instructions"
            subtitle={t("agentCodeTab.ontologySubtitle")}
            padded={false}
            scroll
            style={{ height: "100%" }}
          >
            <div
              style={{
                height: "100%",
                overflow: "auto",
                padding: "10px 14px",
                fontFamily: "var(--mono)",
                fontSize: 11.5,
                lineHeight: 1.65,
                color: "var(--text-2)",
                whiteSpace: "pre-wrap",
              }}
            >
              {ontology ?? t("agentCodeTab.fieldNotRecorded")}
            </div>
          </Panel>
        </div>

        <Splitter axis="y" getValue={() => ontologyH} setValue={setOntologyH} min={80} max={600} />

        <div style={{ height: inputDataH, flexShrink: 0, minHeight: 0 }}>
          <Panel title="input_data" subtitle={t("agentCodeTab.inputDataSubtitle")} padded={false} style={{ height: "100%" }}>
            <MonacoEditor
              value={JSON.stringify(inputData ?? null, null, 2)}
              language="json"
              height="100%"
              readOnly
            />
          </Panel>
        </div>

        <Splitter axis="y" getValue={() => inputDataH} setValue={setInputDataH} min={80} max={500} />

        <div style={{ flex: 1, minHeight: 100 }}>
          <Panel
            title={`tool_use · ${tools.length}`}
            subtitle={t("agentCodeTab.toolUseSubtitle")}
            padded={false}
            scroll
            style={{ height: "100%" }}
          >
            <div style={{ height: "100%", overflow: "auto" }}>
              {rawTools == null ? (
                <Empty
                  title={t("agentCodeTab.toolsNotRecorded")}
                  hint={t("agentCodeTab.fieldNotRecorded")}
                />
              ) : (
                tools.map((tool) => <ToolSchemaRow key={tool.name} tool={tool} />)
              )}
            </div>
          </Panel>
        </div>
      </div>
    </div>
  );
}

function ToolSchemaRow({ tool }: { tool: ToolUseSchema }) {
  const { t } = useI18n();
  const properties = tool.input_schema?.properties ?? {};
  const required = new Set(tool.input_schema?.required ?? []);
  return (
    <div style={{ padding: "10px 14px", borderBottom: "1px solid var(--border)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
        <Icon name="code" size={10} style={{ color: "var(--accent-text)" }} />
        <span className="mono" style={{ fontSize: 12, color: "var(--text)" }}>{tool.name}</span>
        <span style={{ marginLeft: "auto", fontSize: 10, color: "var(--text-3)", fontFamily: "var(--mono)" }}>
          {t("agentCodeTab.params", { n: Object.keys(properties).length })}
        </span>
      </div>
      {tool.description && (
        <div style={{ fontSize: 11.5, color: "var(--text-2)", lineHeight: 1.5, marginBottom: 6 }}>
          {tool.description}
        </div>
      )}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 3 }}>
        {Object.entries(properties).map(([name, schema]) => (
          <span
            key={name}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              padding: "1px 6px",
              fontSize: 10,
              fontFamily: "var(--mono)",
              background: "var(--panel-2)",
              border: "1px solid var(--border)",
              borderRadius: 3,
              color: required.has(name) ? "var(--text)" : "var(--text-3)",
            }}
          >
            {name}<span style={{ color: "var(--text-3)" }}>:</span>
            <span style={{ color: "var(--blue)" }}>{schema.type ?? "unknown"}</span>
            {required.has(name) && <span style={{ color: "var(--amber)" }}>*</span>}
          </span>
        ))}
      </div>
    </div>
  );
}
