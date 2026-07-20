# Agent Studio user guide

Agent Studio helps you create, change, test, publish, and operate an agent without editing a manifest by hand. This guide is written for both business users and technical users. Start with Guided mode; Developer view is optional.

## The safe way to work

Use this sequence for every change:

1. Create or open an agent.
2. Choose **Edit**. If you opened the live version, Agent Studio creates a safe draft automatically.
3. Describe the agent and configure its instructions, inputs, outputs, steps, tools, and runtime.
4. Wait for **saved**, choose **Save** for an immediate checkpoint, or choose **Done** to save and return to protected View mode.
5. Open **Test Lab**, select **Draft**, and run realistic examples with **Safe test** tool effects.
6. Check the Trace, schema-valid Output, Logs, and Artifacts.
7. Choose **Check setup** and fix every blocking error.
8. Choose **Publish**, read the impact message, and confirm only when the change is intentional.

Saving a draft does not change the live agent. Publishing creates a new immutable live version. Runs already in progress continue using the version on which they started.

### Save, Check setup, Test, and Publish are different

| Action          | What it does                                                                                                           | Changes the live agent? |
| --------------- | ---------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| **Edit**        | Enters Edit mode. It uses the existing draft or creates one from the live version.                                     | No                      |
| **Save**        | Stores an editable draft revision. Autosave does the same after a short pause.                                         | No                      |
| **Done**        | Saves any remaining changes and returns the draft to protected View mode.                                              | No                      |
| **Cancel**      | Restores the draft to how it was when you entered Edit mode, including reversing autosaved changes after confirmation. | No                      |
| **Check setup** | Validates the saved definition for missing, invalid, or incompatible settings.                                         | No                      |
| **Run Draft**   | Executes one saved draft revision through the real runtime and stores the run history.                                 | No                      |
| **Run Live**    | Executes the currently published definition.                                                                           | No                      |
| **Publish**     | Validates and creates a new immutable live version.                                                                    | Yes                     |

## Create an agent

1. Open **Agents**.
2. Choose **New Agent**.
3. Pick a template:
   - **Blank agent** for a clean, event-driven starting point.
   - **Classifier** for choosing a category with confidence and review signals.
   - **Extractor** for turning text or documents into validated structured data.
   - **Deep Search** for evidence-backed research across approved web and ontology sources.
   - **Tool-loop agent** for bounded work that may call tools repeatedly.
   - **Human approval** for a durable operator decision.
4. Complete the six creation steps: Template, Identity, Events, Build, Runtime, and Review.
5. Declare one or more trigger events and emitted events. New agents do not require a workflow stage.
6. Read the pre-flight checks and choose **Create & publish**.
7. Choose **Open & run**, or open the new agent and choose **Edit** before refining it.

Creating an agent deploys its first version. Start with conservative tool permissions and runtime limits, then improve it through a tested draft.

## Understand the editor

- **Guided** presents ordinary form fields and is the recommended mode.
- **Developer view** exposes the complete JSON definition and a documentation-only TypeScript field.
- **Definition health** lists errors, warnings, and information. Errors block publishing.
- **View mode** protects fields from accidental changes while still allowing validation, testing, and publishing.
- **Editing** means the fields are unlocked on a safe draft. It never changes the live agent by itself.
- **Draft** means a safe working copy exists; a draft can be either protected in View mode or open in Edit mode.
- **Live** means the page is showing the read-only published version.
- **Versions** lists immutable definitions that were published previously.

The TypeScript reference in Developer view is stored but is not executed by the manifest Agent Studio runtime. Code-defined agents must be implemented and reviewed by an engineering team.

### Opening an older agent

Agent Studio handles older saved agents automatically:

- If an older manifest exists, Studio translates it into the current inputs, outputs, instructions, steps, tools, and runtime fields. Published history remains unchanged.
- If the agent has no usable manifest, Studio creates a safe starter draft from its saved name, owner type, and known event triggers. Review the generated instructions, inputs, step, and output, then test before publishing.
- If the agent is code-defined, Studio shows a read-only **Compatibility** view of its metadata. It does not silently convert or replace source-code behavior; engineering must update the source implementation or create a separate manifest agent.

The header identifies these states as **Upgraded format**, **Generated manifest**, or **Code-defined**. Automatic conversion never publishes a change by itself.

## Field-by-field reference

### Overview

| Field                 | What it means                                                          | What to enter                                                                  |
| --------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| **Display name**      | Friendly name shown in the portal.                                     | A short, specific name such as `Support Ticket Classifier`.                    |
| **Programmatic name** | Permanent identifier used by integrations and history.                 | Nothing while editing; it is read-only so links and past runs remain valid.    |
| **Purpose**           | Explains the agent to operators.                                       | Who it helps, what it does, and what a good result looks like.                 |
| **Owner type**        | Says whether AI or a person performs the work.                         | **AI agent** for model-driven work; **Human task** to pause for an operator.   |
| **Stage**             | Workflow phase or column.                                              | A whole number. Lower numbers normally appear earlier.                         |
| **Starting template** | Starting design pattern.                                               | Blank, classify, extract, RAG, loop, or human. Review every generated setting. |
| **Autosave**          | Saves the draft shortly after you stop typing while Edit mode is open. | Keep on for normal editing. It never publishes automatically.                  |

### Instructions

| Field or action                | What it means                                          | What to enter or do                                                                                           |
| ------------------------------ | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| **Agent instructions**         | Permanent role, objective, rules, and output behavior. | Write the role, objective, method, required behavior, guardrails, and what to do when information is missing. |
| **Write for me**               | Creates a first instruction draft with AI.             | Use it as a starting point, then review every statement.                                                      |
| **Improve**                    | Rewrites existing instructions for clarity.            | Use after the main intent is correct; confirm the meaning did not change.                                     |
| **Make shorter**               | Removes repetition.                                    | Use when instructions are too long; recheck important rules afterward.                                        |
| **Add safety rules**           | Proposes safety, privacy, and uncertainty rules.       | Use as a review aid for sensitive data or tools.                                                              |
| **Extra user-message context** | Adds declared context around the user's request.       | Usually keep it simple. Reference a declared input with `{{json inputs.context}}`.                            |

An AI agent has exactly one input with the behavior **Chat request**. Agent Studio automatically sends that value as the AI model's user message. Do not copy user text into Agent instructions.

A good instruction pattern is:

```text
You are [role].
Your objective is [outcome].

Follow these rules:
1. [rule]
2. [rule]

If required information is missing, [safe fallback].
Return only values that match the configured output contract.
```

### Inputs

An input is information needed to run the agent. An AI agent needs exactly one Chat request input and can have many Form value or File upload inputs.

| Field                          | What it means                                                   | What to enter                                                                                                         |
| ------------------------------ | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| **Internal field name**        | Stable key used by templates, APIs, and mappings.               | A short name without spaces, such as `customer_tier`. The Chat request input always uses `prompt`.                    |
| **Question shown to users**    | Friendly label in Test Lab.                                     | A phrase such as `Customer tier`.                                                                                     |
| **How this input is provided** | How the value is used.                                          | **Chat request** for the main message, **Form value** for structured information, or **File upload** for attachments. |
| **Privacy level**              | Controls handling, visibility, and redaction.                   | Normal, Personal, Confidential, or Secret. Choose the strictest accurate level.                                       |
| **Help text for this field**   | Help shown to the person running the agent.                     | Explain what to provide, its format or units, and where it comes from.                                                |
| **Require this input**         | Blocks a run when the value is absent.                          | Turn it on only if the agent cannot produce a useful result without the value.                                        |
| **Type of information**        | Defines the basic text, number, yes/no, list, or object shape.  | Choose a simple type; this is enough for most fields.                                                                 |
| **Advanced validation rules**  | Optional JSON Schema rules for exact shapes and allowed values. | Use one of the patterns below, or ask a technical user for complex objects.                                           |
| **Pre-filled value**           | Automatically supplied when no value is provided.               | A safe, realistic default or `null`. Do not hide truly required information with a default.                           |
| **Example shown to builders**  | Sample shown to reviewers and testers.                          | Plausible non-sensitive data.                                                                                         |
| **Allowed file types**         | File formats accepted by a File upload input.                   | Comma-separated MIME types, such as `application/pdf, text/plain`.                                                    |
| **Maximum file size**          | Largest accepted file.                                          | A whole number of bytes; `10000000` is about 10 MB.                                                                   |
| **Allow more than one file**   | Allows several files for one input.                             | Turn on only if the instructions and tools handle a collection.                                                       |

Common schemas:

```json
{ "type": "string" }
```

```json
{ "type": "number", "minimum": 0, "maximum": 100 }
```

```json
{ "type": "string", "enum": ["standard", "premium", "enterprise"] }
```

```json
{
  "type": "object",
  "properties": {
    "name": { "type": "string" },
    "score": { "type": "number" }
  },
  "required": ["name"]
}
```

### Outputs

Every completed run produces one aggregate JSON document. Each named output is validated against its schema.

| Field                         | What it means                        | What to enter                                                                       |
| ----------------------------- | ------------------------------------ | ----------------------------------------------------------------------------------- |
| **Internal field name**       | Stable result key for integrations.  | A short name such as `category`, `summary`, or `next_actions`.                      |
| **Question shown to users**   | Friendly result name.                | Words an operator recognizes, such as `Recommended queue`.                          |
| **Privacy level**             | Classification of the result.        | Use the most sensitive category the output may contain.                             |
| **Help text for this field**  | Definition of a correct result.      | Explain meaning, units, and allowed values.                                         |
| **Require this output**       | Fails output validation when absent. | Turn on for every value people or downstream systems rely on.                       |
| **JSON Schema**               | Required type and shape.             | Start with a simple type. Add `enum`, `properties`, or `required` only when useful. |
| **Example shown to builders** | One valid result.                    | A small, realistic sample that matches the schema.                                  |

### Saved JSON and run records

| Field                                     | What it means                                                         | Recommended choice                                                                           |
| ----------------------------------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| **Output file name**                      | Name of the aggregate JSON result.                                    | A descriptive name ending in `.json`, such as `ticket-classification.json`.                  |
| **Automatic correction attempts**         | How often the runtime may ask the model to fix invalid output.        | Start with 1. Zero disables correction; maximum is 3. More attempts add time and cost.       |
| **Require the declared output format**    | Fails the run if the model cannot produce the declared fields.        | Keep on when people or downstream systems need a predictable result.                         |
| **Return a single output directly**       | Returns one declared output as its value instead of a wrapper object. | Turn on for a simpler caller response; the complete JSON file is still saved.                |
| **Save each output as a separate file**   | Saves individual result files as well as the aggregate.               | Turn on only when downstream consumers need separate files.                                  |
| **Save the run's inputs**                 | Stores the structured values used by the run.                         | Usually on for reproducibility; follow your retention policy.                                |
| **Always save run details**               | Stores version, timing, validation, usage, artifacts, and events.     | Always on; this is required for traceability.                                                |
| **Save the model's unprocessed response** | Stores text before validation and cleanup.                            | Leave off. Enable temporarily only for approved debugging; it may contain sensitive content. |

### Steps: common fields

A step is one item in the ordered execution plan. In most simple agents, one **AI / logic** step is enough.

| Field              | What it means                                              | What to enter                                                                                        |
| ------------------ | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| **Order**          | Position in the sequence.                                  | `1`, `2`, `3`, and so on. Prefer Move up/down to manual renumbering.                                 |
| **Stable step ID** | Permanent reference used by condition branches and traces. | A unique technical name such as `classify_ticket`. Avoid changing it after other fields refer to it. |
| **Step name**      | Readable name in traces.                                   | A verb and object, such as `Classify ticket`.                                                        |
| **Type**           | Kind of work performed.                                    | AI / logic, Tool, Human task, Condition, Delay (preview), or Subflow (preview).                      |
| **Description**    | Step purpose.                                              | Describe the intended outcome in plain language.                                                     |
| **Step prompt**    | Extra instructions for one AI step.                        | State only the local task and constraints. Leave blank if Agent instructions already cover it.       |
| **Input mapping**  | Selects or renames values supplied to this step.           | Leave `{}` for ordinary use. A technical example is `{"ticket":"inputs.prompt"}`.                    |
| **Output mapping** | Gives this step result a name for later steps.             | Leave `{}` unless a later step or output needs an explicit mapping.                                  |

### Step types and their fields

#### AI / logic

| Field                  | What it means                                              | What to enter                                          |
| ---------------------- | ---------------------------------------------------------- | ------------------------------------------------------ |
| **Step prompt**        | Instructions limited to this model step.                   | The local task and constraints.                        |
| **AI retry attempts**  | Retries only the model step after an eligible model error. | Usually 0–2. Tools are never retried automatically.    |
| **AI step time limit** | Maximum seconds for this model step.                       | Start around 120 and adjust after observing real runs. |

#### Tool

| Field         | What it means                            | What to enter                                                          |
| ------------- | ---------------------------------------- | ---------------------------------------------------------------------- |
| **Tool name** | Exact catalog tool executed by the step. | Copy its name from Tools and also choose **Allow tool** for that tool. |

#### Human task

| Field                          | What it means                  | What to enter                                                    |
| ------------------------------ | ------------------------------ | ---------------------------------------------------------------- |
| **Task instructions**          | Work the person must complete. | Decision to make, evidence to review, and completion criteria.   |
| **Task type**                  | Classification of the task.    | A team convention such as `approval`, `review`, or `correction`. |
| **Awaiting role**              | Role responsible for the task. | A configured role such as `operator` or `compliance-reviewer`.   |
| **Human response form schema** | Fields the operator completes. | A small JSON object with clearly labeled required answers.       |

#### Condition

| Field                    | What it means                     | What to enter                                                       |
| ------------------------ | --------------------------------- | ------------------------------------------------------------------- |
| **Condition expression** | Restricted yes/no test.           | For example, `inputs.score >= 70` or `lastResult.approved == true`. |
| **When true**            | Next step when the test succeeds. | A later Stable step ID, or continue to the next step.               |
| **When false**           | Next step when the test fails.    | A later Stable step ID, or continue to the next step.               |

#### Delay and Subflow

Delay and Subflow are preview features. Their settings are retained, validated, and traced, but production does not wait on a durable delay or invoke a subflow yet.

| Field                      | What it means                                             | What to enter                                     |
| -------------------------- | --------------------------------------------------------- | ------------------------------------------------- |
| **Delay (milliseconds)**   | Planned wait duration.                                    | `60000` means one minute.                         |
| **Subflow agent or event** | Planned target workflow or agent.                         | Its configured agent or event name.               |
| **Wait policy**            | Whether a future subflow should finish before continuing. | Wait for completion or Start and continue.        |
| **Subflow input**          | Values intended for that target.                          | A JSON object whose keys match the target inputs. |

### Tools

Tools let an agent read data or take actions outside the language model.

| Field or action         | What it means                               | What to do                                                                                                                                    |
| ----------------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| **Search tool catalog** | Finds tools available in this installation. | Search by action or system and read the full description.                                                                                     |
| **Allow tool**          | Gives this agent permission to call a tool. | Allow only tools the agent needs. The list is a security boundary.                                                                            |
| **Remove permission**   | Revokes permission.                         | Remove unused tools.                                                                                                                          |
| **Tool settings**       | Non-secret settings the tool needs.         | Use the documented keys shown below the editor. Reference credential environment variables where supported; never paste secrets into prompts. |

### Runtime: model and generation

| Field                     | What it means                 | What to enter                                                                                   |
| ------------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------- |
| **AI provider**           | AI service used by the agent. | Use the workspace default unless an approved use case needs another.                            |
| **AI model**              | Provider model identifier.    | Leave blank to inherit, or enter an available model name.                                       |
| **Creativity**            | How varied responses may be.  | Use 0–0.3 for extraction or classification; 0.5–0.8 can suit writing. Test before going higher. |
| **Maximum answer length** | Upper response-length limit.  | Enough for the output schema without allowing unnecessary length.                               |

### Runtime: reliability and capacity

| Field                       | What it means                            | What to enter                                                                     |
| --------------------------- | ---------------------------------------- | --------------------------------------------------------------------------------- |
| **Run time limit**          | Maximum allowed run duration in seconds. | Start with 120; increase only for known long work.                                |
| **Retry attempts**          | Eligible whole-run retry attempts.       | Usually 1–3. Be careful when tools write or send.                                 |
| **Maximum tool turns**      | Maximum model-to-tool cycles.            | A modest limit such as 4–8 prevents loops and unexpected cost.                    |
| **Runs at the same time**   | Maximum simultaneous runs in a group.    | A number that providers and downstream services can safely handle.                |
| **Group runs by**           | Groups runs that share the limit.        | A stable subject or customer key; leave blank when no special grouping is needed. |
| **Limit simultaneous runs** | Enables that protection.                 | Keep on for burst traffic or rate-limited services.                               |

### Runtime: trace and retention

| Field                                      | What it means                                    | What to enter                                                                                   |
| ------------------------------------------ | ------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| **Run detail level**                       | Amount of operational detail stored.             | Standard normally; Minimal for lower retention; Debug temporarily for approved troubleshooting. |
| **Capture reasoning summaries**            | Stores concise explanations of decisions.        | Usually on. Hidden chain-of-thought is never exposed.                                           |
| **Save final prompts for troubleshooting** | Stores prompts after input templates are filled. | Leave off unless approved debugging requires it; final prompts can contain sensitive data.      |
| **Keep run details for**                   | How many days observability data is kept.        | Follow organization data and audit policy, for example 30.                                      |

### Schedule

| Field                 | What it means                          | What to enter                                                                        |
| --------------------- | -------------------------------------- | ------------------------------------------------------------------------------------ |
| **Schedule**          | Repeating time schedule.               | Five-part cron, such as `0 9 * * 1-5` for 9:00 on weekdays; blank means no schedule. |
| **Schedule timezone** | Region used to interpret the schedule. | IANA name such as `Asia/Singapore`, not an abbreviation such as `SGT`.               |

### Workflow events

| Field                                 | What it means                                | What to enter                                                                                  |
| ------------------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| **Events that start this agent**      | Events that start this agent.                | One registered name per line or comma-separated.                                               |
| **How event data fills inputs**       | Maps incoming event fields into inputs.      | Leave `{}` when names already match. Technical example: `{"customer_tier":"event.data.tier"}`. |
| **Events sent after success**         | Events sent after success.                   | Registered event names understood by downstream workflows.                                     |
| **What each outgoing event contains** | Builds outgoing payloads from named outputs. | Map event fields to output paths, then check downstream impact in the workflow editor.         |

### Versions and Developer view

| Field                                         | What it means                                   | What to do                                                                                                   |
| --------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| **Versions**                                  | Immutable published definitions.                | Use the list to identify what was live for a past run.                                                       |
| **Complete definition (developer JSON)**      | Complete JSON source behind Guided mode.        | Use only when comfortable with the manifest. Keep **Valid definition** green and still choose Check setup.   |
| **TypeScript reference (documentation only)** | Documentation reserved for code-defined agents. | Leave blank unless engineering owns the matching code. Publishing this text does not deploy or execute code. |

## Test Lab guide

### Prepare a run

1. Save the draft.
2. Open **Test Lab**.
3. Select **Draft** to test changes or **Live** to test the published version.
4. Enter a realistic answer to **What should the agent do?**
5. Complete all required variables. **Form** and **JSON** are two views of the same values.
6. Expand **Advanced test settings** only when needed.
7. Start with **Safe test** tool effects.

### Tool effects

| Setting          | Behavior                                       | When to use                                                                   |
| ---------------- | ---------------------------------------------- | ----------------------------------------------------------------------------- |
| **Safe test**    | Runs only tools explicitly approved for tests. | First choice for ordinary tests.                                              |
| **Read-only**    | Allows approved reads and blocks writes.       | Inspect real source data without changing external systems.                   |
| **Live effects** | Allows configured tool effects.                | Only when you understand each allowed tool and intend its real-world changes. |

**Stop** asks an active run to cancel at a safe checkpoint. It cannot reverse an external action a tool already completed.

### One-run overrides

Temporary AI provider, model, creativity, answer length, and time limit in Test Lab change only that run. Leave them blank to use agent or workspace settings. They are useful for controlled comparisons, not permanent configuration.

### Read the result

1. **Trace** shows the time-ordered steps, tool decisions, and safe reasoning summaries. Start here.
2. **Output** shows schema-validated JSON. Check the content and the **Schema valid** badge.
3. **Logs** provide technical detail after Trace identifies an affected step.
4. **Artifacts** contain saved files, including the aggregate output JSON and run record.
5. **Run history** reopens prior prompts, statuses, durations, traces, outputs, logs, and artifacts.

### Minimum test set before publishing

- A normal, complete request.
- A vague or incomplete request.
- A boundary value or uncommon category.
- A request containing sensitive content or instructions outside the agent's role.
- A tool case in Safe test or Read-only mode, followed by Live effects only in an approved environment.

## Worked example 1: Support Ticket Classifier

### Goal

Route a new support request to `billing`, `technical`, `account`, or `other`, and assign urgency.

### Configuration

- **Display name:** Support Ticket Classifier
- **Purpose:** Classifies incoming support tickets and recommends the correct queue.
- **Template:** classify
- **Inputs:**
  - `prompt`: Chat request, required text
  - `customer_tier`: Form value, optional, choices `standard`, `premium`, `enterprise`
- **Outputs:**
  - `category`: required enum `billing`, `technical`, `account`, `other`
  - `urgency`: required enum `low`, `normal`, `high`, `critical`
  - `rationale`: required string
- **Steps:** one AI / logic step named `Classify ticket`
- **Temperature:** `0.1`
- **Automatic correction attempts:** `1`
- **Output file name:** `ticket-classification.json`
- **Tools:** none

### Agent instructions

```text
You classify customer support tickets.
Choose exactly one category: billing, technical, account, or other.
Choose urgency: low, normal, high, or critical.
Base the answer only on the request. If evidence is weak, choose other.
Keep the rationale to one sentence.
Return values that match the configured output contract.
```

### Test prompt

```text
I reset my security key and now every login attempt fails. I need access before today's payroll run.
```

### Example output

```json
{
  "category": "technical",
  "urgency": "high",
  "rationale": "The customer cannot authenticate after a security-key reset."
}
```

Test an unclear request too, such as `It does not work`, and verify that the agent safely chooses `other` instead of inventing details.

## Worked example 2: Document Summarizer

### Goal

Turn long text into a short summary, key points, and explicit follow-up actions.

### Configuration

- **Display name:** Document Summarizer
- **Purpose:** Summarizes a document for a named audience without inventing facts.
- **Template:** extract
- **Inputs:**
  - `prompt`: Chat request, required text
  - `document_text`: Form value, required text
  - `audience`: Form value, optional text; pre-filled value `executive reader`
- **Outputs:**
  - `summary`: required string
  - `key_points`: required array of strings
  - `action_items`: required array of strings
- **Steps:** one AI / logic step named `Summarize document`
- **Temperature:** `0.2`
- **Maximum tokens:** `2000`
- **Output file name:** `document-summary.json`
- **Tools:** none when text is pasted directly

### Agent instructions

```text
You summarize documents for the named audience.
Use only facts present in document_text.
Write a concise summary, 3–7 key points, and explicit action items.
If the document has no action items, return an empty list.
Do not invent owners, dates, or decisions.
Return values that match the configured output contract.
```

### Extra user-message context

```text
Audience: {{json inputs.audience}}

Document:
{{json inputs.document_text}}
```

### Test prompt

```text
Summarize the document. Focus on decisions, risks, and actions.
```

### Example output

```json
{
  "summary": "The team approved a phased migration beginning in August.",
  "key_points": [
    "Phase one covers internal users",
    "A security review is required before external rollout"
  ],
  "action_items": ["Operations will publish the rollout calendar"]
}
```

To accept an uploaded document instead, change `document_text` to a File upload input, configure allowed file types and maximum file size, and allow an approved document-reading tool. Test the tool with Safe test or Read-only before allowing Live effects.

## Operate and troubleshoot an agent

### A run does not start

- Save the draft; Test Lab cannot pin unsaved edits.
- Fill all required inputs.
- Enter a non-empty answer to **What should the agent do?**
- Correct invalid one-run overrides.
- Confirm the chosen Draft or Live version exists.

### Validation fails

- Choose each item in Definition health to open the related section.
- Look for duplicate or blank input/output IDs.
- Confirm there is exactly one Chat request input for an AI agent.
- Check that JSON Schemas and mappings are valid JSON.
- Confirm Tool steps refer to tools allowed in Tools.
- Confirm condition branches point to later Stable step IDs.

### Output is invalid

- Compare the Output with each required output schema.
- Make Agent instructions explicitly name the required fields and allowed values.
- Add a valid **Example shown to builders** to each output.
- Keep one repair attempt enabled.
- Reduce ambiguity and temperature for classification or extraction.

### A run is slow

- Use Trace to locate the slow step.
- Review model and tool timeouts.
- Check whether the tool loop is making unnecessary calls.
- Reduce the input size or maximum output length where appropriate.
- Do not raise timeouts until the slow operation is understood.

### A tool behaves unexpectedly

- Stop the run if it is still active.
- Remember that Stop does not undo completed external changes.
- Remove unnecessary tool permissions.
- Repeat with Read-only and inspect the Trace and Logs.
- Review tool settings with their owner before another Live effects run.

## Glossary

| Term                      | Meaning                                                                                                          |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| **Agent**                 | A configured worker that receives inputs, follows instructions and steps, and produces validated outputs.        |
| **Artifact**              | A file retained from a run, such as `output.json` or an individual named result.                                 |
| **Draft**                 | A safe working copy that does not affect the live agent; it is protected in View mode and unlocked in Edit mode. |
| **View mode**             | The protected default for inspecting, testing, validating, or publishing without accidentally changing fields.   |
| **Edit mode**             | Unlocks a draft for changes. Save and Done keep changes; Cancel restores the start of the edit session.          |
| **Event**                 | A named message that starts an agent or notifies a downstream workflow.                                          |
| **Input/output contract** | The declared data callers provide and the result shape the agent promises.                                       |
| **JSON**                  | Structured text made of objects, lists, text, numbers, true/false, and null.                                     |
| **JSON Schema**           | Rules that validate the type and shape of JSON.                                                                  |
| **Live**                  | The currently published operational version.                                                                     |
| **Manifest**              | The complete machine-readable workflow and agent definition.                                                     |
| **Generated manifest**    | A safe editable starting draft created for an older agent with no usable saved manifest.                         |
| **Compatibility view**    | A read-only current-format view of code-defined metadata; it does not reproduce the source behavior.             |
| **Chat request**          | The user's request, automatically sent as the AI model's user message.                                           |
| **Provider/model**        | The AI service and particular model used to produce a response.                                                  |
| **Reasoning summary**     | A concise safe explanation of a decision, not hidden chain-of-thought.                                           |
| **Run**                   | One execution of one pinned definition with particular inputs.                                                   |
| **Agent instructions**    | Standing directions that define role, rules, and response behavior.                                              |
| **Tool**                  | An approved capability that reads data or takes action outside the model.                                        |
| **Trace**                 | Time-ordered steps and important runtime decisions for a run.                                                    |
| **Validation**            | Checks that definitions, inputs, and outputs match their contracts.                                              |
| **Version**               | An immutable published snapshot linked to the runs that used it.                                                 |

## Final publishing checklist

- The Display name and Purpose are clear to someone outside the project.
- Agent instructions define role, rules, missing-information behavior, and output expectations.
- There is exactly one Chat request input and every other input has useful help text.
- Required outputs have strict enough schemas and realistic examples.
- Step IDs are stable and condition branches point to the intended steps.
- Only necessary tools are allowed; configuration contains no pasted secrets.
- Runtime limits are conservative and retention follows policy.
- A normal, incomplete, boundary, safety, and tool test have been reviewed.
- The final output says **Schema valid**.
- Workflow owners reviewed changed triggers, outputs, or event bindings.
- Definition health has no blocking errors.
- The publish impact confirmation matches the intended change.
