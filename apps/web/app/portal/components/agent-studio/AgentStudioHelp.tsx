"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Badge, Icon, ModalOverlay } from "@/app/portal/components";

export type AgentStudioHelpTopic =
  | "start"
  | "lifecycle"
  | "fields"
  | "testing"
  | "examples"
  | "glossary";

export interface AgentStudioHelpProps {
  /** Controls whether the guide is visible. */
  open: boolean;
  /** Called by the close button, Escape key, or backdrop click. */
  onClose: () => void;
  /** Optional page to show whenever the guide opens. */
  initialTopic?: AgentStudioHelpTopic;
}

interface HelpField {
  name: string;
  meaning: string;
  enter: string;
  example?: string;
  caution?: string;
}

interface HelpFieldGroup {
  title: string;
  summary: string;
  fields: HelpField[];
}

const TOPICS: Array<{
  id: AgentStudioHelpTopic;
  label: string;
  eyebrow: string;
}> = [
  { id: "start", label: "Start here", eyebrow: "5 minute tour" },
  { id: "lifecycle", label: "Create & publish", eyebrow: "Safe workflow" },
  { id: "fields", label: "Every field", eyebrow: "Plain-language reference" },
  { id: "testing", label: "Test & operate", eyebrow: "Runs and history" },
  { id: "examples", label: "Worked examples", eyebrow: "Copy the pattern" },
  { id: "glossary", label: "Glossary", eyebrow: "Terms decoded" },
];

const FIELD_GROUPS: HelpFieldGroup[] = [
  {
    title: "Overview",
    summary: "The name and purpose people see when they browse agents.",
    fields: [
      {
        name: "Display name",
        meaning: "The friendly name shown in the portal.",
        enter: "A short name that says what the agent does.",
        example: "Support Ticket Classifier",
      },
      {
        name: "Programmatic name",
        meaning:
          "The permanent technical identifier used by integrations and past runs.",
        enter: "Nothing while editing—it is intentionally read-only.",
        example: "supportTicketClassifier",
        caution:
          "Changing a label is safe; this identifier stays fixed so links and history do not break.",
      },
      {
        name: "Purpose",
        meaning: "A one-paragraph explanation for operators.",
        enter:
          "Who the agent helps, what it does, and what a good result looks like.",
        example:
          "Classifies incoming support tickets and recommends the correct queue.",
      },
      {
        name: "Owner type",
        meaning: "Whether this work runs automatically or pauses for a person.",
        enter:
          "Choose AI agent for model-driven work; Human task for work completed by an operator.",
      },
      {
        name: "Stage",
        meaning: "The column or phase where the agent appears in a workflow.",
        enter: "A whole number. Lower numbers normally appear earlier.",
        example: "2",
      },
      {
        name: "Starting template",
        meaning: "A starting pattern for the agent.",
        enter:
          "Blank, classify, extract, Deep Search, loop, or human. It is a design hint; review every generated setting.",
      },
      {
        name: "Edit",
        meaning:
          "Unlocks a safe draft for changes. If only a live version exists, Studio creates the draft automatically.",
        enter: "Choose Edit whenever the header says View mode.",
      },
      {
        name: "Save / Done / Cancel",
        meaning:
          "Save stores a checkpoint; Done saves and returns to View mode; Cancel restores the start of the current edit session.",
        enter:
          "Use Done when you finish. Use Cancel only when you want to reverse this session's changes; Studio asks first.",
        caution:
          "Cancel also safely reverses changes already stored by autosave. None of these actions publishes.",
      },
      {
        name: "Autosave",
        meaning:
          "Saves your draft shortly after you stop typing while Edit mode is open.",
        enter:
          "Keep it on for normal editing, or use Save whenever you want an immediate checkpoint.",
        caution: "Autosave never publishes the draft.",
      },
    ],
  },
  {
    title: "Instructions",
    summary:
      "What the model is responsible for and how the user request is assembled.",
    fields: [
      {
        name: "Agent instructions",
        meaning:
          "The agent's standing role, goal, rules, limits, and required response behavior.",
        enter:
          "Write direct instructions: role, objective, method, output rules, and what to do when information is missing.",
        example:
          "You classify support tickets. Choose exactly one category and explain the choice in one sentence.",
      },
      {
        name: "Write for me",
        meaning:
          "Asks AI to draft agent instructions from the current definition.",
        enter: "Use for a first draft, then review it carefully before saving.",
      },
      {
        name: "Improve",
        meaning: "Rewrites existing instructions for clarity and completeness.",
        enter:
          "Use after writing the main intent; check that the meaning did not change.",
      },
      {
        name: "Make shorter",
        meaning: "Makes instructions more concise.",
        enter:
          "Use when instructions repeat themselves. Recheck important rules afterward.",
      },
      {
        name: "Add safety rules",
        meaning: "Proposes safety, privacy, and uncertainty rules.",
        enter:
          "Use as a review aid, especially for agents using sensitive data or tools.",
      },
      {
        name: "Extra user-message context",
        meaning: "Adds structured context around the user's chat message.",
        enter:
          "Usually leave it simple. Reference declared inputs with template expressions such as {{json inputs.context}}.",
        example: "Customer context:\n{{json inputs.customer_context}}",
        caution:
          "The Chat request input is inserted automatically as the user message; do not copy it into agent instructions.",
      },
    ],
  },
  {
    title: "Inputs",
    summary:
      "The information a person, event, or API must provide to start a run.",
    fields: [
      {
        name: "Internal field name",
        meaning: "The stable key used in templates and integrations.",
        enter: "A short technical name without spaces, such as customer_tier.",
        example: "customer_tier",
        caution:
          "The one Chat request input always uses the reserved ID prompt.",
      },
      {
        name: "Question shown to users",
        meaning: "The friendly label shown in Test Lab forms.",
        enter: "A short label a user will understand.",
        example: "Customer tier",
      },
      {
        name: "How this input is provided",
        meaning: "How the runtime treats the input.",
        enter:
          "Chat request for the main user message, Form value for separate text/numbers/objects, or File upload for attachments.",
        caution: "An AI agent must have exactly one Chat request input.",
      },
      {
        name: "Privacy level",
        meaning: "How carefully traces and stored values should be handled.",
        enter:
          "Normal, Personal, Confidential, or Secret. Choose the strictest accurate level.",
      },
      {
        name: "Help text for this field",
        meaning: "Guidance that explains the input.",
        enter:
          "Say what to provide, expected units or format, and where it comes from.",
        example:
          "The customer's support plan: standard, premium, or enterprise.",
      },
      {
        name: "Require this input",
        meaning: "Prevents a run from starting when the value is missing.",
        enter:
          "Turn on only when the agent cannot produce a useful result without it.",
      },
      {
        name: "Type of information",
        meaning:
          "The basic text, number, yes/no, list, or object format this field accepts.",
        enter:
          "Choose the simple type. Open Advanced validation rules only for allowed choices, limits, or nested data.",
      },
      {
        name: "Advanced validation rules",
        meaning: "Optional JSON Schema rules for a more exact data shape.",
        enter:
          'For simple text use {"type":"string"}; ask a technical user before changing unfamiliar rules.',
        example: '{"type":"string","enum":["standard","premium","enterprise"]}',
      },
      {
        name: "Pre-filled value",
        meaning:
          "A value filled in automatically when the caller does not provide one.",
        enter:
          "Use a realistic safe default, or null when there should be no default.",
        caution:
          "A default can hide missing data; do not use one for information that must be supplied.",
      },
      {
        name: "Example shown to builders",
        meaning: "A sample that helps people understand and test the field.",
        enter: "Use plausible, non-sensitive sample data.",
      },
      {
        name: "Allowed file types",
        meaning: "Which uploaded file formats are accepted.",
        enter:
          "Comma-separated MIME types such as application/pdf, text/plain.",
        example: "application/pdf, text/plain",
      },
      {
        name: "Maximum file size",
        meaning: "The largest accepted upload size.",
        enter: "A whole number of bytes. 10,000,000 is about 10 MB.",
        example: "10000000",
      },
      {
        name: "Allow more than one file",
        meaning: "Whether one input can contain several uploads.",
        enter:
          "Turn on only when the agent and its tools are designed to process a collection.",
      },
    ],
  },
  {
    title: "Outputs and saved files",
    summary: "The promised result shape and which run records are retained.",
    fields: [
      {
        name: "Output internal field name",
        meaning: "The stable key for one named result.",
        enter: "Use a short name such as category, summary, or next_actions.",
      },
      {
        name: "Output question shown to users",
        meaning: "The human-friendly name for the result.",
        enter: "Use words an operator recognizes, such as Recommended queue.",
      },
      {
        name: "Output privacy level",
        meaning: "The sensitivity level of this result.",
        enter:
          "Classify the output based on the most sensitive information it may contain.",
      },
      {
        name: "Output help text",
        meaning: "Explains what a correct value represents.",
        enter: "Describe meaning, units, and any allowed values.",
      },
      {
        name: "Require this output",
        meaning: "Makes the run fail validation if the result is absent.",
        enter: "Turn on for every result downstream users or systems rely on.",
      },
      {
        name: "Output JSON Schema",
        meaning: "The type and shape the model result must match.",
        enter:
          "Start with a simple type; add enum, properties, or required only when useful.",
        example: '{"type":"string","enum":["billing","technical","account"]}',
      },
      {
        name: "Example shown to builders (Outputs)",
        meaning: "A sample valid result.",
        enter:
          "Use it to make the contract concrete for reviewers and testers.",
      },
      {
        name: "Output file name",
        meaning: "The name of the aggregate JSON result saved after a run.",
        enter: "A clear filename ending in .json.",
        example: "ticket-classification.json",
      },
      {
        name: "Automatic correction attempts",
        meaning:
          "How many times the runtime may ask the model to fix output that does not match the schema.",
        enter: "Use 1 for most agents; 0 disables correction; maximum is 3.",
        caution:
          "More attempts can improve reliability but add time and model cost.",
      },
      {
        name: "Require the declared output format",
        meaning:
          "Fails a run when the model cannot produce the declared output fields.",
        enter:
          "Keep on when callers or workflows depend on a predictable result.",
      },
      {
        name: "Return a single output directly",
        meaning:
          "Returns the value directly when the agent declares only one output.",
        enter:
          "Turn on for a simpler caller response; the complete JSON file is still saved.",
      },
      {
        name: "Save each output as a separate file",
        meaning:
          "Saves each output separately in addition to the aggregate JSON file.",
        enter:
          "Turn on when downstream consumers need individual output files.",
      },
      {
        name: "Save the run's inputs",
        meaning: "Stores the structured values used for reproducibility.",
        enter:
          "Usually on. Turn off only when retention policy requires it and reproducibility is less important.",
      },
      {
        name: "Always save run details",
        meaning:
          "Stores version, timing, validation, usage, artifacts, and emitted events.",
        enter: "Always on; it is required for traceability.",
      },
      {
        name: "Save the model's unprocessed response",
        meaning: "Stores the model text before output validation and cleanup.",
        enter:
          "Leave off in normal use. Turn on temporarily for approved debugging.",
        caution: "Raw text may contain sensitive or unwanted content.",
      },
    ],
  },
  {
    title: "Steps — common fields",
    summary:
      "The ordered plan the agent follows. The screenshot in this guide shows these fields.",
    fields: [
      {
        name: "Order",
        meaning: "Where the step runs in the sequence.",
        enter:
          "Use 1, 2, 3, and so on. Move up/down is safer than manually renumbering.",
      },
      {
        name: "Stable step ID",
        meaning: "A permanent reference used by branches and traces.",
        enter: "Use a unique technical name, such as classify_ticket.",
        caution:
          "Avoid changing it after conditions or integrations refer to it.",
      },
      {
        name: "Step name",
        meaning: "A readable name shown in traces.",
        enter: "Use a verb and object, such as Classify ticket.",
      },
      {
        name: "Type",
        meaning: "What kind of work happens in the step.",
        enter:
          "AI / logic, Tool, Human task, Condition, Delay (preview), or Subflow (preview).",
      },
      {
        name: "Description",
        meaning: "A plain-language explanation of the step's purpose.",
        enter: "Describe the intended outcome, not implementation details.",
      },
      {
        name: "Step prompt",
        meaning: "Extra model instructions that apply only to this AI step.",
        enter:
          "State the local task and constraints. Leave blank if the Agent instructions already cover it.",
      },
      {
        name: "Input mapping",
        meaning: "Selects or renames values supplied to this step.",
        enter:
          "Leave {} when the step can use normal inputs. Advanced users can map named values explicitly.",
        example: '{"ticket":"inputs.prompt"}',
      },
      {
        name: "Output mapping",
        meaning: "Routes this step's result to named values for later use.",
        enter: "Leave {} unless a later step or output needs an explicit name.",
        example: '{"classification":"lastResult"}',
      },
    ],
  },
  {
    title: "Steps — type-specific fields",
    summary: "Fields that appear only after choosing a particular step type.",
    fields: [
      {
        name: "AI retry attempts",
        meaning: "Retries only this model step after a model error.",
        enter:
          "Usually 0–2. Tools are never retried automatically because they may cause duplicate effects.",
      },
      {
        name: "AI step time limit",
        meaning: "Maximum seconds allowed for this model step.",
        enter:
          "Use enough time for the expected task; 120 seconds is a reasonable starting point.",
      },
      {
        name: "Tool name",
        meaning: "The exact allowed tool executed by a Tool step.",
        enter:
          "Copy the name from the Tools catalog and also allow that tool in the Tools section.",
      },
      {
        name: "Task instructions",
        meaning: "What the assigned person must decide or enter.",
        enter:
          "Give the decision, evidence to review, and completion criteria.",
      },
      {
        name: "Task type",
        meaning: "A label describing the human task.",
        enter: "Use approval, review, correction, or another team convention.",
      },
      {
        name: "Awaiting role",
        meaning: "The operator role responsible for the task.",
        enter: "Use a configured role such as operator or compliance-reviewer.",
      },
      {
        name: "Human response form schema",
        meaning: "The fields the person completes.",
        enter:
          "Define a small JSON object with clearly labeled required answers.",
      },
      {
        name: "Condition expression",
        meaning: "A restricted yes/no test used to choose the next step.",
        enter:
          "Compare an input or previous result, such as inputs.score >= 70.",
        example: "lastResult.approved == true",
      },
      {
        name: "When true / When false",
        meaning: "The next step for each condition outcome.",
        enter: "Choose a later step, or continue to the next step.",
      },
      {
        name: "Delay (milliseconds)",
        meaning: "A planned wait duration.",
        enter: "Enter milliseconds, such as 60000 for one minute.",
        caution:
          "Preview only: it is traced but production does not wait on a durable timer yet.",
      },
      {
        name: "Subflow agent or event",
        meaning: "The planned workflow or agent to start.",
        enter: "Use its configured agent or event name.",
        caution:
          "Preview only: production validates and traces it but does not invoke it yet.",
      },
      {
        name: "Wait policy",
        meaning:
          "Whether to wait for a subflow result or continue immediately.",
        enter:
          "Choose Wait for completion or Start and continue. This is retained for future durable execution.",
      },
      {
        name: "Subflow input",
        meaning: "Values intended for the subflow.",
        enter: "Enter a JSON object whose keys match the target inputs.",
      },
    ],
  },
  {
    title: "Tools",
    summary: "The explicit permission list for actions outside the model.",
    fields: [
      {
        name: "Search tool catalog",
        meaning: "Finds tools available in this Agentic Operator installation.",
        enter:
          "Search by action or system name, then read the tool description.",
      },
      {
        name: "Allow tool / Remove permission",
        meaning: "Adds or removes the agent's permission to call a tool.",
        enter: "Allow only tools the agent actually needs.",
        caution:
          "The allow-list is a security boundary, not just a convenience list.",
      },
      {
        name: "Tool settings",
        meaning: "Non-secret settings a tool needs for this workspace.",
        enter:
          "Use the documented keys shown below the editor. Reference credential environment variables where supported; never paste secrets into prompts.",
      },
    ],
  },
  {
    title: "Runtime — model",
    summary: "Which model runs and how it generates a response.",
    fields: [
      {
        name: "AI provider",
        meaning: "The model service used by the agent.",
        enter:
          "Use the workspace default unless there is an approved reason to override it.",
      },
      {
        name: "AI model",
        meaning: "The provider's model identifier.",
        enter:
          "Leave blank to inherit the workspace model, or enter an available model name.",
      },
      {
        name: "Creativity",
        meaning: "How varied model responses may be.",
        enter:
          "Use 0–0.3 for extraction/classification, around 0.5–0.8 for writing, and test before going higher.",
        example: "0.2",
      },
      {
        name: "Maximum answer length",
        meaning: "Upper limit on generated response length.",
        enter:
          "Set enough for the output schema, without allowing unnecessarily long responses.",
        example: "2000",
      },
    ],
  },
  {
    title: "Runtime — reliability, capacity, and records",
    summary: "Limits that keep runs safe, useful, and observable.",
    fields: [
      {
        name: "Run time limit",
        meaning: "Maximum duration allowed for an agent run.",
        enter:
          "Start with 120 seconds; increase only for known long-running work.",
      },
      {
        name: "Retry attempts",
        meaning:
          "How many times the agent run may be retried after eligible failures.",
        enter: "Use 1–3 for most agents.",
        caution:
          "Be careful when tools can write or send; side effects should be idempotent.",
      },
      {
        name: "Maximum tool turns",
        meaning: "Maximum number of model-to-tool cycles in one run.",
        enter:
          "Use a modest limit such as 4–8 to prevent loops and unexpected cost.",
      },
      {
        name: "Runs at the same time",
        meaning:
          "Maximum number of runs allowed at the same time for a concurrency group.",
        enter:
          "Choose a limit that providers and downstream services can safely handle.",
      },
      {
        name: "Group runs by",
        meaning: "Groups runs that share a limit.",
        enter:
          "Use a stable grouping key, commonly a subject or customer identifier; leave blank when no special grouping is needed.",
      },
      {
        name: "Limit simultaneous runs",
        meaning: "Turns the configured traffic protection on.",
        enter:
          "Keep on for agents that may receive bursts or call limited services.",
      },
      {
        name: "Run detail level",
        meaning: "How much operational detail is recorded.",
        enter:
          "Standard for normal use, Minimal for lower retention, Debug temporarily during approved troubleshooting.",
      },
      {
        name: "Capture reasoning summaries",
        meaning: "Stores short, user-visible explanations of model decisions.",
        enter: "Usually on. The system never exposes hidden chain-of-thought.",
      },
      {
        name: "Save final prompts for troubleshooting",
        meaning: "Stores the final prompts after templates are filled.",
        enter: "Leave off unless needed for approved debugging.",
        caution: "Final prompts can contain sensitive input values.",
      },
      {
        name: "Keep run details for",
        meaning: "How many days Studio observability data is kept.",
        enter: "Follow your organization's data and audit policy.",
        example: "30",
      },
    ],
  },
  {
    title: "Schedule and workflow events",
    summary: "When the agent starts and what it sends downstream.",
    fields: [
      {
        name: "Schedule",
        meaning: "A repeating time schedule.",
        enter:
          "Use five-part cron, such as 0 9 * * 1-5 for 9:00 on weekdays. Leave blank for no schedule.",
      },
      {
        name: "Schedule timezone",
        meaning: "The region used to interpret the schedule.",
        enter:
          "Use an IANA timezone such as Asia/Singapore, not an abbreviation such as SGT.",
      },
      {
        name: "Events that start this agent",
        meaning: "Events that can start this agent.",
        enter:
          "Enter one event name per line (or comma-separated), exactly as registered.",
      },
      {
        name: "How event data fills inputs",
        meaning: "Maps incoming event fields to agent inputs.",
        enter:
          "Enter a JSON object. Leave {} when names already match or the event needs no mapping.",
        example: '{"customer_tier":"event.data.tier"}',
      },
      {
        name: "Events sent after success",
        meaning: "Events sent after the agent succeeds.",
        enter:
          "Enter registered event names that downstream workflows understand.",
      },
      {
        name: "What each outgoing event contains",
        meaning: "Builds each outgoing event payload from named outputs.",
        enter:
          "Map event fields to output paths; use the workflow editor to check downstream impact.",
        example: '{"ticket.classified":{"category":"outputs.category"}}',
      },
    ],
  },
  {
    title: "Test Lab controls",
    summary:
      "One-off test settings; these do not permanently change the agent definition.",
    fields: [
      {
        name: "Draft / Live",
        meaning: "Chooses the definition version to run.",
        enter:
          "Draft tests your saved edits; Live tests the currently published version.",
      },
      {
        name: "What should the agent do?",
        meaning: "The request sent as the agent's Chat request input.",
        enter:
          "Write a realistic request. It is inserted automatically as the user message.",
      },
      {
        name: "Input variables — Form / All test inputs (JSON)",
        meaning: "Two views of the same non-prompt inputs.",
        enter:
          "Use Form for normal testing; All test inputs is convenient for pasting a complete JSON object.",
      },
      {
        name: "What tools may change",
        meaning: "Controls what tools may do during this test.",
        enter:
          "Start with Safe test. Read-only permits approved reads but blocks writes. Live effects allows configured real changes.",
        caution:
          "Use Live effects only when you understand every allowed tool and intend its real-world changes.",
      },
      {
        name: "Temporary AI provider / Temporary AI model",
        meaning: "Temporarily tests another model setup.",
        enter: "Leave blank to use the agent/workspace settings.",
      },
      {
        name: "Temporary creativity / Temporary answer length / Temporary time limit",
        meaning: "Temporarily changes generation limits for this run.",
        enter:
          "Leave blank for the agent defaults; use positive whole numbers for answer length and time limit.",
      },
      {
        name: "Trace",
        meaning:
          "Chronological sequence of steps, tool decisions, and safe reasoning summaries.",
        enter: "Read it to find where a run slowed down or failed.",
      },
      {
        name: "Output",
        meaning: "The final schema-validated JSON result.",
        enter: "Check both the values and the Schema valid badge.",
      },
      {
        name: "Logs",
        meaning: "Technical runtime messages for troubleshooting.",
        enter: "Use after the Trace identifies a failing area.",
      },
      {
        name: "Artifacts",
        meaning:
          "Files retained by the run, including the aggregate output JSON.",
        enter: "Open or download them only according to your data policy.",
      },
      {
        name: "Run history",
        meaning: "Previous test runs for this agent.",
        enter:
          "Select a run to review its prompt preview, status, duration, trace, output, logs, and artifacts.",
      },
    ],
  },
  {
    title: "Versions and Developer view",
    summary: "Audit history and expert-only escape hatches.",
    fields: [
      {
        name: "Versions",
        meaning: "Immutable published definitions.",
        enter:
          "Use the version list to identify what was live for a past run. Publishing creates a new entry.",
      },
      {
        name: "Complete definition (developer JSON)",
        meaning: "The complete JSON source edited by Guided mode.",
        enter:
          "Use only when comfortable with the manifest contract; keep the Valid definition badge green.",
        caution:
          "A syntactically valid JSON object can still fail agent validation.",
      },
      {
        name: "TypeScript reference (documentation only)",
        meaning:
          "A documentation field reserved for specialized code-defined agents.",
        enter:
          "Leave blank unless your engineering team owns the accompanying code-defined agent.",
        caution:
          "Text entered here is stored, but publishing it does not deploy or execute code.",
      },
    ],
  },
];

const GLOSSARY = [
  [
    "Agent",
    "A configured worker that receives inputs, follows instructions and steps, and produces validated outputs.",
  ],
  [
    "Artifact",
    "A file retained from a run, such as output.json or an individual named output.",
  ],
  [
    "Draft",
    "A safe working copy. It is protected in View mode and unlocked only while Edit mode is on; saving never changes the live agent.",
  ],
  [
    "View mode",
    "The protected default state for inspecting, testing, validating, or publishing without accidentally changing fields.",
  ],
  [
    "Edit mode",
    "The state that unlocks a draft for changes. Save and Done keep the changes; Cancel restores the start of the edit session.",
  ],
  [
    "Event",
    "A named message that can start an agent or notify a downstream workflow.",
  ],
  [
    "Input / output contract",
    "The declared data shape callers provide and the result shape the agent promises.",
  ],
  [
    "JSON",
    "A structured text format made of objects, lists, text, numbers, true/false, and null.",
  ],
  [
    "JSON Schema",
    "A set of rules that validates the type and shape of JSON data.",
  ],
  ["Live", "The currently published, operational agent version."],
  [
    "Manifest",
    "The complete machine-readable definition of agents and workflow behavior.",
  ],
  [
    "Generated manifest",
    "A safe editable starting draft Agent Studio creates when an older agent has identity data but no usable saved manifest.",
  ],
  [
    "Compatibility view",
    "A read-only current-format view of code-defined metadata. It does not replace or reproduce the source-code behavior.",
  ],
  [
    "Chat request",
    "The user's request. Agent Studio automatically sends the declared prompt input as the AI model's user message.",
  ],
  [
    "Provider / model",
    "The AI service and the particular model used to generate a response.",
  ],
  [
    "Reasoning summary",
    "A concise, safe explanation of a model decision. It is not hidden chain-of-thought.",
  ],
  [
    "Run",
    "One execution of one pinned agent version with a particular set of inputs.",
  ],
  [
    "Agent instructions",
    "Standing directions that define the agent's role, rules, and response behavior.",
  ],
  [
    "Tool",
    "An approved capability that can read data or take an action outside the language model.",
  ],
  [
    "Trace",
    "The time-ordered record of steps and important runtime decisions for a run.",
  ],
  [
    "Validation",
    "Checks that the definition, inputs, and outputs match their required contracts.",
  ],
  [
    "Version",
    "An immutable published snapshot. Past runs remain linked to the version they used.",
  ],
] as const;

export function AgentStudioHelp({
  open,
  onClose,
  initialTopic = "start",
}: AgentStudioHelpProps) {
  const titleId = useId();
  const descriptionId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [topic, setTopic] = useState<AgentStudioHelpTopic>(initialTopic);
  const [fieldSearch, setFieldSearch] = useState("");

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
          'button:not([disabled]), input:not([disabled]), a[href], summary, [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((element) => !element.hasAttribute("hidden"));
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

  const filteredGroups = useMemo(() => {
    const query = fieldSearch.trim().toLocaleLowerCase();
    if (!query) return FIELD_GROUPS;
    return FIELD_GROUPS.map((group) => ({
      ...group,
      fields: group.fields.filter((field) =>
        `${group.title} ${field.name} ${field.meaning} ${field.enter} ${field.example ?? ""}`
          .toLocaleLowerCase()
          .includes(query),
      ),
    })).filter((group) => group.fields.length > 0);
  }, [fieldSearch]);

  if (!open) return null;

  return (
    <ModalOverlay onClose={onClose} ariaLabelledBy={titleId}>
      <div
        ref={panelRef}
        className="agent-studio-help-shell"
        aria-describedby={descriptionId}
        style={{
          width: "min(1180px, calc(100vw - 40px))",
          height: "min(820px, calc(100vh - 40px))",
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
              border: "1px solid rgba(208,255,0,0.35)",
              borderRadius: 6,
              color: "var(--signal)",
              background: "rgba(208,255,0,0.06)",
            }}
          >
            <Icon name="agent" size={16} />
          </div>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <h1
                id={titleId}
                style={{ margin: 0, fontSize: 15, fontWeight: 600 }}
              >
                Agent Studio guide
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
              Create, edit, test, publish, and operate an agent safely—no coding
              required.
            </p>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Close Agent Studio guide"
            title="Close guide (Escape)"
            style={{
              width: 30,
              height: 30,
              display: "grid",
              placeItems: "center",
              color: "var(--text-2)",
              border: "1px solid var(--border-2)",
              borderRadius: 5,
              background: "transparent",
            }}
          >
            <Icon name="x" size={13} />
          </button>
        </header>

        <div
          className="agent-studio-help-layout"
          style={{
            minHeight: 0,
            display: "grid",
            gridTemplateColumns: "230px minmax(0, 1fr)",
          }}
        >
          <nav
            aria-label="Agent Studio help topics"
            className="agent-studio-help-nav"
            style={{
              minHeight: 0,
              overflow: "auto",
              padding: 10,
              borderRight: "1px solid var(--border)",
              background: "var(--bg-2)",
            }}
          >
            <div
              className="mono"
              style={{
                padding: "4px 8px 9px",
                color: "var(--text-4)",
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
                  onClick={() => setTopic(item.id)}
                  style={{
                    width: "100%",
                    padding: "9px 9px",
                    display: "grid",
                    gridTemplateColumns: "22px minmax(0, 1fr)",
                    gap: 7,
                    textAlign: "left",
                    color: active ? "var(--text)" : "var(--text-2)",
                    borderLeft: `2px solid ${active ? "var(--signal)" : "transparent"}`,
                    borderRadius: 4,
                    background: active ? "var(--panel-3)" : "transparent",
                  }}
                >
                  <span
                    className="mono"
                    style={{
                      color: active ? "var(--signal)" : "var(--text-4)",
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
                        color: "var(--text-4)",
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
                border: "1px solid var(--border)",
                borderRadius: 5,
                color: "var(--text-3)",
                background: "var(--panel-2)",
                fontSize: 10.5,
                lineHeight: 1.5,
              }}
            >
              <strong style={{ color: "var(--text-2)" }}>Safe default</strong>
              <br />
              Create a draft, test with Safe test tool effects, check the setup,
              then publish.
            </div>
          </nav>

          <main
            className="agent-studio-help-content"
            style={{
              minWidth: 0,
              overflow: "auto",
              padding: "24px clamp(18px, 4vw, 44px) 48px",
            }}
          >
            <div style={{ maxWidth: 860, margin: "0 auto" }}>
              {topic === "start" && <StartHere onNavigate={setTopic} />}
              {topic === "lifecycle" && <LifecycleGuide />}
              {topic === "fields" && (
                <FieldReference
                  search={fieldSearch}
                  onSearch={setFieldSearch}
                  groups={filteredGroups}
                />
              )}
              {topic === "testing" && <TestingGuide />}
              {topic === "examples" && <ExamplesGuide />}
              {topic === "glossary" && <GlossaryGuide />}
            </div>
          </main>
        </div>
      </div>
      <style>{`
        @media (max-width: 760px) {
          .agent-studio-help-shell {
            width: calc(100vw - 16px) !important;
            height: calc(100vh - 16px) !important;
          }
          .agent-studio-help-layout {
            grid-template-columns: 1fr !important;
            grid-template-rows: auto minmax(0, 1fr);
          }
          .agent-studio-help-nav {
            display: flex;
            gap: 4px;
            overflow-x: auto !important;
            border-right: 0 !important;
            border-bottom: 1px solid var(--border);
          }
          .agent-studio-help-nav > div { display: none; }
          .agent-studio-help-nav > button {
            width: auto !important;
            min-width: max-content;
            grid-template-columns: auto 1fr !important;
          }
          .agent-studio-help-nav > button span span:last-child { display: none !important; }
          .agent-studio-help-content { padding: 18px 14px 36px !important; }
          .agent-studio-help-cards,
          .agent-studio-help-example-grid { grid-template-columns: 1fr !important; }
          .agent-studio-help-field-row { grid-template-columns: 1fr !important; gap: 5px !important; }
        }
      `}</style>
    </ModalOverlay>
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

function StartHere({
  onNavigate,
}: {
  onNavigate: (topic: AgentStudioHelpTopic) => void;
}) {
  const tour = [
    ["Describe", "Give the agent a clear name and one-sentence purpose."],
    ["Instruct", "Tell it its role, rules, and required response behavior."],
    [
      "Contract",
      "Define what comes in and the exact JSON result that must come out.",
    ],
    [
      "Test",
      "Run the saved draft with realistic inputs and inspect the trace and output.",
    ],
    [
      "Publish",
      "Validate, review downstream impact, and create a new live version.",
    ],
  ];
  return (
    <>
      <PageHeading
        eyebrow="Start here"
        title="Build an agent in five decisions"
      >
        Agent Studio separates an editable draft from the live version, so you
        can experiment without changing production behavior.
      </PageHeading>
      <div style={{ display: "grid", gap: 8 }}>
        {tour.map(([title, body], index) => (
          <div
            key={title}
            style={{
              padding: 13,
              display: "grid",
              gridTemplateColumns: "32px minmax(0, 1fr)",
              gap: 12,
              border: "1px solid var(--border)",
              borderRadius: 6,
              background: "var(--panel-2)",
            }}
          >
            <div
              className="mono"
              style={{
                width: 28,
                height: 28,
                display: "grid",
                placeItems: "center",
                color: "var(--signal)",
                border: "1px solid rgba(208,255,0,0.3)",
                borderRadius: 4,
              }}
            >
              {index + 1}
            </div>
            <div>
              <strong style={{ display: "block", fontSize: 12 }}>
                {title}
              </strong>
              <span
                style={{
                  display: "block",
                  marginTop: 3,
                  color: "var(--text-3)",
                  fontSize: 11.5,
                  lineHeight: 1.5,
                }}
              >
                {body}
              </span>
            </div>
          </div>
        ))}
      </div>
      <Callout tone="blue" title="The prompt is automatic">
        The input marked <strong>Chat request</strong> becomes the AI model's
        user message. Keep permanent rules in Agent instructions and put each
        user's request in Test Lab.
      </Callout>
      <div
        className="agent-studio-help-cards"
        style={{
          marginTop: 18,
          display: "grid",
          gridTemplateColumns: "repeat(3, 1fr)",
          gap: 10,
        }}
      >
        <JumpCard
          title="Need a field explained?"
          body="Search every editor label in plain language."
          action="Open field reference"
          onClick={() => onNavigate("fields")}
        />
        <JumpCard
          title="Ready to try it?"
          body="Learn the safe Draft → Test → Check setup sequence."
          action="Open test guide"
          onClick={() => onNavigate("testing")}
        />
        <JumpCard
          title="Prefer an example?"
          body="Follow a classifier or summarizer end to end."
          action="Open examples"
          onClick={() => onNavigate("examples")}
        />
      </div>
    </>
  );
}

function LifecycleGuide() {
  return (
    <>
      <PageHeading
        eyebrow="Create & publish"
        title="A safe path from idea to live agent"
      >
        Drafts are working copies; versions are permanent snapshots. This makes
        edits testable, reviewable, and traceable.
      </PageHeading>
      <Callout tone="blue" title="When you open an older agent">
        Agent Studio automatically translates an older saved manifest into the
        current format. If no usable manifest exists, it creates a starter draft
        from the agent's saved identity and event triggers. Review every
        generated field and test before publishing. A code-defined agent instead
        opens as a read-only Compatibility view because its source-code behavior
        cannot be reconstructed safely from metadata.
      </Callout>
      <GuideSection number="01" title="Create a new agent">
        <ol style={listStyle}>
          <li>
            Open <strong>Agents</strong> and choose <strong>New Agent</strong>.
          </li>
          <li>
            Pick an execution pattern. Blank agent is best when unsure;
            Classifier, Extractor, and Deep Search provide focused starting
            plans.
          </li>
          <li>
            Complete Identity, Events, Build, and Runtime. Review the event
            contract, model policy, ontology access, and pre-flight checks.
          </li>
          <li>
            Choose <strong>Create &amp; publish</strong>, then open the live
            agent to test it in Agent Studio.
          </li>
        </ol>
        <Callout tone="amber" title="Creating immediately makes a version live">
          Use conservative tools and runtime settings in the creation wizard.
          Refine it safely as a draft afterward.
        </Callout>
      </GuideSection>
      <GuideSection number="02" title="Edit without changing live behavior">
        <ol style={listStyle}>
          <li>
            Open the agent in protected <strong>View mode</strong> and choose{" "}
            <strong>Edit</strong>. Studio uses the existing draft or creates one
            safely from the live version.
          </li>
          <li>
            Work through Overview, Instructions, Inputs, Outputs, Steps, Tools,
            Runtime, and Workflow.
          </li>
          <li>
            Autosave waits briefly after each change. The header says{" "}
            <strong>saved</strong> when the revision is stored; use{" "}
            <strong>Save</strong> when you need an immediate checkpoint.
          </li>
          <li>
            Choose <strong>Done</strong> to save and return to View mode. Choose{" "}
            <strong>Cancel</strong> to restore the draft to the start of this
            edit session, including safely reversing autosaved changes.
          </li>
          <li>
            Resolve red items in <strong>Definition health</strong>. Warnings
            deserve review but do not always block publishing.
          </li>
        </ol>
      </GuideSection>
      <GuideSection number="03" title="Test the saved draft">
        <ol style={listStyle}>
          <li>
            Open Test Lab and select <strong>Draft</strong>.
          </li>
          <li>Enter a realistic prompt and all required variables.</li>
          <li>
            Keep tool effects on <strong>Safe test</strong> for the first run.
          </li>
          <li>
            Run, then inspect Trace, Output, Logs, and Artifacts. Test both a
            normal case and a difficult or incomplete case.
          </li>
        </ol>
      </GuideSection>
      <GuideSection number="04" title="Validate and publish">
        <ol style={listStyle}>
          <li>
            Choose <strong>Check setup</strong>. Fix every blocking error.
          </li>
          <li>
            Review event, input, output, and tool changes with affected workflow
            owners.
          </li>
          <li>
            Choose <strong>Publish</strong> and read the impact confirmation.
            Confirm only when the change is intentional.
          </li>
          <li>
            The new immutable version becomes Live. Existing in-flight runs
            continue on the version they started with.
          </li>
        </ol>
      </GuideSection>
      <Callout tone="green" title="Recommended release check">
        Normal case passes · incomplete input behaves safely · output says
        Schema valid · tools have only intended effects · downstream event
        contract is reviewed.
      </Callout>
    </>
  );
}

function FieldReference({
  search,
  onSearch,
  groups,
}: {
  search: string;
  onSearch: (value: string) => void;
  groups: HelpFieldGroup[];
}) {
  const total = groups.reduce((count, group) => count + group.fields.length, 0);
  return (
    <>
      <PageHeading
        eyebrow="Every field"
        title="What to enter, in plain language"
      >
        Search by the label you see in Agent Studio. Advanced JSON fields
        include a safe starting point; ask an engineer before changing
        unfamiliar integration mappings.
      </PageHeading>
      <label style={{ display: "block", marginBottom: 16 }}>
        <span
          style={{
            display: "block",
            marginBottom: 6,
            color: "var(--text-2)",
            fontSize: 11.5,
            fontWeight: 600,
          }}
        >
          Find a field
        </span>
        <span
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "8px 10px",
            border: "1px solid var(--border-2)",
            borderRadius: 5,
            background: "var(--bg-2)",
          }}
        >
          <Icon name="search" size={12} color="var(--text-3)" />
          <input
            value={search}
            onChange={(event) => onSearch(event.target.value)}
            placeholder="For example: timeout, mapping, Stable step ID…"
            style={{
              minWidth: 0,
              flex: 1,
              color: "var(--text)",
              background: "transparent",
              border: 0,
              outline: 0,
              fontFamily: "var(--sans)",
              fontSize: 12,
            }}
          />
          {search && (
            <button
              type="button"
              onClick={() => onSearch("")}
              style={{ color: "var(--text-3)", fontSize: 10.5 }}
            >
              Clear
            </button>
          )}
        </span>
      </label>
      <div
        className="mono"
        aria-live="polite"
        style={{ marginBottom: 9, color: "var(--text-4)", fontSize: 9.5 }}
      >
        {total} FIELD{total === 1 ? "" : "S"} SHOWN
      </div>
      {groups.length ? (
        <div style={{ display: "grid", gap: 8 }}>
          {groups.map((group, groupIndex) => (
            <details
              key={group.title}
              open={Boolean(search) || groupIndex === 0}
              style={{
                border: "1px solid var(--border)",
                borderRadius: 6,
                background: "var(--panel-2)",
              }}
            >
              <summary style={{ padding: "11px 13px", cursor: "pointer" }}>
                <strong style={{ fontSize: 12 }}>{group.title}</strong>
                <span
                  style={{
                    marginLeft: 8,
                    color: "var(--text-4)",
                    fontSize: 10.5,
                  }}
                >
                  {group.fields.length} fields
                </span>
                <span
                  style={{
                    display: "block",
                    marginTop: 3,
                    color: "var(--text-3)",
                    fontSize: 10.5,
                    lineHeight: 1.45,
                  }}
                >
                  {group.summary}
                </span>
              </summary>
              <dl style={{ margin: 0, borderTop: "1px solid var(--border)" }}>
                {group.fields.map((field) => (
                  <div
                    className="agent-studio-help-field-row"
                    key={`${group.title}-${field.name}`}
                    style={{
                      padding: "12px 13px",
                      display: "grid",
                      gridTemplateColumns:
                        "minmax(150px, .7fr) minmax(240px, 1.7fr)",
                      gap: 14,
                      borderBottom: "1px solid var(--border)",
                    }}
                  >
                    <dt style={{ fontSize: 11.5, fontWeight: 600 }}>
                      {field.name}
                    </dt>
                    <dd
                      style={{
                        margin: 0,
                        color: "var(--text-2)",
                        fontSize: 11,
                        lineHeight: 1.55,
                      }}
                    >
                      <span>{field.meaning}</span>
                      <span style={{ display: "block", marginTop: 4 }}>
                        <strong style={{ color: "var(--text)" }}>
                          What to enter:
                        </strong>{" "}
                        {field.enter}
                      </span>
                      {field.example && (
                        <code
                          style={{
                            display: "block",
                            width: "fit-content",
                            maxWidth: "100%",
                            marginTop: 6,
                            padding: "3px 6px",
                            overflowWrap: "anywhere",
                            color: "var(--blue)",
                            background: "var(--bg-2)",
                            borderRadius: 3,
                          }}
                        >
                          {field.example}
                        </code>
                      )}
                      {field.caution && (
                        <span
                          style={{
                            display: "block",
                            marginTop: 6,
                            color: "var(--amber)",
                          }}
                        >
                          Watch out: {field.caution}
                        </span>
                      )}
                    </dd>
                  </div>
                ))}
              </dl>
            </details>
          ))}
        </div>
      ) : (
        <div
          style={{
            padding: 36,
            textAlign: "center",
            color: "var(--text-3)",
            border: "1px dashed var(--border-2)",
            borderRadius: 6,
          }}
        >
          No field matches “{search}”. Try a shorter label.
        </div>
      )}
    </>
  );
}

function TestingGuide() {
  return (
    <>
      <PageHeading
        eyebrow="Test & operate"
        title="Run once, inspect everything, learn safely"
      >
        Test Lab uses the real runtime and retains the result. Start with a
        saved draft and Safe test tool effects.
      </PageHeading>
      <div
        className="agent-studio-help-cards"
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(3, 1fr)",
          gap: 9,
        }}
      >
        <MiniCard label="1 · Prepare" title="Use realistic inputs">
          Save the draft, select Draft, enter the user prompt, and fill every
          required variable.
        </MiniCard>
        <MiniCard label="2 · Protect" title="Choose tool effects">
          Safe test runs tools approved for testing; Read-only permits approved
          reads but blocks writes; Live effects can change real systems.
        </MiniCard>
        <MiniCard label="3 · Observe" title="Read the inspector">
          Follow Trace first, verify Output, use Logs for detail, and review
          every Artifact.
        </MiniCard>
      </div>
      <GuideSection number="01" title="Before you press Run">
        <ul style={listStyle}>
          <li>
            <strong>Draft versus Live:</strong> use Draft for saved edits and
            Live for the published version users currently depend on.
          </li>
          <li>
            <strong>What should the agent do?</strong> Enter the real request.
            It is automatically bound to the Chat request input.
          </li>
          <li>
            <strong>Variables:</strong> Form and JSON edit the same values. File
            fields enforce the configured type and size limits.
          </li>
          <li>
            <strong>Overrides:</strong> leave provider, model, temperature,
            tokens, and timeout blank unless you are deliberately comparing
            configurations.
          </li>
        </ul>
      </GuideSection>
      <GuideSection number="02" title="How to read a run">
        <div style={{ display: "grid", gap: 7 }}>
          {[
            [
              "Trace",
              "The sequence of steps and tool decisions. Start here to locate delays or failures. Reasoning summaries are concise explanations, never hidden chain-of-thought.",
            ],
            [
              "Output",
              "The final validated JSON. Require both correct values and the Schema valid badge.",
            ],
            [
              "Logs",
              "Detailed runtime messages. Use them after the trace identifies the affected step.",
            ],
            [
              "Artifacts",
              "Retained files, including the aggregate JSON output and run record.",
            ],
            [
              "History",
              "Select any previous run to reopen its status, timing, trace, output, logs, and artifacts.",
            ],
          ].map(([title, body]) => (
            <div
              key={title}
              style={{
                padding: 10,
                borderLeft: "2px solid var(--border-2)",
                background: "var(--panel-2)",
              }}
            >
              <strong style={{ fontSize: 11.5 }}>{title}</strong>
              <span
                style={{
                  display: "block",
                  marginTop: 3,
                  color: "var(--text-3)",
                  fontSize: 11,
                  lineHeight: 1.5,
                }}
              >
                {body}
              </span>
            </div>
          ))}
        </div>
      </GuideSection>
      <GuideSection number="03" title="A useful minimum test set">
        <ol style={listStyle}>
          <li>
            <strong>Happy path:</strong> complete, ordinary input that should
            succeed.
          </li>
          <li>
            <strong>Missing or vague information:</strong> confirm the agent
            asks, abstains, or applies the intended fallback.
          </li>
          <li>
            <strong>Boundary case:</strong> a longest value, unusual category,
            or near-threshold score.
          </li>
          <li>
            <strong>Safety case:</strong> sensitive data, unsafe instruction, or
            a request outside the agent's role.
          </li>
          <li>
            <strong>Tool case:</strong> Start with Safe test or Read-only, then
            use Live effects only in an approved test environment.
          </li>
        </ol>
      </GuideSection>
      <Callout tone="amber" title="Stop versus undo">
        Stop asks an active run to cancel at a safe checkpoint. It cannot
        reverse an external change a tool already made. This is why Safe test or
        Read-only is the right first choice.
      </Callout>
    </>
  );
}

function ExamplesGuide() {
  return (
    <>
      <PageHeading
        eyebrow="Worked examples"
        title="Two small agents you can reproduce"
      >
        These examples use simple contracts and one AI step so the relationship
        between instructions, inputs, and outputs stays easy to see.
      </PageHeading>
      <Example
        number="01"
        title="Support ticket classifier"
        goal="Route a new support request to billing, technical, account, or other."
        settings={[
          [
            "Overview",
            "Display name: Support Ticket Classifier · Template: classify",
          ],
          [
            "Inputs",
            "prompt (Chat request, required) · customer_tier (Form value, optional text)",
          ],
          [
            "Outputs",
            "category (required enum) · urgency (required enum) · rationale (required string)",
          ],
          ["Steps", "One AI / logic step named Classify ticket"],
          [
            "Runtime",
            "Creativity 0.1 · 1 correction attempt · output file ticket-classification.json",
          ],
        ]}
        instructions={`You classify customer support tickets.\nChoose exactly one category: billing, technical, account, or other.\nChoose urgency: low, normal, high, or critical.\nBase the answer only on the request. If evidence is weak, choose other.\nKeep the rationale to one sentence.`}
        schema={`{\n  "category": "technical",\n  "urgency": "high",\n  "rationale": "The customer cannot authenticate after a security-key reset."\n}`}
        testPrompt="I reset my security key and now every login attempt fails. I need access before today's payroll run."
      />
      <Example
        number="02"
        title="Document summarizer"
        goal="Turn a long document into a short summary, key points, and follow-up actions."
        settings={[
          ["Overview", "Display name: Document Summarizer · Template: extract"],
          [
            "Inputs",
            "prompt (Chat request, required) · document_text (Form value, required text) · audience (Form value, optional text)",
          ],
          [
            "Outputs",
            "summary (required string) · key_points (required string array) · action_items (string array)",
          ],
          ["Steps", "One AI / logic step named Summarize document"],
          [
            "Runtime",
            "Creativity 0.2 · maximum answer length 2000 · output file document-summary.json",
          ],
        ]}
        instructions={`You summarize documents for the named audience.\nUse only facts present in document_text.\nWrite a concise summary, 3–7 key points, and explicit action items.\nIf the document has no action items, return an empty list.\nDo not invent owners, dates, or decisions.`}
        schema={`{\n  "summary": "The team approved a phased migration beginning in August.",\n  "key_points": ["Phase one covers internal users", "Security review is required"],\n  "action_items": ["Operations will publish the rollout calendar"]\n}`}
        testPrompt="Summarize the document for an executive reader. Focus on decisions, risks, and actions."
      />
      <Callout tone="blue" title="Want file upload instead?">
        Change document_text to a File upload input, set allowed file types and
        size, and allow an approved document-reading tool. Test with Safe test
        or Read-only before allowing Live effects.
      </Callout>
    </>
  );
}

function GlossaryGuide() {
  return (
    <>
      <PageHeading eyebrow="Glossary" title="Agent Studio terms, decoded">
        A shared vocabulary makes reviews faster. These definitions describe how
        the words are used in this product.
      </PageHeading>
      <dl style={{ margin: 0, display: "grid", gap: 7 }}>
        {GLOSSARY.map(([term, definition]) => (
          <div
            className="agent-studio-help-field-row"
            key={term}
            style={{
              padding: "11px 12px",
              display: "grid",
              gridTemplateColumns: "150px minmax(0, 1fr)",
              gap: 14,
              border: "1px solid var(--border)",
              borderRadius: 5,
              background: "var(--panel-2)",
            }}
          >
            <dt
              className="mono"
              style={{ color: "var(--blue)", fontSize: 10.5 }}
            >
              {term}
            </dt>
            <dd
              style={{
                margin: 0,
                color: "var(--text-2)",
                fontSize: 11.5,
                lineHeight: 1.5,
              }}
            >
              {definition}
            </dd>
          </div>
        ))}
      </dl>
    </>
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
    <section style={{ marginTop: 24 }}>
      <div
        style={{
          display: "flex",
          gap: 8,
          alignItems: "center",
          marginBottom: 8,
        }}
      >
        <span
          className="mono"
          style={{ color: "var(--signal)", fontSize: 9.5 }}
        >
          {number}
        </span>
        <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>{title}</h3>
      </div>
      {children}
    </section>
  );
}

function Callout({
  tone,
  title,
  children,
}: {
  tone: "blue" | "amber" | "green";
  title: string;
  children: ReactNode;
}) {
  const colors =
    tone === "amber"
      ? ["var(--amber)", "rgba(255,181,71,0.07)"]
      : tone === "green"
        ? ["var(--green)", "rgba(101,224,163,0.07)"]
        : ["var(--blue)", "rgba(132,169,255,0.07)"];
  return (
    <div
      style={{
        marginTop: 16,
        padding: "11px 12px",
        color: "var(--text-2)",
        border: `1px solid color-mix(in srgb, ${colors[0]} 35%, transparent)`,
        borderLeft: `3px solid ${colors[0]}`,
        borderRadius: 5,
        background: colors[1],
        fontSize: 11.5,
        lineHeight: 1.55,
      }}
    >
      <strong style={{ display: "block", marginBottom: 3, color: colors[0] }}>
        {title}
      </strong>
      {children}
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
        padding: 12,
        textAlign: "left",
        color: "var(--text)",
        border: "1px solid var(--border)",
        borderRadius: 6,
        background: "var(--panel-2)",
      }}
    >
      <strong style={{ fontSize: 11.5 }}>{title}</strong>
      <span
        style={{
          display: "block",
          minHeight: 34,
          marginTop: 5,
          color: "var(--text-3)",
          fontSize: 10.5,
          lineHeight: 1.45,
        }}
      >
        {body}
      </span>
      <span
        style={{
          display: "block",
          marginTop: 9,
          color: "var(--blue)",
          fontSize: 10.5,
        }}
      >
        {action} →
      </span>
    </button>
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
        padding: 12,
        border: "1px solid var(--border)",
        borderRadius: 6,
        background: "var(--panel-2)",
      }}
    >
      <div className="mono" style={{ color: "var(--signal)", fontSize: 9.5 }}>
        {label}
      </div>
      <strong style={{ display: "block", marginTop: 7, fontSize: 11.5 }}>
        {title}
      </strong>
      <div
        style={{
          marginTop: 4,
          color: "var(--text-3)",
          fontSize: 10.5,
          lineHeight: 1.5,
        }}
      >
        {children}
      </div>
    </div>
  );
}

function Example({
  number,
  title,
  goal,
  settings,
  instructions,
  schema,
  testPrompt,
}: {
  number: string;
  title: string;
  goal: string;
  settings: string[][];
  instructions: string;
  schema: string;
  testPrompt: string;
}) {
  return (
    <section
      style={{
        marginTop: 22,
        padding: 16,
        border: "1px solid var(--border-2)",
        borderRadius: 7,
        background: "var(--panel-2)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Badge tone="signal">Example {number}</Badge>
        <h3 style={{ margin: 0, fontSize: 15 }}>{title}</h3>
      </div>
      <p
        style={{
          margin: "8px 0 14px",
          color: "var(--text-2)",
          fontSize: 11.5,
          lineHeight: 1.55,
        }}
      >
        <strong>Goal:</strong> {goal}
      </p>
      <div style={{ display: "grid", gap: 5 }}>
        {settings.map(([label, value]) => (
          <div
            key={label}
            style={{
              display: "grid",
              gridTemplateColumns: "90px minmax(0, 1fr)",
              gap: 8,
              fontSize: 10.5,
            }}
          >
            <span className="mono" style={{ color: "var(--text-4)" }}>
              {label}
            </span>
            <span style={{ color: "var(--text-2)" }}>{value}</span>
          </div>
        ))}
      </div>
      <div
        className="agent-studio-help-example-grid"
        style={{
          marginTop: 14,
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 10,
        }}
      >
        <CodeSample label="AGENT INSTRUCTIONS" value={instructions} />
        <CodeSample label="EXAMPLE OUTPUT" value={schema} />
      </div>
      <div
        style={{
          marginTop: 10,
          padding: 10,
          borderLeft: "2px solid var(--blue)",
          background: "var(--bg-2)",
          fontSize: 11,
        }}
      >
        <span
          className="mono"
          style={{
            display: "block",
            marginBottom: 4,
            color: "var(--text-4)",
            fontSize: 9.5,
          }}
        >
          TEST PROMPT
        </span>
        {testPrompt}
      </div>
    </section>
  );
}

function CodeSample({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div
        className="mono"
        style={{ marginBottom: 5, color: "var(--text-4)", fontSize: 9.5 }}
      >
        {label}
      </div>
      <pre
        style={{
          height: "100%",
          margin: 0,
          padding: 10,
          overflow: "auto",
          whiteSpace: "pre-wrap",
          color: "var(--text-2)",
          background: "#080a0b",
          border: "1px solid var(--border)",
          borderRadius: 4,
          fontFamily: "var(--mono)",
          fontSize: 10,
          lineHeight: 1.5,
        }}
      >
        {value}
      </pre>
    </div>
  );
}

const listStyle = {
  margin: 0,
  paddingLeft: 21,
  color: "var(--text-2)",
  fontSize: 11.5,
  lineHeight: 1.7,
} as const;
