# 用 Agent 工厂在 Agents-generation 域生成「RAAS-v1 同款 6 个 agents」的完整指南

> 目标读者：FDE 工程师。回答：① RAAS-v1 的真实 agent 拓扑长什么样、谁是孤岛/谁被外部触发/谁串在一起；② 在 Agents-generation 域里要生成同款 agents，**该补哪些工具、补哪些凭证、运行中在什么情况下补什么 payload/业务信息**；③ 别的 agent（模拟桩）如何替代外部平台。
>
> 关键原则：**Agent 工厂是灵活的，不写死**。它从本体（Allmeta）读真实的 actions/events/objects/rules，自己推荐工具、自己判断缺什么、主动反问你。下面告诉你它会在哪些点问你、你该怎么补。

---

## 一、RAAS-v1 的真实拓扑（gold standard）

RAAS-v1 是一条「招聘需求 → JD → 发布 → 简历 → 匹配 → 面试 → 推荐包」的事件链。`actor=Agent` 的是工厂要生成的 agent；`actor=Human` 的是人工/外部环节（不生成，由人或外部平台承担）。

**三类节点**（这决定了「跑通」的定义）：

| 类型 | 含义 | 例子 |
|---|---|---|
| **串联 (chained)** | emit 被链路里另一个内部 agent 消费 | `analyzeRequirement → ANALYSIS_COMPLETED → clarifyRequirement` |
| **孤岛·外部交接 (external handoff)** | emit 给**外部平台/人**消费，链路里没有内部消费者——**这是合法终态，不是断链** | `createJD → JD_GENERATED →`（外部 HSM/jdReview 人审）；`matchResume → MATCH_PASSED_NO_INTERVIEW →`（外部客户推送）；`ruleCheckerForClientResume → CLIENT_RULES_PASSED →`（外部客户系统） |
| **外部触发 (externally entered)** | trigger 是外部平台/人发来的事件，链路里没有内部生产者——**沙箱里不会自己跑，合法**，等真实外部事件触发 | `syncFromClientSystem ← SCHEDULED_SYNC`（定时器/外部）；`processResume ← RESUME_DOWNLOADED`（人工/采集平台下载后发） |

**RAAS-v1 的 6 个核心 Agent（= Agents-generation 域要造的 6 个，见你的截图）**：

| Agent | trigger（消费） | emit（产出） | 链路角色 | 依赖的外部能力 |
|---|---|---|---|---|
| **createJD** | `CLARIFICATION_READY` / `JD_REJECTED` | `JD_GENERATED` | 孤岛·外部交接（JD 交 HSM/人审） | RoboHire `parseJdApi`（把需求/JD 文件→结构化），或纯 LLM 生成 |
| **processResume** | `RESUME_DOWNLOADED` | `RESUME_PROCESSED` / `RESUME_LOCKED_CONFLICT` / `RESUME_INFO_MISSING` / `RESUME_PARSE_ERROR` | 外部触发（简历由采集平台/人下载后发入） | RoboHire `parseResumeApi`（multipart 文件）、`fs.readFromInbox`（取简历文件） |
| **ruleCheckForCandidateIdentity**（≈ ruleCheckerForClientResume） | `RESUME_PROCESSED` | `CLIENT_RULES_PASSED` / `CLIENT_RULES_FAILED` | 孤岛·外部交接（结果交客户系统）+ 规则闸口 | `ontology.fetchActionRules`（运行时动态抓 executor=Agent 的规则核对，**绝不写死规则**） |
| **ruleCheckForMatchResume** | `RESUME_PROCESSED` | `MATCH_RULE_CHECK_PASSED` / `MATCH_RULE_CHECK_FAILED` | 规则闸口 | `ontology.fetchActionRules` |
| **matchResume** | `MATCH_RULE_CHECK_PASSED`（或 `RESUME_PROCESSED`） | `MATCH_PASSED_NEED_INTERVIEW` / `MATCH_PASSED_NO_INTERVIEW` / `MATCH_FAILED` | 分支：一支串联（→面试）、一支孤岛·外部交接（NO_INTERVIEW→客户）、一支失败终态 | RoboHire `matchResumeApi`（简历 vs JD 打分） |
| **inviteInternalInterview** | `MATCH_PASSED_NEED_INTERVIEW` | `INTERVIEW_INVITATION_SENT` | 孤岛·外部交接（邀约由招聘专员在企业微信跟进） | RoboHire `inviteCandidateApi`（生成邀约），或企业微信工具 |

> 注：`*_FAILED` / `*_CONFLICT` / `*_INFO_MISSING` 是 **FAILISH 失败终态**，本来就不要求「跑到成功终态」；`*_PASSED` 之类的**外部交接 emit 现在被工厂判为合法终态**（见第四节「跑通的新定义」）。

---

## 二、外部平台怎么对接（RoboHire / HSM / 企业微信）

工厂里「真实工具」住在全局工具库 `@agentic/tools`，agent 通过 `tool_use[]` 绑定，运行时按 `tool_use[].config` 注入每租户的凭证/路径——**不用改代码**。

**RoboHire（gohire.top，已对接）**：base url = `https://api.gohire.top/api/v1`，凭证 `ROBOHIRE_API_KEY`。可用工具：
- `parseJdApi` — JD 文件 → 结构化需求（createJD 用）
- `parseResumeApi` — 简历 PDF（multipart）→ 结构化候选人（processResume 用）
- `matchResumeApi` — 简历 vs JD → `{matchScore, verdict, hiringRecommendation}`（matchResume 用）
- `inviteCandidateApi` — 生成面试邀约邮件（inviteInternalInterview 用）

绑定示例（manifest `tool_use[]`，工厂会替你写）：
```json
"tool_use": [
  { "name": "parseResumeApi", "config": { "api_key_env": "ROBOHIRE_API_KEY" } },
  { "name": "fs.readFromInbox", "config": { "subdir": "resumes" } }
]
```

**HSM / 客户系统 / 企业微信**（暂无真实工具）：用 `create_tool` 把它们的 HTTP API 包成声明式工具（给 url 模板 + 凭证 env），或先用 `create_mock_agent` 造模拟桩（见第五节）。

---

## 三、运行中工厂会在哪里问你、你该补什么

工厂现在**主动反问**（ask_user 给 2-4 个选项 + 1 个 recommended + 「其它」自由补充框）。典型卡点与你该补的内容：

| 卡点（工厂会问） | 你该补什么 |
|---|---|
| **某 agent 的工具在库里查不到 / 语义匹配不到真工具** | 选 ①接入真实工具——告诉它工具名（如 `parseResumeApi`）+ 凭证 env（`ROBOHIRE_API_KEY`），或用 create_tool 给该外部 API 的 `{method,url_template,headers}`；②先 create_mock_agent 跑通；③去掉该 agent |
| **某外部 API 的 input/output 契约不清楚**（如 HSM 回传哪些字段） | 在「其它」框补 I/O 契约：输入字段、输出字段、事件 payload 的字段名+类型（要和本体 event_data 对齐） |
| **某事件是「外部交接 / 终态 / 真断点」分不清**（边界事件分类卡） | 在边界分类卡里把每个悬空 emit 标成：外部交接（交给哪个外部平台/团队 + payload 契约）/ 终态 / 真断点。**这直接决定跑通判定**——createJD 的 JD_GENERATED 标「外部交接」就不算断链 |
| **测试用例的入口 payload 缺字段** | 在测试用例卡里补 entry event 的代表性 payload（如 `RESUME_DOWNLOADED` 要 `resume_file_path` / `job_requisition_id`）。工厂会从本体 event_data 推默认值，但真实文件路径/ID 需要你给 |
| **规则校验 agent 该抓哪些规则** | 一般不用补——规则闸口绑 `ontology.fetchActionRules`，运行时按 `executor=Agent` 动态抓。只有 Allmeta 里规则缺失时才需补 |

**什么时候补什么 payload（按事件）**：
- `RESUME_DOWNLOADED`（processResume 入口）：`{ resume_file_path, job_requisition_id, candidate_source }` —— 真实简历文件路径 + 关联的 JD。
- `CLARIFICATION_READY`（createJD 入口）：`{ job_requisition_id, requirement_struct }` —— 澄清后的需求结构。
- `RESUME_PROCESSED`（规则闸口 + matchResume 入口）：`{ candidate_id, resume_id, job_requisition_id, parsed_fields }`。
- 外部触发事件（如 `SCHEDULED_SYNC`）：沙箱里**不用补**——它本就由外部/定时器发，agent 标为「外部触发」豁免跑通计数。

---

## 四、「跑通」的新定义（已修复你说的孤岛问题）

旧逻辑：任何 emit 没有内部消费者就当「断链」，于是 createJD 这种孤岛被误判「未跑通」。**已改为**：

- **外部交接 emit = 合法成功终态**（按你的边界分类）。
- **外部触发 agent = 豁免「必须在沙箱里跑」**（它等外部事件，不强制）。
- 只有 **真断点 (kind=break)** 和 **降级 agent** 才判未跑通。
- UI 现在显示：「整链跑通：**N 个内部链 + M 个外部交接终态**」。

所以 RAAS 同款 6 个 agent，只要：6 个动作都设计了 + 工具都解析（或明确 mock）+ 规则闸口绑了 fetchActionRules + 串联链跑到成功/外部交接终态 + 没降级 → **跑通=true**，即使 createJD/matchResume(NO_INTERVIEW)/ruleCheck 的产出是交给外部平台的。

---

## 五、别的 agent 如何替代外部平台（mock）

当某外部平台（HSM、客户系统、企业微信、甚至 AI 面试）暂时没有真实集成时：

1. 工厂**先 ask_user**（不会默默造桩）：问你是接真集成还是先 mock。
2. 你选 mock → `create_mock_agent`：造一个「模拟 X」的 agent，**消费**该平台收到的事件、**回传**该平台会发回的事件（payload 对齐 event_data）。例：模拟「AI 面试平台」消费 `INTERVIEW_INVITATION_SENT`、回传 `AI_INTERVIEW_COMPLETED`，让 `evaluateInterview` 能继续。
3. 模拟桩会被**自动记入「待补真实集成」清单**（reflection），晋升前你能看到要为哪个平台接什么工具、补什么凭证。
4. 模拟桩默认**不晋升**（slug 带 `-mock-`）——晋升只把真实 agent 推到 Fleet。

---

## 六、一步步操作清单（FDE）

1. 在工厂选 **Agents-generation** 域，目标写「为这个业务域生成能真正跑通的智能体，真实部署到 Inngest 沙箱验证」。
2. 工厂读本体 → 规划 → 逐个设计 6 个 agent。**留意它的反问**（工具/契约/边界），按第三节补信息。
3. 规则闸口（ruleCheck*）会自动绑 `ontology.fetchActionRules`——确认 Allmeta 里这两个动作的规则齐全（`executor=Agent`）。
4. RoboHire 类 agent（processResume/matchResume/createJD/invite）——确认绑了 `parseResumeApi/matchResumeApi/parseJdApi/inviteCandidateApi` + `config.api_key_env=ROBOHIRE_API_KEY`；缺的用 create_tool 包 HSM/企业微信。
5. 边界分类卡：把 `JD_GENERATED / CLIENT_RULES_PASSED / MATCH_PASSED_NO_INTERVIEW / INTERVIEW_INVITATION_SENT` 标「外部交接」，`*_FAILED` 标「终态」。
6. 测试用例卡：补 `RESUME_DOWNLOADED` 等入口的真实 payload。
7. sandbox_run → 看「N 内部链 + M 外部交接终态」，跑通后 finish → 在右侧「已生成·草稿」里勾选 6 个真实 agent → 晋升到 Fleet（mock 桩排除）。

---

## 附：环境/开关

- `ROBOHIRE_BASE_URL=https://api.gohire.top/api/v1`、`ROBOHIRE_API_KEY=…`
- `FACTORY_REAL_DEPLOY=1`（真实部署到 Inngest，非模拟）
- `FACTORY_MODEL_HARD/DEFAULT/FAST`（按难度分层；写码/精修用 sonnet-4.6，读本体用 gemini-flash）
- `FACTORY_EXEC_GENERATED`（true CodeAct：AI 写的 .ts 在沙箱真执行；=0 关闭回退到声明式）
- `FACTORY_BRAIN_LANG=zh|en|auto`（大脑语言；多 domain 时可跟随本体语言）
