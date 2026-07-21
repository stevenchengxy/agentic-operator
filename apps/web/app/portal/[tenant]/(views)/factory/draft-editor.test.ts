import { describe, expect, it } from "vitest";
import { translate } from "@/lib/i18n";
import {
  draftEditContainsSensitiveData,
  humanDraftEditFailure,
  prepareDraftFieldEdit,
  readDraftEditorContract,
  readPatchedDraftVersionReceipt,
  type DraftEditorContract,
  type DraftEditorFieldContract,
} from "./draft-editor";

const t = (key: string, vars?: Record<string, string | number>) => translate("zh", key, vars);

const evidenceEffect = {
  carriedForward: false as const,
  invalidatedForNewVersion: ["human_review", "sandbox", "regression", "promotion_preview"],
  requiredNext: ["human_review", "sandbox_replay", "promotion_preview"],
};

const systemPrompt: DraftEditorFieldContract = {
  key: "systemPrompt",
  label: "系统提示词",
  help: "Agent 的决策职责和边界。",
  valueType: "multiline",
  editable: true,
  unsettable: false,
  present: true,
  valueStatus: "available",
  value: "old prompt",
};

function contract(over: Partial<DraftEditorContract> = {}): DraftEditorContract {
  return {
    schema: "agent-factory-draft-editor/v1",
    scope: {
      tenantId: "ten-one",
      tenantSlug: "tenant-one",
      domain: "domain-one",
      slug: "resume-agent",
      versionId: "v-one",
    },
    fields: [systemPrompt, {
      key: "toolConfigs",
      label: "工具非密钥配置",
      help: "只允许非密钥配置。",
      valueType: "json",
      editable: true,
      unsettable: true,
      present: true,
      valueStatus: "available",
      value: { parser: { base_url: "https://example.test", api_key_env: "PARSER_API_KEY" } },
    }],
    evidenceEffect,
    ...over,
  };
}

const expected = {
  tenantSlug: "tenant-one",
  domain: "domain-one",
  slug: "resume-agent",
  versionId: "v-one",
};

describe("Factory draft editor contract", () => {
  it("accepts only the exact tenant/domain/draft/version response", () => {
    expect(readDraftEditorContract(t, contract(), expected)).toMatchObject({ ok: true });
    expect(readDraftEditorContract(t, contract(), { ...expected, tenantSlug: "tenant-two" })).toEqual({
      ok: false,
      message: "草稿编辑范围已经变化，请刷新后重新打开。",
    });
    expect(readDraftEditorContract(t, contract(), { ...expected, versionId: "v-two" })).toMatchObject({ ok: false });
  });

  it("fails closed if a withheld field still carries its value or evidence rules are missing", () => {
    expect(readDraftEditorContract(t, contract({
      fields: [{ ...systemPrompt, valueStatus: "withheld_sensitive", value: "must-not-reach-browser" }],
    }), expected)).toMatchObject({ ok: false });
    expect(readDraftEditorContract(t, contract({
      evidenceEffect: { ...evidenceEffect, invalidatedForNewVersion: ["sandbox"] },
    }), expected)).toMatchObject({ ok: false });
  });

  it("requires an explicit read-only reason for visible Ontology fields", () => {
    const readonlyTrigger = {
      ...systemPrompt,
      key: "trigger",
      label: "消费事件",
      valueType: "string_array" as const,
      editable: false,
      readonlyReason: "这个字段来自 Allmeta Ontology。请先更新 Allmeta Ontology 后重新生成。",
      unsettable: false,
      value: ["WORK_REQUESTED"],
    };
    const parsed = readDraftEditorContract(t, contract({ fields: [systemPrompt, readonlyTrigger] }), expected);
    expect(parsed).toMatchObject({
      ok: true,
      data: { fields: [expect.objectContaining({ key: "systemPrompt", editable: true }), expect.objectContaining({ key: "trigger", editable: false })] },
    });
    expect(readDraftEditorContract(t, contract({
      fields: [{ ...readonlyTrigger, readonlyReason: undefined }],
    }), expected)).toMatchObject({ ok: false });
    expect(readDraftEditorContract(t, contract({
      fields: [{ ...readonlyTrigger, unsettable: true }],
    }), expected)).toMatchObject({ ok: false });
  });
});

describe("Factory draft field PATCH", () => {
  it("builds a one-field top-level patch and rejects no-op edits", () => {
    expect(prepareDraftFieldEdit(t, systemPrompt, "new prompt", false)).toMatchObject({
      ok: true,
      data: {
        patch: { set: { systemPrompt: "new prompt" } },
        before: "old prompt",
        after: "new prompt",
      },
    });
    expect(prepareDraftFieldEdit(t, systemPrompt, "old prompt", false)).toEqual({
      ok: false,
      message: "内容没有变化，不需要创建新版本。",
    });
  });

  it("parses server-declared JSON/string-array/number types without a business field list", () => {
    const arrayField: DraftEditorFieldContract = {
      key: "anyServerField",
      label: "服务端字段",
      help: "",
      valueType: "string_array",
      editable: true,
      unsettable: true,
      present: false,
      valueStatus: "available",
    };
    expect(prepareDraftFieldEdit(t, arrayField, '["ONE","TWO"]', false)).toMatchObject({
      ok: true,
      data: { patch: { set: { anyServerField: ["ONE", "TWO"] } } },
    });
    expect(prepareDraftFieldEdit(t, { ...arrayField, valueType: "integer" }, "2.5", false)).toMatchObject({ ok: false });
  });

  it("never builds a request containing credentials, fixture bytes or fixture asset ids", () => {
    const jsonField: DraftEditorFieldContract = {
      key: "toolConfigs",
      label: "工具配置",
      help: "",
      valueType: "json",
      editable: true,
      unsettable: true,
      present: false,
      valueStatus: "available",
    };
    expect(prepareDraftFieldEdit(t, jsonField, '{"api_key":"secret-value"}', false)).toMatchObject({ ok: false });
    expect(prepareDraftFieldEdit(t, jsonField, '{"asset_id":"ffa-0123456789abcdef0123456789abcdef"}', false)).toMatchObject({ ok: false });
    expect(prepareDraftFieldEdit(t, jsonField, '{"base64":"aGVsbG8="}', false)).toMatchObject({ ok: false });
    expect(prepareDraftFieldEdit(t, jsonField, '{"content":"aGVsbG8="}', false)).toMatchObject({ ok: false });
    expect(prepareDraftFieldEdit(t, jsonField, '{"headers":{"X-Api-Key":"literal-value"}}', false)).toMatchObject({ ok: false });
    expect(prepareDraftFieldEdit(t, jsonField, '{"auth":"this-is-a-real-secret-value"}', false)).toMatchObject({ ok: false });
    expect(prepareDraftFieldEdit(t, jsonField, '{"authHeader":"this-is-a-real-secret-value"}', false)).toMatchObject({ ok: false });
    expect(prepareDraftFieldEdit(t, jsonField, '{"key":"this-is-a-real-secret-value"}', false)).toMatchObject({ ok: false });
    expect(prepareDraftFieldEdit(t, jsonField, '{"~key":"ordinary-business-value"}', false)).toMatchObject({ ok: true });
    expect(prepareDraftFieldEdit(t, { ...systemPrompt, present: false, value: undefined }, "Bearer literal-token", false)).toMatchObject({ ok: false });
    expect(prepareDraftFieldEdit(t, jsonField, '{"api_key_env":"SAFE_API_KEY"}', false)).toMatchObject({
      ok: true,
      data: { patch: { set: { toolConfigs: { api_key_env: "SAFE_API_KEY" } } } },
    });
    expect(prepareDraftFieldEdit(t, jsonField, '{"auth_env":"AUTH_SECRET_ENV","authHeaderEnv":"AUTH_HEADER_ENV","key_env":"SIGNING_KEY_ENV"}', false)).toMatchObject({ ok: true });
    expect(draftEditContainsSensitiveData("data:application/pdf;base64,aGVsbG8=")).toBe(true);
  });

  it("never builds set or unset patches for Ontology-derived read-only fields", () => {
    const readonlyTrigger: DraftEditorFieldContract = {
      key: "trigger",
      label: "消费事件",
      help: "由 Ontology Action 生成。",
      valueType: "string_array",
      editable: false,
      readonlyReason: "这个字段来自 Allmeta Ontology。请先更新 Allmeta Ontology 后重新生成。",
      unsettable: false,
      present: true,
      valueStatus: "available",
      value: ["WORK_REQUESTED"],
    };
    expect(prepareDraftFieldEdit(t, readonlyTrigger, '["OTHER_EVENT"]', false)).toEqual({
      ok: false,
      message: readonlyTrigger.readonlyReason,
    });
    expect(prepareDraftFieldEdit(t, readonlyTrigger, "", true)).toEqual({
      ok: false,
      message: readonlyTrigger.readonlyReason,
    });
  });

  it("turns technical validation failures into human language without echoing sensitive values", () => {
    expect(humanDraftEditFailure(t, "invalid draft patch: retries must be an integer")).toContain("不符合 Agent 运行契约");
    expect(humanDraftEditFailure(t, "draft version not found: v-old")).toContain("已经变化");
    const hidden = humanDraftEditFailure(t, "failed around ffa-0123456789abcdef0123456789abcdef");
    expect(hidden).toContain("已隐藏");
    expect(hidden).not.toContain("ffa-0123456789abcdef0123456789abcdef");
  });
});

describe("Factory patched-version receipt", () => {
  const receipt = {
    domain: "domain-one",
    versionId: "v-two",
    baseVersionId: "v-one",
    changedSlug: "resume-agent",
    regressionReady: false as const,
    evidenceEffect,
    scope: {
      tenantId: "ten-one",
      tenantSlug: "tenant-one",
      domain: "domain-one",
      slug: "resume-agent",
      baseVersionId: "v-one",
    },
  };
  const receiptScope = { tenantSlug: "tenant-one", domain: "domain-one", slug: "resume-agent", baseVersionId: "v-one" };

  it("requires a different version plus explicit evidence invalidation", () => {
    expect(readPatchedDraftVersionReceipt(t, receipt, receiptScope)).toMatchObject({ ok: true });
    expect(readPatchedDraftVersionReceipt(t, { ...receipt, versionId: "v-one" }, receiptScope)).toMatchObject({ ok: false });
    expect(readPatchedDraftVersionReceipt(t, { ...receipt, regressionReady: true }, receiptScope)).toMatchObject({ ok: false });
  });

  it("rejects scope drift and any response that sends full draft specs", () => {
    expect(readPatchedDraftVersionReceipt(t, {
      ...receipt,
      scope: { ...receipt.scope, tenantSlug: "tenant-two" },
    }, receiptScope)).toMatchObject({ ok: false });
    expect(readPatchedDraftVersionReceipt(t, { ...receipt, drafts: [{ spec: { toolConfigs: { api_key: "leak" } } }] }, receiptScope)).toMatchObject({ ok: false });
  });
});
