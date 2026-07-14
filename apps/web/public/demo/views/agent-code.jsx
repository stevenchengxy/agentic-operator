// Agent code + tool_use editors
// - AgentCodeTab          : read-only "Code" tab in agent detail
// - AgentCodeEditPanel    : Monaco-backed TS editor for edit mode + deploy wizard
// - AgentToolUseEditPanel : card editor for the tool_use[] array (LLM tool definitions)

const { useState: useStateAC } = React;

// ---------------- Default samples ----------------

const SAMPLE_TS_CODE = `import { defineAgent } from "@agentic/runtime";

/**
 * matchResume — score a candidate resume against a job requisition.
 *
 * Triggered by: RESUME_PROCESSED
 * Emits:        MATCH_PASSED_NEED_INTERVIEW
 *               MATCH_PASSED_NO_INTERVIEW
 *               MATCH_FAILED
 */
type MatchInput = {
  candidate_id: string;
  requisition_id: string;
  client_id: string;
};

type MatchOutput = {
  score: number;
  recommendation: "interview" | "skip_to_package" | "reject";
  reasons: string[];
};

export const matchResume = defineAgent<MatchInput, MatchOutput>({
  name: "matchResume",
  model: "claude-sonnet-4-5",

  async run(ctx, input) {
    // 1. Validate against redline + blacklist
    const safety = await ctx.use("blacklist_lookup", {
      candidate_id: input.candidate_id,
      client_id: input.client_id,
    });
    if (safety.hits > 0) {
      return ctx.emit("MATCH_FAILED", {
        reason: "blacklist",
        score: 0,
        recommendation: "reject",
        reasons: safety.matches,
      });
    }

    // 2. Score hard requirements with an LLM judge
    const resume = await ctx.use("resume_fetch", { id: input.candidate_id });
    const req = await ctx.use("requisition_fetch", { id: input.requisition_id });
    const hard = await ctx.llm.evaluate({
      tool_use: "score_hard_requirements",
      input: { resume, requisition: req },
    });
    if (hard.passes < hard.total) {
      return ctx.emit("MATCH_FAILED", {
        reason: "hard_requirements",
        score: (hard.passes / hard.total) * 100,
        recommendation: "reject",
        reasons: hard.failures,
      });
    }

    // 3. Bonus weights + reflux cooldown
    const bonus = await ctx.use("scoring_match", {
      resume_id: input.candidate_id,
      jd_id: input.requisition_id,
    });
    const reflux = await checkReflux(ctx, input.candidate_id);
    const score = bonus.weighted + (reflux.ok ? 0 : -20);

    if (score >= 70) {
      return ctx.emit("MATCH_PASSED_NEED_INTERVIEW", {
        score,
        recommendation: "interview",
        reasons: bonus.signals,
      });
    }
    return ctx.emit("MATCH_PASSED_NO_INTERVIEW", {
      score,
      recommendation: "skip_to_package",
      reasons: bonus.signals,
    });
  },
});

async function checkReflux(ctx: any, candidate_id: string) {
  const h = await ctx.use("candidate_reflux_history", { candidate_id });
  if (!h.has_internal_history) return { ok: true };
  return { ok: h.cooling_period_remaining_days === 0 };
}
`;

const SAMPLE_TOOL_USE = [
  {
    name: "blacklist_lookup",
    description: "Check whether a candidate is on any client's blacklist. Returns hit count and the specific blacklist matches.",
    input_schema: {
      type: "object",
      properties: {
        candidate_id: { type: "string", description: "RAAS candidate id, e.g. CAN-88412" },
        client_id:    { type: "string", description: "Client id, e.g. Tencent" },
      },
      required: ["candidate_id", "client_id"],
    },
  },
  {
    name: "scoring_match",
    description: "Run the weighted resume↔requisition matcher. Returns score (0–100) and the signals that drove it.",
    input_schema: {
      type: "object",
      properties: {
        resume_id: { type: "string" },
        jd_id:     { type: "string" },
      },
      required: ["resume_id", "jd_id"],
    },
  },
  {
    name: "score_hard_requirements",
    description: "LLM-as-judge: score each hard requirement on the JD against the candidate's resume. Returns passes/total and per-line failures.",
    input_schema: {
      type: "object",
      properties: {
        resume:      { type: "object", description: "Parsed candidate resume" },
        requisition: { type: "object", description: "Normalized job requisition" },
      },
      required: ["resume", "requisition"],
    },
  },
];

window.AGENT_SAMPLE_TS_CODE = SAMPLE_TS_CODE;
window.AGENT_SAMPLE_TOOL_USE = SAMPLE_TOOL_USE;

// ---------------- Read-only Code tab ----------------

// ───── Splitter: thin drag handle for resizing adjacent blocks ─────
// axis: "x" -> column resize, "y" -> row resize
// invert: drag direction is reversed (e.g. for sidebar on the right, drag-left grows it)
window.Splitter = function Splitter({ axis, getValue, setValue, min, max, invert }) {
  function onMouseDown(e) {
    e.preventDefault();
    const startPos = axis === "x" ? e.clientX : e.clientY;
    const start = getValue();
    function move(ev) {
      const cur = axis === "x" ? ev.clientX : ev.clientY;
      const delta = invert ? start - (cur - startPos) : start + (cur - startPos);
      setValue(Math.max(min, Math.min(max, delta)));
    }
    function up() {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    }
    document.body.style.userSelect = "none";
    document.body.style.cursor = axis === "x" ? "col-resize" : "row-resize";
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  }
  const [hov, setHov] = useStateAC(false);
  const isX = axis === "x";
  return (
    <div
      onMouseDown={onMouseDown}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={{
        flexShrink: 0,
        cursor: isX ? "col-resize" : "row-resize",
        width: isX ? 6 : "100%",
        height: isX ? "100%" : 6,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "transparent",
        position: "relative",
        zIndex: 1,
      }}
    >
      <div style={{
        width: isX ? 1 : "100%",
        height: isX ? "100%" : 1,
        background: hov ? "var(--signal)" : "var(--border-2)",
        transition: "background 0.12s",
      }} />
    </div>
  );
};
// Alias so code in this file can call it without the `window.` prefix.
const Splitter = window.Splitter;

function AgentCodeTab({ agent }) {
  // For demo: every Agent actor gets the same sample code.
  // Human nodes have no code section.
  if (agent.actor !== "Agent") {
    return (
      <Empty
        title="No code for human tasks"
        hint="Human-actor nodes pause the workflow for an operator. They have no TypeScript handler — only an event payload + UI."
      />
    );
  }
  const code = agent.typescript_code || SAMPLE_TS_CODE;
  const tools = agent.tool_use && agent.tool_use.length ? agent.tool_use : SAMPLE_TOOL_USE;
  const inputData = agent.input_data || {};
  const ontology = agent.ontology_instructions || "";

  const [maximized, setMaximized] = useStateAC(false);
  const [sidebarW, setSidebarW] = useStateAC(340);
  const [ontologyH, setOntologyH] = useStateAC(220);
  const [inputDataH, setInputDataH] = useStateAC(160);
  const [toolUseH, setToolUseH] = useStateAC(240);

  // Outer container fills viewport below the tab strip + header. Resizable
  // dividers let the user tune each block. Maximize hides the sidebar.
  // AgentDetail's tab content wrapper is now a bounded flex column; we just fill it.
  const containerHeight = "100%";

  const codePanel = (
    <Panel
      title="typescript_code"
      subtitle={`${agent.name}.ts`}
      padded={false}
      style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}
      action={<div style={{ display: "flex", gap: 4, alignItems: "center", flexShrink: 0 }}>
        <Button small icon="external" tone="ghost" title="Open in IDE"></Button>
        <Button small icon="upload" tone="ghost" title="Download"></Button>
        <Button
          small
          tone="ghost"
          icon={maximized ? "x" : "code"}
          onClick={() => setMaximized(!maximized)}
        >{maximized ? "Restore" : "Maximize"}</Button>
      </div>}
    >
      <window.MonacoEditor value={code} language="typescript" height="100%" readOnly />
    </Panel>
  );

  if (maximized) {
    return (
      <div style={{
        height: containerHeight,
        minHeight: 480,
        display: "flex",
        flexDirection: "column",
      }}>
        {codePanel}
      </div>
    );
  }

  return (
    <div style={{
      height: containerHeight,
      minHeight: 480,
      display: "flex",
      flexDirection: "row",
    }}>
      {/* LEFT: TypeScript code (flex grows to fill) */}
      <div style={{ flex: 1, minWidth: 280, display: "flex", flexDirection: "column" }}>
        {codePanel}
      </div>

      <Splitter axis="x"
        getValue={() => sidebarW} setValue={setSidebarW}
        min={300} max={900} invert />

      {/* RIGHT: sidebar with stacked, individually-resizable panels */}
      <div style={{
        width: sidebarW,
        flexShrink: 0,
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
      }}>
        <div style={{ height: ontologyH, flexShrink: 0, minHeight: 0 }}>
          <Panel
            title="ontology_instructions"
            subtitle="Domain vocabulary & rules"
            padded={false}
            scroll
            style={{ height: "100%" }}
          >
            <div style={{
              height: "100%", overflow: "auto",
              padding: "10px 14px",
              fontFamily: "var(--mono)", fontSize: 11.5, lineHeight: 1.65,
              color: "var(--text-2)", whiteSpace: "pre-wrap",
            }}>{ontology}</div>
          </Panel>
        </div>

        <Splitter axis="y"
          getValue={() => ontologyH} setValue={setOntologyH}
          min={80} max={600} />

        <div style={{ height: inputDataH, flexShrink: 0, minHeight: 0 }}>
          <Panel
            title="input_data"
            subtitle="Sample input"
            padded={false}
            style={{ height: "100%" }}
          >
            <window.MonacoEditor
              value={JSON.stringify(inputData, null, 2)}
              language="json"
              height="100%"
              readOnly
            />
          </Panel>
        </div>

        <Splitter axis="y"
          getValue={() => inputDataH} setValue={setInputDataH}
          min={80} max={500} />

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
                    <span style={{ marginLeft: "auto", fontSize: 10, color: "var(--text-3)", fontFamily: "var(--mono)" }}>{Object.keys(t.input_schema.properties).length} params</span>
                  </div>
                  <div style={{ fontSize: 11.5, color: "var(--text-2)", lineHeight: 1.5, marginBottom: 6 }}>{t.description}</div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 3 }}>
                    {Object.entries(t.input_schema.properties).map(([k, v]) => (
                      <span key={k} style={{
                        display: "inline-flex", alignItems: "center", gap: 4,
                        padding: "1px 6px",
                        fontSize: 10, fontFamily: "var(--mono)",
                        background: "var(--panel-2)", border: "1px solid var(--border)",
                        borderRadius: 3,
                        color: t.input_schema.required.includes(k) ? "var(--text)" : "var(--text-3)",
                      }}>
                        {k}
                        <span style={{ color: "var(--text-3)" }}>:</span>
                        <span style={{ color: "var(--blue)" }}>{v.type}</span>
                        {t.input_schema.required.includes(k) && <span style={{ color: "var(--amber)" }}>*</span>}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </Panel>
        </div>

        <Splitter axis="y"
          getValue={() => toolUseH} setValue={setToolUseH}
          min={100} max={700} />

        {/* Runtime fills whatever's left at the bottom */}
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
    </div>
  );
}

function RuntimeRow({ label, value, mono }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between" }}>
      <span style={{ color: "var(--text-3)" }}>{label}</span>
      <span style={{ color: "var(--text-2)", fontFamily: mono ? "var(--mono)" : "var(--sans)" }}>{value}</span>
    </div>
  );
}

window.AgentCodeTab = AgentCodeTab;

// ---------------- Editable TS code panel ----------------

function AgentCodeEditPanel({ value, onChange, height = 460 }) {
  const [val, setVal] = useStateAC(value != null ? value : SAMPLE_TS_CODE);
  function handle(v) { setVal(v); onChange && onChange(v); }
  const lines = (val || "").split("\n").length;
  return (
    <Panel
      title="typescript_code"
      subtitle={<>Compiled with the workspace's <span className="mono" style={{ color: "var(--text-2)" }}>@agentic/runtime</span> typings.</>}
      padded={false}
      action={<div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <span style={{ fontSize: 10.5, fontFamily: "var(--mono)", color: "var(--text-3)" }}>{lines} lines</span>
        <Button small tone="ghost" icon="replay" onClick={() => handle(SAMPLE_TS_CODE)}>Reset</Button>
        <Button small tone="ghost" icon="check">Format</Button>
      </div>}
    >
      <window.MonacoEditor
        value={val}
        onChange={handle}
        language="typescript"
        height={height}
      />
      <div style={{ display: "flex", alignItems: "center", gap: 14, padding: "8px 14px", borderTop: "1px solid var(--border)", fontSize: 11, fontFamily: "var(--mono)", color: "var(--text-3)" }}>
        <span><Icon name="check" size={10} style={{ color: "var(--green)" }} /> 0 errors</span>
        <span><Icon name="alert" size={10} style={{ color: "var(--amber)" }} /> 0 warnings</span>
        <span style={{ marginLeft: "auto" }}>TypeScript 5.6 · ESNext · NodeJs resolution</span>
      </div>
    </Panel>
  );
}
window.AgentCodeEditPanel = AgentCodeEditPanel;

// ---------------- Editable ontology + input_data ----------------

function AgentOntologyEditPanel({ value, onChange, height = 220 }) {
  const [val, setVal] = useStateAC(value != null ? value : "");
  function handle(v) { setVal(v); onChange && onChange(v); }
  const lines = (val || "").split("\n").length;
  return (
    <Panel
      title="ontology_instructions"
      subtitle="Domain vocabulary, business rules, and guardrails. Prepended to every prompt."
      padded={false}
      action={<div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <span style={{ fontSize: 10.5, fontFamily: "var(--mono)", color: "var(--text-3)" }}>{lines} lines</span>
        <Button small tone="ghost" icon="external">Templates</Button>
      </div>}
    >
      <window.MonacoEditor
        value={val}
        onChange={handle}
        language="markdown"
        height={height}
      />
      <div style={{ padding: "8px 14px", borderTop: "1px solid var(--border)", fontSize: 11, color: "var(--text-3)", lineHeight: 1.5 }}>
        Plain markdown. Reference entity names, list hard rules, define vocabulary. The LLM sees this verbatim as
        a system-prompt prefix on every call this agent makes.
      </div>
    </Panel>
  );
}
window.AgentOntologyEditPanel = AgentOntologyEditPanel;

function AgentInputDataEditPanel({ value, onChange, height = 200 }) {
  const [raw, setRaw] = useStateAC(JSON.stringify(value || {}, null, 2));
  const [err, setErr] = useStateAC(null);
  function handle(v) {
    setRaw(v);
    try {
      const parsed = JSON.parse(v);
      setErr(null);
      onChange && onChange(parsed);
    } catch (e) {
      setErr(e.message);
    }
  }
  return (
    <Panel
      title="input_data"
      subtitle="Sample input payload. Used for test runs and to auto-generate the IO docs."
      padded={false}
      action={err
        ? <Badge tone="red">JSON ERR</Badge>
        : <Button small tone="ghost" icon="run">Run with this</Button>}
    >
      <window.MonacoEditor
        value={raw}
        onChange={handle}
        language="json"
        height={height}
      />
      {err && (
        <div style={{ padding: "6px 14px", borderTop: "1px solid var(--border)", fontSize: 11, color: "var(--red)", fontFamily: "var(--mono)" }}>
          <Icon name="alert" size={10} style={{ marginRight: 4 }} /> {err}
        </div>
      )}
    </Panel>
  );
}
window.AgentInputDataEditPanel = AgentInputDataEditPanel;

// ---------------- Editable tool_use list ----------------

function AgentToolUseEditPanel({ tools, onChange }) {
  const [items, setItems] = useStateAC(tools && tools.length ? tools : SAMPLE_TOOL_USE);
  const [openId, setOpenId] = useStateAC(0);

  function commit(next) { setItems(next); onChange && onChange(next); }
  function update(i, patch) {
    const next = items.map((t, idx) => idx === i ? { ...t, ...patch } : t);
    commit(next);
  }
  function updateSchema(i, raw) {
    try {
      const parsed = JSON.parse(raw);
      update(i, { input_schema: parsed, __schemaError: null });
    } catch (e) {
      update(i, { __schemaRaw: raw, __schemaError: e.message });
    }
  }
  function add() {
    const next = [...items, {
      name: `new_tool_${items.length + 1}`,
      description: "Describe what this tool does and when the LLM should call it.",
      input_schema: { type: "object", properties: { input: { type: "string" } }, required: ["input"] },
    }];
    commit(next);
    setOpenId(next.length - 1);
  }
  function remove(i) {
    const next = items.filter((_, idx) => idx !== i);
    commit(next);
    if (openId >= next.length) setOpenId(Math.max(0, next.length - 1));
  }

  return (
    <Panel
      title={`tool_use · ${items.length}`}
      subtitle="Tool definitions handed to the LLM at request time. Each tool's input_schema is a JSON Schema."
      padded={false}
      action={<Button small icon="plus" tone="ghost" onClick={add}>Add tool</Button>}
    >
      {items.length === 0 ? (
        <Empty title="No tools defined" hint="Click Add tool to expose an API to the LLM." />
      ) : (
        <div>
          {items.map((t, i) => (
            <ToolUseCard
              key={i}
              tool={t}
              open={openId === i}
              onToggle={() => setOpenId(openId === i ? -1 : i)}
              onUpdate={(patch) => update(i, patch)}
              onUpdateSchema={(raw) => updateSchema(i, raw)}
              onRemove={() => remove(i)}
            />
          ))}
        </div>
      )}
    </Panel>
  );
}
window.AgentToolUseEditPanel = AgentToolUseEditPanel;

function ToolUseCard({ tool, open, onToggle, onUpdate, onUpdateSchema, onRemove }) {
  const paramCount = tool.input_schema && tool.input_schema.properties
    ? Object.keys(tool.input_schema.properties).length : 0;

  return (
    <div style={{ borderBottom: "1px solid var(--border)" }}>
      {/* Card header */}
      <div
        onClick={onToggle}
        style={{
          display: "flex", alignItems: "center", gap: 10,
          padding: "10px 14px",
          cursor: "pointer",
          background: open ? "var(--panel-2)" : "transparent",
          transition: "background 0.1s",
        }}
        onMouseEnter={e => { if (!open) e.currentTarget.style.background = "var(--panel-2)"; }}
        onMouseLeave={e => { if (!open) e.currentTarget.style.background = "transparent"; }}
      >
        <Icon name={open ? "chevron-down" : "chevron-right"} size={11} style={{ color: "var(--text-3)" }} />
        <Icon name="code" size={11} style={{ color: open ? "var(--signal)" : "var(--text-3)" }} />
        <span className="mono" style={{ fontSize: 12.5, color: "var(--text)" }}>{tool.name}</span>
        <span style={{ flex: 1, fontSize: 11.5, color: "var(--text-3)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginLeft: 8 }}>
          {tool.description}
        </span>
        <span style={{ fontSize: 10, fontFamily: "var(--mono)", color: "var(--text-3)" }}>{paramCount} params</span>
        {tool.__schemaError && <Badge tone="red">SCHEMA ERR</Badge>}
        <button onClick={(e) => { e.stopPropagation(); onRemove(); }} style={{ color: "var(--text-3)", padding: 2 }}>
          <Icon name="x" size={11} />
        </button>
      </div>

      {/* Expanded body */}
      {open && (
        <div style={{ padding: "10px 14px 14px 36px", background: "var(--bg-2)", borderTop: "1px solid var(--border)" }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
            <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span style={{ fontSize: 10.5, fontFamily: "var(--mono)", color: "var(--text-3)", textTransform: "uppercase", letterSpacing: "0.06em" }}>name</span>
              <input
                value={tool.name}
                onChange={(e) => onUpdate({ name: e.target.value.replace(/[^a-z0-9_]/gi, "_") })}
                style={inputBoxStyle}
              />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span style={{ fontSize: 10.5, fontFamily: "var(--mono)", color: "var(--text-3)", textTransform: "uppercase", letterSpacing: "0.06em" }}>required by</span>
              <select defaultValue="llm" style={{ ...inputBoxStyle, appearance: "none" }}>
                <option value="llm">LLM tool-use (Anthropic / OpenAI)</option>
                <option value="code">Imperative code only</option>
              </select>
            </label>
          </div>

          <label style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: 10 }}>
            <span style={{ fontSize: 10.5, fontFamily: "var(--mono)", color: "var(--text-3)", textTransform: "uppercase", letterSpacing: "0.06em" }}>description</span>
            <textarea
              value={tool.description}
              onChange={(e) => onUpdate({ description: e.target.value })}
              rows={2}
              style={{ ...inputBoxStyle, resize: "vertical", lineHeight: 1.5 }}
            />
            <span style={{ fontSize: 10.5, color: "var(--text-3)" }}>
              The LLM uses this to decide when to call. Be specific about inputs, side effects, and when NOT to use it.
            </span>
          </label>

          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={{ fontSize: 10.5, fontFamily: "var(--mono)", color: "var(--text-3)", textTransform: "uppercase", letterSpacing: "0.06em" }}>input_schema · JSON Schema</span>
            <window.MonacoEditor
              value={JSON.stringify(tool.input_schema, null, 2)}
              onChange={onUpdateSchema}
              language="json"
              height={180}
            />
            {tool.__schemaError && (
              <div style={{ marginTop: 4, fontSize: 11, color: "var(--red)", fontFamily: "var(--mono)" }}>
                <Icon name="alert" size={10} style={{ marginRight: 4 }} /> {tool.__schemaError}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

const inputBoxStyle = {
  background: "var(--panel-2)",
  border: "1px solid var(--border-2)",
  borderRadius: 4,
  padding: "5px 8px",
  color: "var(--text)",
  fontFamily: "var(--mono)",
  fontSize: 11.5,
  outline: "none",
};
