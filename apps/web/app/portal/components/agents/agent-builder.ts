import type { FleetEntry } from "@/lib/hooks/useModelFleet";

export type AgentTemplateId =
  | "blank"
  | "classify"
  | "extract"
  | "rag"
  | "loop"
  | "human";

export type AgentActor = "Agent" | "Human";

export type AgentModelProfile =
  | "balanced"
  | "fast"
  | "structured"
  | "reasoning"
  | "agentic"
  | "judgment";

export type DeepSearchMode = "answer" | "investigate" | "deep_research";

export interface AgentBuilderStep {
  id: string;
  title: string;
  description: string;
  modelProfile: AgentModelProfile;
  execution: "llm" | "human";
  modelOverride?: string;
}

export interface AgentBuilderTemplate {
  id: AgentTemplateId;
  actor: AgentActor;
  name: string;
  description: string;
  outcome: string;
  bestFor: string[];
  safeguards: string[];
  color: string;
  modelProfile: AgentModelProfile;
  modelWhy: string;
  suggestedTrigger: string;
  suggestedEmit: string;
  toolHints: string[];
  steps: AgentBuilderStep[];
}

/**
 * Product-level archetypes used by the New Agent builder. Each template is a
 * complete execution pattern, not just a visual label. The API's prompt
 * designer receives the template id and turns the user's domain brief into a
 * concrete runtime prompt.
 */
export const AGENT_BUILDER_TEMPLATES: readonly AgentBuilderTemplate[] = [
  {
    id: "blank",
    actor: "Agent",
    name: "Blank agent",
    description:
      "Design a purpose-built agent from a clean, production-ready foundation.",
    outcome:
      "A flexible event-driven agent with an editable plan, tools, model policy, and output contract.",
    bestFor: ["Novel workflows", "Domain copilots", "Custom reasoning"],
    safeguards: [
      "Validate the incoming event",
      "Return a bounded, explicit result",
    ],
    color: "var(--text-3)",
    modelProfile: "balanced",
    modelWhy:
      "A balanced general model is the safest starting point until the purpose is more specific.",
    suggestedTrigger: "AGENT_REQUESTED",
    suggestedEmit: "AGENT_COMPLETED",
    toolHints: [],
    steps: [
      {
        id: "understand",
        title: "Understand & plan",
        description:
          "Validate the event, identify the goal, and form a bounded execution plan.",
        modelProfile: "reasoning",
        execution: "llm",
      },
      {
        id: "execute",
        title: "Execute & verify",
        description:
          "Use approved context and tools, verify the result, and emit the output contract.",
        modelProfile: "balanced",
        execution: "llm",
      },
    ],
  },
  {
    id: "classify",
    actor: "Agent",
    name: "Classifier",
    description:
      "Route requests with constrained labels, confidence, evidence, and an abstain path.",
    outcome:
      "A schema-valid classification that downstream agents can route without parsing prose.",
    bestFor: ["Intent routing", "Risk triage", "Priority queues"],
    safeguards: [
      "Closed label set",
      "Confidence threshold",
      "Abstain when evidence is weak",
    ],
    color: "var(--blue)",
    modelProfile: "fast",
    modelWhy:
      "Classification benefits from a fast, low-cost model with reliable structured output.",
    suggestedTrigger: "CLASSIFICATION_REQUESTED",
    suggestedEmit: "ITEM_CLASSIFIED",
    toolHints: ["ontology"],
    steps: [
      {
        id: "classify",
        title: "Classify",
        description:
          "Normalize the input, apply the label rubric, and return label, confidence, and evidence.",
        modelProfile: "fast",
        execution: "llm",
      },
    ],
  },
  {
    id: "extract",
    actor: "Agent",
    name: "Extractor",
    description:
      "Turn documents or messages into validated structured data with provenance.",
    outcome:
      "Typed JSON with field-level evidence, null handling, validation, and a repair pass when needed.",
    bestFor: ["Document intake", "Entity extraction", "Form automation"],
    safeguards: [
      "Never invent missing fields",
      "Preserve provenance",
      "Validate before emit",
    ],
    color: "var(--blue)",
    modelProfile: "structured",
    modelWhy:
      "Extraction needs dependable schema adherence and enough context for long source material.",
    suggestedTrigger: "EXTRACTION_REQUESTED",
    suggestedEmit: "DATA_EXTRACTED",
    toolHints: ["ontology", "fs.read", "http.fetch"],
    steps: [
      {
        id: "extract",
        title: "Extract with evidence",
        description:
          "Map source content to the requested schema and retain field-level provenance.",
        modelProfile: "structured",
        execution: "llm",
      },
      {
        id: "validate",
        title: "Validate & repair",
        description:
          "Check types, required fields, and ontology constraints; repair only from source evidence.",
        modelProfile: "fast",
        execution: "llm",
      },
    ],
  },
  {
    id: "rag",
    actor: "Agent",
    name: "Deep Search",
    description:
      "Investigate a question across ontology, connected knowledge, and approved sources with citations.",
    outcome:
      "An evidence-backed answer that decomposes the question, searches iteratively, and reports uncertainty.",
    bestFor: [
      "Enterprise research",
      "Knowledge discovery",
      "Evidence synthesis",
    ],
    safeguards: [
      "Cite every material claim",
      "Separate evidence from inference",
      "Expose coverage gaps",
    ],
    color: "var(--violet)",
    modelProfile: "reasoning",
    modelWhy:
      "Deep Search needs a strong reasoning model for query planning, source comparison, and synthesis.",
    suggestedTrigger: "SEARCH_REQUESTED",
    suggestedEmit: "SEARCH_COMPLETED",
    toolHints: ["ontology", "http.fetch", "fs.read"],
    steps: [
      {
        id: "plan-search",
        title: "Plan the investigation",
        description:
          "Decompose the question, identify entities, and create independent search paths.",
        modelProfile: "reasoning",
        execution: "llm",
      },
      {
        id: "retrieve",
        title: "Search & follow leads",
        description:
          "Traverse ontology and approved sources, reranking evidence and closing coverage gaps.",
        modelProfile: "agentic",
        execution: "llm",
      },
      {
        id: "synthesize",
        title: "Synthesize with citations",
        description:
          "Resolve conflicts, distinguish facts from inference, and produce a cited answer.",
        modelProfile: "reasoning",
        execution: "llm",
      },
    ],
  },
  {
    id: "loop",
    actor: "Agent",
    name: "Tool-loop agent",
    description:
      "Plan and execute multi-step work by choosing tools, observing results, and self-correcting.",
    outcome:
      "A completed objective with a bounded plan-act-observe loop and a verified final state.",
    bestFor: ["Operations", "API orchestration", "Multi-step automation"],
    safeguards: [
      "Bound steps and retries",
      "Confirm risky actions",
      "Verify completion from tool output",
    ],
    color: "var(--signal)",
    modelProfile: "agentic",
    modelWhy:
      "Tool loops need a model with strong function calling, planning, and error recovery.",
    suggestedTrigger: "AUTOMATION_REQUESTED",
    suggestedEmit: "AUTOMATION_COMPLETED",
    toolHints: ["ontology", "http.fetch", "fs."],
    steps: [
      {
        id: "plan",
        title: "Plan",
        description:
          "Define success criteria, dependencies, and a bounded sequence of actions.",
        modelProfile: "reasoning",
        execution: "llm",
      },
      {
        id: "act-observe",
        title: "Act, observe & recover",
        description:
          "Call allowed tools, inspect results, and adapt without exceeding runtime limits.",
        modelProfile: "agentic",
        execution: "llm",
      },
      {
        id: "verify",
        title: "Verify & emit",
        description:
          "Confirm the intended state from evidence and publish a machine-readable result.",
        modelProfile: "structured",
        execution: "llm",
      },
    ],
  },
  {
    id: "human",
    actor: "Human",
    name: "Human approval",
    description:
      "Prepare an evidence-rich decision packet and pause for an accountable operator decision.",
    outcome:
      "An approve, reject, or revise decision with rationale, audit context, and a resumable event.",
    bestFor: ["High-impact decisions", "Policy exceptions", "Quality gates"],
    safeguards: [
      "Show evidence and uncertainty",
      "No silent auto-approval",
      "Record decision rationale",
    ],
    color: "var(--violet)",
    modelProfile: "judgment",
    modelWhy:
      "The preparation step benefits from nuanced judgment while the final authority remains human.",
    suggestedTrigger: "APPROVAL_REQUESTED",
    suggestedEmit: "APPROVAL_RESOLVED",
    toolHints: ["ontology", "task"],
    steps: [
      {
        id: "prepare",
        title: "Prepare decision brief",
        description:
          "Summarize evidence, policy constraints, options, uncertainty, and a recommendation.",
        modelProfile: "judgment",
        execution: "llm",
      },
      {
        id: "decide",
        title: "Human decision",
        description:
          "Pause for approve, reject, or revise; capture rationale and resume from the decision event.",
        modelProfile: "balanced",
        execution: "human",
      },
    ],
  },
] as const;

const FAST_MODEL_TERMS = ["mini", "flash", "haiku", "small", "lite", "nano"];
const REASONING_MODEL_TERMS = [
  "reason",
  "thinking",
  "deepseek-r1",
  "o3",
  "o4",
  "opus",
  "gemini-2.5-pro",
  "gpt-5",
];
const TOOL_MODEL_TERMS = [
  "sonnet",
  "gpt-5",
  "gpt-4.1",
  "gemini-2.5",
  "command-r",
];

function containsAny(value: string, terms: string[]): boolean {
  return terms.some((term) => value.includes(term));
}

function modelScore(
  entry: FleetEntry,
  profile: AgentModelProfile,
  purpose: string,
): number {
  const haystack = `${entry.alias} ${entry.modelName}`.toLowerCase();
  const isFastModel = containsAny(haystack, FAST_MODEL_TERMS);
  const isReasoningModel =
    !isFastModel && containsAny(haystack, REASONING_MODEL_TERMS);
  let score =
    entry.role === "primary" ? 12 : entry.role === "fallback" ? 4 : -20;

  if (profile === "fast" || profile === "structured") {
    if (isFastModel) score += 18;
    if (isReasoningModel) score -= 3;
  }
  if (profile === "reasoning" || profile === "judgment") {
    if (isReasoningModel) score += 22;
    if (isFastModel) score -= 8;
  }
  if (profile === "agentic") {
    if (containsAny(haystack, TOOL_MODEL_TERMS)) score += 18;
    if (containsAny(haystack, REASONING_MODEL_TERMS)) score += 8;
  }
  if (profile === "balanced" && entry.role === "primary") score += 8;

  const normalizedPurpose = purpose.toLowerCase();
  if (
    /research|investigat|complex|reason|strategy|compare|synthesi/.test(
      normalizedPurpose,
    ) &&
    isReasoningModel
  ) {
    score += 10;
  }
  if (
    /high volume|latency|realtime|real-time|triage|route|classif/.test(
      normalizedPurpose,
    ) &&
    isFastModel
  ) {
    score += 10;
  }
  return score;
}

/** Picks a concrete fleet entry for Auto mode using archetype + user purpose. */
export function recommendFleetModel(
  fleet: FleetEntry[],
  template: AgentBuilderTemplate | null,
  purpose: string,
): FleetEntry | undefined {
  if (fleet.length === 0) return undefined;
  const profile = template?.modelProfile ?? "balanced";
  return [...fleet].sort(
    (a, b) => modelScore(b, profile, purpose) - modelScore(a, profile, purpose),
  )[0];
}

export function modelLabel(entry: FleetEntry | undefined): string {
  if (!entry) return "Workspace default";
  return `${entry.alias || entry.modelName} · ${entry.provider}`;
}

export function modelSelectionReason(
  template: AgentBuilderTemplate | null,
  purpose: string,
): string {
  const base =
    template?.modelWhy ??
    "The workspace primary model is the starting recommendation.";
  if (
    /research|investigat|complex|reason|strategy|compare|synthesi/i.test(
      purpose,
    )
  ) {
    return `${base} The purpose also signals multi-step reasoning.`;
  }
  if (
    /high volume|latency|realtime|real-time|triage|route|classif/i.test(purpose)
  ) {
    return `${base} The purpose also signals a latency-sensitive workload.`;
  }
  return base;
}

export function defaultStepModels(
  template: AgentBuilderTemplate,
): AgentBuilderStep[] {
  return template.steps.map((step) => ({ ...step, modelOverride: "inherit" }));
}

export function deepSearchStepsForMode(
  template: AgentBuilderTemplate,
  mode: DeepSearchMode,
): AgentBuilderStep[] {
  if (template.id !== "rag" || mode === "investigate") {
    return defaultStepModels(template);
  }
  if (mode === "answer") {
    return [
      {
        id: "retrieve",
        title: "Retrieve focused evidence",
        description:
          "Search ontology and approved sources within a tight budget, then rank the strongest evidence.",
        modelProfile: "fast",
        execution: "llm",
        modelOverride: "inherit",
      },
      {
        id: "answer",
        title: "Answer with citations",
        description:
          "Produce a concise grounded answer, cite material claims, and state when evidence is insufficient.",
        modelProfile: "balanced",
        execution: "llm",
        modelOverride: "inherit",
      },
    ];
  }
  return [
    {
      id: "clarify",
      title: "Clarify scope",
      description:
        "Resolve ambiguity, define success criteria, and turn the request into research questions.",
      modelProfile: "balanced",
      execution: "llm",
      modelOverride: "inherit",
    },
    {
      id: "approve-plan",
      title: "Review research plan",
      description:
        "Present the investigation plan, sources, budget, and boundaries before the background run starts.",
      modelProfile: "balanced",
      execution: "human",
      modelOverride: "inherit",
    },
    {
      id: "research-workstreams",
      title: "Run research workstreams",
      description:
        "Investigate independent source and ontology workstreams within a bounded durable run, preserving evidence for later synthesis.",
      modelProfile: "agentic",
      execution: "llm",
      modelOverride: "inherit",
    },
    {
      id: "gap-check",
      title: "Close evidence gaps",
      description:
        "Compare findings, identify unresolved claims, and follow the most valuable remaining leads.",
      modelProfile: "reasoning",
      execution: "llm",
      modelOverride: "inherit",
    },
    {
      id: "verify-citations",
      title: "Verify citations",
      description:
        "Independently check claim support, source quality, freshness, and citation coverage.",
      modelProfile: "judgment",
      execution: "llm",
      modelOverride: "inherit",
    },
    {
      id: "synthesize",
      title: "Synthesize report",
      description:
        "Produce a structured report that separates evidence, inference, uncertainty, and recommended next steps.",
      modelProfile: "reasoning",
      execution: "llm",
      modelOverride: "inherit",
    },
  ];
}
