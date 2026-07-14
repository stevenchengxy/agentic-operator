"use client";

import { Badge, Button } from "@/app/portal/components";
import { EmptySection, Field, JsonValueEditor, SelectInput, TextArea, TextInput } from "./fields";
import type { StudioAction } from "./model";

export function StepsEditor({
  actions,
  onChange,
  disabled,
}: {
  actions: StudioAction[];
  onChange: (actions: StudioAction[]) => void;
  disabled?: boolean;
}) {
  function add() {
    onChange([
      ...actions,
      { order: String(actions.length + 1), name: `step${actions.length + 1}`, type: "logic" },
    ]);
  }

  if (actions.length === 0) {
    return <EmptySection title="No steps" hint="Add the first action in this agent's execution sequence." actionLabel="Add step" onAction={add} />;
  }

  return (
    <div style={{ display: "grid", gap: 10 }}>
      {actions.map((action, index) => {
        const update = (patch: Partial<StudioAction>) =>
          onChange(actions.map((item, itemIndex) => (itemIndex === index ? { ...item, ...patch } : item)));
        const updateIdentity = (patch: { id?: string; name?: string }) => {
          const previousTarget = String(action.id ?? action.name);
          const updatedAction = { ...action, ...patch };
          const nextTarget = String(updatedAction.id ?? updatedAction.name);
          onChange(actions.map((item, itemIndex) => {
            const next = (itemIndex === index ? updatedAction : { ...item }) as StudioAction;
            return {
              ...next,
              ...(next["true_action_id"] === previousTarget ? { true_action_id: nextTarget } : {}),
              ...(next["false_action_id"] === previousTarget ? { false_action_id: nextTarget } : {}),
            } as StudioAction;
          }));
        };
        const branchOptions = [
          { value: "", label: "Continue to the next step" },
          ...actions
            .slice(index + 1)
            .map((candidate) => ({
              value: String(candidate.id ?? candidate.name),
              label: `${candidate.order} · ${candidate.name}`,
            })),
        ];
        return (
          <details key={`${action.order}-${index}`} open={index === 0} style={{ border: "1px solid var(--border)", borderRadius: 6, background: "var(--panel-2)" }}>
            <summary style={{ display: "flex", alignItems: "center", gap: 9, padding: "10px 12px", cursor: "pointer", listStyle: "none" }}>
              <span className="mono" style={{ width: 24, color: "var(--signal)", fontSize: 10.5 }}>{action.order}</span>
              <span style={{ flex: 1, fontSize: 12, color: "var(--text)", fontWeight: 500 }}>{action.name}</span>
              <Badge tone={action.type === "tool" ? "blue" : action.type === "manual" ? "violet" : "muted"}>{action.type}</Badge>
            </summary>
            <div style={{ padding: "4px 12px 14px 45px", borderTop: "1px solid var(--border)", display: "grid", gap: 12 }}>
              <div style={{ display: "grid", gridTemplateColumns: "80px 1fr 1fr 160px", gap: 10, marginTop: 12 }}>
                <Field label="Order"><TextInput value={action.order} mono disabled={disabled} onChange={(order) => update({ order })} /></Field>
                <Field label="Stable step ID" hint="Used by condition branches and traces."><TextInput value={String(action.id ?? "")} mono disabled={disabled} placeholder={action.name} onChange={(id) => updateIdentity({ id: id || undefined })} /></Field>
                <Field label="Step name"><TextInput value={action.name} mono disabled={disabled} onChange={(name) => updateIdentity({ name })} /></Field>
                <Field label="Type">
                  <SelectInput value={action.type} disabled={disabled} onChange={(type) => update({ type: type as StudioAction["type"] })} options={[
                    { value: "logic", label: "LLM / logic" }, { value: "tool", label: "Tool" }, { value: "manual", label: "Human task" },
                    { value: "condition", label: "Condition" }, { value: "delay", label: "Delay (preview)" }, { value: "subflow", label: "Subflow (preview)" },
                  ]} />
                </Field>
              </div>
              <Field label="Description"><TextArea value={action.description ?? ""} rows={2} disabled={disabled} onChange={(description) => update({ description })} /></Field>
              {(action.type === "logic" || action.type === "manual") && (
                <Field label={action.type === "logic" ? "Step prompt" : "Task instructions"} hint="Optional instructions scoped to this step.">
                  <TextArea value={String(action.action_prompt ?? "")} rows={4} mono disabled={disabled} onChange={(action_prompt) => update({ action_prompt })} />
                </Field>
              )}
              {action.type === "tool" && (
                <Field label="Tool name"><TextInput value={String(action.tool ?? "")} mono disabled={disabled} onChange={(tool) => update({ tool })} /></Field>
              )}
              {action.type === "condition" && (
                <div style={{ display: "grid", gap: 10 }}>
                  <Field label="Condition expression" hint={'Restricted expressions such as inputs.score >= 70 or lastResult.approved == true.'}><TextInput value={String(action.condition ?? "")} mono disabled={disabled} onChange={(condition) => update({ condition })} /></Field>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                    <Field label="When true"><SelectInput value={String(action.true_action_id ?? "")} disabled={disabled} onChange={(true_action_id) => update({ true_action_id: true_action_id || undefined })} options={branchOptions} /></Field>
                    <Field label="When false"><SelectInput value={String(action.false_action_id ?? "")} disabled={disabled} onChange={(false_action_id) => update({ false_action_id: false_action_id || undefined })} options={branchOptions} /></Field>
                  </div>
                </div>
              )}
              {action.type === "manual" && (
                <div style={{ display: "grid", gap: 10 }}>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                    <Field label="Task type"><TextInput value={String(action.task_type ?? "approval")} mono disabled={disabled} onChange={(task_type) => update({ task_type })} /></Field>
                    <Field label="Awaiting role"><TextInput value={String(action.awaiting_role ?? "operator")} mono disabled={disabled} onChange={(awaiting_role) => update({ awaiting_role })} /></Field>
                  </div>
                  <JsonValueEditor value={action.form_schema ?? { type: "object", properties: {} }} onChange={(form_schema) => update({ form_schema })} height={150} label="Human response form schema" readOnly={disabled} />
                </div>
              )}
              {action.type === "delay" && (
                <Field label="Delay (milliseconds)" hint="Preview only: the value is retained and traced, but the production runtime does not wait on a durable timer yet."><TextInput value={Number(action.delay_ms ?? 0)} type="number" min={0} disabled={disabled} onChange={(delay_ms) => update({ delay_ms: Number(delay_ms) })} /></Field>
              )}
              {action.type === "subflow" && (
                <div style={{ display: "grid", gap: 10 }}>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 180px", gap: 10 }}>
                    <Field label="Subflow agent or event" required><TextInput value={String(action.subflow ?? "")} mono disabled={disabled} onChange={(subflow) => update({ subflow })} /></Field>
                    <Field label="Wait policy"><SelectInput value={String(action.wait_policy ?? "wait")} disabled={disabled} onChange={(wait_policy) => update({ wait_policy })} options={[{ value: "wait", label: "Wait for completion" }, { value: "detach", label: "Start and continue" }]} /></Field>
                  </div>
                  <JsonValueEditor value={action.subflow_input ?? {}} onChange={(subflow_input) => update({ subflow_input })} height={140} label="Subflow input" readOnly={disabled} />
                  <div style={{ color: "var(--amber)", fontSize: 10.5, lineHeight: 1.45 }}>Preview only: the target and input are validated and traced, but production execution does not invoke the subflow yet.</div>
                </div>
              )}
              <details>
                <summary className="mono" style={{ color: "var(--text-3)", fontSize: 10.5, cursor: "pointer" }}>Mappings and step-specific runtime</summary>
                <div style={{ display: "grid", gap: 10, marginTop: 10 }}>
                  {action.type === "logic" && (
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                      <Field label="LLM retry attempts" hint="Retries only this model step; tools are never retried automatically."><TextInput value={Number(action.retries ?? 0)} type="number" min={0} max={10} disabled={disabled} onChange={(retries) => update({ retries: Number(retries) })} /></Field>
                      <Field label="LLM timeout (seconds)"><TextInput value={Number(action.timeout_s ?? 120)} type="number" min={1} disabled={disabled} onChange={(timeout_s) => update({ timeout_s: Number(timeout_s) })} /></Field>
                    </div>
                  )}
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                    <JsonValueEditor value={action.input_mapping ?? {}} onChange={(input_mapping) => update({ input_mapping })} height={140} label="Input mapping" readOnly={disabled} />
                    <JsonValueEditor value={action.output_mapping ?? {}} onChange={(output_mapping) => update({ output_mapping })} height={140} label="Output mapping" readOnly={disabled} />
                  </div>
                </div>
              </details>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <div style={{ display: "flex", gap: 6 }}>
                  <Button small disabled={disabled || index === 0} onClick={() => {
                    const next = [...actions]; [next[index - 1]!, next[index]!] = [next[index]!, next[index - 1]!];
                    onChange(next.map((item, i) => ({ ...item, order: String(i + 1) })));
                  }}>Move up</Button>
                  <Button small disabled={disabled || index === actions.length - 1} onClick={() => {
                    const next = [...actions]; [next[index]!, next[index + 1]!] = [next[index + 1]!, next[index]!];
                    onChange(next.map((item, i) => ({ ...item, order: String(i + 1) })));
                  }}>Move down</Button>
                </div>
                <Button small tone="danger" icon="x" disabled={disabled} onClick={() => onChange(actions.filter((_, i) => i !== index))}>Remove</Button>
              </div>
            </div>
          </details>
        );
      })}
      <Button small icon="plus" onClick={add} disabled={disabled} style={{ justifySelf: "start" }}>Add step</Button>
    </div>
  );
}
