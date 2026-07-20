# RAAS-v1 agents 改造设计 — 候选人期望补齐环（最简版）+ createJD 入参优化

- **版本**: v0.7（设计稿，未实施）
  - v0.7: **最简版定稿**。核对活库后修正：期望**不被规则检查（10-1）消费，只被匹配（10-2）消费**（作 candidatePreferences 喂 RoboHire）；因此删除原 v0.6 的 `applyCandidateExpectation` 持久化子步骤——补齐后期望的持久化（镜像库 `candidate_expectation` 表 + Neo4j）**归 RAAS**（它是补齐方/system-of-record）。AO 侧 10-1 只剩一个"换触发器"改动。两事件方向明确：`RESUME_PROCESSED` = AO 发布 / RAAS 消费；`MATCH_RULE_CHECK` = RAAS 发布 / AO 消费。
  - v0.6: 最简方案（1 个新事件，functions 保持 6 个）——applyCandidateExpectation 作 10-1 前置步骤（已被 v0.7 删除）。
  - v0.5 及更早: 拆分/9-2 独立 agent/RESUME_PARSED 等（均已取消，见 §1.7 留痕）。
- **日期**: 2026-07-17
- **范围**: AO 侧 agents / 工具 / manifest 改造。RAAS 侧在既有 `RESUME_PROCESSED` 订阅上新增"补齐期望 + 持久化"用途并发布 `MATCH_RULE_CHECK`（对外契约见 `raas-v1-expectation-enrichment-event-design.md` v0.5）。
- **改造后 functions 数量**: **6 个（不变）**。
- **改造前基线**: `raas-v1-six-functions-baseline.md`（本版下 9-1/10-3/10-2/11-1 与基线完全一致；10-1 仅换触发器）。

---

## 第一部分 — 候选人期望补齐环（最简版）

### 1.1 已核实的活库事实（本版的依据）

| 查证项 | 结果 | 影响 |
|---|---|---|
| 本体（Allmeta RAAS-v1 域）有 `Candidate_Expectation` 对象吗 | **有**（候选人求职期望，11 字段：`expected_positions/expected_locations/expected_salary_range/expected_work_mode/outsourcing_acceptance_level/expected_industries/expected_company_size/constraints/…`） | 可被写实例（但见下行——本流程无需 AO 写） |
| 镜像库有 `candidate_expectation` 表吗 | **有**（13 列，`expected_location/expected_salary_range/expected_work_mode/…`，键 `candidate_expectation_id`+`candidate_id`） | 持久化目标存在——归 RAAS 写 |
| 10-1 规则检查引用 `Candidate_Expectation` 吗 | **不引用**（objectTypes = Candidate/Resume/Job_Requisition/Application/Client/Client_Department/Blacklist/Compliance_Document；keywords 全是国籍/黑名单/回流） | **期望不进规则检查** |
| 期望能顺流到匹配吗 | **能**（`MATCH_RULE_CHECK_PASSED` 出站白名单已含 `candidate_expectation`；`loadMatchInputs` 已读它 → `formatCandidatePreferences` → `candidate_preferences` → RoboHire） | 匹配是期望的唯一消费者，且通路已通 |
| AO 今天写镜像 `candidate_expectation` 表吗 | **不写**（persistRaasEntities 只有 candidate_resume / candidate_match 等 phase） | 持久化本就不在 AO 侧 |

**结论**: 期望的唯一 AO 侧消费者是**匹配（10-2）**，且通路已现成。规则检查（10-1）只需被 `MATCH_RULE_CHECK` 触发、把期望原样带过（白名单已含），不需要任何新增持久化步骤。

### 1.2 两个事件的方向（本版核心）

| 事件 | 发布方 | 消费方 | 变化 |
|---|---|---|---|
| `RESUME_PROCESSED` | **AO** | **RAAS** | 事件契约不变。**双消费**：RAAS 既有的档案状态同步 + ★新增"拿 candidate_id 补齐期望"。AO 侧唯一变化 = **断开对 10-1 的自触发** |
| `MATCH_RULE_CHECK` | **RAAS** | **AO** | ★唯一新增事件。RAAS 补齐并持久化后发布（载荷含补齐后的 `candidate_expectation`）；AO 消费它触发 10-1 |

闭环：**AO 发 `RESUME_PROCESSED` → RAAS 消费并补齐+持久化 → RAAS 发 `MATCH_RULE_CHECK` → AO 消费并跑 10-1 规则检查 → 10-2 匹配**。

### 1.3 目标时序

```
RESUME_DOWNLOADED（RAAS→AO，既有，不变）
   │
[9-1 processResume]（与现状完全一致，零改动）
   │   取件 → 解析 → 内嵌查重(10-3,铸 candidate_id) → 期望基线抽取
   │   → records/persistRaasEntities 落库 → 按岗位扇出
   ├─ 锁冲突 → RESUME_LOCKED_CONFLICT（不变）
   └→ RESUME_PROCESSED【AO 发布】（事件不变，载荷含 candidate_id + 期望基线。
   │                    唯一变化：不再自触发 10-1）
   │
   │   【RAAS 消费 RESUME_PROCESSED（既有档案同步 + ★新增用途）：
   │    拿 candidate_id 检索自家系统（顾问沟通记录/候选人库）补齐期望，
   │    写自家库 + 镜像 candidate_expectation 表 + 自家 Neo4j 同步；
   │    完成后发布 MATCH_RULE_CHECK。链路在此停等（纯事件间隙，无在途 run）】
   │
   ←  MATCH_RULE_CHECK【RAAS 发布 / AO 消费】（★唯一新增事件：
   │                    锚点=candidate_id，载荷含补齐后 candidate_expectation）
   │
[10-1 ruleCheckForMatchResume]（★仅换触发器：RESUME_PROCESSED → MATCH_RULE_CHECK）
   │   ① loadRaasRuleContext（不变） ② reasoning.evaluateRules（不变）
   │   —— 规则检查不读期望；期望经既有白名单原样带到出站事件
   └→ MATCH_RULE_CHECK_PASSED（携 candidate_expectation）/ FAILED（不变）
   │
[10-2 matchResume]（不变）：loadMatchInputs 取期望 → candidatePreferences → RoboHire 打分
   │
   → MATCH_PASSED_NEED_INTERVIEW → RAAS 审批 → [11-1 邀约]   ……全部不变
```

### 1.4 变更矩阵（每个 function 一行）

| Function | 变化 |
|---|---|
| 4 createJD | 无（见第二部分独立优化） |
| 9-1 processResume | **零改动**（bypass 开关开启时终步路由附发一条自答 `MATCH_RULE_CHECK`，见 §1.6——纯配置态） |
| 10-3 身份查重 | 无 |
| **10-1 ruleCheckForMatchResume** | **仅换触发器**: `RESUME_PROCESSED` → `MATCH_RULE_CHECK`。步骤/emit/白名单不变（`candidate_expectation` 本就在白名单，原样带过） |
| 10-2 matchResume | 无（loadMatchInputs 已消费 `candidate_expectation`，权威值自然到 RoboHire） |
| 11-1 邀约 | 无 |

> 与 v0.6 的差别：**删除了 10-1 的 `applyCandidateExpectation` 前置持久化步骤**。期望持久化归 RAAS（§1.5）；AO 侧 10-1 只换触发器，比 v0.6 更小。

### 1.5 持久化归属（明确边界）

- **补齐后期望的持久化 = RAAS 的职责**：RAAS 是补齐方与 system-of-record，由它写①自家库、②共享镜像库 `candidate_expectation` 表、③自家 Neo4j 候选人节点同步。这满足"补齐后更新图谱"的诉求——执行方是 RAAS，避免 AO/RAAS 争写同一张表造成漂移。
- **AO 侧不写 `candidate_expectation` 表 / 不写 Allmeta Candidate_Expectation 实例**——本流程无消费者需要 AO 这么做（规则检查不读、匹配从事件载荷取）。
- 期望在 AO 侧仅**在事件载荷上流转**（`MATCH_RULE_CHECK` → 10-1 carry → `MATCH_RULE_CHECK_PASSED` → 10-2），不落 AO 本地库。

### 1.6 停等语义与兜底

- **停等点**在"9-1 已终、10-1 未始"的纯事件间隙——无在途 run 悬挂，耐 api/Inngest 重启，reconciler 无感。
- **锁冲突候选人到不了 RESUME_PROCESSED** ⇒ RAAS 不会为其补齐。
- **bypass 过渡开关** `ZHAOPIN_EXPECTATION_ENRICHMENT=off`（Phase 1 默认）：RAAS 未上线前，AO 在发 `RESUME_PROCESSED` 的同时**自答**一条 `MATCH_RULE_CHECK`（`enrichment_status: bypassed`，期望=基线）→ 10-1 照常运行，全链行为与今天等价。RAAS 上线后关闭开关，改由 RAAS 真发。
- 运营可手动补发 `MATCH_RULE_CHECK`；建议回执时限 24h（软约定）。
- **幂等**: 入站以 `event_id` 主键、`upload_id`/`candidate_id` 兜底去重；10-1 重复触发的代价 = 多跑一次规则检查（与今天重发 RESUME_PROCESSED 等价的风险面）。

### 1.7 方案演化留痕（已取消的复杂度）

| 曾经的机制 | 处置 | 原因 |
|---|---|---|
| 9-1 拆分 / 解析快照存储 / upload 层提前入库 / `RESUME_PARSED` 出站事件 / 9-2 独立 agent + `CANDIDATE_PROFILE_ENRICHED` 内部事件 | **全部取消** | RAAS 需 candidate_id ⇒ 查重必先行 ⇒ 补齐环后移到 RESUME_PROCESSED 之后；单消费方场景无需拆分/中转事件 |
| 10-1 前置 `applyCandidateExpectation`（写 PG 期望表 + Allmeta 实例 + Neo4j + business_records） | **取消（v0.7）** | 活库核实：规则检查不读期望、匹配从事件载荷取、AO 今天本就不写该表；持久化归 RAAS 更自然、避免双写漂移 |

### 1.8 可选的未来增强（不在本次范围）

若日后要让 4 条期望规则（期望薪资校验/意愿度/求职意向劳务形式/出差意愿）**真正参与匹配前闸门**，需：① 把 `Candidate_Expectation` 加进 10-1 的 `objectTypes`；② 在推理域（`rules-test`）挂上对应规则。届时期望才进规则检查——这是独立一块，本版期望只走匹配。

---

## 第二部分 — createJD 入参优化（公司上下文 + 生成规则注入）

> 与第一部分相互独立，可并行实施。全部改动在 AO 侧（Gohire 是供应商 API，本体规则来自我方 Allmeta Studio，公司数据来自我方镜像库），**不涉及 RAAS 平台**。

### 2.1 目标

让 Gohire `/api/v1/jobs/generate-jd` 拿到两类现在拿不到的输入：

1. **公司上下文**——行业、技术栈偏好、福利政策（当前生成的 JD 里 Benefits 段是 "TBD"）；
2. **本体挂在 createJD 动作上的生成规则**——反歧视、客户匿名、市场化标题（当前完全没被拉取）。

### 2.2 Gohire API 事实（已核实其官方文档）

| 入参 | 必填 | 说明 |
|---|---|---|
| `prompt` | 是 | 自由文本招聘简报，**4–4000 字符** |
| `language` | 否 | 输出语言 |
| `companyName` | 否 | 公司名，用作行文语气上下文；**会被写进 JD 正文** |
| `department` | 否 | 部门提示 |
| `mode` | 否 | `fast`（默认）/ `pro`（更强模型档） |

**没有规则专用入参**——规则要影响生成，单调用通道只有嵌入 `prompt` 文本。

### 2.3 现状缺口

| 步骤 | 现状 | 缺口 |
|---|---|---|
| `loadRaasRequirement` | 只查 `job_requisition` + `job_requisition_specification` | **不 join `client` 表** → `client_name / industry_category / technical_stack_preference / welfare_policy` 断供 |
| `generateJdApi` | prompt 覆盖 14 个需求字段；companyName 取值链代码通 | 数据断供 → companyName 永远为空；prompt 无公司行、无规则行、无福利行；超长 `slice(4000)` 一刀切 |
| （规则拉取） | 不存在 | 本体 RAAS-v1 域 createJD 挂着 **5 条 Agent 规则（4-1～4-5）**，无一进入生成 |

### 2.4 本体规则盘点与分流

| 规则 | 内容摘要 | 分流 |
|---|---|---|
| **4-2** | JD 全文**不得出现客户名称**，检出须移除/替换为通用描述 | 入参匿名化 + 生成约束 + 生成后校验 |
| **4-3** | 移除就业歧视表述（性别/年龄/"不要专升本"/婚育/民族/宗教），保留合法资质要求 | 进 prompt 生成约束块 |
| **4-4** | 内部岗位名 → 市场化标题 + 自定义关键词 | 进 prompt 生成约束块 |
| 4-1 | 同客户相似 JD 聚合 | AO 侧发布生命周期规则，列 backlog |
| 4-5 | 生成时机 + 审核提醒 | 同上，不进 Gohire |

**关键设计约束（规则 4-2 否决"传客户真名"）**：Gohire 会把 `companyName` 写进 JD 正文，而 4-2 禁止 JD 暴露客户身份。**客户真名不进 Gohire**——传派生的匿名描述，输出端再做确定性兜底校验。

### 2.5 设计方案

```
loadRaasRequirement（扩展：LEFT JOIN client + 派生匿名描述，真名不进 carry）
  → ontology.fetchActionRules（新增步骤：action=createJD, domain=RAAS-v1，复用现成全局工具，零新代码）
  → generateJdApi（扩展：公司背景块 + 生成约束块 + companyName=匿名描述 + prompt 分区预算）
  → verifyJdCompliance（新增小工具：4-2 确定性后校验，输出含真名→替换并标记）
  → persistJd
  → persistRaasEntities(job_posting)
```

要点：

1. **`loadRaasRequirement`**：SQL 加 `LEFT JOIN client`；快照新增 `client_industry / technical_stack_preference / welfare_policy`；派生 `company_descriptor = "某{industry_category}行业知名企业"`（行业缺失退化"某知名企业"）；**`client_name` 真名不放入 carry-forward**。
2. **规则拉取**：manifest 插一步 `ontology.fetchActionRules`，config `{"action":"createJD","domain":"RAAS-v1","base_url_env":"ALLMETA_BASE_URL","api_key_env":"ALLMETA_API_KEY"}`；Allmeta 宕机 fail-closed。
3. **`generateJdApi`**（向后兼容可选入参，缺失即今日行为=零回归）：公司背景块（Benefits 从此有真数据）+ 生成约束块（4-2/4-3/4-4 渲染为指令）+ `companyName` = 匿名描述 + **prompt 分区预算**（约束块+背景块保底约 500 字符，需求正文优先截断，总长 ≤4000）+ `mode` 暴露到 tool config。
4. **`verifyJdCompliance`**：生成后、落库前零 LLM 校验——输出含客户真名 → 确定性替换为匿名描述并标记 `compliance_fixes`。

### 2.6 最终发给 Gohire 的请求示例（设计态）

```json
{
  "prompt": "职位: 高级后端工程师\n岗位类型: 外包\n工作城市: 深圳\n薪资范围: 25-35K\n学历要求: 统招本科及以上\n工作年限: 5 年\n必备技能: Java、Spring Cloud、K8s\n岗位职责: …\n任职要求: …\n\n公司背景: 某金融科技行业知名企业\n技术栈偏好: Java/Spring Cloud/K8s\n福利政策: 五险一金、年度体检、弹性办公\n\n生成约束（必须遵守）:\n- JD 全文不得出现客户公司名称…\n- 不得包含性别/年龄/婚育等歧视性表述…\n- 岗位标题市场化并生成关键词",
  "language": "zh",
  "companyName": "某金融科技行业知名企业",
  "mode": "fast"
}
```

---

## 第三部分 — 候选人手机号归一化（E.164，双列 mobile + mobile_e164）

> 独立于补齐环，可并行实施。全部改动在 AO 侧的 9-1 内部与查重工具层，与"10-1 换触发器"零冲突；顺带让补齐环里 RAAS 的电话辅助核对第一次可靠。

### 3.1 问题

简历里既有中国号也有其它国家的号。今天全链只有"去非数字取后 11 位"这一种 China-only 启发式（`packages/recruitment-capabilities/src/tools/dedup-logic.ts` 的 `normPhone`），且落库用的是另一套"纯去数字"（`raas-persistence.ts`），两套并存、靠 PG 后缀匹配打补丁——中国号 `+86…` 与新加坡号尾数相同会**假并**，同一人两种写法会**假拆**。

### 3.2 方案（决策：双列并存）

- **归一化点**：9-1 `parseResumeApi` 之后、查重/落库消费快照之前，一处归一、五个消费点共用。
- **规范形 E.164**，用 `libphonenumber-js`（离线确定性、内建各国 trunk/长度规则），`toE164(raw,{defaultRegion})` → `{e164, valid, type, ext}`；`e164` 仅当 `isValid()` 且 `type ∈ {MOBILE, FIXED_LINE_OR_MOBILE}` 时非空。
- **双列**：`mobile` = 原始串（审计/展示，不动）；`mobile_e164` = 规范形（精确去重/联接键，无效/非个人号型时 NULL + `needs_mobile_review` 标记）。`mobile_normalized` 过渡双读后废弃。
- **默认区号解析链**：JD/需求单国家 → 简历国籍线索 → 租户默认 CN（绝不盲目补 +86 造假键）。
- 详细的五（+1）个消费点、迁移顺序（原子上线 normPhone+SQL+列、从原始串 backfill、`agent_memory_long` 注册表 re-key、双键双读窗口）与测试矩阵，见待补的实施子文档 `raas-v1-phone-normalization-plan.md`（对抗核验已识别 business_records upsert 第 6 个消费点与 RAAS 线上双形依赖两处 blocker，将并入该子文档）。

---

## 第四部分 — 测试计划（实施时 TDD 先行）

**补齐环**：

| 用例 | 层 |
|---|---|
| 10-1 触发器切换：`MATCH_RULE_CHECK` 触发、`RESUME_PROCESSED` 不再触发（断开自触发） | 契约 |
| 期望顺流：`MATCH_RULE_CHECK` 载荷的 `candidate_expectation` 经 10-1 原样带到 `MATCH_RULE_CHECK_PASSED`，10-2 `loadMatchInputs` 取得并成 `candidatePreferences` | 集成 |
| bypass 开：9-1 终步附发自答 `MATCH_RULE_CHECK`（bypassed + 基线期望），全链行为与今日等价 | 集成 |
| 重复 `MATCH_RULE_CHECK`（同 candidate_id）幂等：下游不重复推进 | 集成 |
| 9-1 回归：bypass 关闭时行为与基线逐字节一致 | 契约 |
| 六函数契约测试更新（10-1 触发器）+ `MATCH_RULE_CHECK` 事件契约测试 | 契约 |
| live：9-1→RESUME_PROCESSED→（自答/手动）MATCH_RULE_CHECK→10-1→10-2（candidatePreferences 含 RAAS 值） | 端到端 |

**createJD 优化**：见 §2；**手机号归一化**：见 §3 子文档。

## 第五部分 — 改动文件清单（预估，全部 AO 侧）

| 区域 | 文件 | 改动 |
|---|---|---|
| 补齐环 | `models/zhaopin-v1/workflow_v1.json` | 10-1 触发器 `RESUME_PROCESSED` → `MATCH_RULE_CHECK`；9-1 终步路由支持 bypass 附发自答 |
| 补齐环 | `models/zhaopin-v1/events_v2.json` | 新事件契约 ×1（`MATCH_RULE_CHECK`，boundary: external，producer: RAAS，consumer: ruleCheckForMatchResume） |
| 补齐环 | `tenants/zhaopin/src/legacy-raas-envelope.ts` | `MATCH_RULE_CHECK` 入站（subject 键 = candidate_id）；bypass 自答需出站投影则补白名单 |
| 补齐环 | `tenants/zhaopin/src/index.ts` + 路由工具 | bypass 开关读取；9-1 终步自答分支 |
| 补齐环 | 契约测试 | 10-1 触发器断言更新；`MATCH_RULE_CHECK` 契约测试 |
| createJD | `packages/recruitment-capabilities/.../raas-requirement.ts` | client join + 匿名描述派生 |
| createJD | `models/zhaopin-v1/workflow_v1.json` | 规则拉取步骤 + tool_use 配置（含 mode） |
| createJD | `packages/tools/src/robohire/generate-jd.ts` / `recruitment-input.ts` | 两个可选输入块 + companyName 匿名 + 分区预算 |
| createJD | 新增 `verify-jd-compliance` 工具 + zhaopin 注册 | 4-2 后校验 |
| 手机号 | `packages/recruitment-capabilities/.../dedup-logic.ts`、`candidate-dedup.ts`、`raas-persistence.ts`、`packages/tools/src/records/upsert.ts` + 迁移 | 见 §3 子文档 |
| 通用 | 环境 | `ZHAOPIN_EXPECTATION_ENRICHMENT` 开关 |

## 第六部分 — 风险与回滚

- **补齐环**：9-1 主体零改动 = 简历处理无回归面；回滚 = 10-1 触发器改回 `RESUME_PROCESSED` + 关闭开关（配置级）。停等为纯事件间隙，无在途 run 悬挂。
- **createJD**：所有新入参可选、缺失即今日行为；Allmeta 宕机使 createJD fail-closed。
- **手机号**：附加、双读、可回滚（删 `mobile_e164` 列即回退）；见 §3 子文档。

---

*改造前基线：`raas-v1-six-functions-baseline.md`。对外契约版（发 RAAS 伙伴）：`raas-v1-expectation-enrichment-event-design.md` v0.5（已同步本版）。确认后按本文档实施（TDD → typecheck → live 验证）。*
