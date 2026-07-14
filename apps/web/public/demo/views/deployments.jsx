// Deployments — version history + new-deploy panel showcasing 3 deploy methods

const { useState: useStateDep } = React;

function Deployments({ navigate }) {
  const dpls = window.RAAS_DEPLOYMENTS;
  const [showWizard, setShowWizard] = useStateDep(false);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <ViewHeader
        title="Deployments"
        subtitle="Every agent and workflow version, with rollback. Files in /var/agentic/deploys."
        action={[<Button key="d" icon="deploy" tone="primary" onClick={() => setShowWizard(true)}>Deploy new version</Button>]}
      />

      <div style={{ flex: 1, overflow: "auto", padding: 20 }}>
        {showWizard && <DeployWizard onClose={() => setShowWizard(false)} />}

        {/* Live versions panel */}
        <Panel title="Live versions" padded={false} style={{ marginBottom: 16 }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 1, background: "var(--border)" }}>
            <LiveCard label="Workflow" name="raas" version="2026.05.16-a" agentCount={22} deployedBy="Liu Wei" at={Date.now() - 5*60_000} />
            <LiveCard label="Runtime" name="agentic-operator" version="0.6.2" agentCount={null} deployedBy="Ops" at={Date.now() - 4*86_400_000} />
            <LiveCard label="Inngest worker" name="raas-worker" version="prod-08" agentCount={null} deployedBy="Ops" at={Date.now() - 11*3_600_000} />
          </div>
        </Panel>

        <Panel title="Deployment history" padded={false}
          action={<Button small icon="filter" tone="ghost">Filter</Button>}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--border)", background: "var(--panel)" }}>
                <Th>Status</Th>
                <Th>Version</Th>
                <Th>Target</Th>
                <Th>By</Th>
                <Th>When</Th>
                <Th>Notes</Th>
                <Th></Th>
              </tr>
            </thead>
            <tbody>
              {dpls.map(d => (
                <tr key={d.id} style={{ borderBottom: "1px solid var(--border)" }}>
                  <Td>
                    {d.status === "live" ? <Badge tone="signal">LIVE</Badge>
                      : d.status === "rolled-back" ? <Badge tone="muted">ROLLED BACK</Badge>
                      : <Badge tone="muted">{d.status}</Badge>}
                  </Td>
                  <Td><span className="mono">{d.version}</span></Td>
                  <Td>
                    <span className="mono" style={{ color: "var(--text-2)" }}>{d.agent}</span>
                  </Td>
                  <Td><span style={{ color: "var(--text-2)" }}>{d.by}</span></Td>
                  <Td><span style={{ color: "var(--text-3)" }}>{window.fmtAgo(d.at)}</span></Td>
                  <Td><span style={{ color: "var(--text-2)" }}>{d.note}</span></Td>
                  <Td>
                    <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                      <Button small tone="ghost" icon="external">Diff</Button>
                      {d.status === "live" ? <Button small tone="ghost">Rollback</Button> : <Button small tone="ghost">Restore</Button>}
                    </div>
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      </div>
    </div>
  );
}

function LiveCard({ label, name, version, agentCount, deployedBy, at }) {
  return (
    <div style={{ padding: "14px 16px", background: "var(--panel)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
        <Badge tone="signal">LIVE</Badge>
        <span style={{ fontSize: 10.5, fontFamily: "var(--mono)", textTransform: "uppercase", color: "var(--text-3)", letterSpacing: "0.08em" }}>{label}</span>
      </div>
      <div style={{ fontSize: 16, fontWeight: 500, color: "var(--text)", lineHeight: 1.2, marginBottom: 2 }}>{name}</div>
      <div className="mono" style={{ fontSize: 12, color: "var(--signal)" }}>{version}</div>
      <div style={{ display: "flex", gap: 14, marginTop: 8, fontSize: 11, color: "var(--text-3)", fontFamily: "var(--mono)" }}>
        {agentCount != null && <span>{agentCount} agents</span>}
        <span>{window.fmtAgo(at)}</span>
        <span>· {deployedBy}</span>
      </div>
    </div>
  );
}

function DeployWizard({ onClose }) {
  const [method, setMethod] = useStateDep("manifest");
  return (
    <div style={{
      marginBottom: 16,
      background: "var(--panel)",
      border: "1px solid var(--signal)",
      borderRadius: 8,
      overflow: "hidden",
      boxShadow: "0 0 0 1px rgba(208,255,0,0.08), 0 12px 32px -16px rgba(208,255,0,0.18)",
    }}>
      <header style={{ padding: "12px 16px", borderBottom: "1px solid var(--border)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Icon name="deploy" size={14} style={{ color: "var(--signal)" }} />
          <span style={{ fontSize: 13, color: "var(--text)", fontWeight: 500 }}>Deploy new version</span>
        </div>
        <Button small icon="x" tone="ghost" onClick={onClose} />
      </header>
      <div style={{ padding: 18 }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10, marginBottom: 16 }}>
          <MethodCard active={method === "manifest"} onClick={() => setMethod("manifest")}
            icon="upload" title="Manifest upload"
            sub="Drop a workflow.json + actions.json. Best for declarative pipelines."
          />
          <MethodCard active={method === "code"} onClick={() => setMethod("code")}
            icon="code" title="Code package"
            sub="TypeScript module via CLI / git push. Best for custom logic & tools."
          />
          <MethodCard active={method === "builder"} onClick={() => setMethod("builder")}
            icon="workflow" title="Visual builder"
            sub="Drag agents on a canvas, wire events. Best for prototyping & ops."
          />
        </div>

        {method === "manifest" && <ManifestStep />}
        {method === "code" && <CodeStep />}
        {method === "builder" && <BuilderStep />}
      </div>
    </div>
  );
}

function MethodCard({ active, onClick, icon, title, sub }) {
  return (
    <button onClick={onClick} style={{
      padding: "12px 14px",
      background: active ? "var(--panel-3)" : "var(--panel-2)",
      border: `1px solid ${active ? "var(--signal)" : "var(--border)"}`,
      borderRadius: 6,
      textAlign: "left",
      cursor: "pointer",
      transition: "background 0.12s, border 0.12s",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
        <Icon name={icon} size={13} style={{ color: active ? "var(--signal)" : "var(--text-2)" }} />
        <span style={{ fontSize: 13, fontWeight: 500, color: "var(--text)" }}>{title}</span>
      </div>
      <div style={{ fontSize: 11.5, color: "var(--text-3)", lineHeight: 1.45 }}>{sub}</div>
    </button>
  );
}

function ManifestStep() {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
      <div>
        <div style={{ fontSize: 11, fontFamily: "var(--mono)", textTransform: "uppercase", color: "var(--text-3)", letterSpacing: "0.08em", marginBottom: 8 }}>1 · Upload manifest</div>
        <div style={{
          padding: 24, textAlign: "center",
          background: "var(--bg-2)",
          border: "1px dashed var(--border-3)",
          borderRadius: 6,
        }}>
          <Icon name="upload" size={20} style={{ color: "var(--text-3)" }} />
          <div style={{ marginTop: 8, fontSize: 12.5, color: "var(--text-2)" }}>
            Drop <span className="mono">workflow.json</span> and <span className="mono">actions.json</span>
          </div>
          <div style={{ marginTop: 4, fontSize: 11, color: "var(--text-3)" }}>
            or <span style={{ color: "var(--signal)", cursor: "pointer" }}>browse files</span>
          </div>
        </div>
        <div style={{ marginTop: 10, fontSize: 11.5, color: "var(--text-3)" }}>
          We accept the same schema you provided for RAAS: <span className="mono">id, name, actor, trigger[], actions[], triggered_event[]</span>.
        </div>
      </div>
      <div>
        <div style={{ fontSize: 11, fontFamily: "var(--mono)", textTransform: "uppercase", color: "var(--text-3)", letterSpacing: "0.08em", marginBottom: 8 }}>2 · Preview · 22 agents detected</div>
        <CodeBlock>{`{
  "version": "raas@2026.05.16-b",
  "agents": 22,           // 18 agent · 4 human
  "events": 33,
  "diff_vs_live": {
    "added": ["enrichCandidateLinkedIn"],
    "modified": ["matchResume", "createJD"],
    "removed": []
  }
}`}</CodeBlock>
        <div style={{ marginTop: 10, display: "flex", gap: 8 }}>
          <Button tone="primary" icon="deploy">Deploy to prod</Button>
          <Button>Deploy to staging</Button>
        </div>
      </div>
    </div>
  );
}

function CodeStep() {
  return (
    <div>
      <div style={{ fontSize: 11, fontFamily: "var(--mono)", textTransform: "uppercase", color: "var(--text-3)", letterSpacing: "0.08em", marginBottom: 8 }}>1 · From your shell</div>
      <CodeBlock>{`$ npx agentic deploy raas \\
    --version 2026.05.16-b \\
    --target prod

✓ Bundled 22 agents (4 changed)
✓ Compiled handlers (TypeScript 5.6, Node 26.5.0)
✓ Uploaded to /var/agentic/deploys/raas/2026.05.16-b/
✓ Registered with Inngest worker · 1842 active runs migrated
→ Live in 3.4s`}</CodeBlock>
      <div style={{ marginTop: 12, fontSize: 11, fontFamily: "var(--mono)", textTransform: "uppercase", color: "var(--text-3)", letterSpacing: "0.08em", marginBottom: 8 }}>2 · Or via git push</div>
      <CodeBlock>{`$ git push agentic main:raas/prod

remote: building...
remote: ✓ agents validated
remote: ✓ workflow graph: 0 cycles, 0 orphans
remote: → deploying as 2026.05.16-b`}</CodeBlock>
    </div>
  );
}

function BuilderStep() {
  return (
    <div style={{
      padding: 32, textAlign: "center",
      background: "var(--bg-2)",
      border: "1px dashed var(--border-3)",
      borderRadius: 6,
    }}>
      <Icon name="workflow" size={28} style={{ color: "var(--text-3)" }} />
      <div style={{ marginTop: 10, fontSize: 14, color: "var(--text)" }}>Open visual builder</div>
      <div style={{ marginTop: 4, fontSize: 12, color: "var(--text-3)" }}>
        Drag agents from the palette, connect them with events. Save as a manifest, then deploy.
      </div>
      <div style={{ marginTop: 14 }}>
        <Button tone="primary" icon="external">Open builder →</Button>
      </div>
    </div>
  );
}

window.Deployments = Deployments;
