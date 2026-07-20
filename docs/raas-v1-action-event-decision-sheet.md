# RAAS-v1 Action → Event 决策单

更新时间：2026-07-13

这份文档只记录只读分析结果和待确认的业务语义，不是上传文件，也不会修改 Allmeta。

## 当前事实

- 权威 Action 快照：`actions_v0_1_015.json`，23 个 Action。
- 权威 Event 快照：`events_v0_1_039.json`，37 个 Event。
- 按 Action 的 trigger / triggered_event 重建拓扑后：35 个候选 Event。
- 新 Action 不再引用的旧 Event：`INTERVIEW_INVITATION_REQUESTED`、`INTERVIEW_INVITATION_FAILED`。
- 图库存：37 个 RAAS-v1 Event，0 个无 domain 归属 Event，0 个 graph-only 删除项。
- Action 契约仍有 65 个阻断项：42 个输出缺少 outcome 映射，23 个数据变更缺少 outcome 映射。
- 加强完整图读回后，exact preflight 总阻断为 66：上述 65 项之外，`AI_INTERVIEW_COMPLETED` 缺少 payload 要求的 1 个 `EventField`、2 个 `EventMutation` 及对应关系，新增 1 项 `graph_snapshot_unavailable`。只读查询已确认这些 RAAS-v1 child 节点本身不存在，而不是 key/position 写错；其他 domain 的同名或 orphan 节点不会被认领。
- 当前 Action 快照 hash：`sha256:23b6b6a7bad7c3345e81c308288ee5fe48ca26ba821e3f591e1d2a64bc14d93d`。
- 当前 35-Event 候选 hash：`sha256:d53d1e6e70e2653de5d042a84299af0e80d352fac3fac23b763ece66920ecb53`。
- 目前没有生成新的权威版本文件，也没有覆盖 Allmeta/Neo4j；上述 hash 只是给人工审查和后续 CAS 使用的只读证据。

发布器会自己重新计算这些阻断项；调用方不能用“已经验证通过”或伪造 0 blocker 绕过。

## 为什么现在没有直接覆盖 Allmeta

这次 Action 和 Event 必须一起改。分开调用旧的 Actions Builder 和 Events Builder 会形成循环依赖，而且旧 Action 发布路径会原地改版本文件、允许局部发布，并用 `DETACH DELETE` 丢掉 Rule/Object/Link 关系。

现在已经补了 `OntologyReleaseBundle` 的联合 preview 协议，以及 Event 的完整定义、字段、mutation、producer/consumer 拓扑读回验证。执行入口默认关闭；只有同时具备以下四项能力才允许真正写入：

1. 跨进程 CAS/lease，保证父版本和审查 hash 没有漂移。
2. 被删除 Action/ActionStep 的节点与关系 before-image，可验证地恢复。
3. 持久化 saga journal 和补偿 receipt。
4. Action、ActionStep、Event 在一个受保护的图事务中提交。

当前版本没有安装生产 executor，而且执行入口无条件拒绝；即使调用方伪造 `ready=true` 或传入一个会回显 hash 的 executor，也不会调用任何写方法。Action 的原始 canonical writer 也已从这个 exact 路径及公共导出移除。未来只有服务端持久化的 release、独立验证器和上述四项能力全部实现后，才可以重新开放执行。这个状态是刻意的安全阻断，不是上传完成。

独立复审最初发现旧版 Actions/Events Builder、Studio schema CRUD、Workflow/Links Builder、公开 Event mutator 和维护脚本都能绕过 `OntologyReleaseBundle`。这些入口现已默认 fail-closed：canonical mutation 缺少显式 enable、domain allowlist 和独立 timing-safe Bearer 时返回结构化 `423`，非法/冲突 domain 在任何文件或图调用前拒绝；公开包也不再导出 driver、任意 Cypher、exact publisher 或 Event mutator。三个危险脚本只保留本地只读 dry-run，`--apply` 即使确认 token 正确也会拒绝。

兼容旧系统的 emergency override 仍存在，但必须同时显式配置 `ALLMETA_LEGACY_CANONICAL_WRITE_ENABLED=true`、`ALLMETA_LEGACY_CANONICAL_WRITE_DOMAINS` 和 `ALLMETA_LEGACY_CANONICAL_WRITE_TOKEN`；正常 release worker 不得使用它。当前这三个值保持未启用，所以不会借旧入口上传 RAAS-v1。

## 建议的通用映射原则

这些原则只有在业务负责人确认后才会写回 Action：

1. 结果状态、错误说明、执行摘要：映射到所有可能 outcome。
2. 只在成功后才存在的业务 ID、完成时间、正式记录：只映射到成功 outcome。
3. 失败时产生的告警、失败日志、重试信息：只映射到失败 outcome。
4. 一个 data change 同时包含“成功才写”和“失败也写”的属性时，拆成两条 data change，不用一条模糊映射覆盖全部分支。
5. 无法从 Action 描述、Event schema 和旧运行代码三方一致证明的映射，保持阻断并询问用户，不猜。

## 需要确认的业务分支

### 1. 面试邀请边界

新 Action 是 `MATCH_PASSED_NEED_INTERVIEW → inviteInternalInterview → INTERVIEW_INVITATION_SENT`，没有 REQUESTED/FAILED。

旧生产代码则是：匹配通过后先由 RAAS/HSM 审批并发 `INTERVIEW_INVITATION_REQUESTED`，邀请 Agent 再发 `SENT` 或 `FAILED`。旧设计能表达人工批准和失败恢复。

建议：保留 `REQUESTED / SENT / FAILED` 三段式，并同步修正 Action；不要直接删除 REQUESTED/FAILED。

### 2. 简历下载粒度

`resumeCollection` 输出 `resume_file_paths: List<String>`，但 `processResume` 输入单个 `resume_file_path`。

建议：每份文件产生一个 `RESUME_DOWNLOADED`，每个 Agent run 只处理一份简历。批次 ID 作为关联字段保留。

### 3. 匹配结果类型

新 Action 把 `match_results` 声明成 `String`，旧 Event/生产代码表达的是多岗位匹配结果集合。

建议：改为 `List<JSON>`；不要把结构化结果 JSON.stringify 成字符串。

### 4. `MATCH_PASSED_NO_INTERVIEW`

新 Action 声明该分支；旧生产代码目前只发 NEED_INTERVIEW 或 FAILED。

建议：若业务确实存在“无需面试直接进入推荐包”的岗位，保留并补充明确判定规则；否则先从 Action 删除，不能保留一个永远无法到达的分支。

### 5. 多 outcome Action 的建议映射

| Action | 建议映射 | 仍需业务确认 |
|---|---|---|
| `syncFromClientSystem` | `sync_result` 发成功和失败；持久化变更仅发成功 | 部分成功时是否同时发两个 Event；成功 ID 列表是否也放失败 Event |
| `analyzeRequirement` | 分析字段和 Job_Requisition 变更只发 COMPLETED | BLOCKED 需要新增什么错误字段 |
| `clarifyRequirement` | status/questions 发两边；完整岗位字段只发 READY | INCOMPLETE 是否保存部分澄清结果；沟通日志发哪边 |
| `jdReview` | review_result 和 publish_status 发 APPROVED/REJECTED 两边 | 无 |
| `publishJD` | publish_result 发两边；publish_time 只发成功 | 失败时 publish_status 是否也更新；建议拆 data change |
| `processResume` | process_status 发四个 outcome；正式对象写入只发成功 | INFO_MISSING 是否保存部分 Resume/Candidate；LOCKED_CONFLICT 是否更新 Candidate |
| `ruleCheckForMatchResume` | result/reason 和审计结果发 PASSED/FAILED 两边 | 是否在失败时也创建 Candidate_Match_Result |
| `matchResume` | overall_status 发所有分支；匹配明细发实际完成匹配的分支 | NO_INTERVIEW 是否启用；失败时 Application/Candidate 如何落状态 |
| `evaluateInterview` | evaluation_result 发两边；正式报告 ID/记录只在生成成功时发 | FAILED 是业务淘汰还是系统评估失败，两者是否要拆 Event |
| `generateRecommendationPackage` | package_status 发两边；material ID/正式记录只发 GENERATED | 缺材料时 Candidate/Application 是否更新阶段 |
| `submitToClientPortal` | submission_result 和 Application 状态发两边 | Candidate 锁定、Blacklist 只适用于哪些失败原因 |

## Agents-generation 还需确认的 Ontology 语义

机械性字段改名、缺失 producer/consumer、外域 source_action、无效 RuleCheckAudit 引用可以按当前对象 schema 自动修复；下面几项不能替用户决定：

1. 旧 Rule `9-2` 是否允许映射到当前 `H-8-19`（相似但执行责任不同）。
2. 旧 Rule `10-46` 是自动锁定，当前 `H-10-66` 是人工提醒；必须选一个真实政策。
3. 是否新增 `Job_Posting.updated_time`、`Job_Requisition.client_id`、`Candidate.lock_reason`，还是删除对应 mutation。
4. 是否新增 `RESUME_INFO_MISSING`、`RESUME_PARSE_ERROR`、`MATCH_PASSED_NO_INTERVIEW`，还是从 Action 删除这些 emit。
5. 是否新增历史对象 `Candidate_Identity_Result`；若不新增，身份检查结果必须指定另一个权威对象。

最新只读预检读取的是 Allmeta，而不是本地兜底数据：44 个 Object、16 个 Event、6 个 Action、15 个 Step、262 个 Rule；仍有 59 个阻断和 111 个 warning。27 个集成需求中，3 个已解析、13 个待配置、0 个可直接探针、11 个缺少明确绑定。规则读取和写实例工具现在也必须提供与 tenant/domain/action/object 匹配的显式 profile 配置，不再从进程变量或“唯一候选”自动选择。因此现在还不能进入“生成 6 个 Agent”。

已对一份**内存候选**完成 41 项低风险机械修复 dry-run，结果是 59 → 18 个阻断、0 个新增阻断；没有保存快照、没有上传 Allmeta。41 项由以下可追溯变更组成：

- 2 项外域 `source_action` 的 `source_domain` 修正。
- 6 项旧六 Agent 的 producer/consumer 拓扑补齐。
- 2 项 rule-check 输出字段改名。
- 15 项按现有 Object schema 可唯一证明的 Event 字段/状态映射修正。
- 4 项 MATCH audit DTO 的无效 target object 清理。
- 2 项无效 integration object 引用清理。
- 10 项能由旧生产代码与当前 Object schema 双重证明的 side-effect property 改名。

剩下的 18 项包含真实政策、对象归属、缺失 Event/字段及未绑定输出，必须先做下面的人工选择，不能为了让预检变绿而删除语义。

还需要明确三个真实系统边界，不能靠名称相似自动绑定：

1. Ontology 中的 `Partner PG` 是否就是由现有 PostgreSQL 连接访问的同一个系统；若是，建议在 Ontology 或工具 capability 中显式声明同一身份。
2. `审计库 (RuleCheckAudit)` 和 `审计库 (IdentityResult)` 实际落在 PostgreSQL、Allmeta，还是另一个系统。
3. 身份弱匹配需要创建 RAAS/HSM 人工复核任务时，究竟由哪个 Ontology Event 表示；必须给出准确 Event 名。

## 安全探针需要的数据

不要在聊天中粘贴密码或 API key。环境变量名已经可以安全保存，真实值只放服务器环境。

继续探针前还需要：

- MinIO：一个可读取的测试 bucket + object key（最好是专用、无敏感内容的简历样本）。
- PostgreSQL：statement catalog 的环境变量名，以及专用的只读 operation；写探针需一次性测试记录和清理方案。
- Allmeta instance write：允许写入的测试 object_type、测试 ID 和清理方案。
- RoboHire：生成 JD、解析简历、匹配简历的低风险测试输入；邀请候选人属于真实外部写操作，必须使用专用测试账号/邮箱并单独确认。

另外还要为集成 profile 提供非秘密配置：RoboHire 的 key/base URL **环境变量名**，Allmeta 的 base URL/API key **环境变量名**及 tenant/domain/object/action allowlist，MinIO 的单一 origin 环境变量名与 access/secret 环境变量名。不要把这些环境变量的真实值发到聊天里。

在这些信息和人工确认齐全前，不运行真实写探针，不 promotion，不真实发邀请。

## 本轮可复验结果

- RAAS-v1 exact preview：35 个候选 Event，65 个 Action contract blocker，加 1 个 graph readback blocker，总计 66；候选与 Action hash 保持不变。
- Agents-generation 只读预检：Allmeta strict source、无降级；59 个 Ontology blocker、111 个 warning；27 个集成中 3 resolved、13 needs_config、11 missing、0 needs_probe。
- Agent Factory：90 个测试文件、700 项通过；Tools：12 个测试文件、74 项通过；相关 shared/runtime/factory/tools/API typecheck 通过。
- Allmeta Event Store：19 个测试文件、86 项通过；mock-data（含危险脚本门禁）：76 项通过；ontology-api：25 个测试文件、270 项通过；Actions/Workflow/Links/Events Builder 的定向门禁与相关 typecheck 通过。
- 所有上述验证均未调用 canonical write、Neo4j write、MinIO write 或真实外部邀请。
