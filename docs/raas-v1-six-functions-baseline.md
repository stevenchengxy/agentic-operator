# RAAS-v1 六个 functions 现状基线（拆分改造前留存）

- **日期**: 2026-07-17（拆分/期望补齐环实施前的快照）
- **来源**: `models/zhaopin-v1/workflow_v1.json`（实测导出）+ `tenants/zhaopin/src/legacy-raas-envelope.ts` 出站白名单 + 2026-07-15/16 live 全绿运行回执
- **用途**: 留存记录。改造后以此文档核对"哪些行为被保留、哪些被改变"。

## 0. 公共机制（六个 function 共享）

- **事件信封**（与 RAAS broker 互通）: `{ entity_type, entity_id, event_id, payload, source_action, trace }`；出站按**每事件白名单**投影（fail-closed，未声明的事件不准出站；简历/JD 全文不过线）。
- **carry-forward**: 步骤间通过 `ctx.lastResult` 累积合并；出站事件载荷 = 入站业务字段 ⊕ 最终步骤返回（生产者覆盖同名键）。
- **并发键**: `event.data.entity_id`（信封）→ run subject；同 subject 串行。
- **链路追踪**: 同一 correlationId 串起级联（`GET /v1/runs/:id/chain`）。
- **持久化纪律**: `persistRaasEntities` 为 write-before-emit、fail-closed——PG 镜像（`RAAS_POSTGRES_URL`）+ Allmeta 实例（`ALLMETA_BASE_URL/KEY`，domain=`ALLMETA_DOMAIN`=RAAS-v1）任一配置目标失败即拒绝该步，结果事件不发出。

---

## 1. createJD（节点 4）— JD 生成

| 项 | 值 |
|---|---|
| 触发 | `REQUIREMENT_LOGGED` / `CLARIFICATION_READY` / `JD_REJECTED`（入参锚点: `job_requisition_id`，REQUIREMENT_LOGGED/CLARIFICATION_READY 下 `entity_id` 即需求号） |
| retries | 3（瞬时故障真重试；确定性拒绝走阶梯终态） |
| 发出 | `JD_GENERATED` — 线载字段: `job_posting_id, job_requisition_id, client_id, jd_content` |

| # | 步骤 | 类型 | 输入 → 输出 |
|---|---|---|---|
| 1 | `loadRaasRequirement` | tool | `job_requisition_id`（事件）→ 镜像库 `job_requisition` + `job_requisition_specification` 两表 `row_to_json` 快照（+澄清记录）。**不含 client 表**（公司名/行业/福利断供——已列改造项） |
| 2 | `generateJdApi` | tool | 快照 → `flattenJobRequisition` 拼 14 字段 prompt（≤4000 字符）→ RoboHire `POST /jobs/generate-jd` → `{title, description, qualifications, hardRequirements, niceToHave, benefits, interviewRequirements, evaluationRules, jd_content(拼装 Markdown), must_have_skills[], nice_to_have_skills[], stages, request_id}`。`on_error` 阶梯: `input_invalid/upstream_rejected/output_invalid → terminal`（NonRetriable），其余 retry |
| 3 | `persistJd` | tool | `jd_content` + `job_requisition_id` → 租户 JD store（agentMemoryLong），供 matchResume 回查 |
| 4 | `persistRaasEntities` | tool（config `phase: job_posting`） | 快照+JD → PG `job_posting` 行 + Allmeta `Job_Posting` 实例；fail-closed |

Live 回执（2026-07-16）: 全链 74.2s（真生成 73.5s），Allmeta RAAS-v1 域可查到生成的 Job_Posting 实例。

## 2. processResume（节点 9-1）— 简历解析处理【本次拆分对象】

| 项 | 值 |
|---|---|
| 触发 | `RESUME_DOWNLOADED`（契约必填: `upload_id, bucket, object_key`；可选: `etag, filename, mime_type, job_requisition_id(s)`。入站适配器**先从 MinIO 真拉简历**落 inbox） |
| retries | 0 |
| 发出 | `RESUME_PROCESSED` — 线载: `upload_id, employee_id, candidate_id, resume_id, job_requisition_id(s), sourcing_channel_id, client_id, filename, parsedAt, parserVersion, candidate, candidate_expectation, runtime`；或 `RESUME_LOCKED_CONFLICT` — 线载: `lock_conflict, locked_by(_employee_id/_name), reason, error` |

| # | 步骤 | 类型 | 输入 → 输出 |
|---|---|---|---|
| 1 | `fs.readFromInbox` | tool（`subdir: resumes`） | `filename` → `{base64, bytes, path, mime}` |
| 2 | `parseResumeApi` | tool | 文件字节（multipart，字段名必须 `file`）→ RoboHire `/parse-resume` → 结构化字段（name/phone/email/experience/education/skills/…）+ `rawText` |
| 3 | `invokeCandidateIdentityCheck` | **invoke**（`forward_last_result: true`） | 同步调用 10-3；返回的身份判定载荷（含 `candidate_id`）平铺并入 carry |
| 4 | `records.upsert` | tool（`record_type: candidate`） | 候选人业务档案快照 → `business_records`（按 candidate_id 幂等） |
| 5 | `routeResumeProcessed` | tool | 确定性装配: `candidate_id / resume / resume_id / job_requisition_id(s) 扇出 / jd`（store→PG 回查）/ **`candidate_expectation` 基线抽取**（rawText）；按 `lock_conflict` 路由 `_emit` |
| 6 | `persistRaasEntities` | tool（`phase: candidate_resume`） | PG `candidate` + `resume` 行（含 `parsed_content`=rawText、`bucket_name/object_key`）+ Allmeta 实例；fail-closed（`candidate_id/resume_id/bucket/object_key` 必备） |

Live 回执（2026-07-16）: 7.9s（parse 5.1s）；RESUME_PROCESSED 已携带 `candidate_expectation`（work_mode=远程 由文本抽出）。

## 3. ruleCheckForCandidateIdentity（节点 10-3）— 候选人身份查重

| 项 | 值 |
|---|---|
| 触发 | `CANDIDATE_IDENTITY_REQUESTED`（人工入口）；主链路由 9-1 `step.invoke` 同步调用 |
| retries | 1 |
| 发出 | `CANDIDATE_IDENTITY_CHECKED` — 线载: `upload_id, candidate_id, resume_id, same_person, same_as_candidate_id, dedup_action, matched_rule, matched_tier, needs_review, decision_reason, audit_id` |

| # | 步骤 | 类型 | 输入 → 输出 |
|---|---|---|---|
| 1 | `candidateDedupLookup` | tool | 解析摘要（name+phone+email）→ SQLite 注册表三级查重 + 招聘顾问归属锁（owner=subject；已注册候选人换 subject 重投 → `lock_conflict`）；铸/回 `candidate_id`，echo resume/ids |
| 2 | `checkCandidateIdentity` | **logic**（LLM 经网关，custom 代理） | 花名册: `candidateDedupLookup` + `ontology.fetchActionRules`；产出同人结论 + `decision_reason`，`_emit` 路由 |
| 3 | `ontology.fetchActionRules` | tool（`action: ruleCheckForCandidateIdentity, domain: Agents-generation`，`on_error: soft`） | 审计尾拉取动作规则；**此位置入参缺 action 字段时反漂移检查 fail-closed → soft 放行**（已知瑕疵，不阻塞） |

Live 回执: 2.4–2.7s ×多轮全绿；lock_conflict 语义 2026-07-13 已验证。

## 4. ruleCheckForMatchResume（节点 10-1）— 匹配前规则闸门

| 项 | 值 |
|---|---|
| 触发 | `RESUME_PROCESSED` |
| retries | 3 |
| 发出 | `MATCH_RULE_CHECK_PASSED` — 线载: `candidate_id, resume_id, job_requisition_id, client_id, rule_check_result, rule_check_reason, upload_id, employee_id, audit, rule_check_rules, job_requisition, parsed_resume, parsed_content, runtime_context, candidate_expectation`；或 `MATCH_RULE_CHECK_FAILED`（另含 `failed_rules, matching_score`） |

| # | 步骤 | 类型 | 输入 → 输出 |
|---|---|---|---|
| 1 | `loadRaasRuleContext` | tool | `candidate_id/job_requisition_id` → 镜像库拉宽上下文: 候选人、结构化简历、目标 JR（`row_to_json` 含 `resume_match_score_threshold`）、客户/部门、历史投递/面试、黑名单、合规凭证 → `rule_context` |
| 2 | `reasoning.evaluateRules` | tool（包 config: `scenario: pre_match_resume_rule_check, objectTypes[8], keywords[7], ruleLimit: 30, passEvent/failEvent`） | 嵌套 `reasoningAgent`（独立 run×2 常见）: 规则选择（Allmeta domain `rules-test`）→ 逐条判定 → Quality Guard 证据引用回验（验不过 fail-closed 降 `review_required`）→ 确定性折叠 → `_emit` PASSED/FAILED。**注意非确定性**: 同一候选人可能 PASSED/FAILED 翻转（证据引用质量波动） |

Live 回执: 39.3s（含双 reasoningAgent）；PASSED×4 / review_required→FAILED×1（2026-07-15/16 实测）。

## 5. matchResume（节点 10-2）— 简历匹配

| 项 | 值 |
|---|---|
| 触发 | `MATCH_RULE_CHECK_PASSED` |
| retries | 2 |
| 发出 | `MATCH_PASSED_NEED_INTERVIEW` / `MATCH_FAILED` — 线载: `job_requisition_id, candidate_id, matching_score, upload_id, job_posting_id, candidate_match_result_id, overall_status, success, data, requestId, savedAs, error`（`MATCH_PASSED_NO_INTERVIEW` 已退役但白名单保留） |

| # | 步骤 | 类型 | 输入 → 输出 |
|---|---|---|---|
| 1 | `loadMatchInputs` | tool | 线载 ids → 镜像库回查简历全文（`resume.parsed_content`，按 resume_id else candidate_id 最新）+ JD（store→PG job_posting 回退）+ **`candidate_preferences`**（线上 `candidate_expectation` 优先，否则简历文本现抽；空则省略）；fail-closed |
| 2 | `matchResumeApi` | tool（**显式 `tool_arguments`**: `resume/jd ← lastResult`，`candidatePreferences ← lastResult.candidate_preferences (required:false)`） | RoboHire `POST /match-resume` `{resume, jd, candidatePreferences?}` → `{matchScore, verdict, hiringRecommendation, summary, data(全量分析), requestId, savedAs, raw}` |
| 3 | `records.upsert` | tool（`record_type: candidate_match_result`） | 匹配结果档案 upsert |
| 4 | `routeMatchOutcome` | tool | `matchScore` vs `resume_match_score_threshold`（lastResult/event 顶层或 `job_requisition` 对象内；**无默认值 fail-closed**；多源冲突报错）→ `_emit` NEED_INTERVIEW / MATCH_FAILED |
| 5 | `persistRaasEntities` | tool（`phase: candidate_match`） | PG `candidate_match_result`(+runtime_state) 行 + Allmeta 实例 |

Live 回执（2026-07-16）: loadMatchInputs 17-63ms；真匹配 33.6-87.4s；score 15 vs 阈值 60 → 诚实 MATCH_FAILED；**RoboHire 分析回读了 candidatePreferences**（"候选人明确偏好远程工作 Dealbreaker #1"，54 处引用）。

## 6. inviteInternalInterview（节点 11-1）— 面试邀约

| 项 | 值 |
|---|---|
| 触发 | `INTERVIEW_INVITATION_REQUESTED`（RAAS 审批后发起/运营手动；生产 HITL——匹配通过**不**自动邀约）。载荷需含邀约白名单字段（`resume`/`resume_id`、`jd`/`job_id`、`candidate_email`、`interview_language`…）+ `correlation_id`（镜像 `interview_invitation` 请求行由平台先建，AO 只 UPDATE） |
| retries | 2 |
| 发出 | `INTERVIEW_INVITATION_SENT` — 线载: `candidate_id, job_requisition_id, application_id, candidate_match_result_id, correlation_id, interview_record_id, communication_log_id, login_url, qrcode_url, user_id, request_introduction_id, gohire_job_id, candidate_email, interview_language, interview_duration_minutes, robohire_request_id, sent_at`；或 `INTERVIEW_INVITATION_FAILED`（`error_code/error_message/http_status/failed_at`） |

| # | 步骤 | 类型 | 输入 → 输出 |
|---|---|---|---|
| 1 | `inviteCandidateApi` | tool | 白名单字段投影（`STRING_FIELDS`，未知字段不透传）→ RoboHire `POST /invite-candidate` → 回执（**2xx 无 `login_url` 且非 reused 判 success:false**） |
| 2 | `records.upsert` | tool（`record_type: communication_log, append: true`） | 沟通日志追加 |
| 3 | `persistRaasEntities` | tool（`phase: interview`） | 按 `correlation_id` UPDATE 镜像 `interview_invitation` → `sent`（login_url/qrcode/gohire_invite_log/sent_at）或 `failed`；**行不存在则报错**（请求行须由平台先建） |
| 4 | `routeInterviewInvitation` | tool | 按已持久化回执路由 `_emit` SENT/FAILED；**不做第二次发送** |

Live 回执（2026-07-15）: 真邀约 12.5s/25.8s（login_url 返回），镜像行 `sent` + 日志落库，全链 13.4s。

---

*本基线由实测 manifest/白名单导出，与 2026-07-15/16 的 live 全绿运行互证。改造（9-1 拆分 + 期望补齐环 + createJD 入参优化）见 `raas-v1-agents-optimization-design.md`。*
