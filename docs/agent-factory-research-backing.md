# Agent 工厂技术背书与改进分析

> 2026-07-12 · 两轮多智能体检索（8 路主题并行）→ URL 去重 → **逐源对抗核验**（WebFetch 逐条比对声称要点，宁剔勿假）→ 完整性批判补缺。
> 第一轮：63 个来源去重 → 30 个进核验 → **30/30 通过**。第二轮（补三个被截断主题 + 批判指出的经典缺席）：**28/28 通过**。合计 **58 个已核验来源、0 个虚假引用**；3 篇标注 `partial`（个别要点与原文有出入，正文引用均已按核验后版本修正）。
> 与既有语料的关系：本文档聚焦 **Claude 官方工程正典 / Harness 工程 / SKILLS / CodeAct / Agent Loop** 五个新角度；此前已核验的 34 篇（理解拆分、ask_user 澄清、通信+durable 三主题）见 `docs/agent-factory-contract-first-optimization.html` §4，两者互补不重复。

---

## 0. TL;DR

**最强的五条背书（我们的核心架构决策都有实证/官方正典支撑）：**

| # | 证据 | 数字 | 背书的工厂决策 |
|---|------|------|----------------|
| 1 | AlphaCodium（arXiv 2401.08500）：同一 GPT-4 零模型改动，flow 从单条精心 prompt 改成"理解→生成→真跑测试→修复"流程 | pass@5 **19%→44%（2.3×）** | 阶段机 read→plan→design→validate→sandbox→deliver："流程即产能"，投入放在 flow 而非 prompt 措辞 |
| 2 | SWE-agent ACI（arXiv 2405.15793, NeurIPS24）：同一 LLM 只换工具面/反馈面 | SWE-bench Lite **+10.7pp**（7.33%→18.00%）；edit 首次失败后最终成功率 90.5%→57.2% | "工厂即 harness"：工具面设计 = 一等生产资料；生成代码**每次写入即校验**（编译+安全门），不是最后才验 |
| 3 | CodeAct（arXiv 2402.01030, ICML24）：代码动作空间 vs JSON tool-call，17 个 LLM 实证 | 成功率 **up to +20% 绝对值**，动作数 -30% | 生成 TypeScript 函数代码（而非纯声明式 JSON）作为交付物与执行形态 |
| 4 | 程序化技能归纳 ASI（arXiv 2504.06821）：技能**执行验证通过才入库** | vs 静态 baseline **+23.5%**，vs 文本技能 **+11.3%** | code_really_ran 验收门 + 技能沉淀为可执行代码而非 prompt 片段 |
| 5 | Anthropic 多智能体研究系统（官方工程博客）：多 agent 何时值得 | 胜单 Opus **+90.2%**，但 token **15×**；token 用量解释 80% 成绩方差 | 按需派生子大脑（不默认多派）+ 观测遥测（Workflow→Phase→Agent）是生命线 |

**最大的五个差距（证据指向、我们还没做或做了一半）：**

1. **验收清单应由 harness 持有、agent 无权删改**（Anthropic 长跑 harness 文：feature 清单全标 failing、只许翻绿、"It is unacceptable to remove or edit tests"）——我们的验收判据目前部分由大脑自己参与生成。
2. **从成功 runs 自动归纳技能**（AWM +51.1% 相对成功率；我们 runs/steps/llm_turns 遥测全在，管道未建）。
3. **双预算原语 max_turns + max_budget_usd + 类型化终止态**（Agent SDK 文档五值枚举 error_max_turns/error_max_budget…）——我们只有 poll 超时与 backpressure，缺花费封顶与"循环为何停"的精确归因。
4. **技能格式对齐开放标准**（agentskills.io spec：SKILL.md + 三级渐进披露 + `skills-ref validate` lint 门）——我们的技能是私有 JSON/代码碎片，出不了工厂。
5. **修复循环要预算意识**（Self-Repair 论文：等成本下自修复常不如多采样；宽生成+浅修复优于深修复链；难题才开修复）——我们的 revise 循环还没有难度门控与等成本对照。

---

## 1. 方法论（本文档怎么来的）

- **两轮多智能体工作流**：第一轮 8 路主题检索（Claude loop 正典 / Anthropic 工程 / SKILLS / CodeAct / Harness-ACI / loop 控制 / 多智能体实证 / durable+记忆）并行，各自给出带真实 URL 的来源；跨路按 URL 去重后，每个来源由**独立核验 agent** WebFetch 原文，逐条比对"声称要点 vs 实际内容"，只有 `confirmed/partial` 且相关才保留（结论：30/30 通过，其中 1 篇 LEVER 标记 partial——个别要点表述有出入，引用时以核验后版本为准）。
- **完整性批判**：一个批判 agent 检查覆盖面，指出 5 处缺口（ReAct/ToT 原始文献缺席、agent 安全评估缺席、loop-control 单一来源、多智能体只有厂商单源、评测方法论缺席）→ 触发第二轮补核验。
- **诚实披露**：每章引用均注明证据类型（**论文**=同行评审/arXiv、**官方文**=Anthropic/Claude 第一方工程文章、**repo**=可复现代码库）。厂商博客的数字（如 +90.2%）按其自述引用并标注单源属性。

---

## 2. Agent Loop：Claude 官方正典 × 我们的 conductor

### 证据

**《Loop engineering: Getting started with loops》**（Claude 官方博客, 2026-06-30, 即你给的链接——已核验真实，作者 Delba de Oliveira / Michael Segner）：

- Loop 的官方定义："agents repeating cycles of work until a stop condition is met"；agentic loop 五步 = gather context → take action → check work → repeat if needed → respond。
- **四类循环 + 各自终止条件**：Turn-based（模型自判完成）、Goal-based（goal achieved **OR** max turns，且要求目标"有可验证的退出判据"）、Time-based（定时/外部环境交互）、Proactive（单任务 goal met 即退出、routine 跑到被 disable）。
- 验证要点：**检查越量化越好**（"The more quantitative the checks are, the easier it is for Claude to self-verify"）；**评审 agent 用全新上下文**（"A reviewer with fresh context is less biased"）。
- Token 护栏四件套：硬上限（官方示例"Lighthouse ≥90，最多试 5 次"）、间隔匹配变化频率、确定性步骤换脚本（"Running a script is cheaper than reasoning through the steps"）、大规模先小样本试跑。

**《How the agent loop works》**（Claude Agent SDK 官方文档）：

- 循环机械定义：模型持续调工具直到"产生一个不含 tool call 的回复"即终止。
- **双预算原语**：`max_turns`（只计 tool-use 往返）+ `max_budget_usd`（花费封顶），官方明言"Setting a budget is a good default for production agents"。
- **类型化终止状态机**：`ResultMessage.subtype ∈ {success, error_max_turns, error_max_budget_usd, error_during_execution, error_max_structured_output_retries}`；失败态仍携带 cost/usage/turns/session_id——失败也能计费、审计、恢复。
- Compaction：接近上限自动摘要 + `compact_boundary` 事件 + PreCompact hook 先归档全量；持久规则放 CLAUDE.md（每请求重注入，摘要不掉）。
- Hooks 跑在宿主进程**不占上下文**；工具被 deny 时 rejection 作为 tool_result 注入，模型自行换路。

**《How Claude Code works》**（官方文档）：harness 的第一方定义——"Claude Code serves as the agentic harness around Claude: it provides the tools, context management, and execution environment"。另有 **compaction 打摆检测**：若单个超大输出让每次摘要后上下文立即重满，自动放弃压缩并报错，**而不是死循环**。

### 我们已有（对照）

- conductor 阶段机 = **goal-based loop**：可验证退出判据 = 真部署 + 真 runs 验收（code_really_ran/finish 门 + reachedSuccessTerminal）✓
- P7 治理巡检 = **proactive/time-based loop** ✓；ask_user park-gate = 人在环打断 ✓
- 审校器 allowedCounts（量化核对而非自由评审）与"检查越量化越好"同路 ✓

### 差距与改进（落点）

| 改进 | 证据 | 代码落点 |
|------|------|----------|
| **双预算 + 类型化终止态**：给 conductor 循环与每个生成的 agent 函数挂 max_turns + max_budget_usd，终止时返回五值枚举而非裸超时 | SDK agent-loop 文档 | `packages/agent-factory/src/conductor.ts`（turn-- 逻辑处）、`brain-types.ts` done 事件 status 枚举、生成模板 `ts-function-module.ts` |
| **compaction 打摆断路器**：摘要后上下文立即重满 N 次 → 停止压缩、显式报错（我们吃过 12s-poll 死循环的亏，同类问题） | How Claude Code works | `packages/runtime/src/step-engine.ts` compaction 路径 + conductor compaction 载荷 |
| **fresh-context reviewer 制度化**：critique/supervisor 审计与生成阶段完全隔离上下文（只看产物+判据，不看生成推理） | Loop engineering + Best practices | `supervisor.ts` 审计入口的上下文构造 |
| **确定性步骤脚本化**：manifest 校验、事件链闭合检查等已确定性的环节不再走 LLM 轮次 | Loop engineering | 已部分做到（compileGraph/verifyGraph 是纯代码）；盘点 conductor 中残留的"LLM 干确定性活"轮次 |

---

## 3. Anthropic 工程正典 × 工厂总体架构

### 证据

**《Building Effective AI Agents》**（2024-12，Schluntz & Zhang——业界公认的 agent 设计正典）：

- 核心区分："Workflows are systems where LLMs and tools are orchestrated through **predefined code paths**. Agents … **dynamically direct their own processes**."
- **复杂度阶梯**：单次增强调用 → 5 种 workflow 模式 → 自主 agent，"只有可测量的收益才升级复杂度"。
- **orchestrator-workers** 模式点名适合"子任务数不可预测"的场景（正是我们：一个域要造几个 agent 由本体决定）。
- ACI（Agent-Computer Interface）投入应与 HCI 同级："we actually spent more time optimizing our tools than the overall prompt"。
- poka-yoke 防错工具：把参数改成**结构上无法犯错**（强制绝对路径后模型使用"flawlessly"）。

**《How we built our multi-agent research system》**（2025-06）：

- **effort-scaling 规则写进主 agent 的 prompt**：简单事实查证=1 agent 3-10 次工具调用；直接对比=2-4 个 subagent 各 10-15 次；复杂研究才 10+。
- **委派契约**：每个 subagent 必须拿到 objective / output format / 工具与来源指引 / 任务边界四件套，否则重复劳动或漏活。
- **工具描述自优化回路**：tool-testing agent 诊断失败并重写工具描述 → 后续 agent 任务完成时间 **-40%**。
- 经济学：多 agent 胜单 Opus **+90.2%**（内部研究评测），但 chat 的 ~4×、多 agent ~15× token；**token 用量单变量解释 80% 成绩方差**。
- 评测方法：先 ~20 条真实 query 起步（早期改动效果 30%→80% 级别，不需要大评测集）；对改状态的 agent **评终态而非过程**。

**《Writing effective tools for agents — with agents》**（2025-09）：

- 工具应按**工作流合并**而非 API 端点 1:1（schedule_event 一体化 vs list+list+create 三连）；`list_*` 改 `search_*` 省上下文。
- `response_format` 详略档实测：同一 Slack thread detailed=206 tokens vs concise=72（**~65% 节省**）；把 UUID 解析成语义名"显著降低幻觉"。
- **硬数据**：仅精修 tool descriptions 就让 Claude Sonnet 3.5 在 SWE-bench Verified 达到 SOTA。
- 闭环：把评测 transcripts 直接喂给 Claude 重构工具，产出超过专家手写版。

**《Effective context engineering for AI agents》**（2025-09）：

- "attention budget" 心智模型：找"最小的高信号 token 集合"。
- **sub-agent 回传定额契约**：子 agent 可烧几万 token 探索，但只回传 1,000-2,000 token 的蒸馏摘要。
- compaction 显式保留/丢弃清单：保架构决策、未解 bug；先丢深历史的原始 tool 输出。
- 工具面最小充分集的可测试判据："如果人类工程师说不清该用哪个工具，agent 也不行。"

**《Best practices for Claude Code》**（官方文档）：

- **验证闭环升级梯**：可运行 pass/fail 检查 → 每轮独立 evaluator → 确定性 Stop 拦截 → fresh-model 验证 subagent 主动试图推翻结果（"干活的 agent 不给自己打分"）。
- **证据回执制**："Reviewing evidence is faster than re-running the verification yourself."
- **纠错两次即重置**："After two failed corrections, /clear and write a better initial prompt incorporating what you learned."——上下文被失败尝试污染后，重开比继续修更有效。
- 警句（解释我们审校器曾经的误报）："A reviewer prompted to find gaps will usually report some, even when the work is sound."

### 我们已有（对照）

- 阶段机 = "能 workflow 就别 agent"的落地（固定骨架+骨架内自主）✓；conductor+舰队 = orchestrator-workers ✓
- packages/tools 的 catalog/argsSchema/examples/aliases/credentialEnv 元数据投入 = ACI 原则 ✓
- 评终态而非过程 = 我们沙箱验收看 runs 终态 ✓；观测遥测 = 他们"全链 tracing 救命"的同款 ✓
- comms 数据面（carry-forward envelope + blob offload）= "轻量 identifier + JIT load" ✓
- 2026-07-10 修的报告审校器误报（allowedCounts 认簇子计数）正是"被要求找茬的 reviewer 总会报出问题"的教科书案例 ✓

### 差距与改进（落点）

| 改进 | 证据 | 代码落点 |
|------|------|----------|
| **effort-scaling 规则写进 system prompt**：按子问题复杂度定 agent 数与 tool-call 预算，防过度供给 | multi-agent research system | `system-prompt.ts`（design/spawn 指引段） |
| **委派四件套契约**：spawn_subagent/design_subagent 强制 objective/output format/工具指引/边界四字段 | 同上 | `tools.ts` spawn_subagent 参数 schema |
| **工具描述自优化回路**：用已落库的 llm_turns/tool_stats 定期让 LLM 重写表现差工具的 description（-40% 实证） | writing-tools-for-agents | `packages/tools` catalog + `fleet-governance` 巡检的新 action |
| **生成工具默认 concise 返回 + 语义 ID**：doc→tool 管线产出的工具加 response_format 档位 | 同上（65% token 节省实证） | `extract_api_schema`/`create_tool` 生成模板 |
| **revise 上限=2 + 上下文重置**：超限丢弃污染上下文、教训折入新 prompt 重新生成 | Best practices | `conductor.ts` revise 循环 + `design-loop.ts` |
| **sub-agent 回传定额**：ctx.spawn 的子 agent 回传强制 ≤2k token 蒸馏摘要 | context engineering | 嵌套 harness 回传路径 |

---

## 4. SKILLS：官方标准 × 学术技能库 × 我们的 create_skill

### 证据

**官方三件套**（Agent Skills 发布文 + 工程文 + agentskills.io 开放规范，2025-10 发布、2025-12 开源为标准）：

- 技能的正确形态 = **声明式文件夹（SKILL.md + frontmatter + scripts/ + resources/）**，不是纯代码也不是纯 prompt。
- **三级渐进披露**是硬设计契约：Discovery 只载 name+description（~100 tokens/skill）→ Activation 读全量 SKILL.md（建议 <5000 tokens / 500 行）→ 资源按需读。"技能可捆绑的上下文量实际上是无界的"——技能库规模与常驻上下文成本**解耦**。
- description 字段**就是路由信号**：必须同时说"做什么"和"何时用"。
- `allowed-tools` frontmatter = 每技能的声明式工具白名单（与我们 manifest `tool_use[]` 信任边界 1:1 对应）。
- 参考校验器 `skills-ref validate` = 现成的 lint 门；"确定性可靠性只有代码能提供"——技能捆绑脚本让 agent 直接跑，不载入上下文。

**学术技能库四篇（全部核验通过）**：

- **Voyager**（arXiv 2305.16291）：技能=**真实执行验证后才入库的代码**，embedding 检索（描述→top-5 语义相似）、组合复用；技能库贡献量化：**3.3× 独特物品、tech-tree 里程碑最快 15.3×**；库可迁移到全新世界（4/4 vs 2/4）——**证明"持久技能库"而非 LLM 本身是承重组件**。
- **AWM / Agent Workflow Memory**（arXiv 2409.07429, CMU/MIT）：从**历史成功轨迹被动归纳** workflow（LM 评估器判成败、只从成功轨迹归纳、实例细节抽象成占位符）；WebArena 相对成功率 **+51.1%**，每例平均少走 2 步；**技能不必是代码**——流程级文本记忆即可沉淀能力。
- **ASI / Inducing Programmatic Skills**（arXiv 2504.06821, CMU）：**归纳期程序化验证门是增益主因**（+23.5% vs 静态、**+11.3% vs 文本技能**）；原子动作组合成高层技能步数 -10.7~15.3%；技能库要有"检测失效→修复/替换"维护路径。
- **SkillWeaver**（arXiv 2504.07079, OSU 等）：Propose→Synthesize→Hone 三段技能工厂（LLM 提议课程、成功轨迹蒸馏成 Python API、自动单测打磨）；**强模型造的技能给弱模型用，最高 +54.3%**——技能库是跨模型可转移资产，背书"design 用高 tier、运行用低 tier"的省钱路由。

### 我们已有（对照）

- create_skill + DrizzleSkillStore + 向量 MemoryDriver（本地嵌入+cosine）= Voyager 模式的骨架 ✓
- capability-ladder（能力梯+spawnable 技能生命周期）✓；code_really_ran 门与"执行验证才入库"同哲学 ✓
- skill-creator（官方引导式造技能）= 我们 create_skill 的官方对照物 ✓

### 差距与改进（落点）

| 改进 | 证据 | 代码落点 |
|------|------|----------|
| **P0：从成功 runs 自动归纳技能**——AWM 式管道：runs/steps/llm_turns 里判成功的轨迹 → 抽象占位符 → 归纳成 manifest 模板/plan[] 片段入技能库。数据全在、管道未建 | AWM +51.1%；ASI 在线归纳闭环 | 新模块 `packages/agent-factory/src/skill-induction.ts` + governance 巡检触发 |
| **P1：技能入库加执行验证门**——create_skill 的产物必须带测例、真跑通过才入库（与 code_really_ran 同款门挂到技能上） | ASI：验证门是 +23.5% 的主因；Voyager | `tools.ts` create_skill + `function-tester` 复用 |
| **P1：技能落盘对齐 agentskills.io 规范**——SKILL.md + frontmatter(name/description/allowed-tools) + scripts/，过 `skills-ref validate`；技能变成可带出工厂、可被 Claude Code/Codex 直接复用的资产 | 官方开放标准 + 44 个 harness 已采纳 | SkillStore 的序列化层 + 导出命令 |
| **P2：三级渐进披露进大脑上下文**——技能目录只给 name+description，命中才展开全文 | 官方 spec（~100 tokens/skill） | `system-prompt.ts` 技能目录注入处 |
| **P2：强弱模型技能分工显式化**——design 期高 tier 造技能，生成的 agent 运行期低 tier 调用 | SkillWeaver +54.3% | `model-router.ts` 已有 tier 路由，补"技能合成任务强制高 tier"规则 |

---

## 5. CodeAct 谱系 × 我们的代码生成与真执行

### 证据

- **CodeAct**（arXiv 2402.01030, ICML24, 奠基作）：统一动作空间为可执行代码 vs JSON tool-call，17 个 LLM 实证 **up to +20% 绝对成功率、-30% 动作数**；代码原生 control/data flow（中间结果存变量、循环批处理）；**interpreter 报错回灌 = self-debug 信号**。
- **Self-Debug**（arXiv 2304.05128, DeepMind）：执行反馈（而非模型空想）是自纠错增益来源；有单测时反馈回灌值 **up to +12%**；**2-3 轮修复即收敛**，迭代复用失败预测的样本效率超过 10× 多采样。
- **Self-Repair is not a Silver Bullet**（arXiv 2306.09896, MIT）：**等成本对照下自修复收益常常温和甚至为零**；**宽初始采样+浅修复 > 深修复链**（10 初始×1 修复=1.05× 基线，2 初始×10 修复=0.97× 反而更差）；**强 critic + 弱 generator 分工成立**（GPT-4 反馈喂 GPT-3.5 修复超过其自修复）；人类反馈把修复成功率提 **1.58×**——ask_user 升级门有量化依据；修复收益集中在**难题**。
- **LEVER**（arXiv 2302.08468）：静态看代码不足以判对错，**执行产物（含类型、值域）携带正确性信号**；执行结果等价类聚合再选优。
- **Steering Code vs Text**（arXiv 2410.03524, MIT/Harvard/MSR）：**没有哪个模态对所有子问题最优**；模型自选 code/text 只对强模型有益、弱模型反而受害（要硬路由）；**"看起来像代码"≠真代码**——模型常生成"更像文本推理的代码"，**直接验证了 code_really_ran 收据门的必要性**；execute-and-refine 2 轮内收敛。
- **TaskWeaver**（arXiv 2311.17541, Microsoft）：plugin 即可调用函数（code-first 工具绑定）；**per-session worker 进程 + Docker 容器隔离执行生成代码**——工厂三档隔离的同行佐证。
- **OpenHands**（arXiv 2407.16741）：CodeAct→生产平台谱系闭环；per-session Docker 沙箱；event stream 即状态（可回放可审计）；agent 委派（同一 CodeAct 骨架承载 10+ agents）。
- **DynaSaur**（arXiv 2411.01747, Adobe）：动作即带 docstring 的函数、生成→执行→**沉淀→embedding 检索复用**；GAIA 38.21% vs HF Agent 29.00%（发表时公开榜首）；预定义工具失败时**现场生成替代函数**恢复。

### 我们已有（对照）

- 生成 TypeScript Inngest 函数 + 编译/安全 lint/加载探针/真执行 = CodeAct 路线的工程化 ✓
- worker_thread / 子进程 scrubEnv / Docker --network-none 三档 = TaskWeaver/OpenHands 同款生产实践 ✓
- 执行反馈回灌 reflection = Self-Debug 配方 ✓；runs/steps/事件账本 = OpenHands "event stream 即状态" ✓
- "代码长得对≠能跑" = Steering 论文实锤的现象，我们的 code_really_ran 收据正是解药 ✓

### 差距与改进（落点）

| 改进 | 证据 | 代码落点 |
|------|------|----------|
| **P1：修复循环预算化**——revise 默认 ≤2-3 轮；难题才开深修复；给"宽生成"路径（同一 spec 采样 2-3 个候选再挑）留开关 | Self-Repair 等成本分析 + Self-Debug 2-3 轮收敛 | `design-loop.ts` / `conductor.ts` revise 计数 |
| **P1：critic/generator 模型分层**——修复反馈由高 tier 模型出，代码生成可用低 tier（省钱且实证更好） | Self-Repair：强反馈喂弱修复超过其自修复 | `model-router.ts` + specialists 的 critique 通道 |
| **P2：测试判分捕获带类型的执行产物**——不只 pass/fail 布尔，记录输出类型/值域特征入 verdict | LEVER | `function-tester.ts` gradeFunctionTest |
| **P2：code/text 模态硬路由表**——符号/数学/批处理类子任务强制走代码路径，不信模型自选（弱模型时） | Steering：自选只对强模型有益 | `reasoning-policy.ts` selectStrategy 加模态维度 |
| **P2：工具失败→现场生成替代函数**——tool-failure fallback 已有 ask_user 路径，补"生成临时函数绕过"选项（审计门内） | DynaSaur | `tools.ts` 工具失败分支 |

---

## 6. Harness 工程 / ACI × "工厂即 harness"

### 证据

- **SWE-agent**（arXiv 2405.15793, NeurIPS24）：**同一 LLM 只换工具面 +10.7pp**（7.33%→18.00%）。四条可直接抄的设计定量：①观察窗口 100 行最优（30 行 -3.7pp、全文件 -5.3pp）；②**写入即 lint**：去掉编辑门禁 -3.0pp，且首次编辑失败后最终成功率从 90.5% 崩到 57.2%（级联失败占全部失败 23.4%）；③搜索结果硬上限 50 条、超了**宁可拒绝并让它细化查询**（分页式结果比没有搜索工具还差 -6.0pp）；④历史折叠：只留最近 5 条完整观察、更早的折叠成单行（不折叠 -3.0pp）。
- **Anthropic SWE-bench 博文**（官方）：极简脚手架（一条 prompt + Bash + Edit 两工具）同模型 45%→49%；"agent 成绩因 scaffolding 显著变化，即使底座模型相同"；工具描述当产品文案迭代（实测模型误解→改描述预防）；错误信息本身是自纠错回路的一环。
- **AlphaCodium**（arXiv 2401.08500）：19%→44%（见 TL;DR#1）；先推理后写码的 pre-processing 段；**AI 补测试盲区**（额外生成 6-8 个测试、明确要求覆盖 public tests 未覆盖的面）；阶段间上下文注入。
- **mini-swe-agent**（repo，SWE-agent 团队）：100 行、唯一工具是 bash、无状态 subprocess.run 执行，**>74% SWE-bench Verified**——harness 复杂度的边际价值随模型能力增长而衰减；"trajectory 与传给 LM 的 messages 零差别"（审计透明一等公民）；无状态动作执行与 Inngest step.run 可重放语义天然同构。

### 我们已有（对照）

- "工厂即 harness"的自我定位有第一方定义背书（How Claude Code works 的 harness 三要素：tools + context management + execution environment）✓
- 生成代码"每次写入即过编译+安全检查" = SWE-agent 写入门禁的同构 ✓
- llm_turns 原始回合捕获 = mini-swe-agent "轨迹即消息"审计原则 ✓

### 差距与改进（落点）

| 改进 | 证据 | 代码落点 |
|------|------|----------|
| **P1：工具输出窗口化+历史折叠进 step-engine**——大输出截 ~100 行等效窗口；只留最近 N 条完整 tool_result，更早折叠单行；空输出给显式"成功且无输出"回执 | SWE-agent 四条定量 | `packages/runtime/src/step-engine.ts` 工具结果回灌处 |
| **P1：search_tools 结果硬上限+拒绝细化**——超限不分页，返回"请更具体"（分页对 agent 有害 -6.0pp） | SWE-agent | `tool-catalog.ts` searchRealTools |
| **P2：AI 补测试盲区**——generate_test_cases 后追加一步"生成 N 个覆盖既有用例未覆盖面的测试" | AlphaCodium | `fixtures.ts`/generate_test_cases 工具 |
| **哲学校准**：工厂复杂度应压在**契约/隔离/验收/治理**（模型替代不了的层），工具面保持窄而精——阶段机管交付流程，不替模型做事 | mini-swe-agent + Anthropic 极简脚手架 | 设计原则（评审新特性时的门槛问题） |

---

## 7. Loop 控制与验证 × finish 门 / 监督者 / revise 循环

这一章是**整个工厂验收哲学的科学地基**——五篇论文从不同角度收敛到同一条结论：**LLM 自评不可靠，纠错信号必须来自外部执行**。

### 证据 A：自评被系统性证伪

- **《LLMs Cannot Self-Correct Reasoning Yet》**（arXiv 2310.01798, ICLR24, DeepMind）：无外部反馈时自我纠错**让性能下降**（GPT-4 GSM8K 95.5%→91.5%→89.0% 两轮递降；GPT-3.5 CommonSenseQA 75.8%→38.1%）；此前文献的"纠错收益"是 **oracle 混淆**（带标准答案 75.9%→84.3%，拿掉 oracle 只剩 75.1%）。论文认可的三类有效外部信号——**代码执行结果+报错、外部工具、训练过的 verifier**——正是我们 CodeAct 真执行 / API 探针 / 审校器的三件套。另一发现直接背书 **Contract-First**：完整初始 prompt 81.8% > 事后自纠错 75.1%（所谓纠错收益常常只是补回初始 prompt 缺的信息）。
- **CRITIC**（arXiv 2305.11738, ICLR24, 清华/MSR）：纯 self-critique 定量无效（两模型仅 -0.03 / +2.33 F1，低于初始输出）；去掉解释器反馈，GSM8k 增益从 +5.7 掉到 +4.5 甚至倒退。**只对"已验证失败"的样本触发修正，收益翻倍**（oracle 设置 +11.4 vs 全量修正 +5.7）——已通过的 agent 反复再修反而引入退化风险。
- **Self-Refine**（arXiv 2303.17651, NeurIPS23）：审校 prompt 必须 **actionable + specific**（指出哪一行错、怎么改；泛评显著更差）；ChatGPT 对 **94%** 的数学错误实例反馈 "everything looks good"——正确性类工件不能靠语言自评；intrinsic refinement 的收益集中在**生成类**工件（对话/文案 +30~49），代码正确性必须靠外部锚点。

### 证据 B：分工与真执行反馈的量化收益

- **AgentCoder**（arXiv 2312.13010）：**测试设计者不看被测代码**（防被代码带偏），消融：独立出题测试准确率 **87.8% vs 自产测试 61.0%**；反馈=终端真实报错原样回传；默认 **5 轮迭代封顶**即收敛；分工反而省 token（GPT-4 HumanEval **96.3%@56.9K tokens** vs SOTA 90.2%@138.2K）。
- **LATS**（arXiv 2310.04406, ICML24）：树搜索的关键区分是 **"评分在环境反馈之后"**（先真执行再打分，HumanEval 92.7% vs Reflexion 91.0%）；失败轨迹+反思成对入记忆；成本锚点 **~173K tokens/任务**——搜索式策略只配给验收门槛最高的关键 agent，且前提是**状态可回滚**（我们只有 Docker/子进程档满足）。
- **Reflexion**（arXiv 2303.11366, NeurIPS23，第一轮已核验）：语言化反思 + 情景记忆，HumanEval 80%→**91%**——但其 coding 增益同样来自**测试执行反馈**。

### 证据 C：重试预算是一条 scaling law，但前提是 verifier 为真

- **Large Language Monkeys**（arXiv 2407.21787, Stanford）：coverage 随样本数在 4 个数量级上**近似 log-linear**；**便宜模型×多采样反超强模型单发**——SWE-bench Lite 上 DeepSeek-Coder 1 样本 15.9% → 250 样本 **56%**，超过单发 SOTA 43%。**但没有自动验证器时加预算无效**（majority voting/reward model 几百样本后平台化）。→ 我们的排序是对的：**先把 code_really_ran 这类硬验证器做真，重试预算才值得加大**。
- **Test-Time Compute Optimal Scaling**（arXiv 2408.03314, Berkeley/DeepMind）：**按难度分配预算**比固定预算省 **4×**；简单任务→顺序修订、中等→verifier 引导的并行搜索、**最难分位→加推理预算几乎无益，应升 model tier 或走 ask_user HITL**——这就是"多迭代几轮还是升模型"的定量答案，也是我们 12s 固定轮询翻车教训的理论化（任何固定预算同时过度且不足）。
- **过优化警示**：easy 题上高预算 beam search 反而退化（verifier over-optimization）——高分候选应封顶审查轮次，**多审不等于更好**。

### 证据 D：防死循环（2026 新文，与我们事件链架构直接相关）

- **《When Agents Do Not Stop: Infinite Agentic Loops》**（arXiv 2607.01641，2026-07 预印本，**partial**——尚无同行评审，引用需注明）：68 例确认的无限循环里 **100% 缺"有效停止界"**（bound 只有约束到实际反馈路径才算数）、41.2% 工具控制重试、**38.2% 把终止权交给模型**（"模型不再发 tool call 就算结束"——论文明确说不要依赖这个）、**25% 来自 agent-as-tool 重入**（正对我们 ctx.spawn 嵌套 harness：深度帽必须压在重入路径本身）、27.9% 是上下文膨胀先于步数上限爆掉。可落地：**给生成的 Inngest 函数做 bound 覆盖静态检查 + 部署期事件环检测**（`${tenant}/${event}` 发射 vs 触发建图，找无 verified bound 的环）。

### 证据 E：推理策略的原始出处（补上正典引用）

- **ReAct**（arXiv 2210.03629, ICLR23）：交错 thought→action→observation；ALFWorld **+34%**、WebShop +10% 绝对成功率，仅需 1-2 个 few-shot 示例；推理轨迹的**人类可读性**正是 HITL 审查的依据（把 thought 流呈给人审）。
- **Tree of Thoughts**（arXiv 2305.10601, NeurIPS23）：Game of 24 上 GPT-4 CoT 4% → ToT **74%**；关键机制=思维拆成**可评估的中间单元** + 自评剪枝 + 回溯。对工厂的映射：**typecheck/dry-run 就是廉价 lookahead 评估器**——先淘汰坏分支，让全量沙箱部署只当最后一道门。

### 我们已有 ✓ / 差距 → 落点

已有：finish 拒绝 declarative-fallback、真执行验收（=论文推荐的外部 oracle 路径）✓；监督者审计用可核对事实 ✓；三档隔离 Tester ✓；reflection 策略 + 失败归因写记忆 ✓；事件链闭合检查（compileGraph/verifyGraph）✓。

| 改进 | 证据 | 代码落点 |
|------|------|----------|
| **P0：验收测试出题人不看生成代码**——generate_test_cases 只读契约/本体，不读生成的 TS | AgentCoder 87.8 vs 61.0 | `tools.ts` generate_test_cases 的输入构造 |
| **P0：修复只对已验证失败触发 + 轮帽**——过验收的 agent 不再进 revise；轮帽 2（Best practices）~5（AgentCoder） | CRITIC +11.4 vs +5.7 | `conductor.ts`/`design-loop.ts` |
| **P0：IAL bound 静态门**——promote-to-fleet 前检查每个生成函数的循环是否有"模型停发 tool call"之外的硬界；部署期检测无 bound 事件环 | 2607.01641（68 例根因清单） | `verifyGraph` 扩展 + `sandbox-deployer.ts` 部署门 |
| **P1：宽生成+真验收择优开关**——对关键 agent 同规格并行生成 2-3 候选，全部过沙箱验收后择优 | Monkeys（coverage scaling）+ Self-Repair（宽>深） | `design-loop.ts` 候选数参数 |
| **P1：难度感知预算路由**——reviewer 对候选打分估难度→按分位分配 revise/搜索预算；最难档直接升 tier 或 ask_user | 2408.03314（4× 效率） | `reasoning-policy.ts` + `model-router.ts` |
| **P1：审校输出强制 actionable+specific 格式**——审校器 verdict 必须"哪一行/哪个字段 + 怎么改" | Self-Refine 消融 | `supervisor.ts`/`report-verify.ts` 修正指令已类似，推广到全部审校面 |
| **P2：ToT 式廉价 lookahead**——typecheck/加载探针作为分支评估器前置于沙箱 | ToT 4%→74% | 已部分成立（编译+探针先行），补"多分支比较"语义 |

---

## 8. 多智能体实证边界 × "按需派生子大脑"

这是 2025-2026 文献里**修正最猛**的一个领域：早期"多 agent 必好"的叙事被等预算对照实验系统性推翻——而这恰好**全面背书我们"按需派生、不默认多派"的架构选择**。

### 证据

- **等预算单 agent ≥ 多 agent**（arXiv 2604.02460，2026）：5 种 MAS 架构（sequential/subtask-parallel/parallel-roles/debate/ensemble）在**等 thinking-token 预算**下全被单 agent 追平或击败；理论解释是 **DPI（数据处理不等式）**——agent 间 handoff 是有损信道，"多 agent 的报告优势更多来自未计入的额外算力，而非架构本身"。→ 对比舰队方案时**必须按 token 归一**；也解释了我们 carry-forward envelope/blob offload（减少转述损耗）为什么是对的方向。
- **OneFlow**（arXiv 2601.12307，2026）：**同底模的多 agent workflow 可编译成单 agent 顺序多轮对话**，7 个基准精度持平或略升，靠 KV cache 复用 **~10× 降本**（HumanEval $0.020 vs 多 agent $0.198，精度还高 2pp）；"不同角色"本身不构成拆分理由，**硬边界只有跨底模**（KV cache 无法跨模型共享）。
- **SAS-first 级联**（arXiv 2505.18286, UIUC）：先单 agent，质量评估不合格才升级多 agent——accuracy **+1.1~12%、部署成本 -20%**；MAS 的 prefill tokens 比 SAS 多 **4~220×**；且 **MAS 增益随底模变强从 10.7% 缩到 3.0%**——每次升级模型后应重估舰队是否可折叠。
- **多智能体辩论被高估**（arXiv 2502.08788）：36 个配置里**没有任何 MAD 方法对 CoT 胜率超过 20%**；等预算下 Self-Consistency（N 采样投票）几乎总强于辩论；**解药是模型异构**——评审用不同底模（Heter-SoM +6.4%），且便宜模型当 critic 反而更好（错误分布互补是增益真源）。
- **讨论 vs 好示例**（arXiv 2402.18272, ACL24）：带示例的单 agent（75.63%）≈ 最好的 6-agent 讨论（74.46%），LLM 调用少 6×；**讨论只在无示例的冷启动场景占优**；最常见错误是 **Wrong Answer Propagation**（agent 在同伴影响下放弃自己本来正确的答案）。
- **角色 prompt 是死重**（arXiv 2311.10054, EMNLP24 Findings）：162 个 persona × 4 模型族 × 2410 题——**system prompt 里加"你是资深 XX 专家"不提升客观准确率**，且方向不可预测、自动选最佳 persona 不如随机。注意边界：它只否定**修辞性**角色，不否定**结构性**专化（不同 tool_use 白名单/契约/上下文）——正好支持 Contract-First：专化要落在结构上，不是话术上。
- **Don't Build Multi-Agents**（Cognition/Devin 官方博客）：写侧任务（代码生成）经验——**共享完整轨迹而非摘要**（摘要式子 agent 会漂移）；"Actions carry implicit decisions"——**写操作必须串行**，只并行只读子任务；长程压缩交给专职 compressor 模型。
- 对照 **Anthropic +90.2%**（第 3 章）：多 agent 的正收益区在**宽而可并行的只读探索**（研究检索），且要付 15× token。

### 综合出的决策法则（写给 design_agent / critique_plan 的门）

1. **默认单 agent + 好契约 + 好示例**；拆分需要给出结构性理由（工具隔离 / 权限边界 / 真并行只读 / 跨模型 tier / 事件链上的独立部署单元）。
2. **同底模的相邻 agent 质询合并**（我们的舰队按业务动作拆分有事件链的结构性理由，但 critique_plan 应显式质询"这两个同模 agent 为何不合并"）。
3. **评审面用异构模型**（reviewer 换底模，甚至更便宜的），等预算下 N 采样投票优先于辩论。
4. **写串行、读并行**：codegen/manifest 写入永远单线；本体理解/工具检索/文档抓取可以 fan-out。
5. **舰队遥测记录双计数**：每轮 review 记 fixes introduced 与 regressions introduced（防"纠错多但翻掉更多对的"）。

### 我们已有 ✓ / 差距 → 落点

已有：按需 spawn_subagent（非默认多派）✓；碳水化的结构性拆分（事件链+工具白名单+独立部署）而非角色话术 ✓；carry-forward envelope ✓；模型分层路由 ✓。

| 改进 | 证据 | 代码落点 |
|------|------|----------|
| **P1：critique_plan 加"同模合并"质询** + 部署档位增加"collapsed 单函数"选项（同模舰队编译为单函数内顺序轮次，跨模型才拆函数） | OneFlow 10× 降本 | `tools.ts` critique_plan 判据 + `ts-function-module.ts` 渲染模式 |
| **P1：评审异构化**——supervisor/critique 强制路由到与生成不同的底模（可以更便宜） | 2502.08788 +6.4~8.2%；Self-Repair 强 critic 弱 generator | `model-router.ts` review 通道规则 |
| **P1：SAS-first 运行时级联**——生产路径默认单 agent，验收失败才触发舰队升级 | 2505.18286 | fleet-governance 巡检的升级动作 |
| **P2：从记忆库注入 few-shot 示例**到生成 agent 的 prompt（示例是最高杠杆组件；有示例就别开讨论组） | 2402.18272 | MemoryDriver 检索 → `codegen.ts` prompt 组装 |
| **P2：去掉生成 prompt 里的修辞性角色段**，预算移到契约/工具描述 | 2311.10054 | `codegen.ts`/`system-prompt.ts` 模板审查 |
| **P2：review 遥测加 fixes/regressions 双计数** | 2502.08788 诊断法 | acceptance recorder + 治理面板 |

---

## 9. Durable 执行 + 记忆 + 验收基准 × 我们的 Inngest 纪律与 MemoryDriver

### 证据：durable（三家独立来源同构 = 行业共识）

- **12-Factor Agents**（HumanLayer，24.2k stars，事实标准参考）：框架化 agent 到 **70-80% 质量即平台化**，"80% 对客户级功能不够"——自持 prompt/控制流（我们的 Contract-First）有实证依据；**Factor 8**：必须能在"工具选择之后、执行之前"挂起（我们生成的函数应把 LLM 出 tool call 与 dispatch 拆成两个 step 边界，风险工具中间插 HITL 门）；**Factor 7** 给了 ask_user 工具的现成 schema（urgency/format 枚举）；执行状态从事件日志推断（= 我们 llm_turns/runs/steps 单一事实源）。
- **Inngest 官方 durable AI agent 文**：动态命名 tool step（每次工具调用独立 memoized 步骤）；**崩溃恢复不重付已花的 LLM 费用**；`singleton: {mode:"cancel"}` 同 subject 单飞（我们并发键控的升级选项）；循环必须带 maxIterations；**token 用量放进 step 返回值即入 trace**（零插桩遥测——直接印证我们的遥测脊做法）。
- **Temporal 官方**：LLM/工具调用全部进 Activity 自动重试；HITL 用 Signals/Updates 做一等 durable 原语（挂起可跨"小时、天、周、月、年"）——与 Inngest waitForEvent、LangGraph interrupt 三家同构，**park-gate 设计正确性的最强外部三角验证**。
- **LangGraph Interrupts 文档**：恢复时**整节点从头重放**、"interrupt 之前的副作用必须幂等"（= 我们"DB 写必须进 step.run"同一纪律）；**禁止 while 循环包 interrupt**（指数级重放）；多 interrupt 按索引配对的坑——我们 taskId 精确匹配天然免疫，应固化为 codegen 规则：**每 step 至多一个 HITL 门、门必须带稳定 taskId**。还给了两个我们缺的 HITL 门类型：**edit-state**（人改产物后继续）与**工具内打断**。

### 证据：记忆（升级 MemoryDriver 的完整路线图）

- **MemGPT**（arXiv 2310.08560）：分页式上下文管理的学术锚点；**记忆操作全部走 function call 由 agent 自主**（→ 把 memory.append/search/replace 做成 registry 普通工具）；两级水位有具体数字（~70% 窗口插警告促落盘、100% 驱逐一半+递归摘要）；嵌套 KV 检索 **100% vs 基线 0%** ——分页+自主检索是数量级差异。
- **Generative Agents**（arXiv 2304.03442, Stanford）：检索打分 = **recency + importance + relevance 三分量**（各归一化、等权）；recency 按**上次被检索**时间衰减（读记忆要刷新 last_accessed）；importance 写入时 LLM 打 1-10 分一次缓存；**reflection 触发规则**（importance 累计超阈值才反思，反思写回记忆流成树）。我们 MemoryDriver 目前只有 cosine relevance 一个分量——这是现成的升级公式。
- **A-MEM**（arXiv 2502.12110）：七属性结构化记忆卡片 + 廉价 embedding 粗筛 + LLM 精判链接 + **memory evolution**（新记忆入库时复查近邻、修订旧记忆）——技能库防"只追加日志化"的机制；token 省 85-93%；有 MIT 生产级参考实现。
- **Mem0**（arXiv 2504.19413）：**直接对症我们审计发现的"memory 写路径死"缺口**——extract（滚动摘要+最近 10 条+当前消息）→ 向量召回候选 → LLM 在 **ADD/UPDATE/DELETE/NOOP** 四操作里显式选择；p95 延迟 **-91%**、token **省 >90%**；图记忆变体只 +2% 但 token 翻倍——**先平面向量，图结构等瓶颈出现再说**。

### 证据：验收基准方法论（怎么"科学地"验收生成的 agent）

- **AgentBench**（arXiv 2308.03688, ICLR24）：每任务 Docker 镜像封装 + 独立 worker（= 我们三档隔离+并行沙箱的蓝本）；**判分靠真实执行的确定性结果**（bash/SQL），不靠文本匹配；失败分类学：**Task Limit Exceeded 占主导**（KG 环境 67.9%）——TLE/死循环要与答错分开归因；GPT-4 总分 4.01 vs 开源 ≤70B 平均 0.51——model-tier 路由的定量依据。
- **τ-bench**（arXiv 2406.12045, Sierra）：**验收=对比会话结束时的数据库状态与目标状态 diff**（只认真实副作用，不认 transcript）——与我们 code_ran 收据门同构；**pass^k 可靠性指标**：gpt-4o pass^1 <50%、retail pass^8 <25%——**单次跑通是弱证据，finish 应看多次一致性**；LM 模拟用户自动打通 ask_user 多轮路径做回归。
- **ToolEmu**（arXiv 2309.15817, ICLR24，**partial**）：LM 模拟工具执行做**真执行前的低成本风险预演**；对抗式模拟器专挖长尾高危；自动安全评估器 68.8% 有效；**最安全的 agent 仍有 23.9% 失败率**——高危副作用前强制 ask_user 的数字论据。

### 我们已有 ✓ / 差距 → 落点

已有：Inngest step.run 纪律 + waitForEvent HITL ✓（三家共识的同款）；llm_turns/runs/steps 事件日志 ✓；每轮 conversation checkpoint + crash-resume ✓；scoped 向量记忆 ✓；沙箱验收看 runs 终态 ✓。

| 改进 | 证据 | 代码落点 |
|------|------|----------|
| **P0：Mem0 式写路径补活**——extract→ADD/UPDATE/DELETE/NOOP 决策调用，接到每次 run 结束后（审计确认过我们写路径经 ToolContext 是死的） | Mem0（-91% p95 / >90% token） | `packages/agent-factory` MemoryDriver 写侧 + run 收尾钩子 |
| **P1：检索三分量升级**——recency（读时刷新 last_accessed）+ importance（写入时打分缓存）+ relevance 加权 | Generative Agents 公式 | MemoryDriver 打分函数 |
| **P1：pass^k 进 finish 门**——关键 agent 验收跑 k 次（k=2-3）全过才算 reachedSuccessTerminal | τ-bench（pass^8<25% 的警示） | `sandbox-deployer.ts` 验收循环 |
| **P1：生成函数的 codegen 规则固化**——tool-select 与 dispatch 拆 step；每 step ≤1 个 HITL 门带稳定 taskId；interrupt 前副作用必须已在 step.run 内；循环带 maxIterations | 12-Factor F8 + LangGraph + Inngest | `ts-function-module.ts` 模板 + code-lint 检查 |
| **P2：ToolEmu 式预演门**——高危工具（write 类）在真执行前用 LLM 模拟最坏返回跑一轮 agent 行为预检 | ToolEmu 68.8% 有效 | Tester 前置阶段（可选档） |
| **P2：HITL 门类型补齐**——edit-state（人改产物继续）与工具内打断 | LangGraph 模式清单 | ask_user 门 + tasks 表 resolution 结构 |
| **P2：LM 模拟用户回归**——ask_user 多轮路径的自动回归验收 | τ-bench | 测试基建（cassette 体系扩展） |

---

## 10. 改进路线图（合并去重后的总表）

**P0（验收与安全的直接补强，改动小、证据硬）—— ✅ 全部六项已于 2026-07-13 落地实装**（`#CHECKLIST`/`#CRITIC-GATE`/`#IAL`/`#INDEPENDENT-TESTER`/`#MEM-WRITE`/`#SKILL-INDUCE` 代码标记；新增 29 个单测全过；验收清单已接入前端后台面板 + agent 下钻）

| # | 改进 | 最强证据 | 落点 |
|---|------|---------|------|
| P0-1 | 验收清单 harness 持有、agent 无权删改（feature 全标 failing 只许真跑翻绿） | Anthropic 长跑 harness 文 | `acceptance.ts` + conductor finish 门 |
| P0-2 | 验收测试出题人**不看生成代码**（只读契约/本体） | AgentCoder 消融 87.8% vs 61.0% | `generate_test_cases` 输入构造 |
| P0-3 | 修复循环只对**已验证失败**触发 + 轮帽 2~5 + 超限重置上下文 | CRITIC / Best practices / Self-Debug | `conductor.ts` revise 计数 |
| P0-4 | **IAL bound 静态门**：promote 前检查生成函数循环的硬停止界 + 部署期事件环检测 | arXiv 2607.01641（68 例根因） | `verifyGraph` + `sandbox-deployer.ts` |
| P0-5 | **Mem0 式记忆写路径补活**（extract→ADD/UPDATE/DELETE/NOOP） | Mem0 -91% p95 | MemoryDriver 写侧 |
| P0-6 | **AWM 式技能归纳管道**：从成功 runs 被动归纳技能（数据全在） | AWM +51.1% | 新 `skill-induction.ts` + 治理巡检触发 |

**P1（结构性收益，中等工作量）**

| # | 改进 | 最强证据 | 落点 |
|---|------|---------|------|
| P1-1 | 双预算 max_turns + max_budget_usd + 五值类型化终止态 | Agent SDK 文档 | conductor + 生成模板 + 遥测 |
| P1-2 | 宽生成（2-3 候选）+ 真验收择优（关键 agent） | Monkeys scaling / Self-Repair 宽>深 | `design-loop.ts` |
| P1-3 | 评审异构化：supervisor/critique 换底模（可更便宜）；N 采样投票优先于辩论 | 2502.08788 / Self-Repair | `model-router.ts` |
| P1-4 | critique_plan 加"同模合并"质询 + collapsed 单函数部署档 | OneFlow 10× 降本 | critique_plan + 渲染模式 |
| P1-5 | 难度感知预算路由（最难档升 tier 或 ask_user） | 2408.03314（4×） | `reasoning-policy.ts` |
| P1-6 | 技能入库执行验证门 + 落盘对齐 agentskills.io 规范（可导出资产） | ASI +23.5% / 官方开放标准 | create_skill + SkillStore 序列化 |
| P1-7 | 工具描述自优化回路（llm_turns/tool_stats 驱动重写） | Anthropic -40% 任务时间 | 治理巡检新 action |
| P1-8 | step-engine 工具输出窗口化 + 历史折叠 + search 结果硬上限（拒绝分页） | SWE-agent 四条定量 | `step-engine.ts` / `tool-catalog.ts` |
| P1-9 | pass^k 进 finish 门（k=2-3 全过） | τ-bench | 沙箱验收循环 |
| P1-10 | codegen 规则固化：tool-select/dispatch 拆 step、HITL 门带稳定 taskId、循环带 maxIterations | 12-Factor / LangGraph / Inngest | `ts-function-module.ts` + code-lint |
| P1-11 | 委派四件套契约（objective/output format/工具指引/边界）+ effort-scaling 规则进 prompt | Anthropic 多智能体文 | spawn_subagent schema + system-prompt |
| P1-12 | 审校输出强制 actionable+specific；fresh-context reviewer 制度化 | Self-Refine / Loop engineering | supervisor 审计面 |

**P2（打磨与防御）**：compaction 打摆断路器（How Claude Code works）；三级渐进披露进大脑上下文（agentskills spec）；从记忆注入 few-shot 示例（2402.18272）；删修辞性角色段（2311.10054）；带类型执行产物入 verdict（LEVER）；code/text 模态硬路由（2410.03524）；工具失败现场生成替代函数（DynaSaur）；ToT 式 lookahead 语义（typecheck 已是）；ToolEmu 预演门；HITL 门类型补齐（edit-state/工具内打断）；LM 模拟用户回归（τ-bench）；review 遥测 fixes/regressions 双计数；AI 补测试盲区（AlphaCodium）；SAS-first 运行时级联（2505.18286）。

---

## 11. 附录：全部核验来源（58）

**核验方法**：每个来源由独立 agent 于 2026-07-12 WebFetch 原文，逐条比对检索阶段的"声称要点"，`confirmed`=全部属实、`partial`=个别要点有出入（正文引用已修正）。0 个来源被判 `wrong`/剔除。

### A. Claude/Anthropic 官方（11）
| 来源 | 类型 | 核验 |
|------|------|------|
| Loop engineering: Getting started with loops — claude.com/blog/getting-started-with-loops | blog | confirmed |
| Building agents with the Claude Agent SDK — claude.com/blog/building-agents-with-the-claude-agent-sdk | blog | confirmed |
| How the agent loop works — code.claude.com/docs/en/agent-sdk/agent-loop | docs | confirmed |
| How Claude Code works — code.claude.com/docs/en/how-claude-code-works | docs | confirmed |
| Effective harnesses for long-running agents — anthropic.com/engineering/effective-harnesses-for-long-running-agents | blog | confirmed |
| Building Effective AI Agents — anthropic.com/engineering/building-effective-agents | blog | confirmed |
| How we built our multi-agent research system — anthropic.com/engineering/multi-agent-research-system | blog | confirmed |
| Writing effective tools for agents — anthropic.com/engineering/writing-tools-for-agents | blog | confirmed |
| Effective context engineering for AI agents — anthropic.com/engineering/effective-context-engineering-for-ai-agents | blog | confirmed |
| Best practices for Claude Code — code.claude.com/docs/en/best-practices | docs | confirmed |
| Raising the bar on SWE-bench Verified — anthropic.com/news/swe-bench-sonnet | blog | confirmed |

### B. SKILLS（7）
Agent Skills 工程文（anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills, confirmed）· Agent Skills 规范（agentskills.io/specification, confirmed）· Introducing Agent Skills（claude.com/blog/skills, confirmed）· Voyager（arXiv 2305.16291, confirmed）· AWM（arXiv 2409.07429, confirmed）· ASI（arXiv 2504.06821, confirmed）· SkillWeaver（arXiv 2504.07079, confirmed）

### C. CodeAct 谱系（8）
CodeAct（2402.01030, confirmed）· Self-Debug（2304.05128, confirmed）· Is Self-Repair a Silver Bullet?（2306.09896, confirmed）· TaskWeaver（2311.17541, confirmed）· OpenHands（2407.16741, confirmed）· LEVER（2302.08468, **partial**）· Steering Code vs Text（2410.03524, confirmed）· DynaSaur（2411.01747, confirmed）

### D. Harness/ACI（3 + A 类 1）
SWE-agent（2405.15793, confirmed）· AlphaCodium（2401.08500, confirmed）· mini-swe-agent（github.com/SWE-agent/mini-swe-agent, confirmed）

### E. Loop 控制与验证（10）
Reflexion（2303.11366, confirmed）· Cannot Self-Correct（2310.01798, confirmed）· AgentCoder（2312.13010, confirmed）· Self-Refine（2303.17651, confirmed）· LATS（2310.04406, confirmed）· CRITIC（2305.11738, confirmed）· Test-Time Compute（2408.03314, confirmed）· Large Language Monkeys（2407.21787, confirmed）· Infinite Agentic Loops（2607.01641, **partial**，2026 预印本未同行评审）· ReAct（2210.03629, confirmed）· ToT（2305.10601, confirmed）

### F. 多智能体实证边界（7）
等预算 SAS≥MAS（2604.02460, confirmed）· OneFlow（2601.12307, confirmed）· Why Not Both（2505.18286, confirmed）· Stop Overvaluing MAD（2502.08788, confirmed）· Multi-Agent Discussions（2402.18272, confirmed）· Personas 无效（2311.10054, confirmed）· Don't Build Multi-Agents（cognition.com/blog/dont-build-multi-agents, confirmed）

### G. Durable + 记忆 + 评测（11）
12-Factor Agents（github.com/humanlayer/12-factor-agents, confirmed）· Inngest durable AI agent（inngest.com/blog/ai-agents-inngest-durable-steps, confirmed）· Temporal durable execution meets AI（confirmed）· LangGraph Interrupts（docs.langchain.com, confirmed）· MemGPT（2310.08560, confirmed）· Generative Agents（2304.03442, confirmed）· A-MEM（2502.12110, confirmed）· Mem0（2504.19413, confirmed）· AgentBench（2308.03688, confirmed）· τ-bench（2406.12045, confirmed）· ToolEmu（2309.15817, **partial**）

### 与既有 34 篇语料的关系
此前三主题语料（ADaPT/Plan-and-Solve/Meta-Reasoner 等理解拆分组；Ask-before-Plan/Active Task Disambiguation 等澄清组；MetaGPT/AutoGen/MAST/SagaLLM 等通信+durable 组）依然有效，与本文档互补：那边回答"怎么理解与拆分任务、何时问人、agent 间怎么通信"，这边回答"loop 怎么控制、harness 怎么建、技能怎么沉淀、代码怎么验收、多 agent 何时值得、记忆怎么升级"。两份合计 **92 个已核验来源**，覆盖工厂全部关键架构决策。

### 诚实披露
- 3 篇 `partial`（LEVER / IAL / ToolEmu）：来源真实、结论方向成立，但检索阶段的个别要点表述与原文有出入，本文引用均以核验后版本为准。
- 厂商单源数字（如 Anthropic +90.2%、Inngest/Temporal 工程主张、Rakuten 8× 轶事）已标注出处属性，学术双源可交叉的结论优先引用论文。
- 2026 年新论文（2604.02460、2601.12307、2607.01641）多为预印本，引用时保留"尚未同行评审"注记。

