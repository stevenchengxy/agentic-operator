---
name: interview-loop
description: How to design an interview panel + question set for a candidate the workflow just screened-in
audience: interviewPlannerAgent
---

# Interview-loop design

Use this skill once a candidate has been promoted to interview.

## Procedure

1. Read the real candidate profile and requisition from the triggering event or a configured ATS connector. If either is missing, return an explicit `missing_source_data` gap; do not invent a profile or requisition.
2. Identify the 2-3 must-have skills the candidate's profile doesn't strongly demonstrate. Those become the **technical screen** topics.
3. For each topic, write one open-ended question and one practical follow-up. Avoid leetcode-style puzzles.
4. Add a **values screen** slot: one question keyed off the candidate's most recent role (e.g. "Tell me about a time you disagreed with your tech lead — what did you do?").
5. Suggest a panel composition: 1 hiring manager + 1 senior peer + 1 cross-team partner. If the role is staff+, add a principal-level interviewer.
6. Return the plan as `{ candidate_id, panel: [{name, role}], rounds: [{topic, questions: [string]}], total_time_min }`.

## Conventions

- Round count: 4 max for IC, 6 max for management.
- Always include at least one panelist outside the hiring team.
- Default interview-day load: 5 hours including breaks.
