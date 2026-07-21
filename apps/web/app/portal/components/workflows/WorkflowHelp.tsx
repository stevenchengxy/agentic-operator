"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Badge, Icon, ModalOverlay } from "@/app/portal/components";
import { useI18n } from "@/app/portal/lib/preferences-context";

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

const TOPICS: WorkflowHelpTopic[] = [
  "start",
  "read",
  "edit",
  "fields",
  "examples",
  "troubleshooting",
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
  const { t } = useI18n();
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
                {t("workflowHelp.title")}
              </h1>
              <Badge tone="signal">{t("workflowHelp.helpBadge")}</Badge>
            </div>
            <p
              id={descriptionId}
              style={{
                margin: "3px 0 0",
                color: "var(--text-3)",
                fontSize: 10.5,
              }}
            >
              {t("workflowHelp.subtitle")}
            </p>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label={t("workflowHelp.closeAria")}
            title={t("workflowHelp.closeTitle")}
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
            aria-label={t("workflowHelp.topicsAria")}
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
              {t("workflowHelp.userGuide")}
            </div>
            {TOPICS.map((item, index) => {
              const active = item === topic;
              return (
                <button
                  key={item}
                  type="button"
                  aria-current={active ? "page" : undefined}
                  onClick={() => selectTopic(item)}
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
                      {t(`workflowHelp.topic.${item}.label`)}
                    </span>
                    <span
                      style={{
                        display: "block",
                        marginTop: 2,
                        color: "var(--text-3)",
                        fontSize: 9.5,
                      }}
                    >
                      {t(`workflowHelp.topic.${item}.eyebrow`)}
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
              <strong style={{ color: "var(--text-2)" }}>
                {t("workflowHelp.safeRule")}
              </strong>
              <br />
              {t("workflowHelp.safeRuleBody")}
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
  const { t } = useI18n();
  return (
    <>
      <PageHeading
        eyebrow={t("workflowHelp.start.eyebrow")}
        title={t("workflowHelp.start.title")}
      >
        {t("workflowHelp.start.intro")}
      </PageHeading>
      <Callout tone="blue" title={t("workflowHelp.start.lookTitle")}>
        {t("workflowHelp.start.lookBody")}
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
        <MiniCard
          label={t("workflowHelp.start.findLabel")}
          title={t("workflowHelp.start.findTitle")}
        >
          {t("workflowHelp.start.findBody")}
        </MiniCard>
        <MiniCard
          label={t("workflowHelp.start.traceLabel")}
          title={t("workflowHelp.start.traceTitle")}
        >
          {t("workflowHelp.start.traceBody")}
        </MiniCard>
        <MiniCard
          label={t("workflowHelp.start.inspectLabel")}
          title={t("workflowHelp.start.inspectTitle")}
        >
          {t("workflowHelp.start.inspectBody")}
        </MiniCard>
      </div>
      <GuideSection number="01" title={t("workflowHelp.start.canvasTitle")}>
        <ul style={listStyle}>
          <li>{t("workflowHelp.start.canvasColumns")}</li>
          <li>{t("workflowHelp.start.canvasBoxes")}</li>
          <li>{t("workflowHelp.start.canvasLines")}</li>
          <li>{t("workflowHelp.start.canvasPanel")}</li>
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
          title={t("workflowHelp.start.jumpTraceTitle")}
          body={t("workflowHelp.start.jumpTraceBody")}
          action={t("workflowHelp.topic.read.label")}
          onClick={() => onNavigate("read")}
        />
        <JumpCard
          title={t("workflowHelp.start.jumpEditTitle")}
          body={t("workflowHelp.start.jumpEditBody")}
          action={t("workflowHelp.topic.edit.label")}
          onClick={() => onNavigate("edit")}
        />
        <JumpCard
          title={t("workflowHelp.start.jumpExampleTitle")}
          body={t("workflowHelp.start.jumpExampleBody")}
          action={t("workflowHelp.start.jumpExampleAction")}
          onClick={() => onNavigate("examples")}
        />
      </div>
    </>
  );
}

function ReadGuide() {
  const { t } = useI18n();
  return (
    <>
      <PageHeading
        eyebrow={t("workflowHelp.read.eyebrow")}
        title={t("workflowHelp.read.title")}
      >
        {t("workflowHelp.read.intro")}
      </PageHeading>
      <GuideSection number="01" title={t("workflowHelp.read.boxTitle")}>
        <ol style={listStyle}>
          <li>{t("workflowHelp.read.box1")}</li>
          <li>{t("workflowHelp.read.box2")}</li>
          <li>{t("workflowHelp.read.box3")}</li>
          <li>{t("workflowHelp.read.box4")}</li>
          <li>{t("workflowHelp.read.box5")}</li>
        </ol>
      </GuideSection>
      <GuideSection number="02" title={t("workflowHelp.read.eventTitle")}>
        <ol style={listStyle}>
          <li>{t("workflowHelp.read.event1")}</li>
          <li>{t("workflowHelp.read.event2")}</li>
          <li>{t("workflowHelp.read.event3")}</li>
          <li>{t("workflowHelp.read.event4")}</li>
        </ol>
      </GuideSection>
      <Callout
        tone="amber"
        title={t("workflowHelp.read.lineTitle")}
      >
        {t("workflowHelp.read.lineBody")}
      </Callout>
      <GuideSection number="03" title={t("workflowHelp.read.runTitle")}>
        <ol style={listStyle}>
          <li>{t("workflowHelp.read.run1")}</li>
          <li>{t("workflowHelp.read.run2")}</li>
          <li>{t("workflowHelp.read.run3")}</li>
          <li>{t("workflowHelp.read.run4")}</li>
        </ol>
      </GuideSection>
      <GuideSection number="04" title={t("workflowHelp.read.questionsTitle")}>
        <ul style={listStyle}>
          <li>{t("workflowHelp.read.question1")}</li>
          <li>{t("workflowHelp.read.question2")}</li>
          <li>{t("workflowHelp.read.question3")}</li>
          <li>{t("workflowHelp.read.question4")}</li>
          <li>{t("workflowHelp.read.question5")}</li>
        </ul>
      </GuideSection>
    </>
  );
}

function EditGuide() {
  const { t } = useI18n();
  return (
    <>
      <PageHeading
        eyebrow={t("workflowHelp.edit.eyebrow")}
        title={t("workflowHelp.edit.title")}
      >
        {t("workflowHelp.edit.intro")}
      </PageHeading>
      <Callout tone="green" title={t("workflowHelp.edit.sequenceTitle")}>
        {t("workflowHelp.edit.sequenceBody")}
      </Callout>
      <GuideSection number="01" title={t("workflowHelp.edit.startTitle")}>
        <ol style={listStyle}>
          <li>{t("workflowHelp.edit.start1")}</li>
          <li>{t("workflowHelp.edit.start2")}</li>
          <li>{t("workflowHelp.edit.start3")}</li>
        </ol>
      </GuideSection>
      <GuideSection number="02" title={t("workflowHelp.edit.boxTitle")}>
        <ul style={listStyle}>
          <li>{t("workflowHelp.edit.box1")}</li>
          <li>{t("workflowHelp.edit.box2")}</li>
          <li>{t("workflowHelp.edit.box3")}</li>
          <li>{t("workflowHelp.edit.box4")}</li>
          <li>{t("workflowHelp.edit.box5")}</li>
          <li>{t("workflowHelp.edit.box6")}</li>
          <li>{t("workflowHelp.edit.box7")}</li>
        </ul>
        <Callout tone="amber" title={t("workflowHelp.edit.eventsTitle")}>
          {t("workflowHelp.edit.eventsBody")}
        </Callout>
      </GuideSection>
      <GuideSection number="03" title={t("workflowHelp.edit.reviewTitle")}>
        <ol style={listStyle}>
          <li>{t("workflowHelp.edit.review1")}</li>
          <li>{t("workflowHelp.edit.review2")}</li>
          <li>{t("workflowHelp.edit.review3")}</li>
          <li>{t("workflowHelp.edit.review4")}</li>
          <li>{t("workflowHelp.edit.review5")}</li>
        </ol>
        <Callout tone="blue" title={t("workflowHelp.edit.validateTitle")}>
          {t("workflowHelp.edit.validateBody")}
        </Callout>
      </GuideSection>
      <GuideSection number="04" title={t("workflowHelp.edit.laterTitle")}>
        <ul style={listStyle}>
          <li>{t("workflowHelp.edit.later1")}</li>
          <li>{t("workflowHelp.edit.later2")}</li>
          <li>{t("workflowHelp.edit.later3")}</li>
        </ul>
      </GuideSection>
    </>
  );
}

function FieldReference() {
  const { t } = useI18n();
  const row = (key: string): [string, string, string] => [
    t(`${key}.name`),
    t(`${key}.meaning`),
    t(`${key}.use`),
  ];
  const groups = [
    {
      title: t("workflowHelp.fields.canvas.title"),
      summary: t("workflowHelp.fields.canvas.summary"),
      rows: [
        "stage",
        "agent",
        "human",
        "event",
        "triggers",
        "emits",
        "details",
        "eventStream",
      ].map((id) => row(`workflowHelp.fields.canvas.${id}`)),
    },
    {
      title: t("workflowHelp.fields.actions.title"),
      summary: t("workflowHelp.fields.actions.summary"),
      rows: ["edit", "run", "new", "import", "help"].map((id) =>
        row(`workflowHelp.fields.actions.${id}`),
      ),
    },
    {
      title: t("workflowHelp.fields.edit.title"),
      summary: t("workflowHelp.fields.edit.summary"),
      rows: [
        "titleField",
        "triggeredBy",
        "triggeredEvent",
        "generatePrompt",
        "runtime",
        "complete",
        "remove",
        "validate",
        "run",
        "publish",
        "discard",
      ].map((id) => row(`workflowHelp.fields.edit.${id}`)),
    },
    {
      title: t("workflowHelp.fields.newWorkflow.title"),
      summary: t("workflowHelp.fields.newWorkflow.summary"),
      rows: [
        "startFrom",
        "displayName",
        "workflowId",
        "tenant",
        "defaultModel",
        "triggerType",
        "firstAgent",
        "template",
      ].map((id) => row(`workflowHelp.fields.newWorkflow.${id}`)),
    },
  ];

  return (
    <>
      <PageHeading
        eyebrow={t("workflowHelp.fields.eyebrow")}
        title={t("workflowHelp.fields.title")}
      >
        {t("workflowHelp.fields.intro")}
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
                        {t("workflowHelp.fields.whatToDo")}
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
  const { t } = useI18n();
  return (
    <>
      <PageHeading
        eyebrow={t("workflowHelp.examples.eyebrow")}
        title={t("workflowHelp.examples.title")}
      >
        {t("workflowHelp.examples.intro")}
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
          title={t("workflowHelp.examples.support.title")}
          goal={t("workflowHelp.examples.support.goal")}
          steps={[
            [t("workflowHelp.examples.support.step1"), "support.ticket.received"],
            [
              t("workflowHelp.examples.support.step2"),
              "support.ticket.classified",
            ],
            [t("workflowHelp.examples.support.step3"), "support.ticket.approved"],
            [t("workflowHelp.examples.support.step4"), "support.ticket.routed"],
          ]}
          tryIt={[
            t("workflowHelp.examples.support.try1"),
            t("workflowHelp.examples.support.try2"),
            t("workflowHelp.examples.support.try3"),
          ]}
          watch={t("workflowHelp.examples.support.watch")}
        />
        <ExampleCard
          number="02"
          title={t("workflowHelp.examples.invoice.title")}
          goal={t("workflowHelp.examples.invoice.goal")}
          steps={[
            [t("workflowHelp.examples.invoice.step1"), "invoice.received"],
            [t("workflowHelp.examples.invoice.step2"), "invoice.checked"],
            [t("workflowHelp.examples.invoice.step3"), "invoice.approved"],
            [t("workflowHelp.examples.invoice.step4"), "payment.scheduled"],
          ]}
          tryIt={[
            t("workflowHelp.examples.invoice.try1"),
            t("workflowHelp.examples.invoice.try2"),
            t("workflowHelp.examples.invoice.try3"),
          ]}
          watch={t("workflowHelp.examples.invoice.watch")}
        />
      </div>
      <Callout tone="blue" title={t("workflowHelp.examples.testTitle")}>
        {t("workflowHelp.examples.testBody")}
      </Callout>
    </>
  );
}

function TroubleshootingGuide() {
  const { t } = useI18n();
  const issues = [
    [
      t("workflowHelp.troubleshooting.emptyTitle"),
      t("workflowHelp.troubleshooting.emptyBody"),
    ],
    [
      t("workflowHelp.troubleshooting.neverStartsTitle"),
      t("workflowHelp.troubleshooting.neverStartsBody"),
    ],
    [
      t("workflowHelp.troubleshooting.nextBoxTitle"),
      t("workflowHelp.troubleshooting.nextBoxBody"),
    ],
    [
      t("workflowHelp.troubleshooting.publishDisabledTitle"),
      t("workflowHelp.troubleshooting.publishDisabledBody"),
    ],
    [
      t("workflowHelp.troubleshooting.draftFailedTitle"),
      t("workflowHelp.troubleshooting.draftFailedBody"),
    ],
    [
      t("workflowHelp.troubleshooting.publicationFailedTitle"),
      t("workflowHelp.troubleshooting.publicationFailedBody"),
    ],
    [
      t("workflowHelp.troubleshooting.draftReturnedTitle"),
      t("workflowHelp.troubleshooting.draftReturnedBody"),
    ],
    [
      t("workflowHelp.troubleshooting.wrongThingTitle"),
      t("workflowHelp.troubleshooting.wrongThingBody"),
    ],
  ];

  return (
    <>
      <PageHeading
        eyebrow={t("workflowHelp.troubleshooting.eyebrow")}
        title={t("workflowHelp.troubleshooting.title")}
      >
        {t("workflowHelp.troubleshooting.intro")}
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
      <Callout
        tone="red"
        title={t("workflowHelp.troubleshooting.stopTitle")}
      >
        {t("workflowHelp.troubleshooting.stopBody")}
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
  const { t } = useI18n();
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
        {t("workflowHelp.exampleLabel", { number })}
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
                  {index === 0
                    ? t("workflowHelp.startsWith", { event })
                    : t("workflowHelp.emits", { event })}
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
      <h4 style={{ margin: "14px 0 5px", fontSize: 11.5 }}>
        {t("workflowHelp.tryTrace")}
      </h4>
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
        <strong>{t("workflowHelp.watchOut")}</strong> {watch}
      </div>
    </article>
  );
}
