# RAAS-v1（zhaopin 租户）六智能体 Payload Schema 全景

> 生成日期：2026-07-15。
> 事实来源：`models/zhaopin-v1/workflow_v1.json`（部署版 manifest）、`models/zhaopin-v1/events_v2.json`（18 事件权威契约）、`models/zhaopin-v1/actions_v2.json`（16 动作契约，其中 6 个 Agent 动作）、`models/zhaopin-v1/objects_v1.json`（25 对象）、`tenants/zhaopin/src/**`（租户工具实现）、`packages/tools/src/robohire/**`（GoHire 适配器）、`data/agentic.db` business_records（2026-07-13 live run 落库样本）、live GoHire API 探测（2026-07-15）。

---

## 0. 域定位与运行时语义

| 项 | 值 |
|---|---|
| 租户 slug / 显示名 | `zhaopin` / **RAAS-v1**（注意：仓库里另有 `raas` 租户 = `models/RAAS-v1/` 14-agent 大域，非本文对象） |
| 模型目录 | `models/zhaopin-v1/`（workflow_v1 + events_v2 + actions_v2 + objects_v1 + rules_v1） |
| Inngest 函数 id | `zhaopin.<agentName>`，共 6 个 |
| 事件名 | `zhaopin/<EVENT_NAME>`，并发按 `event.data.subject` 分键 |
| 外部依赖 | GoHire（RoboHire.io）`https://api.gohire.top/api/v1`、RAAS partner Postgres（`RAAS_POSTGRES_URL`）、Allmeta 本体库、本地 SQLite `business_records` |

**六智能体事件流**（人工动作以〔〕标注）：

```
〔manualEntry / confirmRequirementClarification / jdReview驳回〕
   REQUIREMENT_LOGGED / CLARIFICATION_READY / JD_REJECTED
        │
        ▼
   ① createJD ──JD_GENERATED──▶〔jdReview〕──JD_APPROVED──▶ (发布环节，六agent外)
                                                │
〔resumeCollection〕                             ▼
   RESUME_DOWNLOADED                        (渠道采集)
        │
        ▼
   ② processResume ──(step.invoke 同步)──▶ ③ ruleCheckForCandidateIdentity
        │                                       （事件入口 CANDIDATE_IDENTITY_REQUESTED
        │                                         → CANDIDATE_IDENTITY_CHECKED）
        ├─RESUME_LOCKED_CONFLICT──▶〔resolveLockConflict〕
        ▼
   RESUME_PROCESSED
        │
        ▼
   ④ ruleCheckForMatchResume ──MATCH_RULE_CHECK_FAILED──▶〔redispatchCandidate〕
        │
   MATCH_RULE_CHECK_PASSED
        ▼
   ⑤ matchResume ──MATCH_FAILED──▶〔redispatchCandidate〕
        │
   MATCH_PASSED_NEED_INTERVIEW
        ▼
   〔approveInterviewInvitation (HSM审批)〕──INTERVIEW_INVITATION_REQUESTED──▶
        ▼
   ⑥ inviteInternalInterview ──INTERVIEW_INVITATION_SENT──▶〔interviewExecution〕
                              └─INTERVIEW_INVITATION_FAILED──▶〔handleInvitationFailure〕
```

**通用运行时语义**（适用于所有 step，理解 payload 流动的前提）：

1. **carry-forward 信封**：`type:"tool"` 步骤的出站事件 payload = `{ ...入站事件顶层字段, ...最终步骤返回的 data }`（`packages/runtime/src/message-envelope.ts` 的 `assembleEmitPayload`）。因此"步骤输出"会平铺进事件 payload。
2. **`ctx.lastResult`**：上一步骤输出的 `data` 在服务端直接传给下一步，不经 LLM 转述（大字段防腐蚀通道）。
3. **`_emit` / `_emits`**：终步返回的 `_emit`（单个）或 `_emits[]`（多岗位扇出）决定实际发出的事件名，必须 ∈ manifest `triggered_event[]`。
4. **RAAS 信封 unwrap**：入站事件若为老 RAAS 信封形态 `{entity_type, entity_id, event_id, payload, trace}`，由 `zhaopinLegacyRaasEventAdapter` 摊平为顶层字段，transport 元数据挂在 `__raas`；出站按 `EVENT_PAYLOAD_FIELDS` 白名单投影回信封（`tenants/zhaopin/src/legacy-raas-envelope.ts`）。
5. **F3 契约**：关键字段顶层平铺，取不到一律 `null`，禁止空串、禁止省略字段。
6. **工具凭证**：所有 GoHire 工具经 `tool_use[].config` 注入 `{api_key_env: "ROBOHIRE_API_KEY", base_url_env: "ROBOHIRE_API_BASE_URL", timeout_ms: 300000}`，rest-helper 拒绝字面量凭证。

> **两层步骤视图**：每个 agent 下面给出两层——**部署版步骤**（workflow_v1.json 实际在跑的 `actions[]`）与**契约版步骤**（actions_v2.json 的 `action_steps[]`，2026-07-14 修订，工厂再生成时以此为准）。两者的差异均已标注。

---

## 1. createJD（id 4，Create JD Agent）

| 项 | 值 |
|---|---|
| 触发 | `REQUIREMENT_LOGGED` \| `CLARIFICATION_READY` \| `JD_REJECTED` |
| 产出 | `JD_GENERATED` |
| retries | 1 |
| 目标对象 | Job_Posting, Job_Requisition, Job_Requisition_Specification |

### 1.1 输入：触发事件 payload

**REQUIREMENT_LOGGED**（boundary=external，producer=人工 manualEntry；RAAS 信封，entity_id=job_requisition_id）

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| job_requisition_id | String | ✅ | 需求编号（=信封 entity_id；兼容 `payload.requirement_id` / `raw_input_data.job_requisition_id`） |
| client_id | String | — | 客户编号（便利字段，缺失由 AO 回查） |
| is_urgent | Boolean | — | 是否加急 |
| source_channel | String | — | 需求来源渠道 |
| requirement_brief | String | — | free-text 需求简报 |
| raw_input_data | Object | — | 需求原始 28 字段快照（老格式兼容位，权威数据以 partner Postgres 为准） |
| trace | Object | — | `{trace_id, request_id, workflow_id, parent_trace_id}` |

**CLARIFICATION_READY**（external，producer=人工 confirmRequirementClarification）

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| job_requisition_id | String | ✅ | 需求编号（信封 entity_id） |
| trace | Object | — | 追踪上下文 |

**JD_REJECTED**（external，producer=人工 jdReview 驳回）

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| job_requisition_id | String | ✅ | 需求编号（重新生成锚点） |
| job_posting_id | String | — | 被退回的岗位发布编号 |
| reject_reason | String | — | 审核退回原因（拼进重生成上下文） |

### 1.2 步骤（部署版 workflow_v1：4 步，全 tool）

**Step 1 `loadRaasRequirement`** [tool]
- 条件：收到需求登记 / 澄清就绪 / JD 被退回事件。
- 输入：`event.data`（job_requisition_id 锚点，兼容 requirement_id / 信封 entity_id——仅 REQUIREMENT_LOGGED / CLARIFICATION_READY / JD_REJECTED（entity_type=JobRequisition）三事件允许从 entity_id 恢复）。
- 行为：按 job_requisition_id 从 RAAS partner Postgres 加载完整 `job_requisition` 行 + `job_requisition_specification` + 澄清记录。记录不存在或主库不可用 → 抛错（禁止凭 ID 生成空泛 JD）。
- 输出 `data`：`{ job_requisition: Object(JR整行), specification: Object, clarifications: Array, job_requisition_id, client_id, ... }`（透传锚点）。

**Step 2 `generateJdApi`** [tool] — GoHire `POST /api/v1/jobs/generate-jd`
- 输入解析顺序（`resolveInput`）：`prompt` | `requirement_brief` | `job_brief`（event.data 优先，lastResult 次之）→ 都没有则用 `flattenJobRequisition({...specification, ...job_requisition})` 摊平出 prompt，并追加 `需求澄清:` 列表；截断至 4000 字符。
- 请求体：`{ prompt: string(4..4000), language?: en|zh|zh-TW|ja|es|fr|pt|de, companyName?, department? }`
- 响应校验：信封 `success!==false`；`meta.stages.parse/generate` 均非 `failed`；`meaningfulJd`（title 非空非 Untitled，且 description/qualifications/hardRequirements/niceToHave/evaluationRules/interviewRequirements 至少一项非空）。失败分类：`generate_jd_input_invalid`(400,终态) / `upstream_rejected`(4xx,终态) / `upstream_unavailable`(429/5xx,重试) / `stage_failed`(重试) / `output_invalid`(重试)。
- 输出 `data`：`{ ...供应商JD字段(title/description/qualifications/hardRequirements/niceToHave/interviewRequirements/evaluationRules/benefits…), must_have_skills: string[](缺失时由 hardRequirements 逐行解析), nice_to_have_skills: string[], jd_content: string(拼装的规范 Markdown: # title + ## 职位描述/任职要求/硬性要求/加分项/面试要求/评估标准/薪资福利), request_id, stages, raw }`

**Step 3 `persistJd`** [tool]
- 输入：`ctx.lastResult`（generateJdApi 输出）+ `event.data`；提取 `{ jd_content(必填非空), job_posting_id(仅透传上游提供的，绝不造 ID), title, job_requisition_id }`。
- 行为：按 job_requisition_id 幂等写入租户 JD store（供 processResume/matchResume 回查）。缺字段或写库失败 → 终止。
- 输出 `data`：`{ jd_content, job_posting_id, job_requisition_id, title, jd_persisted: true }`

**Step 4 `persistRaasEntities`** [tool] config `{ phase: "job_posting" }`
- 输入：`ctx.lastResult` + 全链上下文快照。
- 行为：write-before-emit——把 JobPosting 按业务键幂等写 RAAS partner Postgres + Allmeta 本体实例；任一已启用目标失败即阻断 emit。
- 输出 `data`：`{ ...lastResult透传, ...receipt.ids(如 job_posting_id), _persistence: <receipt> }`

*契约版（actions_v2）差异：6 步 —— `resolveRequirementContext(tool)` → `buildJdPrompt(logic)` → `generateJdContent(tool)` → `deriveStructuredSkills(logic)` → `persistJdPosting(tool)` → `emitJdGenerated(emit)`。部署版把 buildJdPrompt/deriveStructuredSkills 折叠进了 generateJdApi 适配器内部（`resolveInput`/`proseToSkillArray`），把外部持久化独立成 persistRaasEntities 步。*

### 1.3 输出：JD_GENERATED payload（internal，consumer=人工 jdReview）

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| job_posting_id | String | ✅ | canonical：岗位发布编号（=信封 entity_id） |
| jd_content | String | ✅ | canonical：整段 JD markdown（标题/正文/任职要求/硬性要求/加分项/面试要求/评估标准/福利） |
| job_requisition_id | String | ✅ | 便利 FK：父需求编号 |
| client_id | String | — | 便利 FK：客户编号 |
| trace | Object | — | 追踪上下文透传 |

state_mutations：Job_Posting CREATE_OR_MODIFY（job_posting_id, job_requisition_id, client_id, title, responsibility, requirement, key_words, recruitment_type, work_years, degree_requirement, education_requirement, city, salary_range, interview_mode, publish_status, jd_content）；Job_Requisition MODIFY（must_have_skills, nice_to_have_skills）；Job_Requisition_Specification MODIFY（status）。

---

## 2. processResume（id 9-1，Resume Parser Agent）

| 项 | 值 |
|---|---|
| 触发 | `RESUME_DOWNLOADED` |
| 产出 | `RESUME_PROCESSED` \| `RESUME_LOCKED_CONFLICT` |
| retries | 0 |

### 2.1 输入：RESUME_DOWNLOADED payload（external，producer=人工 resumeCollection；RAAS 只发 transport 元数据，不预解析）

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| upload_id | String | ✅ | 上传编号——全链路锚点，MATCH_* 事件需原样回传 |
| bucket | String | ✅ | 对象存储桶 |
| object_key | String | ✅ | 对象存储键（与 bucket 一起做 Resume 去重） |
| etag | String | — | 可 null；AO 以原始字节 MD5 兜底作 dedup key |
| filename | String | — | 原始文件名（路径 B 模糊匹配辅助） |
| mime_type | String | — | 声明 MIME（不可信，AO 按 magic bytes 识别） |
| size | Int | — | 文件字节数 |
| employee_id | String | — | 上传者（招聘员）工号（路径 B 锚点） |
| locked_by_employee_id | String | — | RMHR 锁持有人工号（有锁时归属以锁持有人为权威） |
| client_id | String | — | 客户编号透传 |
| job_requisition_id | String | — | 上传关联单岗位（路径 A 精准匹配） |
| job_requisition_ids | Array\<String\> | — | RAAS 预窄化岗位数组（路径 B'） |
| sourcing_channel_id | String | — | 简历来源渠道 |
| parsed | Object | — | legacy 兼容：已带 `parsed.data` 时跳过取件+解析 |
| trace | Object | — | 追踪上下文 |

### 2.2 步骤（部署版 workflow_v1：6 步）

**Step 1 `fs.readFromInbox`** [tool] config `{ subdir: "resumes" }`（zhaopin 覆写版）
- 输入：`event.data`。zhaopin 覆写先做 ①RAAS 信封 unwrap ②`RESUME_DOWNLOADED` 时 `materializeRemoteResume`（按 bucket/object_key 从对象存储拉字节落到 `data/resumes/<tenant>/inbox`），再调全局 fs 工具。
- 输出 `data`：`{ filename, mime, base64, sha256, bytes, path }`

**Step 2 `parseResumeApi`** [tool] — GoHire `POST /api/v1/parse-resume`（**multipart-only**，字段名必须 `file`；JSON body → 400）
- 输入（三选一）：`{resume_base64, filename?, mime?}` | `{resume_url}` | 无参→取 `ctx.lastResult.{base64,filename,mime}`（首选，免 LLM 转述 base64）。
- 响应处理：解信封（深层 wrapper 递归展开，deepest wins），要求实质内容（raw_text/name/contact/experience/education/skills 至少一类）。失败分类：`document_failure`(422 终态：扫描件/密码保护/无可提取文本) / `dependency_degradation`(502 可重试：2xx 空壳、非JSON、5xx/429) / `upstream_rejected`(4xx 终态)。
- 输出 `data` = **GoHire 解析结果原样透传**，live 实测 20 个顶层字段：

```
name, email, phone, address, linkedin, github, portfolio, summary,
skills{technical[], soft[], languages[], tools[], frameworks[], other[]},
experience[]{company, role, location, startDate, endDate, duration,
             description, achievements[], technologies[], employmentType},
education[]{institution, degree, field, startDate, endDate, year, gpa,
            achievements[], coursework[]},
projects[], certifications[], awards[], languages[], volunteerWork[],
publications[], patents[], otherSections{}, rawText
```
- meta：`{ provider, endpoint, upstreamStatus, filename, bytes, responseWrapped, validatedContent }`
- ⚠️ **注意：无任何"求职期望"类字段**（详见附录 B）。

**Step 3 `invokeCandidateIdentityCheck`** [invoke → `ruleCheckForCandidateIdentity`]
- `forward_last_result: true`（把 parse 输出带给身份检查），`timeout_s: 300`。
- 通过 Inngest `step.invoke` 同步调用已部署的 10-3 函数（独立 run/step 审计），返回值回到本链路作为下一步 `ctx.lastResult`。
- 输出（=10-3 的最终步输出，见 §3.2）：`{ candidate_id, same_as_candidate_id, is_new, tier, needs_review, lock_conflict, locked_by_employee_id, requesting_recruiter_id, name/phone/email/gender/school/major/degree/graduation_year, resume(解析JSON字符串回显), resume_id, job_requisition_id, job_requisition_ids }`

**Step 4 `records.upsert`** [tool] config `{ record_type: "candidate", candidate_field: "candidate_id" }`
- 输入：`ctx.lastResult` + `event.data`（pass-through 工具：回显上游结果，不动 `_emit`）。
- 行为：候选人业务档案（含解析简历快照）幂等 upsert 到本地 `business_records`。fail-closed。
- 输出：回显入参（pass-through）。

**Step 5 `routeResumeProcessed`** [tool]（确定性终路由，无 LLM）
- 输入：`ctx.lastResult`（dedup 结论）+ `event.data`。
- 行为：装配 RESUME_PROCESSED 顶层 payload；`lock_conflict=true` → `_emit: RESUME_LOCKED_CONFLICT`（终止，不进匹配）；否则按 job_requisition_id（单）或 job_requisition_ids（多，`_emits[]` 扇出，每岗位一条）emit RESUME_PROCESSED。`jd` 由 `loadJdWithRaasFallback(ctx, jr_id)`（本地 JD store 优先，RAAS PG 兜底 + write-through 缓存）按岗位回查。
- 输出 `data`（即事件 payload 增量）：`{ _emit, candidate_id, locked_by_employee_id, requesting_recruiter_id, resume: string(解析JSON字符串), resume_id, job_requisition_id, job_requisition_ids[], jd: string(JD文本), lock_conflict, needs_review, _emits?[] }`
- ⚠️ **resume 字段的真实形态**：`candidateDedupLookup` 在 Step 3 内把 `ctx.lastResult`（= parseResumeApi 输出 `.data`）做 `JSON.stringify` 后回显（`candidate-dedup.ts:347-355`）——即下游拿到的"简历文本"= **GoHire 解析结果的 JSON 字符串**（内含 rawText）。

**Step 6 `persistRaasEntities`** [tool] config `{ phase: "candidate_resume" }`
- 行为：RESUME_PROCESSED emit 前幂等写 RAAS PG Candidate + Resume 与 Allmeta 实例；锁冲突事件不伪造成功实体。
- 输出：`{ ...透传, ...receipt.ids, _persistence: <receipt> }`

*契约版（actions_v2）差异：7 步 —— `unwrapAndValidateTransport(logic)` → `downloadResumeObject(tool)` → `parseResumeStructured(tool)` → `invokeCandidateIdentity(invoke, CANDIDATE_IDENTITY_ENABLED!=0)` → `persistCandidateAndResume(tool records.upsert)` → `optionalOwnershipLockCheck(logic, LOCK_CHECK_ENABLED=1 默认关)` → `emitResumeOutcome(emit)`。部署版把 unwrap 折叠进 zhaopinReadFromInbox，把锁检查折叠进 dedup/route。*

### 2.3 输出事件 payload

**RESUME_PROCESSED**（internal；consumers：ruleCheckForMatchResume + RAAS 状态同步；另一 producer=人工 redispatchCandidate 重派）

events_v2 权威契约：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| candidate_id | String | ✅ | 候选人编号（新建或复用老档） |
| resume_id | String | ✅ | 简历编号 |
| upload_id | String | ✅ | 上传锚点（RAAS 按此反查） |
| employee_id | String | ✅ | 上传者工号（不随锁归属改写） |
| application_id | String | — | 投递申请编号（RAAS 侧创建，存在则透传） |
| parsed | Object | — | `{data:{name/phone/email/experience[]/education[]/skills/rawText…}}` 解析透传（fat event；缺失时下游回拉） |
| job_requisition_id | String | — | 单岗位 → 路径 A 精准撮合 |
| job_requisition_ids | Array\<String\> | — | 预窄化数组 → 路径 B' 逐个撮合 |
| sourcing_channel_id / client_id / filename / bucket / objectKey / etag | String | — | 透传 |
| parsedAt / parserVersion | String | — | 解析时间 / 解析器版本 |

as-built 补充（carry-forward 实际平铺的顶层字段，live 落库样本验证）：`resume: string(解析JSON)`、`jd: string`、`lock_conflict: false`、`needs_review`、`locked_by_employee_id`、`requesting_recruiter_id`。

state_mutations：Candidate CREATE_OR_MODIFY；Resume CREATE_OR_MODIFY；Resume_Upload MODIFY(status)；Application CREATE_OR_MODIFY。

**RESUME_LOCKED_CONFLICT**（internal；consumer=人工 resolveLockConflict；数据已入库，仅拦截下游流程）

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| upload_id | String | ✅ | 上传编号 |
| candidate_id | String | ✅ | 候选人编号（已入库） |
| resume_id | String | ✅ | 简历编号（已入库） |
| current_owner_employee_id | String | — | 当前锁持有人工号 |
| current_owner_email | String | — | 当前锁持有人邮箱 |
| reason | String | — | locked / protected / blacklisted |

---

## 3. ruleCheckForCandidateIdentity（id 10-3，候选人查重）

| 项 | 值 |
|---|---|
| 触发 | `CANDIDATE_IDENTITY_REQUESTED`（事件入口，人工复核重发）；**主链路是 processResume 的 `step.invoke` 同步调用**（不发事件） |
| 产出 | `CANDIDATE_IDENTITY_CHECKED` |
| retries | 1 |

### 3.1 输入：CANDIDATE_IDENTITY_REQUESTED payload（external，producer=人工 reviewCandidateIdentity）

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| upload_id | String | ✅ | case 锚点 |
| candidate_id | String | — | 落库前调用时用 upload_id 占位 |
| resume_id | String | — | 可空 |
| parsed | Object | ✅ | `{data:{…}}` 结构化解析结果（身份字段来源） |
| invoked_by | String | — | resume-parser / manual / external |
| trace_id | String | — | 追踪编号 |

（invoke 路径输入 = parseResumeApi 输出经 `forward_last_result` 传入。）

### 3.2 步骤（部署版：3 步）

**Step 1 `candidateDedupLookup`** [tool]
- 输入：`ctx.lastResult`（= parse 输出，身份字段来源）+ `event.data`（job_requisition_id/resume_id/employee_id 锚点）。
- 行为：三级身份比对（**手机号 > 姓名+邮箱 > 六字段弱匹配**，规则 9-15），对象是租户本地注册表 + RAAS PG 权威候选池；强命中→挂老档（一人多简历），未命中→原子注册新候选人索引，弱命中→仅标记人工复核（绝不自动合并）；无可用身份字段组合/租户/DB/索引异常 → fail-closed 抛错。
- 输出 `data`：`{ candidate_id, same_as_candidate_id, matched_candidate_id, is_new, tier(phone|name_email|six_field|null), needs_review, lock_conflict, locked_by_employee_id, requesting_recruiter_id, name, phone, email, gender, school, major, degree, graduation_year, resume(解析JSON字符串回显), resume_id, job_requisition_id, job_requisition_ids[] }`

**Step 2 `checkCandidateIdentity`** [logic]（LLM 步）
- 输入：`ctx.lastResult`（查重结果）。
- 行为：按 9-15 三级规则复核判定（模糊字段做语义等价），产出审计结论。
- 输出：`{ same_person, same_as_candidate_id, dedup_action(auto-merged|needs_review|new), needs_review, … }`

**Step 3 `ontology.fetchActionRules`** [tool] config `{ action: "ruleCheckForCandidateIdentity", domain: "Agents-generation" }`，`on_error: "soft"`
- 行为：从 Allmeta 拉本动作现行规则，为审计补充本体依据；**末步不阻断主流程**，失败时用 `default_result` 降级。
- 输出 `data`：`{ rules[], mandatory[], count, source: "allmeta" }`；软失败时 `{ rules: [], mandatory: [], count: 0, source: "unavailable", ontology_degraded: true }`

*契约版差异：4 步 —— `extractCandidateIdentityRecord(logic)` → `resolveIdentityMatch(tool)` → `persistIdentityAudit(tool records.upsert)` → `emitIdentityChecked(emit)`；总开关 `CANDIDATE_IDENTITY_ENABLED=0` 时直接返回 skipped；审计写失败必须抛错（无审计不得有结论）。*

### 3.3 输出：CANDIDATE_IDENTITY_CHECKED payload（internal；consumer=人工 reviewCandidateIdentity；主链路真正出口是 invoke 返回值）

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| upload_id | String | — | 上传编号 |
| candidate_id | String | ✅ | 被检查候选人编号（落库前=upload_id 占位） |
| resume_id | String | — | 简历编号 |
| same_person | Boolean | ✅ | 是否同一人 |
| same_as_candidate_id | String | — | 强命中时的老候选人编号；弱命中/未命中 null |
| dedup_action | String | ✅ | auto-merged / needs_review / new |
| matched_rule | String | — | IDENTITY-1/2/3（本体规则 9-15） |
| audit_id | String | ✅ | 身份检查审计编号（强制产物） |

state_mutations：Candidate_Identity_Result CREATE（candidate_identity_result_id, candidate_id, resume_id, matched_rule, same_person, same_as_candidate_id, dedup_action, needs_human_review, pool_size）。

---

## 4. ruleCheckForMatchResume（id 10-1，Rule Check Agent —— 匹配前规则闸门）

| 项 | 值 |
|---|---|
| 触发 | `RESUME_PROCESSED` |
| 产出 | `MATCH_RULE_CHECK_PASSED` \| `MATCH_RULE_CHECK_FAILED` |
| retries | 3 |
| manifest input_data | `{ candidate_id: 候选人唯一标识, job_requisition_id: 招聘岗位唯一标识 }` |

### 4.1 输入：RESUME_PROCESSED（见 §2.3 完整表）

### 4.2 步骤（部署版：2 步）

**Step 1 `loadRaasRuleContext`** [tool]
- 输入：`event.data`（candidate_id + job_requisition_id 锚点）。
- 行为：从 RAAS partner Postgres 拉规则判定证据集，实际查询的表：`candidate`（整行 row_to_json）、`job_requisition`、`resume`、`application`（历史投递）、`blacklist`、`interview_record`（历史面试）、客户 BP 凭证（`client_bp_decision` 列，不从 stage/status 推断）。连接失败或引用对象缺失 → fail-closed（`RAAS_POSTGRES_URL` 必配，"live mandatory rules cannot run from resume/JD alone"）。
- 输出 `data`：`RaasRuleContext`——`{ candidate: Object, job_requisition: Object, resume: Object, applications[], blacklist_hits[], interview_records[], bp_credentials[], … }`（供规则引擎作证据）。
- ⚠️ **不查询 `candidate_expectation` 表**（表在 RAAS PG 中存在，见附录 B）。

**Step 2 `reasoning.evaluateRules`** [tool]（通用规则推理引擎，内部嵌套 ReasoningAgent 真实 LLM run）
- config（manifest 注入）：

```json
{
  "action": "ruleCheckForMatchResume",
  "scenario": "pre_match_resume_rule_check",
  "prompt": "在简历匹配前，结合候选人、结构化简历、目标招聘岗位、客户与部门、历史投递/面试、黑名单和合规凭证，筛选所有适用规则并逐条判定。mandatory 违反或缺证据必须阻断；optional 未达到需 flag 但不得自行变成 mandatory。",
  "objectTypes": ["Candidate","Resume","Job_Requisition","Application","Client","Client_Department","Blacklist","Compliance_Document"],
  "keywords": ["简历匹配","回流","冷冻期","国籍","外籍","黑名单","合规凭证"],
  "executor": "Agent", "ruleLimit": 30,
  "passEvent": "MATCH_RULE_CHECK_PASSED", "failEvent": "MATCH_RULE_CHECK_FAILED"
}
```
- 行为：生成有界 Query IR → Allmeta rules-test 只读 Rule Selector 筛规则（action 强关联 + 上下文适配，≤30 条）→ Prompt Compiler 动态编译 QualifiedAgent 提示 → 逐条判定 mandatory/optional → 确定性 fail-closed 折叠（任一 mandatory 不通过/存疑/评估器异常 → 不通过；基础设施故障走停靠重试，**绝不**发 FAILED）。
- 输出 `data`：`{ reasoning_rule_engine: <完整输出>, rule_decision(eligible|eligible_with_flags|rejected|…), rule_bundle_id, rule_count, rule_results: [{rule_id, rule_name, enforcement_level, failure_policy, status, reason, evidence, flag_only}], rule_flags[], rule_missing_evidence[], nested_reasoning_run_id, _emit: PASSED|FAILED }`
- ⚠️ objectTypes/keywords 均不含 Candidate_Expectation / 期望（见附录 B）。

*契约版差异：5 步 —— `resolveCandidateAndResumeContext(tool)` → `resolveMatchableRequirements(tool)`（岗位收敛：路径 A 单岗位 / 路径 B' 数组逐个）→ `evaluateRulesPerRequisition(tool，对每个 JR 循环)` → `persistRuleCheckOutcome(tool records.upsert)` → `emitRuleCheckOutcome(emit)`。空简历不得跑规则判 PASS。*

### 4.3 输出事件 payload

**MATCH_RULE_CHECK_PASSED**（internal；consumer=matchResume；每岗位一条事件）

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| candidate_id | String | ✅ | canonical（可 null，禁止空串） |
| resume_id | String | — | canonical |
| job_requisition_id | String | ✅ | canonical：本次通过检查的岗位 |
| client_id | String | ✅ | canonical |
| rule_check_result | Enum["通过"] | ✅ | PASS 路径恒"通过" |
| rule_check_reason | String | ✅ | PASS 时恒空串 |
| upload_id | String | — | carry：上传锚点 |
| employee_id | String | ✅ | carry：招聘员工号 |
| audit | Object | ✅ | carry：`{rules_evaluated, graph_calls, client_id, business_group, studio, llm_model, llm_duration_ms, llm_round_trips, rule_source, fail_reason?}` —— 下游防伪闸门核验对象 |
| rule_check_rules | Array\<Object\> | — | carry：逐条判定 `[{rule_id, rule_name, status, reason(截300), enforcement_level, failure_policy, blocking}]`；匹配段默认追加进 JD 文本 |
| job_requisition | Object | ✅ | carry：完整岗位对象（含回填技能），匹配段免回查 |
| parsed_resume | Object | ✅ | carry：结构化简历（渲染首选） |
| parsed_content | String | — | carry：PDF 纯文本 rawText（回退，保证不发空简历） |
| runtime_context | Object | ✅ | carry：`{upload_id, candidate_id, resume_id, employee_id, filename?, received_at?, trace_id}` |

as-built 补充：部署版 carry-forward 实际还平铺 `resume: string(解析JSON)`、`jd: string`、`decision`、`reason`、`rule_results` 等顶层字段（live 落库样本验证）。

state_mutations：Candidate_Match_Result CREATE_OR_MODIFY（rule_check_result, rule_check_reason 等）；Rule_Check_Audit CREATE。

**MATCH_RULE_CHECK_FAILED**（internal；consumer=人工 redispatchCandidate；仅业务证据充分的 mandatory 失败才发）

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| candidate_id | String | ✅ | canonical（可 null） |
| resume_id | String | — | canonical |
| job_requisition_id | String | ✅ | canonical：未通过的岗位 |
| client_id | String | ✅ | canonical |
| rule_check_result | Enum["未通过"] | ✅ | 恒"未通过" |
| rule_check_reason | String | ✅ | mandatory 阻断原因拼接（截 1000） |
| failed_rules | Array\<Object\> | ✅ | `[{rule_id, rule_name, step_id?, severity?, reason?}]` 仅 mandatory 失败明细 |
| matching_score | Float | ✅ | F3 兼容：恒 null（未进匹配） |
| upload_id | String | — | 透传 |
| success | Boolean | ✅ | 恒 false |
| data | Object | — | `{audit}` 结构化错误信息 |

---

## 5. matchResume（id 10-2，Match Resume Agent）

| 项 | 值 |
|---|---|
| 触发 | `MATCH_RULE_CHECK_PASSED` |
| 产出 | `MATCH_PASSED_NEED_INTERVIEW` \| `MATCH_FAILED`（`MATCH_PASSED_NO_INTERVIEW` 已于 2026-05-21 单阈值化后下线，事件定义保留为兼容订阅位） |
| retries | 2 |

### 5.1 输入：MATCH_RULE_CHECK_PASSED（见 §4.3 完整表）

契约版 submission_criteria（防伪闸门五连验，事件名不足为凭）：`rule_check_result=='通过'`；`audit` 存在且 `llm_model!='bypass'` 且 `fail_reason` 为空；`rules_evaluated>0`；`rule_check_rules` 数组存在且每条 rule_id/rule_name/status 完整；无 status=fail。

### 5.2 步骤（部署版：4 步，全 tool、无 LLM）

**Step 1 `matchResumeApi`** [tool] — GoHire `POST /api/v1/match-resume`
- 输入：`ctx.event.data`。**请求体只有两个字段：`{ resume: string, jd: string }`**（纯文本全文）。适配器把 LLM 常见变体（resume_text/candidate_resume/jd_text/job_description…）归一为 canonical 名；两者缺一即抛错。
- 实测 API 校验（2026-07-15 live probe）：空体 → `"jd is required"`；只有 jd → `"One of resume or resumeId is required"`（code `RESUME_INPUT_REQUIRED`）——即 API 侧输入面为 `{resume | resumeId, jd}`，无其它一级业务字段。
- 部署版数据来源：`resume` = §2.2 Step 5 说明的 **GoHire 解析结果 JSON 字符串**；`jd` = JD store 回查的 `jd_content` 文本。（契约版 Step 2 `buildMatchPayload` 则规定：resume=结构化 parsed_resume 渲染 → 空则回退 parsed_content(rawText) → 仍空则不可重试失败；jd=job_requisition 摊平（职位/级别/城市/薪资/年限/学历/语言/技能/排除条件/职责/要求）+ 默认追加规则检查逐条结论。）
- 响应：**双层信封** `{success, data: {…31 维分析…}, requestId, savedAs}`——顶层 `matchScore` 恒 null，真实分嵌套在 `data.overallMatchScore.score`（归一化提取，勿读浅一层）。适配器输出 `data`：

```
{ matchScore: number|null,          // overallMatchScore.score 归一化
  verdict: string|null,             // overallFit.verdict
  hiringRecommendation: string|null,
  summary: string|null,
  data: <解包后的完整分析>, requestId, savedAs, raw: <同 data 别名> }
```
- GoHire 分析体 31 个顶层维度（live 落库样本实测）：`areasToProbeDeeper[]`, `candidateName`, `candidatePotential{}`, `counterPerspective`, `disqualified`, `experienceBreakdown{}`, `experienceMatch{}`, `experienceValidation{}`, `grade`, `hardRequirementGaps[]`, `hardRequirementsAssessment[]`, `jdAnalysis{}`, `jobTitle`, `matchedAt`, `mustHaveAnalysis{}`, `niceToHaveAnalysis{}`, `overallFit{verdict, hiringRecommendation, summary}`, `overallMatchScore{score, grade, confidence, breakdown{experienceScore/Weight, potentialScore/Weight, skillMatchScore/Weight}}`, **`preferenceAlignment{companyTypeFit, jobTypeFit, locationFit, salaryFit, workTypeFit, overallAssessment, overallScore, warnings[]}`**, `recommendations{}`, `resumeAnalysis{}`, `resumeCreated`, `resumeId`, `rubricVersion`, `score`, `skillMatch{}`, `skillMatchScore`, `suggestedInterviewQuestions[]`, `transferableSkills[]`, `verdict`, `workHistoryStability{}`。
- 总分权重（实测）：experience 35% + potential 25% + skillMatch 40%；`preferenceAlignment` 不入总分，但产出 warnings 并影响 verdict/推荐语。
- 失败语义：不可恢复（凭证坏/空结果）→ emit MATCH_FAILED（`data.error_kind='robohire-match-call-failed'`）；可恢复（欠费/瞬断/5xx）→ 不发终态，停靠重试。

**Step 2 `records.upsert`** [tool] config `{ record_type: "candidate_match_result", candidate_field: "candidate_id" }`
- 按 `candidate_id:job_requisition_id` 幂等 upsert 匹配结果到 business_records；pass-through 保留 matchScore 供路由。

**Step 3 `routeMatchOutcome`** [tool]（确定性路由，无 LLM）
- 输入：`ctx.lastResult`（取 matchScore/match_score/overall_match_score 第一个合法 0-100 数）+ **显式阈值**（`resume_match_score_threshold` 等 4 个别名，从 action 输入或 Job_Requisition 上取；缺失/冲突 → fail-closed 抛错，**代码里没有默认阈值**）。
- 输出 `data`：`{ ...透传, matchScore, match_score, resume_match_score_threshold, _emit: score>=threshold ? "MATCH_PASSED_NEED_INTERVIEW" : "MATCH_FAILED", decision_reason }`
- （契约版描述为固定 40 分单阈值；部署实现已升级为"必须显式阈值"。）

**Step 4 `persistRaasEntities`** [tool] config `{ phase: "candidate_match" }`
- MATCH_* emit 前：GoHire envelope 原样写 RAAS PG `candidate_match_result`（归一化 overall_* 落列，source=need_interview, created_by=ai_engine），本地 business_records 已在 Step 2；Allmeta 以 `cmr_<candidate>_<jr>` 合并写 overall_*（不覆盖规则段写的 rule_check_*）。JobPosting 不存在时 fail-loud。

### 5.3 输出事件 payload

**MATCH_PASSED_NEED_INTERVIEW**（internal；consumer=人工 approveInterviewInvitation(HSM)；RAAS 审批通过后回发 INTERVIEW_INVITATION_REQUESTED——邀约 agent 不直接订阅本事件）

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| job_requisition_id | String | ✅ | 岗位编号 |
| candidate_id | String | ✅ | 候选人编号（可 null，禁止空串） |
| matching_score | Float | ✅ | 匹配分（源于 overallMatchScore.score 归一化；取不到显式 null） |
| upload_id | String | ✅ | 上传锚点（RAAS 反查用） |
| job_posting_id | String | — | 关联岗位发布编号 |
| candidate_match_result_id | String | — | partner PG 匹配结果主键 |
| overall_status | Enum["匹配"] | ✅ | 恒"匹配" |
| success | Boolean | ✅ | 恒 true |
| data | Object | — | GoHire 原始匹配分析（overallMatchScore/breakdown/recommendation），consumer cherry-pick |
| requestId | String | — | GoHire 请求编号 |

state_mutations：Candidate_Match_Result CREATE_OR_MODIFY（overall_match_score, overall_fit_verdict, overall_fit_summary, overall_match_grade）。

**MATCH_FAILED**（internal；consumer=人工 redispatchCandidate；两个来源：①评分低于阈值（overall_status=不匹配，结果已入库）②GoHire 不可恢复调用失败）

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| job_requisition_id | String | ✅ | 岗位编号 |
| candidate_id | String | ✅ | 候选人编号（可 null） |
| matching_score | Float | ✅ | 低于阈值的分；调用失败路径为 null |
| upload_id | String | ✅ | 上传锚点 |
| job_posting_id / candidate_match_result_id | String | — | 关联键 |
| overall_status | Enum["不匹配"] | ✅ | 恒"不匹配" |
| success | Boolean | ✅ | 评分路由=true；调用失败=false |
| data | Object | — | GoHire 原始数据；失败时 `{error_kind:'robohire-match-call-failed'}` |
| error | String | — | 调用失败原因（仅失败路径） |

---

## 6. inviteInternalInterview（id 11-1，Interview Inviter Agent）

| 项 | 值 |
|---|---|
| 触发 | `INTERVIEW_INVITATION_REQUESTED`（RAAS 侧 HSM 审批后请求；**不是** MATCH_PASSED_NEED_INTERVIEW） |
| 产出 | `INTERVIEW_INVITATION_SENT` \| `INTERVIEW_INVITATION_FAILED` |
| retries | 2 |

### 6.1 输入：INTERVIEW_INVITATION_REQUESTED payload（external，producers=人工 approveInterviewInvitation / handleInvitationFailure 重发；RAAS emit 前已 INSERT interview_invitation(status=requested)）

面试材料三级优先：`robohire_*_id`（GoHire 服务端取数）> `*_text` 直传 > AO 按锚点回拉（thin event）。

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| candidate_id | String | ✅ | 缺 → FAILED(MISSING_PAYLOAD) |
| job_requisition_id | String | ✅ | 缺 → FAILED(MISSING_PAYLOAD) |
| application_id | String | — | 投递申请编号 |
| candidate_match_result_id | String | — | 匹配结果编号（trace 串联） |
| client_id | String | — | 客户编号 |
| resume_id | String | — | thin event 回拉 parsed_content 用 |
| recruiter_id | String | — | 发起邀请的招聘者工号 |
| correlation_id | String | — | 跨服务关联键（RAAS join 回 interview_invitation 行；缺失则 AO 跳过回写仅告警） |
| job_posting_id | String | — | 纯 trace |
| requested_at | String | — | ISO-8601（SLA 监控） |
| trigger_source | String | — | manual_candidate_card / hsm_auto / bulk_invite |
| resume_text | String | — | 直传简历文本（优先级 2） |
| jd_text | String | — | 直传 JD 文本（优先级 2） |
| robohire_resume_id | String | — | GoHire 侧 resume 行 id（优先级 1；普通 resume_id 绝不可冒充） |
| robohire_job_id | String | — | GoHire 侧 job 行 id（优先级 1） |
| hiring_request_id | String | — | GoHire 招聘请求编号 |
| candidate_email | String | — | 缺省 GoHire 从简历推断 |
| recruiter_email | String | — | 接收抄送 |
| interviewer_requirement | String | — | 面试官考察要求（AI 出题依据） |
| job_title / company_name | String | — | 邮件展示 |
| interview_language | Enum[en,zh,ja] | — | 面试语言 |
| interview_duration | Int | — | 分钟（>0，默认 30） |
| interview_mode | String | — | ai_video 等 |
| passing_score | Float | — | 通过分数线（0-100） |
| linked_assessment_id | String | — | 关联测评编号 |
| runtime_context | Object | — | `{trace_id, request_id, workflow_id}` |

### 6.2 步骤（部署版：4 步，全 tool、无 LLM）

**Step 1 `inviteCandidateApi`** [tool] — GoHire `POST /api/v1/invite-candidate`（**本端点即发送**，非草稿生成；全链唯一发送端，后续不得二次投递）
- 输入：`{...ctx.lastResult, ...event.data}` 合并后经 `prepareInviteCandidateRequest` 白名单投影（**未知业务字段一律不转发**）。
- 请求体（canonical vendor 契约）：`resume? | resume_id?`（至少一）、`jd? | job_id?`（至少一）、`hiring_request_id?`、`candidate_email?`、`recruiter_email?`、`interviewer_requirement?`、`job_title?`、`company_name?`、`interview_language?(en|zh|ja)`、`interview_duration?(>0)`、`interview_mode?`、`passing_score?(0-100)`、`linked_assessment_id?`。
- thin event 时先按 candidate_id+resume_id/job_requisition_id 从 partner PG 回拉简历/JD 文本（manifest 描述；适配器本身不查库）。
- 响应归一：`success = !explicitlyFailed && (login_url 非空 || reused===true)`（**2xx 无 login_url = 业务失败**）。4xx（非429）返回带 `error_code: ROBOHIRE_QUOTA(402)|ROBOHIRE_4XX` 的失败 data（in-band，走 FAILED emit）；网络/429/5xx 抛可重试异常（Inngest 停靠重试，不发假终态）。
- 输出 `data`：`{ ...nested回执, success, error_code: null|GOHIRE_REJECTED|ROBOHIRE_QUOTA|ROBOHIRE_4XX, login_url, qrcode_url, user_id, request_introduction_id, request_id, error_message, persistence_warning, raw }`

**Step 2 `records.upsert`** [tool] config `{ record_type: "communication_log", append: true }`
- 把真实发送回执作为沟通日志**追加**写 business_records；写库失败即终止（不发成功事件）。

**Step 3 `persistRaasEntities`** [tool] config `{ phase: "interview" }`
- 结果 emit 前：按 correlation_id 更新 RAAS PG `interview_invitation` 行 + 写 Allmeta Interview_Record / Communication_Log；correlation_id 不存在或任一外部写失败即阻断 emit。

**Step 4 `routeInterviewInvitation`** [tool]（确定性路由，fail-closed）
- 输入：`ctx.lastResult`。`sent = (success===true)`；缺失/异常回执**不算送达**。
- 输出 `data`：`{ ...透传, invitation_sent, interview_link(login_url|null), reason, _emit: SENT|FAILED, error_code }`；特例 `persistence_warning` 非空且已送达 → `_emits` 双发（FAILED(PERSISTENCE_WARNING) + SENT）。

*契约版差异：5 步 —— `unwrapAndValidateInvitation(logic)` → `resolveResumeAndJdText(logic)` → `callGoHireInvite(tool)` → `persistInvitationOutcome(tool persistRaasEntities)` → `emitInvitationOutcome(emit)`。*

### 6.3 输出事件 payload

**INTERVIEW_INVITATION_SENT**（internal；consumer=人工 interviewExecution；RAAS 按 correlation_id 回写）

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| candidate_id | String | ✅ | 候选人编号 |
| job_requisition_id | String | ✅ | 岗位编号 |
| application_id / candidate_match_result_id | String | — | trace |
| correlation_id | String | — | RAAS join 键 |
| interview_record_id | String | ✅ | AO 新建面试记录主键（`ivr_<candidate>_<jr>_inv`） |
| communication_log_id | String | ✅ | AO 新建沟通日志主键 |
| login_url | String | ✅ | AI 面试入口（成功判据；仅 reused 时可 null） |
| qrcode_url | String | — | 二维码 |
| user_id / request_introduction_id / gohire_job_id / robohire_request_id | String | — | GoHire 侧编号 |
| candidate_email | String | — | 实际接收邮箱（回执 > 入参） |
| interview_language / interview_duration_minutes | String/Int | — | 回执 > 入参 |
| sent_at | String | ✅ | ISO-8601 |

state_mutations：Interview_Record CREATE；Communication_Log CREATE；Interview_Invitation MODIFY（status, login_url, qrcode_url, gohire_user_id, request_introduction_id, gohire_invite_log, sent_at）。

**INTERVIEW_INVITATION_FAILED**（internal；consumer=人工 handleInvitationFailure）

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| candidate_id | String | ✅ | 未知时 'unknown' |
| job_requisition_id | String | ✅ | 未知时 'unknown' |
| application_id | String | — | 投递申请编号 |
| error_code | Enum | ✅ | MISSING_PAYLOAD / BACKFILL_FAILED / ROBOHIRE_4XX / ROBOHIRE_QUOTA / ROBOHIRE_5XX / GOHIRE_REJECTED / PERSISTENCE_WARNING / UNKNOWN |
| error_message | String | ✅ | 失败详情 |
| http_status | Int | — | GoHire 错误路径 |
| robohire_request_id | String | — | GoHire 请求编号 |
| failed_at | String | ✅ | ISO-8601 |

---

## 7. GoHire（RoboHire.io）外部 API 契约实测汇总

`GET https://api.gohire.top/` 端点目录（2026-07-15 实测）：`POST /api/v1/match-resume`、`POST /api/v1/invite-candidate`、`POST /api/v1/parse-resume`、`POST /api/v1/parse-jd`、`POST /api/v1/evaluate-interview`、`GET /api/v1/health`、`GET /api/v1/stats`。鉴权：`Authorization: Bearer <key>`。

| 端点 | 请求 | 响应要点 |
|---|---|---|
| `POST /parse-resume` | **multipart/form-data only**，字段名必须 `file`（JSON → 400 "PDF file is required"；`pdf`/`resume` 字段名 → 500） | 结构化 20 字段（§2.2 Step 2），含 `rawText` 全文；**无求职期望字段** |
| `POST /match-resume` | JSON `{resume\|resumeId, jd}`（实测校验：缺 jd → "jd is required"；缺简历 → "One of resume or resumeId is required"） | 双层信封 `{success, data:{31维}, requestId, savedAs}`；总分 `data.overallMatchScore.score`（权重 experience35/potential25/skillMatch40）；含 `preferenceAlignment` 五子维度（不入总分，产出 warnings） |
| `POST /jobs/generate-jd` | JSON `{prompt(4-4000), language?, companyName?, department?}` | `{success, data:{title/description/qualifications/hardRequirements/niceToHave/interviewRequirements/evaluationRules/benefits…}, meta.stages{parse,generate}, requestId}`；stage=failed 或空壳 JD 需拒收 |
| `POST /invite-candidate` | JSON：`resume\|resume_id` + `jd\|job_id` + 可选 vendor 字段（§6.2 Step 1） | `{success, data:{login_url, qrcode_url, user_id, request_introduction_id, reused?, persistenceWarning?}, requestId}`；**该端点即真实发送** |

已知坑（均已在适配器内处理）：match 响应顶层 `matchScore` 恒 null（真实分在 `data.data.overallMatchScore.score`，双层包裹）；parse 是 multipart-only；invite 2xx 无 login_url = 业务失败；GoHire 上游 LLM 分发渠道偶发 503（`分组 default 下模型 … 无可用渠道`，2026-07-15 观测），属可恢复依赖降级——停靠重试，不发终态。

---

## 附录 A. 18 事件一览（events_v2）

| 事件 | 边界 | producers | consumers | 六 agent 角色 |
|---|---|---|---|---|
| REQUIREMENT_LOGGED | external | manualEntry | createJD | ① 入口 |
| CLARIFICATION_READY | external | confirmRequirementClarification | createJD | ① 入口 |
| JD_REJECTED | external | jdReview | createJD | ① 重跑 |
| JD_GENERATED | internal | createJD | jdReview | ① 出口 |
| JD_APPROVED | external | jdReview | （发布环节，六 agent 外） | — |
| RESUME_DOWNLOADED | external | resumeCollection | processResume | ② 入口 |
| RESUME_PROCESSED | internal | processResume, redispatchCandidate | ruleCheckForMatchResume | ②→④ |
| RESUME_LOCKED_CONFLICT | internal | processResume | resolveLockConflict | ② 终态 |
| CANDIDATE_IDENTITY_REQUESTED | external | reviewCandidateIdentity | ruleCheckForCandidateIdentity | ③ 入口（主链路走 step.invoke） |
| CANDIDATE_IDENTITY_CHECKED | internal | ruleCheckForCandidateIdentity | reviewCandidateIdentity | ③ 出口 |
| MATCH_RULE_CHECK_PASSED | internal | ruleCheckForMatchResume | matchResume | ④→⑤ |
| MATCH_RULE_CHECK_FAILED | internal | ruleCheckForMatchResume | redispatchCandidate | ④ 终态 |
| MATCH_PASSED_NEED_INTERVIEW | internal | matchResume | approveInterviewInvitation | ⑤ 出口（人工审批接缝） |
| MATCH_PASSED_NO_INTERVIEW | internal | （已下线保留位） | — | — |
| MATCH_FAILED | internal | matchResume | redispatchCandidate | ⑤ 终态 |
| INTERVIEW_INVITATION_REQUESTED | external | approveInterviewInvitation, handleInvitationFailure | inviteInternalInterview | ⑥ 入口 |
| INTERVIEW_INVITATION_SENT | internal | inviteInternalInterview | interviewExecution | ⑥ 出口 |
| INTERVIEW_INVITATION_FAILED | internal | inviteInternalInterview | handleInvitationFailure | ⑥ 终态 |

---

## 附录 B. 候选人求职期望（Candidate_Expectation）缺口分析

**结论：是的——候选人期望目前完全没有进入简历匹配。且这不是单点漏传，而是"来源 → 本体 → 规则 → 数据面 → 匹配调用"五层全断。GoHire 侧其实有一个专门的 `preferenceAlignment` 评估维度在等这份数据，我们从来没喂过。**

### B.1 五层断点（全部经代码/落库/实测核验）

1. **匹配调用层**：`matchResumeApi` 只发 `{resume, jd}` 两段文本（`packages/tools/src/robohire/match-resume.ts:95-98`；API 400 校验实测同样只认 `resume|resumeId` + `jd`）。resume 文本 = GoHire parse 输出的 JSON.stringify（`tenants/zhaopin/src/tools/candidate-dedup.ts:347-355` 回显 → `route-resume-processed.ts:78` 携带 → MATCH_RULE_CHECK_PASSED carry）。jd 文本 = JD store 的 `jd_content`。**两侧都没有候选人期望**——jd 侧有城市/薪资（岗位的），但没有可与之比对的候选人侧期望。
2. **解析来源层**：GoHire `/parse-resume` 返回 20 个顶层字段（live 落库样本实测，§2.2），**无 expectedSalary / expectedLocation / 求职意向类字段**。若简历 PDF 里写了期望，只会藏在 `rawText`（随 JSON 字符串带过去，GoHire 匹配端能读到）；结构化期望（渠道 profile、顾问电话确认的）没有任何进入通道。
3. **本体层**：`models/RAAS-v1/objects_v1.json` 定义了完整的 **Candidate_Expectation 对象**（candidate_expectation_id, candidate_id, expected_position, expected_location, expected_salary_range, outsourcing_acceptance_level, expected_industry, expected_company_size, constraints[], updated_time），关系描述明确写着："**系统会拿它和【招聘岗位】的地点、薪资进行比对，不匹配时会触发预警或拦截**"。而 live 的 `models/zhaopin-v1/objects_v1.json`（25 对象）**没有这个对象**——只在候选人的 relationship_description 里提了一句"拥有【候选人求职期望】"；候选人对象本身也无期望字段（expected_degree/expected_graduation_date 是校招在读学历，不是求职期望）。
4. **规则层**：RAAS-v1 规则库（248 条）里有两条**简历匹配阶段的通用规则**直接依赖期望数据——**10-7 候选人期望薪资校验**（无期望薪资 → 标记"期望薪资未知"**挂起**匹配；期望 ≤ 岗位上限 → 继续；超上限 → 综合得分 <90 标记"薪资不匹配"终止，≥90 走特批）与 **10-8 候选人意愿度校验**（对外包模式明确排斥 → "意愿不匹配"终止推荐）。zhaopin-v1 规则库（17 条）**一条期望相关规则都没有**；④ 号 agent 的 `reasoning.evaluateRules` config 的 objectTypes/keywords 也不含 Candidate_Expectation/期望，`loadRaasRuleContext` 只查 candidate/job_requisition/resume/application/blacklist/interview_record 六类表。
5. **数据面层**：RAAS partner Postgres **已经建好 `candidate_expectation` 表**（13 列，与本体 1:1 对齐，含 expected_work_mode/available_from），当前 **0 行**——没有任何写入方：processResume 的 `persistRaasEntities(candidate_resume)` 不写它，RAAS 侧也未录入。

### B.2 GoHire 侧的"空转"证据（2026-07-13 live run 落库原文）

GoHire match 分析里的 `preferenceAlignment` 维度（companyTypeFit / jobTypeFit / **locationFit** / **salaryFit** / workTypeFit + warnings）：

> `salaryFit.assessment: "No data provided; assume neutral."`（score 100）
> `overallAssessment: "No candidate preferences on file, but professional trajectory aligns perfectly with the role."`

即：**该维度对我们所有候选人恒为"无数据→中性满分"**。值得注意 locationFit 写的是 "Candidate is in Hangzhou"——它读的是简历文本里的现居地址，证明**只要期望内容出现在 resume 文本里，GoHire 就会把它纳入 preferenceAlignment 评估**（薪资期望超预算的顾虑也确实出现在了 counterPerspective/recommendations 里，但那是模型从 Staff 职级猜的，不是我们提供的数据）。preferenceAlignment 不进总分权重（experience 35 + potential 25 + skillMatch 40），但直接产出 warnings 并影响 verdict / hiringRecommendation / 面试建议。

（2026-07-15 曾尝试注入实验——把"求职期望：仅限北京 / 55k-60k / 不接受外包"写进 resume 文本、JD 写上海 20k-28k 外包岗，验证 locationFit/salaryFit 是否翻红——当日 GoHire 上游 LLM 渠道 503（`分组 default 下模型 openai/gpt-5.6-luna-pro 无可用渠道`），实验未完成；但"on file 缺省中性"与"locationFit 会读简历内文本"两点已由落库样本证实。）

### B.3 历史佐证：旧 AO 里这条链路"契约有、数据无、函数死"

- 旧 AO 的 `RESUME_PROCESSED` 事件契约（`server/inngest/client.ts:100-103`）带四嵌套对象 `{candidate, candidate_expectation, resume, runtime}`；
- 专门写了 `flattenResumeForMatch`（`lib/mappers/flatten-resume.ts:94-110`）——含 **`Expectations:` 段**（Positions / Locations / Salary / Work Mode）拼进匹配简历文本；
- 但 `mapRobohireToRaas`（`lib/mappers/robohire-to-raas.ts:128-135`）里 candidate_expectation 全字段初始化为 null/空数组（parse 给不出），v7 拉模型后（`resume-parser-agent.ts:555`）四对象干脆置空 `{}`，且 `flattenResumeForMatch` **全仓库零调用者**——期望从未真正到达过匹配调用。
- 新 AO 忠实迁移了 as-built 行为，仅在出站 RAAS 信封投影里保留了 `candidate_expectation` 字段位（`tenants/zhaopin/src/legacy-raas-envelope.ts:208`，RESUME_PROCESSED 白名单）——有"座位"，没"乘客"。

### B.4 建议的补全路径（分析结论，未实施）

| 层 | 动作 | 落点 |
|---|---|---|
| 数据来源 | RAAS 侧提供期望录入/导入（渠道 profile 如 BOSS直聘期望字段、顾问沟通确认），写 `candidate_expectation` 表（表已就绪）；或随 RESUME_DOWNLOADED / redispatch 事件带 `candidate_expectation` 对象（出站信封已有字段位，入站契约需在 events 里补可选字段） | RAAS + `events_v*.json` |
| 匹配调用 | 匹配前按 candidate_id 回查 candidate_expectation（或直接消费事件 carry），把"求职期望"段追加进 resume 文本（对齐旧 `flattenResumeForMatch` 设计；GoHire 的 preferenceAlignment 会消费它）。API 无独立 preferences 入参，文本注入是当前唯一通道 | `route-resume-processed`（回查+carry）或 matchResume 前置步 |
| 规则闸门 | 把 RAAS-v1 规则 10-7（期望薪资）/10-8（外包意愿）引入 zhaopin 规则库；`reasoning.evaluateRules` config 的 objectTypes 加 `Candidate_Expectation`、keywords 加 期望薪资/意愿；`loadRaasRuleContext` 增查 candidate_expectation 表 —— 让"薪资超限挂起/明确排斥终止"成为**确定性前置闸门**，而不是依赖 GoHire 的软性维度 | `models/zhaopin-v1/rules`、`raas-rule-context.ts`、manifest config |
| 本体 | zhaopin-v1 objects 补 Candidate_Expectation 对象（从 RAAS-v1 平移），persistRaasEntities 的 candidate_resume phase 顺带 upsert 期望快照 | `objects_v*.json`、`raas-persistence.ts` |

优先级建议：**规则闸门（10-7/10-8）> resume 文本注入 > 本体/持久化补全**——前者是客户明确的业务规则（挂起/拦截语义，GoHire 的中性缺省正好把它掩盖了），后两者是让 preferenceAlignment 真正生效的增量。
