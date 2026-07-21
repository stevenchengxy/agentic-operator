"use client";

import type { ReactNode } from "react";
import { Badge, Button } from "@/app/portal/components";
import { useI18n } from "@/app/portal/lib/preferences-context";
import { studioUi } from "./copy";
import {
  EmptySection,
  Field,
  InlineNotice,
  JsonValueEditor,
  SelectInput,
  TextArea,
  TextInput,
} from "./fields";
import type { StudioAction } from "./model";

const STEP_TYPE_GUIDANCE: Record<
  StudioAction["type"],
  { label: string; summary: string; example: string }
> = {
  logic: {
    label: "AI / logic",
    summary:
      "Ask the AI model to understand, write, classify, or transform information.",
    example:
      "Example: read the customer request and produce a concise, friendly reply.",
  },
  tool: {
    label: "Tool",
    summary:
      "Call one approved capability, such as searching, reading a file, or saving a result.",
    example:
      "Example: call fs.readFromInbox to load a document before the next AI step.",
  },
  manual: {
    label: "Human task",
    summary:
      "Pause a published run and ask a person to review, approve, or provide information. Studio test runs record the request without waiting.",
    example:
      "Example: ask a delivery manager to approve a high-value refund before continuing.",
  },
  condition: {
    label: "Condition",
    summary: "Choose what happens next by checking a simple yes/no rule.",
    example:
      "Example: if lastResult.score >= 70, continue to Approve; otherwise go to Review.",
  },
  delay: {
    label: "Delay (preview)",
    summary:
      "Record a planned waiting period. Durable production waiting is not enabled yet.",
    example:
      "Example: 60000 milliseconds represents a planned wait of one minute.",
  },
  subflow: {
    label: "Subflow (preview)",
    summary:
      "Describe a hand-off to another agent or event. Production invocation is not enabled yet.",
    example: "Example: pass the approved request to an order-fulfilment agent.",
  },
};

function StepTypeGuide() {
  const { t } = useI18n();
  return (
    <details
      className="agent-studio-step-type-guide"
      style={{
        border: "1px solid var(--border)",
        borderRadius: 6,
        background: "var(--bg-2)",
      }}
    >
      <summary
        style={{
          padding: "9px 11px",
          cursor: "pointer",
          color: "var(--text-2)",
          fontSize: 12,
          fontWeight: 600,
        }}
      >
        {studioUi(t, "Which step type should I choose?")}
      </summary>
      <div
        className="agent-studio-step-type-guide-grid"
        style={{
          display: "grid",
          gridTemplateColumns:
            "repeat(auto-fit, minmax(min(230px, 100%), 1fr))",
          gap: 8,
          padding: "2px 11px 11px",
        }}
      >
        {(Object.keys(STEP_TYPE_GUIDANCE) as StudioAction["type"][]).map(
          (type) => {
            const guidance = STEP_TYPE_GUIDANCE[type];
            return (
              <div
                key={type}
                style={{
                  padding: "8px 9px",
                  border: "1px solid var(--border)",
                  borderRadius: 4,
                  background: "var(--panel-2)",
                }}
              >
                <div
                  style={{
                    marginBottom: 3,
                    color: "var(--text)",
                    fontSize: 12,
                    fontWeight: 600,
                  }}
                >
                  {studioUi(t, guidance.label)}
                </div>
                <div
                  style={{
                    color: "var(--text-2)",
                    fontSize: 11.5,
                    lineHeight: 1.5,
                  }}
                >
                  {studioUi(t, guidance.summary)}
                </div>
              </div>
            );
          },
        )}
      </div>
    </details>
  );
}

function CurrentStepHelp({ type }: { type: StudioAction["type"] }) {
  const { t } = useI18n();
  const guidance = STEP_TYPE_GUIDANCE[type];
  const preview = type === "delay" || type === "subflow";
  return (
    <InlineNotice
      tone={preview ? "amber" : "blue"}
      title={studioUi(t, "{type} step", {
        type: studioUi(t, guidance.label),
      })}
    >
      <div>{studioUi(t, guidance.summary)}</div>
      <details style={{ marginTop: 4 }}>
        <summary
          style={{
            cursor: "pointer",
            color: "var(--text-2)",
            fontSize: 11.5,
            fontWeight: 600,
          }}
        >
          {studioUi(t, "Show an example")}
        </summary>
        <div
          style={{
            marginTop: 3,
            color: "var(--text-2)",
            fontSize: 11.5,
            lineHeight: 1.5,
          }}
        >
          {studioUi(t, guidance.example)}
        </div>
      </details>
    </InlineNotice>
  );
}

function JsonFieldHelp({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        marginBottom: 6,
        color: "var(--text-2)",
        fontSize: 11.5,
        lineHeight: 1.5,
      }}
    >
      {children}
    </div>
  );
}

export function StepsEditor({
  actions,
  onChange,
  disabled,
}: {
  actions: StudioAction[];
  onChange: (actions: StudioAction[]) => void;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  function add() {
    onChange([
      ...actions,
      {
        order: String(actions.length + 1),
        name: `step${actions.length + 1}`,
        type: "logic",
      },
    ]);
  }

  if (actions.length === 0) {
    return (
      <div
        className="agent-studio-steps-editor"
        style={{ display: "grid", gap: 10, minWidth: 0 }}
      >
        <StepTypeGuide />
        <EmptySection
          title={studioUi(t, "No steps")}
          hint={studioUi(t, "Add the first thing this agent should do.")}
          actionLabel={studioUi(t, "Add step")}
          onAction={add}
        />
      </div>
    );
  }

  return (
    <div
      className="agent-studio-steps-editor"
      style={{ display: "grid", gap: 10, minWidth: 0 }}
    >
      <StepTypeGuide />
      {actions.map((action, index) => {
        const update = (patch: Partial<StudioAction>) =>
          onChange(
            actions.map((item, itemIndex) =>
              itemIndex === index ? { ...item, ...patch } : item,
            ),
          );
        const updateIdentity = (patch: { id?: string; name?: string }) => {
          const previousTarget = String(action.id ?? action.name);
          const updatedAction = { ...action, ...patch };
          const nextTarget = String(updatedAction.id ?? updatedAction.name);
          onChange(
            actions.map((item, itemIndex) => {
              const next = (
                itemIndex === index ? updatedAction : { ...item }
              ) as StudioAction;
              return {
                ...next,
                ...(next["true_action_id"] === previousTarget
                  ? { true_action_id: nextTarget }
                  : {}),
                ...(next["false_action_id"] === previousTarget
                  ? { false_action_id: nextTarget }
                  : {}),
              } as StudioAction;
            }),
          );
        };
        const branchOptions = [
          { value: "", label: studioUi(t, "Continue to the next step") },
          ...actions.slice(index + 1).map((candidate) => ({
            value: String(candidate.id ?? candidate.name),
            label: `${candidate.order} · ${candidate.name}`,
          })),
        ];
        return (
          <details
            key={`${action.order}-${index}`}
            open={index === 0}
            className="agent-studio-step-card"
            style={{
              border: "1px solid var(--border)",
              borderRadius: 6,
              background: "var(--panel-2)",
              minWidth: 0,
            }}
          >
            <summary
              className="agent-studio-step-card-summary"
              style={{
                display: "flex",
                alignItems: "center",
                flexWrap: "wrap",
                gap: 9,
                padding: "10px 12px",
                cursor: "pointer",
                listStyle: "none",
              }}
            >
              <span
                className="agent-studio-step-card-order mono"
                style={{
                  flex: "0 0 24px",
                  color: "var(--signal)",
                  fontSize: 11.5,
                  fontWeight: 600,
                }}
              >
                {action.order}
              </span>
              <span
                className="agent-studio-step-card-title"
                style={{
                  flex: "1 1 180px",
                  minWidth: 0,
                  fontSize: 12,
                  color: "var(--text)",
                  fontWeight: 600,
                }}
              >
                {action.name}
              </span>
              <Badge
                tone={
                  action.type === "tool"
                    ? "blue"
                    : action.type === "manual"
                      ? "violet"
                      : "muted"
                }
              >
                {studioUi(t, STEP_TYPE_GUIDANCE[action.type].label)}
              </Badge>
            </summary>
            <div
              className="agent-studio-step-card-body"
              style={{
                padding: "4px 12px 14px 45px",
                borderTop: "1px solid var(--border)",
                display: "grid",
                gap: 12,
                minWidth: 0,
              }}
            >
              <CurrentStepHelp type={action.type} />
              <div
                className="agent-studio-step-identity-grid"
                style={{
                  display: "grid",
                  gridTemplateColumns:
                    "repeat(auto-fit, minmax(min(220px, 100%), 1fr))",
                  gap: 10,
                  marginTop: 12,
                  minWidth: 0,
                }}
              >
                <Field
                  label={studioUi(t, "Order")}
                  hint={studioUi(
                    t,
                    "When this step runs. Use Move up or Move down to reorder safely.",
                  )}
                >
                  <TextInput
                    value={action.order}
                    mono
                    disabled={disabled}
                    onChange={(order) => update({ order })}
                  />
                </Field>
                <Field
                  label={studioUi(t, "Stable step ID")}
                  hint={studioUi(
                    t,
                    "A unique internal reference for branches and traces. Leave blank to use the step name; avoid changing it after connecting conditions.",
                  )}
                >
                  <TextInput
                    value={String(action.id ?? "")}
                    mono
                    disabled={disabled}
                    placeholder={action.name}
                    onChange={(id) => updateIdentity({ id: id || undefined })}
                  />
                </Field>
                <Field
                  label={studioUi(t, "Step name")}
                  hint={studioUi(
                    t,
                    "A short label shown in run history, such as draftReply or managerReview.",
                  )}
                >
                  <TextInput
                    value={action.name}
                    mono
                    disabled={disabled}
                    onChange={(name) => updateIdentity({ name })}
                  />
                </Field>
                <Field
                  label={studioUi(t, "Type")}
                  hint={studioUi(
                    t,
                    "What this step does. Selecting a type reveals only the settings it needs.",
                  )}
                >
                  <SelectInput
                    value={action.type}
                    disabled={disabled}
                    onChange={(type) =>
                      update({ type: type as StudioAction["type"] })
                    }
                    options={[
                      { value: "logic", label: studioUi(t, "AI / logic") },
                      { value: "tool", label: studioUi(t, "Tool") },
                      { value: "manual", label: studioUi(t, "Human task") },
                      { value: "condition", label: studioUi(t, "Condition") },
                      {
                        value: "delay",
                        label: studioUi(t, "Delay (preview)"),
                      },
                      {
                        value: "subflow",
                        label: studioUi(t, "Subflow (preview)"),
                      },
                    ]}
                  />
                </Field>
              </div>
              <Field
                label={studioUi(t, "Description")}
                hint={studioUi(
                  t,
                  "Explain this step's purpose to teammates. This is documentation; it does not tell the AI what to do.",
                )}
              >
                <TextArea
                  value={action.description ?? ""}
                  rows={2}
                  disabled={disabled}
                  placeholder={studioUi(
                    t,
                    "Example: Create a first draft from the customer's request.",
                  )}
                  onChange={(description) => update({ description })}
                />
              </Field>
              {(action.type === "logic" || action.type === "manual") && (
                <Field
                  label={
                    action.type === "logic"
                      ? studioUi(t, "Step prompt")
                      : studioUi(t, "Task instructions")
                  }
                  hint={
                    action.type === "logic"
                      ? studioUi(
                          t,
                          "Optional directions for this AI step only. The agent's main Instructions still apply.",
                        )
                      : studioUi(
                          t,
                          "Tell the person exactly what to review, decide, or provide.",
                        )
                  }
                >
                  <TextArea
                    value={String(action.action_prompt ?? "")}
                    rows={4}
                    mono
                    disabled={disabled}
                    placeholder={
                      action.type === "logic"
                        ? studioUi(
                            t,
                            "Example: Return a three-sentence summary and list any missing facts.",
                          )
                        : studioUi(
                            t,
                            "Example: Check the proposed refund and approve or reject it with a short reason.",
                          )
                    }
                    onChange={(action_prompt) => update({ action_prompt })}
                  />
                </Field>
              )}
              {action.type === "tool" && (
                <Field
                  label={studioUi(t, "Tool name")}
                  hint={studioUi(
                    t,
                    "Enter the exact name of a tool enabled in this agent's Tools section. Example: fs.readFromInbox.",
                  )}
                >
                  <TextInput
                    value={String(action.tool ?? "")}
                    mono
                    disabled={disabled}
                    placeholder={studioUi(t, "Example: fs.readFromInbox")}
                    onChange={(tool) => update({ tool })}
                  />
                </Field>
              )}
              {action.type === "condition" && (
                <div style={{ display: "grid", gap: 10 }}>
                  <Field
                    label={studioUi(t, "Condition expression")}
                    hint={studioUi(
                      t,
                      "A simple yes/no check. Use an input, event value, or the previous step result; for example: inputs.score >= 70 or lastResult.approved == true.",
                    )}
                  >
                    <TextInput
                      value={String(action.condition ?? "")}
                      mono
                      disabled={disabled}
                      placeholder={studioUi(
                        t,
                        "Example: lastResult.approved == true",
                      )}
                      onChange={(condition) => update({ condition })}
                    />
                  </Field>
                  <div
                    className="agent-studio-step-fields-grid"
                    style={{
                      display: "grid",
                      gridTemplateColumns:
                        "repeat(auto-fit, minmax(min(220px, 100%), 1fr))",
                      gap: 10,
                      minWidth: 0,
                    }}
                  >
                    <Field
                      label={studioUi(t, "When true")}
                      hint={studioUi(
                        t,
                        "Choose a later step to run when the rule passes, or continue normally.",
                      )}
                    >
                      <SelectInput
                        value={String(action.true_action_id ?? "")}
                        disabled={disabled}
                        onChange={(true_action_id) =>
                          update({
                            true_action_id: true_action_id || undefined,
                          })
                        }
                        options={branchOptions}
                      />
                    </Field>
                    <Field
                      label={studioUi(t, "When false")}
                      hint={studioUi(
                        t,
                        "Choose a later step to run when the rule does not pass, or continue normally.",
                      )}
                    >
                      <SelectInput
                        value={String(action.false_action_id ?? "")}
                        disabled={disabled}
                        onChange={(false_action_id) =>
                          update({
                            false_action_id: false_action_id || undefined,
                          })
                        }
                        options={branchOptions}
                      />
                    </Field>
                  </div>
                </div>
              )}
              {action.type === "manual" && (
                <div style={{ display: "grid", gap: 10 }}>
                  <div
                    className="agent-studio-step-fields-grid"
                    style={{
                      display: "grid",
                      gridTemplateColumns:
                        "repeat(auto-fit, minmax(min(220px, 100%), 1fr))",
                      gap: 10,
                      minWidth: 0,
                    }}
                  >
                    <Field
                      label={studioUi(t, "Task type")}
                      hint={studioUi(
                        t,
                        "A category that helps people recognize the request, such as approval, review, or data-entry.",
                      )}
                    >
                      <TextInput
                        value={String(action.task_type ?? "approval")}
                        mono
                        disabled={disabled}
                        placeholder="approval"
                        onChange={(task_type) => update({ task_type })}
                      />
                    </Field>
                    <Field
                      label={studioUi(t, "Awaiting role")}
                      hint={studioUi(
                        t,
                        "The kind of person expected to respond, such as manager or operator. This is saved as workflow metadata; task access is managed separately.",
                      )}
                    >
                      <TextInput
                        value={String(action.awaiting_role ?? "operator")}
                        mono
                        disabled={disabled}
                        placeholder="operator"
                        onChange={(awaiting_role) => update({ awaiting_role })}
                      />
                    </Field>
                  </div>
                  <JsonFieldHelp>
                    {studioUi(
                      t,
                      "Advanced: describe the expected response as JSON Schema. Leave the empty object form for a simple approval, or define fields such as decision and comments.",
                    )}
                  </JsonFieldHelp>
                  <JsonValueEditor
                    value={
                      action.form_schema ?? { type: "object", properties: {} }
                    }
                    onChange={(form_schema) => update({ form_schema })}
                    height={150}
                    label={studioUi(t, "Human response form schema")}
                    readOnly={disabled}
                  />
                </div>
              )}
              {action.type === "delay" && (
                <Field
                  label={studioUi(t, "Delay (milliseconds)")}
                  hint={studioUi(
                    t,
                    "Planned wait in thousandths of a second; 60000 means one minute. Preview only: the value is retained and traced, but production does not wait on a durable timer yet.",
                  )}
                >
                  <TextInput
                    value={Number(action.delay_ms ?? 0)}
                    type="number"
                    min={0}
                    disabled={disabled}
                    onChange={(delay_ms) =>
                      update({ delay_ms: Number(delay_ms) })
                    }
                  />
                </Field>
              )}
              {action.type === "subflow" && (
                <div style={{ display: "grid", gap: 10 }}>
                  <div
                    className="agent-studio-step-fields-grid"
                    style={{
                      display: "grid",
                      gridTemplateColumns:
                        "repeat(auto-fit, minmax(min(220px, 100%), 1fr))",
                      gap: 10,
                      minWidth: 0,
                    }}
                  >
                    <Field
                      label={studioUi(t, "Subflow agent or event")}
                      hint={studioUi(
                        t,
                        "The exact agent name or event identifier that should receive the hand-off.",
                      )}
                      required
                    >
                      <TextInput
                        value={String(action.subflow ?? "")}
                        mono
                        disabled={disabled}
                        placeholder={studioUi(t, "Example: fulfilOrder")}
                        onChange={(subflow) => update({ subflow })}
                      />
                    </Field>
                    <Field
                      label={studioUi(t, "Wait policy")}
                      hint={studioUi(
                        t,
                        "Choose whether this agent should wait for the hand-off or continue immediately. Saved for future execution support.",
                      )}
                    >
                      <SelectInput
                        value={String(action.wait_policy ?? "wait")}
                        disabled={disabled}
                        onChange={(wait_policy) => update({ wait_policy })}
                        options={[
                          {
                            value: "wait",
                            label: studioUi(t, "Wait for completion"),
                          },
                          {
                            value: "detach",
                            label: studioUi(t, "Start and continue"),
                          },
                        ]}
                      />
                    </Field>
                  </div>
                  <JsonFieldHelp>
                    {studioUi(
                      t,
                      "Data planned for the receiving agent. Most users can leave this as {}; technical users can map named values for the hand-off.",
                    )}
                  </JsonFieldHelp>
                  <JsonValueEditor
                    value={action.subflow_input ?? {}}
                    onChange={(subflow_input) => update({ subflow_input })}
                    height={140}
                    label={studioUi(t, "Subflow input")}
                    readOnly={disabled}
                  />
                  <div
                    style={{
                      color: "var(--amber)",
                      fontSize: 11.5,
                      lineHeight: 1.5,
                    }}
                  >
                    {studioUi(
                      t,
                      "Preview only: the target and input are validated and traced, but production execution does not invoke the subflow yet.",
                    )}
                  </div>
                </div>
              )}
              <details>
                <summary
                  className="mono"
                  style={{
                    color: "var(--text-2)",
                    fontSize: 11.5,
                    fontWeight: 600,
                    cursor: "pointer",
                  }}
                >
                  {studioUi(t, "Advanced: data mappings and model limits")}
                </summary>
                <div style={{ display: "grid", gap: 10, marginTop: 10 }}>
                  <div
                    style={{
                      color: "var(--text-2)",
                      fontSize: 11.5,
                      lineHeight: 1.5,
                    }}
                  >
                    {studioUi(
                      t,
                      "These settings are optional. Leave both mappings as {} to pass normal data through without custom reshaping.",
                    )}
                  </div>
                  {action.type === "logic" && (
                    <div
                      className="agent-studio-step-fields-grid"
                      style={{
                        display: "grid",
                        gridTemplateColumns:
                          "repeat(auto-fit, minmax(min(220px, 100%), 1fr))",
                        gap: 10,
                        minWidth: 0,
                      }}
                    >
                      <Field
                        label={studioUi(t, "AI retry attempts")}
                        hint={studioUi(
                          t,
                          "How many extra times to try this AI step after a temporary failure. Use 0 for no retry. Tools are never retried automatically.",
                        )}
                      >
                        <TextInput
                          value={Number(action.retries ?? 0)}
                          type="number"
                          min={0}
                          max={10}
                          disabled={disabled}
                          onChange={(retries) =>
                            update({ retries: Number(retries) })
                          }
                        />
                      </Field>
                      <Field
                        label={studioUi(t, "AI step time limit")}
                        hint={studioUi(
                          t,
                          "Maximum seconds to wait for this AI step before marking it failed. 120 seconds is a practical starting point.",
                        )}
                      >
                        <TextInput
                          value={Number(action.timeout_s ?? 120)}
                          type="number"
                          min={1}
                          disabled={disabled}
                          onChange={(timeout_s) =>
                            update({ timeout_s: Number(timeout_s) })
                          }
                        />
                      </Field>
                    </div>
                  )}
                  <div
                    className="agent-studio-step-mapping-grid"
                    style={{
                      display: "grid",
                      gridTemplateColumns:
                        "repeat(auto-fit, minmax(min(280px, 100%), 1fr))",
                      gap: 10,
                      minWidth: 0,
                    }}
                  >
                    <div>
                      <JsonFieldHelp>
                        {studioUi(
                          t,
                          "Choose and rename data sent into this step. Example:",
                        )}{" "}
                        {`{"topic":"$.inputs.topic"}`}.
                      </JsonFieldHelp>
                      <JsonValueEditor
                        value={action.input_mapping ?? {}}
                        onChange={(input_mapping) => update({ input_mapping })}
                        height={140}
                        label={studioUi(t, "Input mapping")}
                        readOnly={disabled}
                      />
                    </div>
                    <div>
                      <JsonFieldHelp>
                        {studioUi(
                          t,
                          "Choose and rename data kept from this step. Example:",
                        )}{" "}
                        {`{"summary":"$.result.summary"}`}.
                      </JsonFieldHelp>
                      <JsonValueEditor
                        value={action.output_mapping ?? {}}
                        onChange={(output_mapping) =>
                          update({ output_mapping })
                        }
                        height={140}
                        label={studioUi(t, "Output mapping")}
                        readOnly={disabled}
                      />
                    </div>
                  </div>
                </div>
              </details>
              <div
                className="agent-studio-step-actions"
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  justifyContent: "space-between",
                  gap: 8,
                }}
              >
                <div
                  className="agent-studio-step-order-actions"
                  style={{ display: "flex", flexWrap: "wrap", gap: 6 }}
                >
                  <Button
                    small
                    disabled={disabled || index === 0}
                    onClick={() => {
                      const next = [...actions];
                      [next[index - 1]!, next[index]!] = [
                        next[index]!,
                        next[index - 1]!,
                      ];
                      onChange(
                        next.map((item, i) => ({
                          ...item,
                          order: String(i + 1),
                        })),
                      );
                    }}
                  >
                    {studioUi(t, "Move up")}
                  </Button>
                  <Button
                    small
                    disabled={disabled || index === actions.length - 1}
                    onClick={() => {
                      const next = [...actions];
                      [next[index]!, next[index + 1]!] = [
                        next[index + 1]!,
                        next[index]!,
                      ];
                      onChange(
                        next.map((item, i) => ({
                          ...item,
                          order: String(i + 1),
                        })),
                      );
                    }}
                  >
                    {studioUi(t, "Move down")}
                  </Button>
                </div>
                <Button
                  small
                  tone="danger"
                  icon="x"
                  disabled={disabled}
                  style={{ marginLeft: "auto" }}
                  onClick={() =>
                    onChange(actions.filter((_, i) => i !== index))
                  }
                >
                  {studioUi(t, "Remove")}
                </Button>
              </div>
            </div>
          </details>
        );
      })}
      <Button
        small
        icon="plus"
        onClick={add}
        disabled={disabled}
        style={{ justifySelf: "start" }}
      >
        {studioUi(t, "Add step")}
      </Button>
    </div>
  );
}
