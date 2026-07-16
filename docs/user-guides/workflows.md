# Workflows user guide

The Workflows page shows how agents and people pass work from one step to the next. It is designed to answer ordinary business questions such as:

- What happens after a request arrives?
- Which agent performs this part of the process?
- Where does a person review or approve the work?
- What starts the next step?
- Why did a particular step run—or fail to run?

You do not need to understand code to read or trace a workflow. Technical users can also inspect exact event names and the complete agent definition without leaving the canvas.

## The idea in one minute

A workflow is a shared plan:

- A **box** is one unit of work. It can be an AI agent or a human task.
- A **line** is a hand-off between boxes.
- An **event** is the named message carried by a line.
- A **trigger** is an event that is allowed to start a box.
- An **emitted event** is a message announced after a box succeeds.
- A **stage** is a business phase, such as Intake, Analyze, Review, or Submit.

For example:

```text
New ticket
    │ support.ticket.received
    ▼
Classify ticket
    │ support.ticket.classified
    ▼
Route ticket
```

The first box emits `support.ticket.received`. The Classify ticket box listens for that event. After classification, it emits `support.ticket.classified`, which starts the Route ticket box.

Looking at or clicking a workflow does not change it. Live behavior changes only after an editor creates, saves, validates, tests, and deliberately publishes a draft.

## Open the in-app guide

Open **Workflows** and choose **Help** in the page header. The guide remains available while viewing the live workflow and while editing a draft. It includes:

1. A five-minute introduction.
2. Instructions for tracing boxes and events.
3. A safe editing and publication process.
4. A plain-language field and button reference.
5. Worked examples.
6. Troubleshooting advice.

## Read the canvas

### Stage headings

The headings across the top divide the process into business phases. Work usually moves from left to right. A workflow can skip a stage or have several boxes in the same stage.

Stage headings help you find the relevant part of a large process. They do not start or stop work themselves.

### Agent boxes

An agent box represents automated work. Its lime edge distinguishes it from a human task. The box shows:

- The owner type.
- The friendly title.
- The stable agent identifier.

Click an agent box to highlight its incoming and outgoing hand-offs. The right panel then shows its triggers, emitted events, and other available details.

Double-click an agent box to widen its right-side detail panel. You can also drag the divider between the canvas and panel. In Edit mode, the guided tabs expose identity, prompts, model selection, runtime, concurrency, reasoning, scheduling, observability, tools, actions, input/output contracts, and artifact policy. Use **Complete definition · all settings** for a lossless JSON view.

### Human-task boxes

A human-task box represents work that pauses for a person. Its violet edge distinguishes it from an automated agent.

Typical human tasks include:

- Approving a high-value invoice.
- Reviewing a low-confidence match.
- Correcting incomplete information.
- Confirming a compliance decision.

Treat removal or bypass of a human task as a material process change. Ask the business owner, control owner, or compliance reviewer before deploying it.

### Event lines

A line represents a configured event hand-off. The arrow points toward the box that listens for the event.

Click a line to select its event. Every line carrying the same event becomes easier to see, and the right panel lists:

- Which boxes emit the event.
- Which boxes listen for the event.
- Recent occurrences, when available.

A configured line is a promise about how the workflow should behave. It is not proof that a particular run succeeded. Use **View in event stream** and the Runs page to confirm what actually happened.

### Right-side inspector

When nothing is selected, the inspector shows the legend and available events. When a box or event is selected, it changes to show details about that selection.

Use it to answer:

- **Triggers:** What can start this box?
- **Emits:** What does this box announce after success?
- **Emitted by:** Which boxes can send this event?
- **Listened by:** Which boxes wait for this event?
- **Recent:** Has this event occurred recently?

## Trace a process

### Trace forward from a box

1. Click the box where you want to begin.
2. Read its **Emits** list in the right panel.
3. Click the relevant emitted event.
4. Follow the highlighted line in the direction of the arrow.
5. Select the next box and repeat.

This answers “What happens after this step succeeds?”

### Trace backward to a cause

1. Click the box that ran unexpectedly or failed to start.
2. Read its **Triggers** list.
3. Click the relevant trigger event.
4. Review the **Emitted by** list in the event inspector.
5. Open the upstream box or inspect the event stream.

This answers “What was supposed to start this step?”

### Confirm a real hand-off

1. Select the event line.
2. Choose **View in event stream**.
3. Find the occurrence for the correct subject, customer, request, or time.
4. Open **Runs** and confirm the upstream run completed successfully.
5. Confirm the downstream run started and used the expected version.

If the event was emitted but the downstream box did not run, compare the exact event spelling and check the downstream run logs.

## Run and test a workflow

Choose **Run workflow** in view mode or **Run** in edit mode to open the Run Console.

The console has two deliberately separate targets:

- **Current draft test** executes the exact current canvas definition in a bounded, request-scoped harness. It does not publish the draft.
- **Published live** emits an operator event into the immutable live workflow and follows exact event-to-run causality in the durable runtime.

### Test the current draft

1. Choose an external entry event, or deliberately select an internal event to test one branch.
2. Enter the generated input variables. Controls come from the listening agents' input contracts, including enums, booleans, numbers, JSON, and file policies.
3. Add a subject or correlation key so the test is easy to identify.
4. Choose a tool policy: safe test, read-only, or explicitly confirmed live effects.
5. Choose whether independent branches continue after a failure, and set the simulated human decision for manual steps.
6. Keep agent-run, event, and depth budgets bounded.
7. Choose **Run draft test**.

Review the result tabs:

- **Summary** shows status, pass/fail counts, events, terminal outputs, tokens, duration, and warnings.
- **Agent trace** shows validated inputs and outputs, model/provider evidence, every action, branch target, retries, simulation notes, and failures.
- **Events** shows the event chain, depth, consumers, payloads, and terminal events.
- **Raw JSON** is the complete copyable evidence report.

### Run the published workflow

The live target is available only when a version is published. Confirm the production action, choose **Run published workflow**, and keep the console open while it follows the exact seed event. Use the durable run links for logs, persisted outputs, and operational follow-up.

## Edit a workflow safely

### The safe release sequence

Use this sequence for every workflow change:

1. Trace and understand the current path.
2. Choose **Edit workflow**.
3. Confirm the amber **Draft** badge is visible.
4. Make one related change at a time.
5. Review the number of added, changed, and removed boxes.
6. Check every changed event name against its intended sender and listeners.
7. Ask affected process owners to review event and human-task changes.
8. Choose **Save draft** to create an immutable server revision.
9. Choose **Validate** and resolve every blocking issue.
10. Use **Run** to exercise the current canvas with representative inputs.
11. Choose **Publish** only when the validated version and evidence are acceptable.
12. Confirm the new live version behaves correctly in Events and Runs.

The draft is a working copy. Editing, saving, validating, and draft testing do not change the live workflow. Publishing explicitly promotes one immutable version.

### Edit a box

While in Edit mode, click a box to open its editable fields in the right panel.

| Area                                   | What it controls                                                                                    |
| -------------------------------------- | --------------------------------------------------------------------------------------------------- |
| **Identity**                           | Stable ID, name, title, description, actor, stage, and template.                                    |
| **Instructions**                       | System/ontology instructions, prompt ownership, and AI-assisted prompt proposals.                   |
| **Model selection**                    | Provider and model, including inherited defaults and discovered model choices.                      |
| **Runtime controls**                   | Temperature, tokens, timeout, retries, verbosity, response storage, and tool-loop limits.           |
| **Reasoning**                          | Reasoning mode, effort, summary, and context controls supported by the selected model.              |
| **Concurrency & schedule**             | Concurrency key/limit plus cron schedule and timezone.                                              |
| **Observability**                      | Trace level, reasoning summaries, rendered-prompt persistence, and retention.                       |
| **Inputs / outputs**                   | Typed schemas, defaults/examples, sensitivity, bindings, strict validation, repair, and unwrapping. |
| **Tools & actions**                    | Tool allow-list/configuration and the ordered action plan.                                          |
| **Artifacts**                          | Output filename and persistence of inputs, outputs, run records, and raw responses.                 |
| **Complete definition · all settings** | Lossless JSON editor for the entire agent contract.                                                 |
| **Remove node**                        | Excludes the box from the new draft version after dependency review.                                |

Event names are the connections in a workflow. Spelling, capitalization, and punctuation must match exactly. For example, `invoice.approved` and `invoice_approved` are different events.

When one box emits the exact event another box listens for, the canvas draws the link automatically. If you rename either side so the names no longer match, the link disappears. You do not need to maintain a separate visual connection.

### Generate or improve the system prompt

In an automated agent's **Instructions** area, choose **Generate prompt** or **Regenerate**. Select whether to generate, improve, shorten, or add guardrails. The proposal uses the current role, system/ontology text, inputs, outputs, actions, tools, and runtime context.

Generation is non-destructive:

1. Review and edit the proposed instructions.
2. Check the source-change warning if the agent definition changed after generation.
3. Choose **Apply proposal** only when it accurately represents the intended behavior.
4. Save and test the workflow before publishing.

Applied prompts retain provenance, including provider, model, generation mode, timestamp, and a source hash.

### Validate a draft

**Validate** runs authoritative server checks against the saved immutable draft revision. It reports blocking errors, warnings, and prompt-completeness findings without publishing anything.

Review common graph and manifest problems such as:

- A required definition is missing.
- An event connection is invalid.
- A node would be orphaned.
- The workflow contains an invalid cycle.

Fix blocking issues, save a new revision, and validate again. Server validation does not replace business review: a technically valid workflow can still route work incorrectly.

### Publish a draft

Before choosing **Publish**:

- Review the change count in the button and draft banner.
- Save and validate the exact revision you intend to publish.
- Run representative draft tests and inspect terminal outputs.
- Confirm every renamed event has matching senders and listeners.
- Confirm no required human approval was removed.
- Ask downstream owners about changes to events they consume.
- Make sure nobody else has published a newer version while you were editing.

After publication, check the first real runs and events. Past versions and run history remain available for traceability.

### Discard or continue later

Choose **Discard draft** to abandon current workflow changes and return to the live definition.

The page preserves unfinished draft state in the current browser for the selected tenant. If it restores the draft after a refresh, a banner shows when it was saved. Continue only if the changes are yours. Otherwise, discard them and coordinate with the previous editor.

A browser-restored draft is not a reliable team hand-off and does not follow you to another browser or device.

## Preview a new workflow

Choose **New workflow** and select how to start:

- **Blank canvas:** preview one starting box and plan the process yourself.
- **From template:** explore a prepared pattern for a common business process.
- **Import manifest:** preview the file-based path intended for technical users.

**Create workflow** persists a tenant-scoped server draft and opens it in Edit mode. It does not publish the workflow. For reviewed definition files, use **Import manifest** and inspect the resulting draft before publication.

### New workflow field reference

| Field                | What it means                             | What to enter                                                               |
| -------------------- | ----------------------------------------- | --------------------------------------------------------------------------- |
| **Display name**     | Friendly workflow name.                   | The business process name, such as `Customer Support Triage`.               |
| **Workflow ID**      | Stable technical identifier.              | Accept the suggested lowercase ID unless your naming policy says otherwise. |
| **Tenant**           | Workspace that owns the workflow.         | The team or organization whose agents and runs belong to it.                |
| **Default model**    | Starting AI model for new automated work. | Use the approved workspace default unless an expert recommends a change.    |
| **Trigger type**     | How a blank workflow begins.              | Event, Scheduled, Webhook, or Manual, based on the real process start.      |
| **First agent name** | First box on a blank canvas.              | A short technical name describing its action.                               |
| **Template**         | Prepared multi-step starting pattern.     | Choose the closest business process, then review every box and event.       |

Use the new draft to complete agent settings, validate, test, and gather review evidence before publication.

## Import a manifest

**Import manifest** accepts a workflow definition prepared outside the visual editor. This is an advanced path.

Before importing:

1. Confirm the files belong to the correct tenant.
2. Review every agent, trigger, emitted event, and tool permission.
3. Remove sample credentials or environment-specific values.
4. Validate the graph.
5. Review the reported change summary before publication.

Do not import files merely because the canvas is empty or the API is temporarily unreachable. The production portal does not create replacement sample data automatically.

## Worked example 1: customer support triage

### Goal

Classify a new support ticket and route urgent cases for human attention.

### Flow

```text
Receive ticket
    │ support.ticket.received
    ▼
Classify topic and urgency
    │ support.ticket.classified
    ▼
Human priority review
    │ support.ticket.approved
    ▼
Assign service queue
    │ support.ticket.routed
    ▼
Notify support team
```

### Trace it

1. Click **Classify topic and urgency**.
2. Confirm `support.ticket.received` appears under Triggers.
3. Confirm `support.ticket.classified` appears under Emits.
4. Click `support.ticket.classified`.
5. Confirm the human priority review and any ordinary routing boxes appear as listeners.
6. Open the event stream to confirm a real ticket produced the event.

### Safe change example

Suppose premium customers should always receive a human priority review. Enter the event emitted by the relevant routing agent, then enter the same event under **Triggered by** for the Human priority review box. Confirm that the canvas draws the link automatically. Test both premium and standard tickets, review the graph, and deploy only after the support owner reviews the change.

### Watch out

If you rename `support.ticket.classified`, update every listener that uses it. Otherwise, classification can succeed while routing silently stops.

## Worked example 2: invoice approval

### Goal

Check an invoice, pause for manager approval when required, and send the approved invoice to payment.

### Flow

```text
Read invoice
    │ invoice.received
    ▼
Check amount and supplier
    │ invoice.checked
    ▼
Manager approval
    │ invoice.approved
    ▼
Schedule payment
    │ payment.scheduled
    ▼
Record payment plan
```

### Trace it

1. Click **Manager approval** and confirm it is a human node.
2. Click `invoice.checked` to see the automated checker that emits it.
3. Click `invoice.approved` to see the payment step that listens for approval.
4. Use the event stream to locate a recent approval.
5. Open the related runs to confirm the correct invoice and workflow version were used.

### Safe change example

Suppose invoices below a policy threshold no longer need manager approval. Define the decision in the responsible agent, preserve the approval route for invoices at or above the threshold, and trace both branches. Test values just below, exactly at, and just above the threshold. Obtain approval from the finance control owner before publication.

### Watch out

Removing or bypassing Manager approval can change a financial control. A graph can be technically valid and still violate policy.

## Troubleshooting

### The canvas looks empty

1. Confirm the correct tenant is selected.
2. Wait for the API request to finish.
3. Look for an API-unreachable banner.
4. Scroll horizontally; a small workflow may begin in a later stage.
5. Ask the platform operator to check API health if data does not load.

Do not create or import a replacement workflow merely because the API is temporarily unavailable.

### A box never starts

1. Select the box and copy its trigger event name.
2. Select that event and find its upstream emitter.
3. Compare the exact spelling and capitalization.
4. Use the event stream to determine whether the event occurred.
5. Check Runs to determine whether the upstream box succeeded.

### The next box does not run

Confirm all of the following:

- The upstream run completed successfully.
- It emitted the expected event.
- The downstream box listens for that exact event.
- The event belongs to the correct tenant and subject.
- The runtime service was available when the event was dispatched.

### Publish is disabled

The button remains disabled when:

- The current edit has not been saved.
- The editor contains a blocking field error.
- A save, validation, or publication is already in progress.

Save the change, resolve editor errors, and validate the saved revision. Run representative tests before choosing **Publish**.

### Publication failed

Keep the draft and read the reported error. Common causes include:

- Invalid or incomplete agent definitions.
- Event names that do not satisfy validation rules.
- A conflicting newer workflow version.
- The API being unavailable.

If another person published a newer version, refresh and compare rather than repeatedly forcing the old draft.

### A draft returned after refresh

This is expected. The browser preserves unfinished changes for the current tenant. Read the restored timestamp. Continue only if the changes are yours; otherwise choose **Discard** and coordinate with the previous editor.

### I published the wrong workflow

Stop further edits and notify the workflow owner. Review the **Deployments** page and recent runs. Restore or republish the last known-good definition through the approved release process, then confirm event flow. Do not delete run history or rewrite old versions.

## Glossary

| Term             | Plain-language meaning                                                                     |
| ---------------- | ------------------------------------------------------------------------------------------ |
| **Agent**        | An automated unit of work with instructions, inputs, outputs, tools, and runtime settings. |
| **Canvas**       | The visual area containing workflow boxes and connecting lines.                            |
| **Draft**        | A working copy that does not affect live runs until published.                             |
| **Emit**         | Announce a named event after a box succeeds.                                               |
| **Event**        | A named message that can start another agent or human task.                                |
| **Event stream** | The chronological record of event occurrences.                                             |
| **Human task**   | A workflow step that waits for a person to review, decide, or enter information.           |
| **Live**         | The workflow version currently used for new production work.                               |
| **Manifest**     | The complete machine-readable workflow definition.                                         |
| **Node**         | A box representing an agent or human task.                                                 |
| **Run**          | One execution of one agent using a particular version and input.                           |
| **Run Console**  | Tests the current canvas or starts the published workflow with typed inputs and evidence.  |
| **Stage**        | A business phase or column in the workflow.                                                |
| **Tenant**       | The organization or workspace that owns the workflow and its data.                         |
| **Trigger**      | An event that is allowed to start a node.                                                  |
| **Validate**     | Runs authoritative server checks against the saved draft without publishing it.            |
| **Publish**      | Promotes one validated immutable draft revision to the live workflow.                      |
| **Version**      | An immutable saved or published snapshot of the workflow.                                  |

## Before publishing: quick checklist

- [ ] I can explain the changed path in ordinary business language.
- [ ] Every emitted event has the intended listener.
- [ ] Every trigger has an intended source.
- [ ] Event spelling and capitalization match exactly.
- [ ] No required human review or approval was removed.
- [ ] The exact saved revision has passed authoritative server validation.
- [ ] Representative draft tests passed and their terminal outputs were reviewed.
- [ ] The added, changed, and removed counts are expected.
- [ ] Affected process owners reviewed the change.
- [ ] I know how to confirm the first live runs and events.
- [ ] I know which previous version is the last known-good release.
