# Agent Factory 对 v0.2 Ontology 的可生成性结论

检查日期：2026-07-15

数据来源：

- `actions_v0_2_001.json`
- `objects_v0_2_001.json`
- `rules_v0_2_001.json`
- 通过 AllmetaOntology HTTP API 只读取得的 `Agents-generation` 16 个 Events

本次检查没有直连 Neo4j、没有写入 Allmeta、没有从 `RAAS-v1` 生成或部署 Agent。

## 结论

这三份文件已经足够让 Factory 理解六个 Agent Action，并形成待审的 Ontology/plan 修订提案；目前还不足以直接生成可执行、可 sandbox、可 promotion 的 function draft。

Factory 不应该因为可确定性补齐的字段而停住，也不应该为了继续运行而猜业务。当前实现把两者分开：

1. 只依据同一份 Ontology 内部唯一事实，自动归一化字段路径和多分支输出路由；
2. 事件拓扑、规则语义、外部集成、写操作和失败策略仍然要求权威数据或 `ask_user`；
3. prose-only `instruction` 可以形成结构化 plan 草稿，但必须人工审查；外部调用和写操作在 sandbox/promotion 前还必须有 integration profile 与安全探针。

## 当前只读预检

输入规模：44 Objects、16 Events、16 Actions（6 Agent / 10 Human）、61 Rules、0 structured action steps。

归一化后：

- 56 个 Event input bindings 可确定性补齐，其中六个 Agent 占 42 个；15 个 Agent required inputs 中可补 13 个。
- 13 个 multi-outcome output mappings 可由 Event schema 唯一确定。
- 全图 blocker 从 76 个降到 63 个；仍有 60 个 warning。全图数字包含 Human Action 和共享 Event/Object 问题，Factory 应按 Action slice 展示，不能把 63 条机器错误直接交给用户。

## 六个 Agent 的真实缺口

### createJD

`trigger=JOB_REQUIREMENTS_READY`，但 `Agents-generation` 没有该 Event。现有 `REQUIREMENT_LOGGED`、`CLARIFICATION_READY`、`JD_REJECTED` 又都把 `createJD` 列为 consumer，Action 描述也说订阅这三类事件。

需要业务选择其一：

- 把 `createJD.trigger` 改回三个现有 Events，并为 `job_requisition_id <- entity_id` 分别声明 `source_event/event_path`；或
- 新建 `JOB_REQUIREMENTS_READY`，明确 producer、consumer、payload，并移除旧三条 consumer edge。

Factory 不会自动修改这条拓扑。

### required input

仍有两个 required input 不能机械补齐：

- `createJD.job_requisition_id`：trigger Event 不存在；
- `ruleCheckForCandidateIdentity.parsed`：Event 提供的是 `parsed.data:Object`。需要确认 Agent 接收 inner data，还是 Event 改成 `parsed:Object`。

`source_object` 只表示数据血缘，不表示数据库查询。真正的 `object_lookup` 必须声明 `lookup_tool/integration_ref + lookup_args + result_path`。

### output

19 个 multi-outcome mapping 中，13 个已可安全归一化。仍有 6 个没有任何同名、类型兼容的 outcome Event field：

- `processResume.application_id`
- `processResume.parsed`
- `processResume.is_new_candidate`
- `processResume.is_new_resume`
- `ruleCheckForMatchResume.audit_id`
- `matchResume.overall_match_grade`

另有两个单 outcome output 没有 Event field：

- `createJD.robohire_request_id`
- `ruleCheckForCandidateIdentity.needs_human_review`

每个字段都需要明确“加入哪个 Event field”或标成 `delivery=internal|invoke_return`，不能猜。

### Event/Object 引用

当前 Events 对新 Objects 有 24 个硬引用冲突：18 个 mutation property 不存在、5 个 Event field target object 不存在、1 个 mutation object 不存在。未知对象主要是 `RuleCheckAudit` 与 `OntologyRuleCheck`。

这类冲突应改 Event 引用，或在 Objects 中增加 canonical object/property；runtime 不应静默忽略。

### Rules

- 身份核验 Action 引用的 `9-15` 不存在；`9-2` 是 Human 身份证获取规则，语义不同，不能自动替换。
- `10-46` 已存在，文本也表达“未上传凭证持续锁定”，但仍缺 `stage`、结构化 condition、`mandatory/block`、evidence 与恢复条件。
- 61 条 Rules 全部仍是 prose：没有 `applies_to`、可执行 condition/decision table、enforcement/effect、failure policy、priority 和 action-step edge，因此不能直接编译成规则执行器。

邀请流程必须保留：

`matchResume -> MATCH_PASSED_NEED_INTERVIEW -> approveInterviewInvitation(Human/RAAS) -> INTERVIEW_INVITATION_REQUESTED -> inviteInternalInterview -> SENT|FAILED`

## Objects 的建模问题

44 个 Objects、597 个 properties、93 个 FK 的主键与外键结构完整；但 597 个 properties 都没有 required/nullability 和 PII classification。

`Job_Requisition.resume_match_score_threshold` 当前是 `String`，应确认是否改为 `Number/Float` 并声明范围。

`objects` 和 `rules` 文件的 `metadata.project_name` 仍是 `RAAS-v1`。若目标 domain 是 `Agents-generation`，上传时必须使用精确 domain id 并修正 metadata，不能靠文件名或模糊匹配。

## Allmeta 最小 execution schema

Allmeta 必须保存并原样返回以下字段；未知 execution 扩展应 versioned strict-reject，不能静默 strip：

- Action：`trigger/triggered_event`（可兼容 `emit` alias）、`instruction/on_success/on_failure`、`action_steps`、`integration`、`side_effects`、`target_objects`、`tool_use`。
- ActionInput：`binding_kind`、`event_path`、`source_event`；lookup 的 `lookup_tool|integration_ref/lookup_args/result_path`；secret/config 的 `binding_ref`；step output 的 `source_step/source_output`。
- ActionOutput：`delivery`、`emitted_on`、`event_field`；同一 output 在不同 Event 路径不同时需要 `event_field_by_event` 或 `event_bindings`。
- Event：producer/consumer topology，以及 required Event field 的来源绑定。
- Rule：`stage/applies_to/condition(or decision table)/enforcement/effect/failure_policy/evidence/resume_condition/priority/action-step refs`。

## 建议补齐顺序

1. 确认 `createJD` 的 Event 方案，并解决两个 required input 的 shape/binding。
2. 对剩余 8 个 output 做“Event field 或 internal/invoke_return”决策。
3. 修复 24 个 Event/Object 引用冲突，以及 `CLARIFICATION_READY`、`JD_APPROVED`、`RESUME_PROCESSED` 的全图拓扑问题。
4. 新增 canonical `9-15`（或指定真正等价规则），把 `10-46` 与其他关键 Rules 结构化。
5. 为六个 Agent 补 action steps、integration bindings、event bindings、error policies、idempotency、timeout、config/secret refs 和安全探针。
6. 按“预检 → draft → 人工审查 → isolated sandbox 回放 → promotion → 真实运行”推进。
