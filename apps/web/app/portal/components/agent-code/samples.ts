/**
 * Sample TypeScript code + tool_use seed values used by AgentCodeTab and the
 * edit panels when an agent has no override. Verbatim from
 * `apps/web/public/portal/views/agent-code.jsx:10-137`.
 */

export const AGENT_SAMPLE_TS_CODE = `import { defineAgent } from "@agentic/runtime";

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

export interface ToolInputPropertySchema {
  type?: string | string[];
  description?: string;
  enum?: Array<string | number | boolean | null>;
  items?: ToolInputPropertySchema;
  anyOf?: ToolInputPropertySchema[];
  additionalProperties?: boolean | ToolInputPropertySchema;
  default?: unknown;
  [key: string]: unknown;
}

export interface ToolUseSchema {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, ToolInputPropertySchema>;
    required: string[];
  };
}

export const AGENT_SAMPLE_TOOL_USE: ToolUseSchema[] = [
  {
    name: "blacklist_lookup",
    description:
      "Check whether a candidate is on any client's blacklist. Returns hit count and the specific blacklist matches.",
    input_schema: {
      type: "object",
      properties: {
        candidate_id: {
          type: "string",
          description: "RAAS candidate id, e.g. CAN-88412",
        },
        client_id: { type: "string", description: "Client id, e.g. Tencent" },
      },
      required: ["candidate_id", "client_id"],
    },
  },
  {
    name: "scoring_match",
    description:
      "Run the weighted resume↔requisition matcher. Returns score (0–100) and the signals that drove it.",
    input_schema: {
      type: "object",
      properties: {
        resume_id: { type: "string" },
        jd_id: { type: "string" },
      },
      required: ["resume_id", "jd_id"],
    },
  },
  {
    name: "score_hard_requirements",
    description:
      "LLM-as-judge: score each hard requirement on the JD against the candidate's resume. Returns passes/total and per-line failures.",
    input_schema: {
      type: "object",
      properties: {
        resume: { type: "object", description: "Parsed candidate resume" },
        requisition: {
          type: "object",
          description: "Normalized job requisition",
        },
      },
      required: ["resume", "requisition"],
    },
  },
];
