"use client";

/**
 * AgentCodeTab — read-only Code tab in agent detail.
 *
 * Ported from `apps/web/public/portal/views/agent-code.jsx:197-393`.
 * Includes the Phase 1 deltas:
 *   - D-6: Maximize toggle hides the sidebar
 *   - D-6: Per-block height splitters (ontology / input_data / tool_use)
 *   - D-6: Sidebar width splitter (default 340, range 300-900)
 *
 * Used by Agents detail (tab="code") and by Runs detail (tab="agent").
 */

import { useState } from "react";
import {
  Badge,
  Button,
  Empty,
  Icon,
  MonacoEditor,
  Panel,
  Splitter,
} from "@/app/portal/components";
import {
  AGENT_SAMPLE_TOOL_USE,
  AGENT_SAMPLE_TS_CODE,
  type ToolUseSchema,
} from "./samples";

interface AgentCodeShape {
  actor: "Agent" | "Human";
  name: string;
  typescript_code?: string;
  tool_use?: unknown;
  input_data?: Record<string, unknown>;
  ontology_instructions?: string;
}

export function AgentCodeTab({ agent }: { agent: AgentCodeShape }) {
  if (agent.actor !== "Agent") {
    return (
      <Empty
        title="No code for human tasks"
        hint="Human-actor nodes pause the workflow for an operator. They have no TypeScript handler — only an event payload + UI."
      />
    );
  }
  const code = agent.typescript_code || AGENT_SAMPLE_TS_CODE;
  const rawTools = agent.tool_use;
  const tools: ToolUseSchema[] =
    Array.isArray(rawTools) && rawTools.length > 0
      ? (rawTools as ToolUseSchema[])
      : AGENT_SAMPLE_TOOL_USE;
  const inputData = agent.input_data ?? {};
  const ontology = agent.ontology_instructions ?? "";

  const [maximized, setMaximized] = useState(false);
  const [sidebarW, setSidebarW] = useState(340);
  const [ontologyH, setOntologyH] = useState(220);
  const [inputDataH, setInputDataH] = useState(160);
  const [toolUseH, setToolUseH] = useState(240);

  const codePanel = (
    <Panel
      title="typescript_code"
      subtitle={`${agent.name}.ts`}
      padded={false}
      style={{
        flex: 1,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
      }}
      action={
        <div style={{ display: "flex", gap: 4, alignItems: "center", flexShrink: 0 }}>
          <Button small icon="external" tone="ghost" title="Open in IDE" />
          <Button small icon="upload" tone="ghost" title="Download" />
          <Button
            small
            tone="ghost"
            icon={maximized ? "x" : "code"}
            onClick={() => setMaximized(!maximized)}
          >
            {maximized ? "Restore" : "Maximize"}
          </Button>
        </div>
      }
    >
      <MonacoEditor value={code} language="typescript" height="100%" readOnly />
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
            subtitle="Domain vocabulary & rules"
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
              {ontology}
            </div>
          </Panel>
        </div>

        <Splitter axis="y" getValue={() => ontologyH} setValue={setOntologyH} min={80} max={600} />

        <div style={{ height: inputDataH, flexShrink: 0, minHeight: 0 }}>
          <Panel title="input_data" subtitle="Sample input" padded={false} style={{ height: "100%" }}>
            <MonacoEditor
              value={JSON.stringify(inputData, null, 2)}
              language="json"
              height="100%"
              readOnly
            />
          </Panel>
        </div>

        <Splitter axis="y" getValue={() => inputDataH} setValue={setInputDataH} min={80} max={500} />

        <div style={{ height: toolUseH, flexShrink: 0, minHeight: 0 }}>
          <Panel
            title={`tool_use · ${tools.length}`}
            subtitle="LLM tool API surface"
            padded={false}
            scroll
            style={{ height: "100%" }}
          >
            <div style={{ height: "100%", overflow: "auto" }}>
              {tools.map((t) => (
                <div key={t.name} style={{ padding: "10px 14px", borderBottom: "1px solid var(--border)" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                    <Icon name="code" size={10} style={{ color: "var(--signal)" }} />
                    <span className="mono" style={{ fontSize: 12, color: "var(--text)" }}>{t.name}</span>
                    <span
                      style={{
                        marginLeft: "auto",
                        fontSize: 10,
                        color: "var(--text-3)",
                        fontFamily: "var(--mono)",
                      }}
                    >
                      {Object.keys(t.input_schema.properties).length} params
                    </span>
                  </div>
                  <div style={{ fontSize: 11.5, color: "var(--text-2)", lineHeight: 1.5, marginBottom: 6 }}>
                    {t.description}
                  </div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 3 }}>
                    {Object.entries(t.input_schema.properties).map(([k, v]) => (
                      <span
                        key={k}
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
                          color: t.input_schema.required.includes(k)
                            ? "var(--text)"
                            : "var(--text-3)",
                        }}
                      >
                        {k}
                        <span style={{ color: "var(--text-3)" }}>:</span>
                        <span style={{ color: "var(--blue)" }}>{v.type}</span>
                        {t.input_schema.required.includes(k) && (
                          <span style={{ color: "var(--amber)" }}>*</span>
                        )}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </Panel>
        </div>

        <Splitter axis="y" getValue={() => toolUseH} setValue={setToolUseH} min={100} max={700} />

        <div style={{ flex: 1, minHeight: 80 }}>
          <Panel title="Runtime" padded style={{ height: "100%" }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 11.5 }}>
              <RuntimeRow label="Language" value="TypeScript 5.6" />
              <RuntimeRow label="Runtime" value="Node 26.5.0 · esm" />
              <RuntimeRow label="Bundler" value="esbuild" />
              <RuntimeRow label="Source" value="agentic/raas-workflows@main" mono />
              <RuntimeRow label="Last build" value="3.4s · 12 KB minified" />
            </div>
          </Panel>
        </div>
      </div>

      {/* Keep Badge import alive in case future tools surface schema errors. */}
      {false && <Badge tone="muted">unused</Badge>}
    </div>
  );
}

function RuntimeRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between" }}>
      <span style={{ color: "var(--text-3)" }}>{label}</span>
      <span
        style={{
          color: "var(--text-2)",
          fontFamily: mono ? "var(--mono)" : "var(--sans)",
        }}
      >
        {value}
      </span>
    </div>
  );
}
