"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Badge, Icon, ModalOverlay } from "@/app/portal/components";

export type WorkflowHelpTopic =
  | "start"
  | "read"
  | "edit"
  | "fields"
  | "examples"
  | "troubleshooting";

export interface WorkflowHelpProps {
  open: boolean;
  onClose: () => void;
  initialTopic?: WorkflowHelpTopic;
}

const TOPICS: Array<{
  id: WorkflowHelpTopic;
  label: string;
  eyebrow: string;
}> = [
  { id: "start", label: "Start here", eyebrow: "A five-minute tour" },
  { id: "read", label: "Read a workflow", eyebrow: "Nodes, lines, and events" },
  { id: "edit", label: "Edit safely", eyebrow: "Draft to deployment" },
  {
    id: "fields",
    label: "Fields & buttons",
    eyebrow: "Plain-language reference",
  },
  {
    id: "examples",
    label: "Worked examples",
    eyebrow: "Follow two common flows",
  },
  {
    id: "troubleshooting",
    label: "Troubleshooting",
    eyebrow: "What to do when stuck",
  },
];

const listStyle = {
  margin: 0,
  paddingLeft: 20,
  color: "var(--text-2)",
  fontSize: 12,
  lineHeight: 1.7,
};

export function WorkflowHelp({
  open,
  onClose,
  initialTopic = "start",
}: WorkflowHelpProps) {
  const titleId = useId();
  const descriptionId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const contentRef = useRef<HTMLElement>(null);
  const [topic, setTopic] = useState<WorkflowHelpTopic>(initialTopic);

  function selectTopic(nextTopic: WorkflowHelpTopic) {
    setTopic(nextTopic);
    if (contentRef.current) contentRef.current.scrollTop = 0;
  }

  useEffect(() => {
    if (!open) return;
    setTopic(initialTopic);
    const previouslyFocused =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const frame = window.requestAnimationFrame(() => closeRef.current?.focus());

    function trapFocus(event: KeyboardEvent) {
      if (event.key !== "Tab" || !panelRef.current) return;
      const focusable = Array.from(
        panelRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), a[href], summary, [tabindex]:not([tabindex="-1"])',
        ),
      );
      if (!focusable.length) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", trapFocus);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("keydown", trapFocus);
      previouslyFocused?.focus();
    };
  }, [initialTopic, open]);

  if (!open) return null;

  return (
    <ModalOverlay onClose={onClose} ariaLabelledBy={titleId}>
      <div
        ref={panelRef}
        className="workflow-help-shell"
        aria-describedby={descriptionId}
        style={{
          width: "min(1120px, calc(100vw - 40px))",
          height: "min(790px, calc(100vh - 40px))",
          display: "grid",
          gridTemplateRows: "auto minmax(0, 1fr)",
          overflow: "hidden",
          color: "var(--text)",
          background: "var(--panel)",
          border: "1px solid var(--border-2)",
          borderRadius: 9,
          boxShadow: "0 22px 70px rgba(0,0,0,0.48)",
        }}
      >
        <header
          style={{
            padding: "14px 16px",
            display: "flex",
            alignItems: "center",
            gap: 12,
            borderBottom: "1px solid var(--border)",
            background: "var(--panel-2)",
          }}
        >
          <div
            style={{
              width: 32,
              height: 32,
              display: "grid",
              placeItems: "center",
              color: "var(--signal)",
              background: "rgba(208,255,0,0.06)",
              border: "1px solid rgba(208,255,0,0.35)",
              borderRadius: 6,
            }}
          >
            <Icon name="workflow" size={16} />
          </div>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <h1
                id={titleId}
                style={{ margin: 0, fontSize: 15, fontWeight: 600 }}
              >
                Workflows user guide
              </h1>
              <Badge tone="signal">Help</Badge>
            </div>
            <p
              id={descriptionId}
              style={{
                margin: "3px 0 0",
                color: "var(--text-3)",
                fontSize: 10.5,
              }}
            >
              Understand, trace, and safely change a workflow—no coding
              required.
            </p>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Close Workflows user guide"
            title="Close guide (Escape)"
            style={{
              width: 30,
              height: 30,
              display: "grid",
              placeItems: "center",
              color: "var(--text-2)",
              background: "transparent",
              border: "1px solid var(--border-2)",
              borderRadius: 5,
            }}
          >
            <Icon name="x" size={13} />
          </button>
        </header>

        <div
          className="workflow-help-layout"
          style={{
            minHeight: 0,
            display: "grid",
            gridTemplateColumns: "230px minmax(0, 1fr)",
          }}
        >
          <nav
            aria-label="Workflow help topics"
            className="workflow-help-nav"
            style={{
              minHeight: 0,
              overflow: "auto",
              padding: 10,
              background: "var(--bg)",
              borderRight: "1px solid var(--border)",
            }}
          >
            <div
              className="mono"
              style={{
                padding: "4px 8px 9px",
                color: "var(--text-3)",
                fontSize: 9.5,
                letterSpacing: ".08em",
              }}
            >
              USER GUIDE
            </div>
            {TOPICS.map((item, index) => {
              const active = item.id === topic;
              return (
                <button
                  key={item.id}
                  type="button"
                  aria-current={active ? "page" : undefined}
                  onClick={() => selectTopic(item.id)}
                  style={{
                    width: "100%",
                    padding: 9,
                    display: "grid",
                    gridTemplateColumns: "22px minmax(0, 1fr)",
                    gap: 7,
                    textAlign: "left",
                    color: active ? "var(--text)" : "var(--text-2)",
                    background: active ? "var(--panel-3)" : "transparent",
                    borderLeft: `2px solid ${active ? "var(--signal)" : "transparent"}`,
                    borderRadius: 4,
                  }}
                >
                  <span
                    className="mono"
                    style={{
                      color: active ? "var(--signal)" : "var(--text-3)",
                      fontSize: 9.5,
                    }}
                  >
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <span>
                    <span
                      style={{
                        display: "block",
                        fontSize: 11.5,
                        fontWeight: active ? 600 : 500,
                      }}
                    >
                      {item.label}
                    </span>
                    <span
                      style={{
                        display: "block",
                        marginTop: 2,
                        color: "var(--text-3)",
                        fontSize: 9.5,
                      }}
                    >
                      {item.eyebrow}
                    </span>
                  </span>
                </button>
              );
            })}
            <div
              style={{
                margin: "14px 8px 0",
                padding: 10,
                color: "var(--text-3)",
                background: "var(--panel-2)",
                border: "1px solid var(--border)",
                borderRadius: 5,
                fontSize: 10.5,
                lineHeight: 1.5,
              }}
            >
              <strong style={{ color: "var(--text-2)" }}>Safe rule</strong>
              <br />
              Trace the current flow, edit a draft, review the change count,
              then deploy deliberately.
            </div>
          </nav>

          <main
            ref={contentRef}
            className="workflow-help-content"
            style={{
              minWidth: 0,
              overflow: "auto",
              padding: "24px clamp(18px, 4vw, 44px) 48px",
            }}
          >
            <div style={{ maxWidth: 830, margin: "0 auto" }}>
              {topic === "start" && <StartHere onNavigate={selectTopic} />}
              {topic === "read" && <ReadGuide />}
              {topic === "edit" && <EditGuide />}
              {topic === "fields" && <FieldReference />}
              {topic === "examples" && <ExamplesGuide />}
              {topic === "troubleshooting" && <TroubleshootingGuide />}
            </div>
          </main>
        </div>
      </div>
      <style>{`
        @media (max-width: 760px) {
          .workflow-help-shell {
            width: calc(100vw - 16px) !important;
            height: calc(100vh - 16px) !important;
          }
          .workflow-help-layout {
            grid-template-columns: 1fr !important;
            grid-template-rows: auto minmax(0, 1fr);
          }
          .workflow-help-nav {
            display: flex;
            gap: 4px;
            overflow-x: auto !important;
            border-right: 0 !important;
            border-bottom: 1px solid var(--border);
          }
          .workflow-help-nav > div { display: none; }
          .workflow-help-nav > button {
            width: auto !important;
            min-width: max-content;
            grid-template-columns: auto 1fr !important;
          }
          .workflow-help-nav > button span span:last-child { display: none !important; }
          .workflow-help-content { padding: 18px 14px 36px !important; }
          .workflow-help-card-grid,
          .workflow-help-example-grid { grid-template-columns: 1fr !important; }
          .workflow-help-field-row { grid-template-columns: 1fr !important; gap: 5px !important; }
        }
      `}</style>
    </ModalOverlay>
  );
}

function StartHere({
  onNavigate,
}: {
  onNavigate: (topic: WorkflowHelpTopic) => void;
}) {
  return (
    <>
      <PageHeading eyebrow="Start here" title="A workflow is a shared plan">
        Each box is a person or agent doing one part of the work. A named event
        carries the work from one box to the next. The canvas helps you see the
        complete process without reading code.
      </PageHeading>
      <Callout tone="blue" title="Looking does not change anything">
        Clicking a box or event only highlights and explains it. Live behavior
        changes only after someone enters Edit workflow, makes a draft, and
        deploys that draft.
      </Callout>
      <div
        className="workflow-help-card-grid"
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(3, 1fr)",
          gap: 9,
          margin: "18px 0",
        }}
      >
        <MiniCard label="1 · Find" title="Locate the work">
          Read the stage headings and find the box whose name matches the task
          you care about.
        </MiniCard>
        <MiniCard label="2 · Trace" title="Follow the hand-off">
          Click the box, then click its incoming or outgoing event to see all
          connected steps.
        </MiniCard>
        <MiniCard label="3 · Inspect" title="Read the details">
          Use the right panel to see what starts the step, what it emits, and
          recent activity.
        </MiniCard>
      </div>
      <GuideSection number="01" title="What you see on the canvas">
        <ul style={listStyle}>
          <li>
            <strong>Columns</strong> are stages such as Intake, Analyze, or
            Submit. Work usually moves from left to right.
          </li>
          <li>
            <strong>Boxes</strong> are nodes. A lime edge means an AI agent; a
            violet edge means a human task.
          </li>
          <li>
            <strong>Lines</strong> show event hand-offs. The arrow points to the
            next listener.
          </li>
          <li>
            <strong>The right panel</strong> explains the selected box or event.
            With nothing selected, it shows the legend and event list.
          </li>
        </ul>
      </GuideSection>
      <div
        className="workflow-help-card-grid"
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(3, 1fr)",
          gap: 9,
          marginTop: 18,
        }}
      >
        <JumpCard
          title="Need to trace a problem?"
          body="Learn how to follow boxes and events."
          action="Read a workflow"
          onClick={() => onNavigate("read")}
        />
        <JumpCard
          title="Need to change the flow?"
          body="Use a safe draft and deploy deliberately."
          action="Edit safely"
          onClick={() => onNavigate("edit")}
        />
        <JumpCard
          title="Prefer an example?"
          body="Follow support and invoice workflows."
          action="View examples"
          onClick={() => onNavigate("examples")}
        />
      </div>
    </>
  );
}

function ReadGuide() {
  return (
    <>
      <PageHeading
        eyebrow="View & trace"
        title="Follow the work from start to finish"
      >
        Start with a business question: “What happens after this?” or “Why did
        this step run?” Then use selections to narrow the canvas.
      </PageHeading>
      <GuideSection number="01" title="Trace from a box">
        <ol style={listStyle}>
          <li>Click the agent or human-task box you want to understand.</li>
          <li>
            The connected boxes and lines stay bright; unrelated work dims.
          </li>
          <li>
            Read <strong>Triggers</strong> in the right panel to learn what can
            start it.
          </li>
          <li>
            Read <strong>Emits</strong> to learn what it announces after
            success.
          </li>
          <li>
            Choose <strong>Open agent</strong> when you need its instructions,
            inputs, outputs, tools, or run history.
          </li>
        </ol>
      </GuideSection>
      <GuideSection number="02" title="Trace an event hand-off">
        <ol style={listStyle}>
          <li>
            Click a line, or choose an event from the right-side event list.
          </li>
          <li>Every line carrying that event is highlighted.</li>
          <li>
            The inspector lists which boxes <strong>emit</strong> the event and
            which boxes <strong>listen</strong> for it.
          </li>
          <li>
            Use <strong>View in event stream</strong> to inspect recent real
            occurrences and timestamps.
          </li>
        </ol>
      </GuideSection>
      <Callout
        tone="amber"
        title="A line is a promise, not proof of a successful run"
      >
        The graph shows configured hand-offs. Use the event stream and Runs
        pages to confirm that a particular event was emitted and processed.
      </Callout>
      <GuideSection number="03" title="Questions this view can answer">
        <ul style={listStyle}>
          <li>What starts this agent, and what happens after it finishes?</li>
          <li>Which agents depend on this event?</li>
          <li>Where does a person review or approve the work?</li>
          <li>Which stage contains the problem?</li>
          <li>Will renaming an event affect more than one listener?</li>
        </ul>
      </GuideSection>
    </>
  );
}

function EditGuide() {
  return (
    <>
      <PageHeading
        eyebrow="Edit mode"
        title="Change a draft, not the live workflow"
      >
        Edit mode gives you a working copy. Your live workflow keeps running
        until you deliberately deploy the draft.
      </PageHeading>
      <Callout tone="green" title="Recommended sequence">
        Understand the current path → enter Edit workflow → change one idea at a
        time → review the change count and event names → deploy deliberately.
      </Callout>
      <GuideSection number="01" title="Start a draft">
        <ol style={listStyle}>
          <li>
            Choose <strong>Edit workflow</strong> in the page header.
          </li>
          <li>
            Confirm the amber <strong>Draft</strong> badge is visible. This
            means you are not changing the live version yet.
          </li>
          <li>Click a box. Its editable details appear on the right.</li>
        </ol>
      </GuideSection>
      <GuideSection number="02" title="Edit a box">
        <ul style={listStyle}>
          <li>
            <strong>Title:</strong> change the friendly name people see.
          </li>
          <li>
            <strong>Triggered by:</strong> list events that are allowed to start
            this box.
          </li>
          <li>
            <strong>Triggered event:</strong> list events announced when the box
            succeeds.
          </li>
          <li>
            <strong>Remove node:</strong> removes the box from this draft. It
            does not delete past versions or run history.
          </li>
        </ul>
        <Callout tone="amber" title="Event names connect the workflow">
          An emitted event must exactly match the event a downstream box listens
          for. Changing spelling, spaces, or capitalization can disconnect the
          hand-off.
        </Callout>
      </GuideSection>
      <GuideSection number="03" title="Review and deploy">
        <ol style={listStyle}>
          <li>
            Review the header count for added, changed, and removed boxes.
          </li>
          <li>
            Ask the affected process owner to review changes to events or human
            approval steps.
          </li>
          <li>
            Choose <strong>Deploy draft</strong>. Deployment creates a new
            version and makes that version live. The server rejects an invalid
            definition without replacing the live version.
          </li>
        </ol>
        <Callout tone="blue" title="About the Validate button">
          The separate Validate control is visible but does not run a dedicated
          check in this release. Deploy draft performs the authoritative server
          validation. Review the graph and event names first; an invalid
          definition is rejected without replacing the live version.
        </Callout>
      </GuideSection>
      <GuideSection number="04" title="Stop or continue later">
        <ul style={listStyle}>
          <li>
            <strong>Discard draft</strong> abandons the current working changes.
          </li>
          <li>
            Unsaved draft state is kept in this browser for the current tenant.
            If it is restored later, a banner shows when it was saved.
          </li>
          <li>
            A browser draft is not a team hand-off. Deploy it or coordinate with
            another editor before switching devices.
          </li>
        </ul>
      </GuideSection>
    </>
  );
}

function FieldReference() {
  const groups = [
    {
      title: "Canvas and inspector",
      summary: "Controls used to explore the live workflow.",
      rows: [
        [
          "Stage heading",
          "A business phase of the workflow.",
          "Use it to find where work is in the overall process.",
        ],
        [
          "Agent node",
          "An automated unit of work.",
          "Click it to highlight its hand-offs and read its triggers and emitted events.",
        ],
        [
          "Human node",
          "A step that waits for a person.",
          "Click it to see where review or approval fits in the process.",
        ],
        [
          "Event line",
          "A named message connecting one box to another.",
          "Click it to highlight every sender and listener for that event.",
        ],
        [
          "Triggers",
          "Events that are allowed to start the selected box.",
          "Use these to work backward to the source.",
        ],
        [
          "Emits",
          "Events announced after the selected box succeeds.",
          "Use these to follow the process forward.",
        ],
        [
          "Open agent",
          "Opens the full Agent Studio definition.",
          "Use it for instructions, input/output contracts, tools, runtime, tests, and versions.",
        ],
        [
          "View in event stream",
          "Opens recent occurrences of one event.",
          "Use it to confirm that a configured hand-off actually happened.",
        ],
      ],
    },
    {
      title: "Page actions",
      summary: "Actions that create, import, or change a workflow.",
      rows: [
        [
          "Edit workflow",
          "Starts a safe working draft of the current workflow.",
          "Use it when changing box titles or event connections.",
        ],
        [
          "New workflow",
          "Opens a planning preview for a blank canvas, template, or import.",
          "The preview form does not persist a workflow in this release. Use Import manifest for an approved workflow definition.",
        ],
        [
          "Import manifest",
          "Loads workflow definition files.",
          "This is for technical users with reviewed workflow.json and actions.json files.",
        ],
        [
          "Help",
          "Opens this guide.",
          "It is available in both view and edit modes.",
        ],
      ],
    },
    {
      title: "Edit-mode fields and actions",
      summary: "What you can change in a workflow draft.",
      rows: [
        [
          "Title",
          "The friendly box name on the canvas.",
          "Use a short verb-and-object name, such as Classify ticket.",
        ],
        [
          "Triggered by",
          "The list of event names that start this box.",
          "Enter exact registered names, separated by commas or new lines.",
        ],
        [
          "Triggered event",
          "The list of event names emitted after success.",
          "Enter the exact names expected by downstream listeners.",
        ],
        [
          "Remove node",
          "Excludes the box from the new draft version.",
          "Use only after checking every incoming and outgoing event dependency.",
        ],
        [
          "Validate",
          "Reserved for a future dedicated pre-deployment check.",
          "It is not active in this release. Deploy draft performs the authoritative server validation and rejects invalid definitions.",
        ],
        [
          "Deploy draft",
          "Creates a new workflow version and makes it live.",
          "Review the change count and affected downstream owners first.",
        ],
        [
          "Discard draft",
          "Abandons the current working changes.",
          "Use it when you want to return to the live definition without deploying.",
        ],
      ],
    },
    {
      title: "New workflow fields",
      summary: "Choices shown when starting a workflow.",
      rows: [
        [
          "Start from",
          "How the first draft is created.",
          "Choose Blank canvas, From template, or Import manifest.",
        ],
        [
          "Display name",
          "The friendly workflow name.",
          "Use the business process name, such as Customer Support Triage.",
        ],
        [
          "Workflow ID",
          "The stable technical identifier.",
          "Accept the suggested lowercase ID unless your naming policy says otherwise.",
        ],
        [
          "Tenant",
          "The workspace that owns the workflow.",
          "Choose the team or organization whose agents and runs this workflow belongs to.",
        ],
        [
          "Default model",
          "The starting AI model for new automated steps.",
          "Use the approved workspace default unless an expert recommends a change.",
        ],
        [
          "Trigger type",
          "How a blank workflow begins.",
          "Choose Event, Scheduled, Webhook, or Manual based on the real business start.",
        ],
        [
          "First agent name",
          "The first box created on a blank canvas.",
          "Use a short technical name describing the first action.",
        ],
        [
          "Template",
          "A prepared multi-step pattern.",
          "Choose the closest business process, then review every box and event before deployment.",
        ],
      ],
    },
  ];

  return (
    <>
      <PageHeading
        eyebrow="Reference"
        title="Every workflow field in plain language"
      >
        Use the label you see in the page to find what it means and what you
        should do. Import files and technical identifiers are best reviewed with
        an engineer.
      </PageHeading>
      <div style={{ display: "grid", gap: 8 }}>
        {groups.map((group, index) => (
          <details
            key={group.title}
            open={index === 0}
            style={{
              background: "var(--panel-2)",
              border: "1px solid var(--border)",
              borderRadius: 6,
            }}
          >
            <summary style={{ padding: "11px 13px", cursor: "pointer" }}>
              <strong style={{ fontSize: 12 }}>{group.title}</strong>
              <span
                style={{
                  display: "block",
                  marginTop: 3,
                  color: "var(--text-3)",
                  fontSize: 10.5,
                }}
              >
                {group.summary}
              </span>
            </summary>
            <dl style={{ margin: 0, borderTop: "1px solid var(--border)" }}>
              {group.rows.map(([name, meaning, use]) => (
                <div
                  className="workflow-help-field-row"
                  key={name}
                  style={{
                    padding: "12px 13px",
                    display: "grid",
                    gridTemplateColumns:
                      "minmax(150px, .7fr) minmax(260px, 1.7fr)",
                    gap: 14,
                    borderBottom: "1px solid var(--border)",
                  }}
                >
                  <dt style={{ fontSize: 11.5, fontWeight: 600 }}>{name}</dt>
                  <dd
                    style={{
                      margin: 0,
                      color: "var(--text-2)",
                      fontSize: 11,
                      lineHeight: 1.55,
                    }}
                  >
                    {meaning}
                    <span style={{ display: "block", marginTop: 4 }}>
                      <strong style={{ color: "var(--text)" }}>
                        What to do:
                      </strong>{" "}
                      {use}
                    </span>
                  </dd>
                </div>
              ))}
            </dl>
          </details>
        ))}
      </div>
    </>
  );
}

function ExamplesGuide() {
  return (
    <>
      <PageHeading
        eyebrow="Worked examples"
        title="See how events move real work"
      >
        These examples use ordinary business language first, then show the event
        names a workflow builder would configure.
      </PageHeading>
      <div
        className="workflow-help-example-grid"
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 12,
        }}
      >
        <ExampleCard
          number="01"
          title="Customer support triage"
          goal="Classify a new ticket and route urgent cases for immediate human attention."
          steps={[
            ["Receive ticket", "support.ticket.received"],
            ["Classify topic and urgency", "support.ticket.classified"],
            ["Human priority review", "support.ticket.approved"],
            ["Assign service queue", "support.ticket.routed"],
          ]}
          tryIt={[
            "Click Classify topic and urgency.",
            "Confirm support.ticket.received is a trigger.",
            "Click support.ticket.classified and verify the review and routing listeners.",
          ]}
          watch="If you rename support.ticket.classified, update every listener using it or the route will break."
        />
        <ExampleCard
          number="02"
          title="Invoice approval"
          goal="Check an invoice, pause for approval when needed, then send it to payment."
          steps={[
            ["Read invoice", "invoice.received"],
            ["Check amount and supplier", "invoice.checked"],
            ["Manager approval", "invoice.approved"],
            ["Schedule payment", "payment.scheduled"],
          ]}
          tryIt={[
            "Click Manager approval to locate the human step.",
            "Trace invoice.checked backward to the automated check.",
            "Trace invoice.approved forward to Schedule payment.",
          ]}
          watch="Removing the approval box can change a financial control. Ask the process owner before deploying."
        />
      </div>
      <Callout tone="blue" title="A useful design test">
        Explain every box as “When [trigger] happens, this box [does one job],
        then emits [event].” If that sentence is unclear, rename the title or
        event before adding more steps.
      </Callout>
    </>
  );
}

function TroubleshootingGuide() {
  const issues = [
    [
      "The canvas looks empty",
      "Confirm the correct tenant is selected and wait for the API to load. Scroll horizontally if the workflow begins in a later stage. If the API-unreachable banner appears, contact the operator rather than importing or creating replacement data.",
    ],
    [
      "A box never starts",
      "Open the box and check its Trigger name. Then click that event and confirm an upstream box emits the exact same spelling and capitalization. Use the event stream to see whether the event actually occurred.",
    ],
    [
      "The next box does not run",
      "Check that the first box completed successfully in Runs, emitted the expected event, and that the next box listens for that exact event. A configured line alone does not prove the event was processed.",
    ],
    [
      "Deploy draft is disabled",
      "Make at least one real draft change. If there is already a change, wait for the draft state to update. The button also stays disabled while another deployment is in progress.",
    ],
    [
      "Deployment failed",
      "Read the error message, keep the draft, and fix the reported field. Common causes are invalid event names, incomplete agent definitions, or a newer version published by someone else. Refresh and compare before retrying a conflict.",
    ],
    [
      "My draft returned after refresh",
      "This is expected: the browser preserves unfinished changes for this tenant. Read the restored time. Continue only if the changes are yours; otherwise choose Discard and coordinate with the previous editor.",
    ],
    [
      "I changed the wrong thing",
      "Before deployment, choose Discard draft. After deployment, do not recreate history manually—review the Deployments page and restore or republish the last known-good definition using your team's release process.",
    ],
  ];

  return (
    <>
      <PageHeading
        eyebrow="Troubleshooting"
        title="Start with the hand-off that failed"
      >
        Identify the last successful box or event, then inspect one connection
        at a time. Keep the current draft while investigating unless you are
        certain it should be discarded.
      </PageHeading>
      <div style={{ display: "grid", gap: 8 }}>
        {issues.map(([title, answer], index) => (
          <details
            key={title}
            open={index === 0}
            style={{
              padding: "11px 13px",
              background: "var(--panel-2)",
              border: "1px solid var(--border)",
              borderRadius: 6,
            }}
          >
            <summary
              style={{ cursor: "pointer", fontSize: 12, fontWeight: 600 }}
            >
              {title}
            </summary>
            <p
              style={{
                margin: "9px 0 0",
                color: "var(--text-2)",
                fontSize: 11.5,
                lineHeight: 1.65,
              }}
            >
              {answer}
            </p>
          </details>
        ))}
      </div>
      <Callout tone="red" title="Stop before deploying when">
        You cannot explain an event change, a human approval disappears, the
        validation result is unclear, or another person may be editing the same
        workflow. Ask the workflow owner or an engineer to review the draft.
      </Callout>
    </>
  );
}

function PageHeading({
  eyebrow,
  title,
  children,
}: {
  eyebrow: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <div style={{ marginBottom: 22 }}>
      <div
        className="mono"
        style={{
          color: "var(--signal)",
          fontSize: 9.5,
          letterSpacing: ".1em",
          textTransform: "uppercase",
        }}
      >
        {eyebrow}
      </div>
      <h2
        style={{
          margin: "6px 0 7px",
          fontSize: 24,
          lineHeight: 1.2,
          fontWeight: 550,
        }}
      >
        {title}
      </h2>
      <p
        style={{
          maxWidth: 720,
          margin: 0,
          color: "var(--text-2)",
          fontSize: 12.5,
          lineHeight: 1.65,
        }}
      >
        {children}
      </p>
    </div>
  );
}

function GuideSection({
  number,
  title,
  children,
}: {
  number: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section
      style={{
        display: "grid",
        gridTemplateColumns: "34px minmax(0, 1fr)",
        gap: 10,
        padding: "17px 0",
        borderTop: "1px solid var(--border)",
      }}
    >
      <span
        className="mono"
        style={{ color: "var(--signal)", fontSize: 10, paddingTop: 3 }}
      >
        {number}
      </span>
      <div>
        <h3 style={{ margin: "0 0 8px", fontSize: 14, fontWeight: 600 }}>
          {title}
        </h3>
        {children}
      </div>
    </section>
  );
}

function MiniCard({
  label,
  title,
  children,
}: {
  label: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <div
      style={{
        padding: 13,
        background: "var(--panel-2)",
        border: "1px solid var(--border)",
        borderRadius: 6,
      }}
    >
      <div
        className="mono"
        style={{
          color: "var(--signal)",
          fontSize: 9.5,
          letterSpacing: ".05em",
        }}
      >
        {label}
      </div>
      <h3 style={{ margin: "6px 0 5px", fontSize: 12.5, fontWeight: 600 }}>
        {title}
      </h3>
      <p
        style={{
          margin: 0,
          color: "var(--text-3)",
          fontSize: 10.75,
          lineHeight: 1.55,
        }}
      >
        {children}
      </p>
    </div>
  );
}

function JumpCard({
  title,
  body,
  action,
  onClick,
}: {
  title: string;
  body: string;
  action: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        padding: 13,
        textAlign: "left",
        color: "var(--text)",
        background: "var(--panel-2)",
        border: "1px solid var(--border)",
        borderRadius: 6,
      }}
    >
      <strong style={{ display: "block", fontSize: 12 }}>{title}</strong>
      <span
        style={{
          display: "block",
          margin: "5px 0 9px",
          color: "var(--text-3)",
          fontSize: 10.5,
          lineHeight: 1.5,
        }}
      >
        {body}
      </span>
      <span style={{ color: "var(--signal)", fontSize: 10.5 }}>{action} →</span>
    </button>
  );
}

function Callout({
  tone,
  title,
  children,
}: {
  tone: "blue" | "green" | "amber" | "red";
  title: string;
  children: ReactNode;
}) {
  const colors = {
    blue: "var(--blue)",
    green: "var(--green)",
    amber: "var(--amber)",
    red: "var(--red)",
  };
  const color = colors[tone];
  return (
    <div
      style={{
        margin: "16px 0",
        padding: "11px 13px",
        color: "var(--text-2)",
        background: "var(--panel-2)",
        borderLeft: `3px solid ${color}`,
        borderRadius: 4,
        fontSize: 11.5,
        lineHeight: 1.6,
      }}
    >
      <strong style={{ display: "block", marginBottom: 3, color }}>
        {title}
      </strong>
      {children}
    </div>
  );
}

function ExampleCard({
  number,
  title,
  goal,
  steps,
  tryIt,
  watch,
}: {
  number: string;
  title: string;
  goal: string;
  steps: Array<[string, string]>;
  tryIt: string[];
  watch: string;
}) {
  return (
    <article
      style={{
        padding: 15,
        background: "var(--panel-2)",
        border: "1px solid var(--border)",
        borderRadius: 7,
      }}
    >
      <div
        className="mono"
        style={{
          color: "var(--signal)",
          fontSize: 9.5,
          letterSpacing: ".08em",
        }}
      >
        EXAMPLE {number}
      </div>
      <h3 style={{ margin: "6px 0", fontSize: 15, fontWeight: 600 }}>
        {title}
      </h3>
      <p
        style={{
          margin: "0 0 13px",
          color: "var(--text-2)",
          fontSize: 11.5,
          lineHeight: 1.55,
        }}
      >
        {goal}
      </p>
      <div style={{ display: "grid", gap: 5 }}>
        {steps.map(([label, event], index) => (
          <div key={event}>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "20px minmax(0, 1fr)",
                gap: 7,
                alignItems: "start",
                padding: "7px 8px",
                background: "var(--bg)",
                border: "1px solid var(--border)",
                borderRadius: 4,
              }}
            >
              <span
                className="mono"
                style={{ color: "var(--signal)", fontSize: 9.5 }}
              >
                {index + 1}
              </span>
              <span style={{ minWidth: 0 }}>
                <strong style={{ display: "block", fontSize: 11 }}>
                  {label}
                </strong>
                <code
                  style={{
                    display: "block",
                    marginTop: 3,
                    overflowWrap: "anywhere",
                    color: "var(--blue)",
                    fontSize: 9.5,
                  }}
                >
                  {index === 0 ? `starts with ${event}` : `emits ${event}`}
                </code>
              </span>
            </div>
            {index < steps.length - 1 && (
              <div
                aria-hidden="true"
                style={{
                  height: 8,
                  marginLeft: 17,
                  borderLeft: "1px solid var(--border-2)",
                }}
              />
            )}
          </div>
        ))}
      </div>
      <h4 style={{ margin: "14px 0 5px", fontSize: 11.5 }}>Try this trace</h4>
      <ol style={{ ...listStyle, fontSize: 10.75 }}>
        {tryIt.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ol>
      <div
        style={{
          marginTop: 12,
          padding: 9,
          color: "var(--amber)",
          background: "var(--bg)",
          borderRadius: 4,
          fontSize: 10.5,
          lineHeight: 1.5,
        }}
      >
        <strong>Watch out:</strong> {watch}
      </div>
    </article>
  );
}
