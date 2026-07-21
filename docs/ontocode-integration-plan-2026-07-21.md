# OntoCode 整合方案 — v10 设计 × Agent 工厂后端（2026-07-21）

> 目标：Agent 工厂更名 **OntoCode**，前端按 v10 设计风格重建，后端复用工厂现有引擎；本文档给出分析、整合架构、UI 设计、前后端接线表、@agent 语言交互设计、后端优化路线与实施任务。

---

## 1. v10 设计分析：值得采纳的优点

v10（承 v9）在多轮迭代后沉淀出的核心资产，逐条对应我们的整合价值：

| # | v10 优点 | 为什么值得采纳 | 与工厂后端的对应 |
|---|---|---|---|
| 1 | **三栏分工**：左=导航与任务，中=产物，右=过程与日志 | 每栏职责单一，「主页面不展示思考推理」靠结构保证 | 中栏=SSE 事件的产物投影；右栏=同一 SSE 流的过程投影 |
| 2 | **任务框统一入口 + @引用** | 八种情景（整套/单函数/修改/debug/扩展/漂移…）共用一个入口，零学习成本 | `runs/start`（新会话）+ `conversation` 续接（append 模式，现成）+ `inject`（parked 时） |
| 3 | **执行行单行原地刷新** | 反聊天核心：智能感可见、历史不刷屏 | BrainEvent 流的「当前活动」投影（最后一个未完成 tool/stage） |
| 4 | **待你决定 + 动态配置层（同屏覆盖）** | AI 所有提问的唯一居所；点击滑出 schema 驱动的表单层，带上下文头，Esc 退出 | 三类 park 门（clarify/test_approval/boundary）+ 凭证缺失 warn → todo 化；答复走 `inject`（`buildHumanInteractionSubmission` 已有） |
| 5 | **闭环三态**：待答 → ◐ 沙箱重跑中 → ✓ 通过（署名归档） | 「配置帮助沙箱测试」的闭环感来源 | 门决议后 brain 自动续跑；沙箱事件回流同一 SSE |
| 6 | **右栏时间线即索引**（可点击跳转）+ 46px 可折叠 + warn 点 | 右栏从展示升级为导航；平时不占宽 | `deriveBrainFlow()`（现成函数）产出的 BrainStep 就是时间线；interactionId 可定位 todo |
| 7 | **事件与业务流 SVG**（自动生成、只读、点节点展开卡） | 套件级结构可视化，也是给客户讲方案的交付物 | agents 的 trigger/emit 派生（现有 DAG 派生逻辑同源） |
| 8 | **agent 卡行内展开：步骤逻辑编号列表 + 代码** | 「看不懂」的解药：一切就地展开，无抽屉迷宫 | `AgentCardData.decisionLogic / systemPrompt / code`（`deriveAgents()` 现成） |
| 9 | **「下一步」建议 chips**（换生产凭证/导出 PR/存为模板） | 把 Day-2 动作变成建议而非常驻按钮群 | 从 run 终态 + 待办派生（前端纯投影） |
| 10 | **检查点已存·可回滚** | 生成过程的安全感 | 草稿版本（draft versionId / revisions）已有；run 级检查点见后端路线 |

**结论：v10 的每一个面都有工厂后端的现成数据源，整合是「换壳+投影适配」，不是重写。**

## 2. 整合架构决策

1. **新路由并存，旧工厂降级为高级模式**：新建 `/portal/<tenant>/ontocode`，旧 `/factory` 保留（左栏底部「高级模式」入口），零回归风险，跑稳后再退役。
2. **数据层 100% 复用**：SSE 走现有 `/factory-stream` 代理（`useBrainStream` hook 直接用）；事件→UI 的派生复用 `factory/model.ts` 的 `toBlocks / deriveAgents / deriveBrainFlow / deriveStages / sandboxEvidenceStatus`（纯函数，零改动 import）。
3. **P0 后端零改动**：三类 park 门以「必答 todo」呈现（run 暂停=todo 出现=结构化作答=续跑），行为与现工厂一致、形态全新。autopilot（假设不阻塞）是 P1 后端项。
4. **v10 浅色风格作用域隔离**：portal 全局是深色 token；OntoCode 页面根节点挂 `.oc` 作用域，内部自带浅色变量与组件样式，不污染其他页面。
5. **命名**：侧栏新增「OntoCode」导航项（i18n zh/en 双词典 + parity 测试），工厂项保留。

## 3. 页面结构与 UI 设计（v10 风格）

```
┌ 顶栏: OntoCode 标识 · ⬡域·快照 chip · Inngest 状态 · [部署 vN] ┐
├───────────┬──────────────────────────────┬───────────────────┤
│ 左栏 220px │ 中栏（产物）                     │ 右栏 300px（可折叠46px）│
│ ＋新任务    │ ① 任务框(＠引用/上传/Generate ⌘↵) │ tab: 会话 | 日志      │
│ 工作台      │ ② 执行行(单行原地刷新)            │ 推理与工具调用时间线    │
│ Ontology域 │ ③ 套件头(N agents·沙箱·测试·部署)  │  (可点击=索引)        │
│ 模板库      │    事件与业务流(ribbon+图,可折叠)   │ 日志尾部              │
│ 最近任务    │    agent 卡网格(行内展开:步骤+代码) │ 导出会话记录          │
│ 客户/设置   │ ④ 待你决定(条件出现)→配置覆盖层     │ (warn 琥珀点提醒)     │
└───────────┴──────────────────────────────┴───────────────────┘
```

关键交互规格：

- **任务框**：多行输入 + 📎上传（Ontology JSON/文档，复用 `ontology-upload` 分类逻辑）+ **@ 引用菜单**（列出当前套件 agents + 最近失败 run）+ `Generate ⌘↵`；运行中变 `⏹ 停止`。空态给来自 Ontology 的推荐场景 chips（`factory-goals` 现成逻辑）。
- **执行行**：`◐ <当前活动> · 已 N 步 · M 工具 · ¥成本`，完成折叠为 `✓ 完成 · … · 推理与日志见右栏`；错误态红字给「重新连接/重试」。
- **agent 卡**：名称 + 状态 chip（生成中/已验证/未变/手改/失败）+ 事件接线等宽行；点击行内展开：决策逻辑（步骤列表）、系统提示摘要、代码块（等宽、深底）。
- **待你决定**：琥珀条 `N 项待决 · K 必填`；行卡=问题+溯源+影响；点「处理」右侧滑出**配置覆盖层**：上下文头（影响哪些 agent、完成后自动续跑）+ 按 todo 类型渲染的表单体 + 提交。提交后行卡走 `◐ 已提交·大脑继续中 → ✓`。
- **todo 类型注册表（P0 四类）**：`clarify`（选项 chips+自由文本）/ `test_approval`（用例表+执行/重生成/补数据）/ `boundary`（每事件 终点/外部/断链 三选+消费方契约）/ `credential`（提示去 Settings→Integrations 配置的引导层，P0 引导、P1 内嵌表单）。
- **@agent 语言交互**（详见 §5）：`@jd-matcher 把分数线改成 75` —— @token 从菜单选择，任务以同会话续接发送。

## 4. 前后端接线表（P0 全部现成）

| UI 面 | 数据/动作来源 | 现成资产 |
|---|---|---|
| 启动/续接任务 | `POST /v1/agent-factory/runs/start` `{domain, goal, conversation?}` | `composeFactoryGoal` · `FactoryRunStartReceipt` · `replayModeForStart` |
| SSE 事件流 | `GET /factory-stream?tenant&run` | `useBrainStream`（events/running/error，断线码） |
| 产物（agents/代码） | `deriveAgents(events)` | factory/model.ts |
| 右栏时间线 | `deriveBrainFlow(t, events)` | 同上（BrainStep 含 interactionId） |
| 执行行/阶段 | `deriveStages(t, events)` + 末段 tool/think 帧 | 同上 |
| 待你决定 | blocks 中 `clarify/testcases/boundarycases` 且 `awaiting` | `toBlocks(t, events)` |
| 作答 | `POST /v1/agent-factory/inject` | `buildHumanInteractionSubmission` |
| 域列表/上传 | `GET /v1/agent-factory/*` + `POST /ontology-upload` | `useAgentFactoryDomains` · `ontology-upload.ts` |
| 最近任务 | `GET /v1/agent-factory/runs?domain=` | RunRow 类型现成 |
| 部署 | `POST /drafts/promotion-preview` → `POST /drafts/promote` | 既有晋升管线（含人工签核语义） |
| 沙箱徽章 | `sandboxEvidenceStatus(events)` | factory/model.ts |

## 5. @agent 语言交互（生成/修改/debug）的实现路径

体验：任务框输入 `@` 弹出菜单（当前套件 agents、最近失败 runs）→ 选中成为 token → 继续用自然语言描述意图 → Generate。示例：`@jd-matcher 分数线改成 75`、`@run-8f2c 修一下`、`@invite-drafter 邀约文案改成英文`。

实现（P0 即可用，因为后端已有三块能力）：
1. **同会话续接**：`runs/start` 带 `conversation` 续接同一会话（`mode:"attached"` / append 重放），大脑自带全部上下文——@agent 的多轮交互天然成立，不需要新会话模型。
2. **意图分派**：大脑已有 intent 顶层分派（analyze/question/generate/修改），`@<slug>` 前缀 + 自然语言会被解析为对该 agent 的局部操作（#SCOPE 单动作范围 + 按 agent 重生成已存在）。
3. **debug**：`@run-<id>` 引用失败 run，goal 组装时附带 run 摘要（P0 由前端把 run 状态行拼进 goal；P1 后端出结构化 scope 字段）。

P1 后端强化：`runs/start` 增加结构化 `scope: { agentSlug? runId? }` 字段，替代文本约定；扩展会话内「按 @ 对象过滤时间线」。

## 6. 后端优化路线（回答「后端还需要什么优化」）

**P0（本次整合，零后端改动）**：上表全部走现有端点。

**P1（体验闭环，小-中改动）**：
1. **autopilot 假设模式**：`ask_user` 在 autopilot 开关下不 park——记录假设（推荐值）继续生成，假设清单随 done 帧输出；`sandbox_run` 首跑门加「信任默认用例」旁路。落点：packages/agent-factory tools.ts + reasoning-policy.ts。
2. **todo 结构化注册表**：门事件统一携带 `todoType + form_schema + impact[]`，前端配置层按 schema 渲染（Kenny 的 `AgentPortUiSchema`/TestLab schema 表单是现成渲染基建）。
3. **凭证内嵌配置**：todo=credential 时直接渲染 integrations 表单（`/v1/integrations` 现成，补「测试连接」端点）。
4. **结构化 scope**：`runs/start` 的 `scope` 字段（见 §5）。
5. **run 检查点/回滚**：draft revisions 已有版本链；补「回滚到上一检查点重放」的 run 级 API（v10 的「检查点已存·可回滚」）。

**P2（护城河，中-大改动）**：
6. **增量生成 + diff**：per-agent 指纹（prompt+code+tools 签名，`deriveAgentVersions` 的 sig 思路后端化）；vs 已部署 manifest 比对；只重算受影响节点。
7. **Ontology 快照钉住 + 漂移检测**：生成时落快照版本号；每日 diff 活库；漂移事件投递为 todo。
8. **失败→修复 composer**：基于 run_summaries（problem+likelyCauses 现成）生成补丁 diff + 回归夹具提案。
9. **手改保护标记 + Git PR 导出**：agent 级 detached 标志；manifest+代码导出为 PR。
10. **「下一步」建议服务化**：终态后由大脑产出 next-step chips（P0 前端规则先行）。

## 7. 实施任务分解（P0 前端）

新增文件（`apps/web/app/portal/[tenant]/(views)/ontocode/`）：
- `oc-model.ts` — OntoCode 投影层：`deriveTodos(blocks)`（三门+awaiting→todo）、`deriveExecLine(t, events, running)`、`deriveFlowGraph(agents)`（事件图数据）、`deriveNextSteps(...)`；单测 `oc-model.test.ts`
- `oc-api.ts` — `apiSend` 副本（复用 `decodeFactoryResponse`）+ startRun/inject/listRuns/listDomains 封装
- `page.tsx` — 三栏 shell + 状态编排（useBrainStream 接线、@菜单、配置覆盖层开关）
- `components.tsx` — TaskComposer / ExecLine / SuiteHeader / FlowStrip / AgentGrid / TodoQueue / ConfigOverlay / SessionRail（单文件分组件，遵循工厂目录习惯）
- `ontocode.css` — `.oc` 作用域浅色主题（v10 色板：底 #f6f7f8、面板 #fff、墨字 #17211b、品牌绿 #17a673 系）

修改文件：
- `apps/web/app/portal/components/shell/sidebar.tsx` — 新增 OntoCode NavItem（icon spark，置于工厂项上方）
- `apps/web/lib/i18n/zh.ts` / `en.ts` — `nav.ontocode` 键（parity 测试要求成对）

验收：
1. `pnpm --filter @agentic/web run typecheck` 通过；`vitest run` 新增单测绿。
2. `pnpm dev` 后 `/portal/raas/ontocode` 可开：空态（域 chips+推荐场景）→ 输入目标 Generate → 执行行滚动 → agent 卡出现 → 门事件转 todo → 配置层作答 → 续跑 → 终态徽章；右栏时间线同步。
3. 历史 run 回放（最近任务点击）呈现同一投影。
4. 旧 /factory 完全不受影响。

## 8. 风险与边界

- OntoCode P0 的文案先用中文字面量（工厂级 i18n 键量大，P1 抽取）；仅 nav 走词典（parity 测试强制）。
- 浅色主题只作用于 `.oc` 子树；Monaco/代码块维持深底（v10 同款）。
- P0 不做：模板库实体、多客户切换（沿用租户切换器）、事件图拖拽（只读 SVG）、@run 的结构化注入（文本组装先行）。
