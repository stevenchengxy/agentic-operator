---
name: candidate-sourcing
description: How to translate a job requisition into a structured RoboHire candidate search and select shortlist
audience: sourcerAgent
---

# Candidate sourcing

Use this skill when you need to turn a fresh job requisition into a candidate longlist.

## Input you will see

You will be invoked after a `NEW_JOB_REQUISITION` event. The payload must carry `job_requisition_id`, the real `jd` text, and `candidates: [{ candidate_id, resume }]` from the caller's ATS or export. No candidate-search connector is configured for this tenant, so missing source data is a blocking integration gap.

## Procedure

1. **Validate source data**. If `jd` or any candidate's `resume` is empty, return `missing_source_data` with the exact missing fields and stop.
2. **Probe RoboHire** with `robohireHealthApi`. Treat missing credentials or an unreachable upstream as a real failure.
3. **Structure the requisition** with `parseJdApi` when downstream needs parsed must-have and nice-to-have fields.
4. **Score supplied candidates** with `matchResumeApi` using the exact real `{ resume, jd }` strings. Never replace a failed call with a locally generated score.
5. **Emit `CANDIDATES_SOURCED`** with `{ job_requisition_id, jd, shortlist: [{candidate_id, resume, score, verdict}, …] }`.

## What "done" looks like

A shortlist of 3-5 candidates with a numeric score and a one-line rationale per entry. If RoboHire returns zero candidates, surface that as `{ shortlist: [], reason: "no_candidates_found", searched_at: <iso> }` — silence is worse than an empty result.

## Failure modes

- `ROBOHIRE_API_KEY not set` — surface verbatim. Do not retry.
- Upstream 5xx — preserve the upstream error and stop or mark that candidate failed; do not synthesize a replacement.
- Empty result — emit the empty shortlist with `reason`. Don't synthesize candidates.
