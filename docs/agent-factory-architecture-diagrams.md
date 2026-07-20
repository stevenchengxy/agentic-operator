# Agent 工厂 · 技术原理与流程架构（图解）

> 本文用 mermaid 序列图 / 流程图 / 状态图逐层讲清 Agent 工厂的技术原理。所有图都对齐真实代码（文件名、事件名、工具名均可在仓库中检索）。
> 在支持 mermaid 的地方（GitHub / VS Code 预览 / Obsidian / mermaid.live / Claude）可直接渲染。

---

## 0. 一句话心智模型

工厂里其实有**两个系统**，共用一套 `runs`/`steps` 表与 SSE 日志：

- **系统 A —「生成系统」(Factory Brain)**：一个长驻的 ReAct 大脑（`packages/agent-factory/src/conductor.ts` 的 `runBrain`），读业务本体（Ontology），**推理并生成**可部署的业务 agent。
- **系统 B —「运行时」(Runtime)**：把生成好的 agent 注册成 Inngest 函数（`packages/runtime`），由**事件**触发**真正执行**，一个 agent 的产出事件触发下一个 agent，串成事件链。

工厂 = 系统 A 生成 → 沙箱用系统 B 真跑验证 → finish 晋升上线。

---

## 1. 全局架构：两进程 + 两系统

```mermaid
graph TB
  subgraph Browser["浏览器 (你)"]
    UI["Next.js 16 Portal<br/>apps/web · 纯 UI · 零数据库"]
  end

  subgraph Web["apps/web (Next 16)"]
    APIClient["lib/api-client.ts<br/>用 @agentic/contracts Zod 解析响应"]
    Rewrite["next.config.mjs<br/>/v1/* /health → 代理到 api"]
  end

  subgraph API["apps/api (Fastify 5) :3540"]
    Routes["/v1/* 路由<br/>Zod 校验 + RBAC + 租户作用域"]
    RunReg["run-registry.ts<br/>detached 驱动大脑 + SSE"]
    Mailbox["mailbox.ts<br/>HITL 人工消息投递"]
    Boot["bootstrap.ts<br/>发现本体→注册 Inngest 函数"]
  end

  subgraph SysA["系统 A · 生成系统 (packages/agent-factory)"]
    Brain["runBrain (conductor.ts)<br/>ReAct 主循环 · 长驻 async generator"]
    Tools["FACTORY_TOOLS<br/>read_ontology / design_agent / revise_ontology<br/>sandbox_run / finish / ask_user / spawn_subagent_group …"]
    Brain --> Tools
  end

  subgraph SysB["系统 B · 运行时 (packages/runtime + packages/agents)"]
    Register["registerAgent<br/>清单 agent → 每(租户,agent)一个 Inngest 函数"]
    StepEngine["step-engine.ts<br/>step.run() 内跑动作 + 工具循环"]
    Inngest["Inngest dev :8488<br/>事件路由 + durable 重放"]
  end

  Gateway["LLM Gateway (packages/llm-gateway)<br/>单例 · 多 provider 目录"]
  DB[("SQLite WAL<br/>data/agentic.db · 25+ 表")]
  Logs[("NDJSON 日志 + 事件账本<br/>data/logs/")]
  Onto["Ontology 源<br/>本地 models/ 或 Allmeta Studio"]

  UI --> APIClient --> Rewrite --> Routes
  Routes --> RunReg --> Brain
  Routes <--> Mailbox
  RunReg -.SSE BrainEvent 流.-> UI
  Brain --> Gateway
  Tools --> Onto
  Boot --> Register --> Inngest
  Tools -->|sandbox_run 真部署| Inngest
  Inngest --> StepEngine --> Gateway
  Brain --> DB
  StepEngine --> DB
  Brain --> Logs
  StepEngine --> Logs
```

**要点**
- `apps/web` **零数据库**：每次读写都走 `/v1/*` 到 `apps/api`；`@agentic/contracts` 的 Zod schema 是请求/响应的单一事实源。
- 大脑是**detached** 驱动的（`run-registry.drive()`）：关掉 SSE 连接大脑仍在跑，重连即回放。
- 系统 A 生成的 agent，通过 `sandbox_run`/`finish` 进入系统 B 被真正注册、被事件驱动执行。

---

## 2. 端到端生成流水线（核心序列图）

从你在聊天框敲一句话，到工厂造出一组可运行 agent 并验证事件链。

```mermaid
sequenceDiagram
  autonumber
  actor U as 用户
  participant W as apps/web
  participant API as apps/api /v1
  participant RR as run-registry
  participant B as runBrain (大脑)
  participant GW as LLM Gateway
  participant O as Ontology 源
  participant IG as Inngest (沙箱)
  participant DB as SQLite + 日志

  U->>W: 「为本域生成能跑通的 agent」
  W->>API: POST /v1/agent-factory/runs/start {domain, goal}
  API->>RR: startRun(domain, goal, conversationId)
  RR-->>API: 202 {runId, mode:"started"}
  RR->>B: drive(): for await ev of runBrain(...)
  W->>API: GET /v1/agent-factory/stream?run=runId (SSE)
  API-->>W: BrainEvent 流 (think/tool.call/agent.created/clarify/…)

  Note over B: ReAct 主循环 (最多 MAX_TURNS 轮)
  B->>GW: 意图门 parseUserIntent(goal)
  B->>O: read_ontology → 自动规范化 + 可执行性闸门
  Note over B: ⑤ understand_ontology<br/>大本体派「认知专家组」四维分治深读
  B->>B: create_plan → critique_plan (真 LLM 评审)
  loop 每个 Agent 动作 (按切片就绪)
    B->>GW: design_agent (亲写 system_prompt/决策/选真实工具)
    alt 切片有阻塞
      B->>O: revise_ontology 补执行绑定 → 重算闸门
    end
    B->>B: codegen_agent (渲染/AI 写 .ts) → 过 TS+安全+加载探针
  end
  B->>B: validate_graph (事件链断链检测)
  B->>B: generate_test_cases (通过用例 + 故障用例)
  B->>IG: sandbox_run: 真部署到隔离租户 + 发事件真跑
  IG-->>B: 每个 agent 的真实 run I/O (code_ran 回执)
  B->>GW: 逐 agent 审校 (review_agent) + 打分
  B->>B: finish: 验收门 (覆盖/代码真跑/事件链/证据) 全过才交付
  B->>DB: 每轮 checkpoint (崩溃可续) + 反思记忆写入
  B-->>W: {t:"done", status:"delivered"}
  Note over U,W: 交付：可部署 agent 代码 + 事件链验证报告
```

**关键闸门（都是"结构强制"，不是提示词口头约束）**
- `read_ontology` 后**可执行性闸门**：本体不完整就挡住生成（见 §4）。
- `finish` 的**验收门**：必须有真实沙箱执行回执（`code_ran`）、事件链跑通、覆盖齐全，才算"交付"，否则 `finish` 返回 `ok:false` 把大脑打回。
- 全程**HITL 门**：拿不准就 `ask_user` 真挂起等你（见 §5）。

---

## 3. 大脑 ReAct 主循环（每一轮做什么）

`runBrain` 是一个 `async generator`，每 `turn` 一轮。gates 在**轮顶**（先处理人工/park），再 LLM 一次，再派发工具，再落检查点。

```mermaid
flowchart TD
  Start([turn 开始]) --> Gates{"轮顶 HITL 门<br/>awaitingApproval / boundary / clarify?"}
  Gates -- 有门在等 --> Park["park：轮询 mailbox<br/>不消耗 LLM 轮次<br/>(turn--; 睡 1.2s; 继续)"]
  Park -->|收到答复| Resolve["登记人工决策<br/>emit 清除帧<br/>注入答案到上下文"]
  Resolve --> Drain
  Gates -- 无门 --> Drain["排空邮箱人工消息 (常规介入)"]
  Drain --> Compact["超长则自动压缩上下文<br/>(保留结构化状态摘要)"]
  Compact --> LLM["streamTurn: 调 Gateway 一次<br/>(带工具 schema + 分层模型链)"]
  LLM --> Acc["累计 token → 记共享预算账本<br/>(#TREE-BUDGET)"]
  Acc --> HasCall{"有工具调用?"}

  HasCall -- 无工具(纯文本) --> Q{"以开放问题收尾?"}
  Q -- 是 --> AutoPark["#ASK-PARK v2<br/>合成一次真澄清挂起<br/>→ 下一轮命中 clarify 门 park"]
  Q -- 否 --> End([结束])
  AutoPark --> Start

  HasCall -- 有工具 --> Mutex{"ask_user 与 finish/sandbox 同轮?"}
  Mutex -- 是 --> Refuse["#ASK-PARK-MUTEX<br/>拒绝 finish/sandbox<br/>只让 ask_user park"]
  Mutex -- 否 --> Dispatch["逐个派发工具<br/>tenant override ?? global ?? MCP"]
  Refuse --> Dispatch
  Dispatch --> Admit["准入门 stageAdmission<br/>(阶段跳跃被结构化拒绝)"]
  Admit --> Exec["执行工具 → tool_result 回灌<br/>(throw 转 is_error 让模型自纠)"]
  Exec --> Finish{"finish 通过验收门?"}
  Finish -- 是 --> Deliver([交付 done])
  Finish -- 否 --> Ckpt["每轮 checkpoint (崩溃可续)"]
  Ckpt --> Start
```

**为什么这样设计**
- 门在轮顶 → 人工介入优先于模型行动；park 不烧 LLM 轮次。
- 工具 `throw` → 运行时转成 `tool_result is_error`，模型下一轮自我纠正（ReAct 闭环）。
- 工具解析顺序：`租户覆盖 ?? 全局 globalToolRegistry ?? MCP`，`tool_use[]` 白名单是信任边界。

---

## 4. 本体可执行性闸门 + in-loop 修复（Track 2）

从上游语义建模器（Allmeta）拉来的本体是给**人看的语义**，缺工厂要的**执行绑定**（binding_kind / lookup result_path / 输出→事件映射）。旧设计一刀切禁止生成 → 死循环。现在是**闭环**：

```mermaid
flowchart TD
  Read["read_ontology"] --> Norm["normalizeOntologySelfConsistency<br/>确定性自洽规范化<br/>(producer/consumer 对称 · 主键补全)"]
  Norm --> Heal["emit ontology.heal (透明展示补了什么)"]
  Heal --> Gate["analyzeOntologyReadiness<br/>→ blocking / warning 缺口"]
  Gate --> Ready{"ready = blocking.length==0 ?"}
  Ready -- 是 --> Design
  Ready -- 否 --> PerAction["design_agent 按动作切片<br/>blockingIssuesForAction(action)"]
  PerAction --> Slice{"这个动作的切片<br/>有阻塞吗?"}
  Slice -- 干净 --> Design["design_agent 生成该 agent<br/>(部分生成：别的动作先造)"]
  Slice -- 有阻塞 --> Repair["revise_ontology<br/>大脑传 grounded 补丁<br/>(binding_kind/result_path/输出映射…)"]
  Repair --> Validate["applyOntologyRevision<br/>校验引用真实存在 (不存在就拒绝不编造)"]
  Validate --> Recompute["重算 analyzeOntologyReadiness"]
  Recompute --> Slice
  Repair -->|缺真实外部值 · API路径或凭证| Ask["ask_user 真挂起问你"]
  Ask --> Repair
  Design --> Codegen["codegen_agent"]
```

**要点**
- **A 类自洽缺口**（本体单边已声明的）→ `read_ontology` 里**确定性自动补**，很可能一次消掉一大批。
- **B/C 类执行绑定/引用缺口** → `revise_ontology` 环内修，每个补丁**校验真实实体**，坏的拒绝、绝不编造；真实外部值先 `ask_user`。
- `design_agent` 从"全或无"改成**按动作切片**：切片干净的动作照常生成，只挡真正受阻的。**"分析→禁止→继续→又禁止"的死循环从机制上消除。**

---

## 5. HITL 澄清 park 生命周期（Track 1 / 1-C · 已实景验证）

这是"ask_user 开了却不暂停"三个成因的修复后形态。下图即 2026-07-14 真实 LLM run 里抓到的帧序列。

```mermaid
sequenceDiagram
  autonumber
  actor U as 用户
  participant W as 前端 (transcript/dock)
  participant API as /v1/agent-factory
  participant MB as mailbox
  participant B as runBrain 大脑

  Note over B: 情形A — 大脑纯文本以问题收尾(没调 ask_user)
  B->>B: #ASK-PARK v2 合成澄清挂起<br/>ctx.awaitingClarify=true
  B-->>W: emit {t:"clarify", awaitingAnswer:true}
  W-->>U: 澄清卡「❓大脑在问你」+ 交互坞高亮

  Note over B: 情形B — 大脑显式调 ask_user(question+options)
  B->>B: ask_user → awaitingClarify=true + emit clarify(true)

  Note over B,MB: 下一轮命中 clarify 门 → PARK<br/>轮询 mailbox，不烧 LLM 轮次
  U->>W: 点选项 / 自由回答
  W->>API: POST /agent-factory/inject {conversation, text}
  API->>MB: pushHumanMessage(...)
  B->>MB: drainHumanMessages() 取到答复
  B->>B: 登记人工决策 + 写记忆 + awaitingClarify=false
  B-->>W: emit {t:"clarify", awaitingAnswer:false}  (清除帧 · Track 1-C)
  W->>W: toBlocks/deriveBrainFlow 把卡片翻成「已回答」<br/>横幅/琥珀点清除
  B-->>W: {t:"message} "✅ 收到你的回答：…"
  B->>B: 注入答案到上下文，继续推进
```

**三个成因都修了**
- **纯文本提问不 park** → 合成真 park（`AUTO_PARK_MAX` 上限防死挂）。
- **同轮 ask_user + finish 抢跑** → 互斥门，两种排列都拦住 finish/sandbox。
- **跨会话 dedup 回放 / 记忆越会话泄漏** → 记忆改 `role:system` 背景注入、不预填 askedQuestions，ask_user 真正暂停。
- **清除帧**（`awaitingAnswer:false`）→ 前端把"等你回答"翻成"已回答"，不再永久常亮。

---

## 6. 递归子智能体组（Track 3）

一个内部 agent 推理后可决定**开一组分工子脑**，每个各自独立推理（一整轮 `runBrain`），结果回灌；整棵树共享一个预算账本。

```mermaid
sequenceDiagram
  autonumber
  participant B as 父大脑
  participant G as spawn_subagent_group
  participant L as BudgetLedger (共享)
  participant M1 as 成员子脑1
  participant M2 as 成员子脑2
  participant DS as design_subagent

  B->>G: spawn_subagent_group{mode, members[], parent_action?}
  G->>L: chargeSpawn(N) 记入树级上限 (超限则拒绝)
  G->>M1: runSubBrain (并发限流, isSubAgent, depth+1, 同一 L)
  G->>M2: runSubBrain (…)
  Note over M1,M2: 每个成员=一整轮 runBrain<br/>可再 spawn_group (共享树深 < MAX=2)
  M1-->>G: 结论 (research) / JSON 设计提案 (build)
  M2-->>G: 结论 / 设计提案

  alt mode = research
    G->>G: reduceGroup 归并成一份结构化结论 (quorum 降级)
    G-->>B: {merged, members[]}
  else mode = build (需 parent_action)
    loop 串行 (无 ctx.specs 竞争)
      G->>DS: design_subagent(parent_action, 提案)
      DS-->>G: ok / 被校验拒绝(TS/安全/绑定)
    end
    G-->>B: 落地 k/N 个子 agent + 父 plan 串上 invoke
  end
```

```mermaid
graph TD
  Root["父大脑 depth0"] --> S1["spawn_subagent_group"]
  S1 --> A["成员子脑 甲 depth1"]
  S1 --> Bm["成员子脑 乙 depth1"]
  S1 --> C["成员子脑 丙 depth1"]
  A --> A1["甲可再 spawn_group<br/>depth2 (到 MAX 转只读)"]
  Ledger["共享 BudgetLedger<br/>maxSpawns / maxTokens"] -.约束.-> S1
  Ledger -.约束.-> A1
```

**要点**
- **共享预算账本** `BudgetLedger`：全树 token + spawn 计数统一上限，防"并行×递归"成本爆炸（**必须先于递归落地**）。
- **research**：只读调研组 → `reduceGroup` 归并（存活成员 quorum 降级）。
- **build**：每成员产出**隔离**设计提案 → **串行**调真实 `design_subagent` 逐个落地（每个过 TS/安全/绑定校验，坏提案被拒不污染）→ 父→子 invoke 工作流。串行=无共享 ctx 竞争。

---

## 7. 系统 B · 运行时：生成好的 agent 怎么被"真跑"

声明式清单 agent → `registerAgent` → **每 (租户, agent) 一个 Inngest 函数**，事件触发，串成事件链。

```mermaid
sequenceDiagram
  autonumber
  participant EV as 入口事件<br/>(POST /v1/events → inngest.send)
  participant IG as Inngest
  participant Fn as Agent 函数<br/>id = tenantSlug.agentName
  participant SE as step-engine
  participant GW as LLM Gateway
  participant Tools as globalToolRegistry / 租户工具 / MCP
  participant DB as runs/steps/events + 日志

  EV->>IG: 事件 tenantSlug/eventName {subject, ...}
  IG->>Fn: 触发 (并发键=event.data.subject, retries=清单值/3)
  Fn->>DB: 插 runs(status=running) + steps 行
  loop 每个 action step (plan)
    Fn->>SE: step.run("action", runAction()) — durable
    alt logic + tool_use[]
      SE->>GW: 调模型 (发 tool_use 块)
      GW-->>SE: tool_use 请求
      SE->>Tools: 解析(租户覆盖??全局??MCP) 并执行
      Tools-->>SE: tool_result 回灌
      SE->>GW: 循环直到出文本
    end
    SE-->>Fn: 动作产出
  end
  Fn->>Fn: selectEmittedEvents(triggered_event)
  Fn->>DB: 插 outbound events 行 + 追加事件账本
  Fn->>IG: step.sendEvent(下游事件) — 唯一幂等出边
  Fn->>DB: 更新 run(status=ok, emitted_event_id)
  Note over IG,Fn: 下游 agent 被该事件触发 → 事件链继续
```

**durability 纪律（关键）**
- 每个 DB 写必须在 `step.run("name", ...)` 里 → Inngest 重放时**恰好一行**。
- `step.sendEvent` 是**唯一**幂等出边，绝不在 step 体里 `inngest.send`。
- HITL：`step.run` 建 `tasks` 行 → `step.waitForEvent("task.resolved", if: taskId==...)`。
- 另有**代码定义 agent**（`packages/agents` 的 `BaseAgent` 子类）走同一 `runs`/`steps` 表与 SSE。

---

## 8. 一个工厂 run 的状态机

```mermaid
stateDiagram-v2
  [*] --> Running: startRun
  Running --> Parked: ask_user / auto-park / 边界 / 测试用例门
  Parked --> Running: inject 答复 (清除帧)
  Parked --> Suspended: park 超时约 180s，不自动替你拍板
  Suspended --> Running: 下条消息即续跑
  Running --> Delivered: finish 过验收门，有真实沙箱回执
  Running --> Incomplete: 诚实收尾，跑不通就说清楚
  Running --> Errored: 网关过载或异常，已生成内容保留
  Running --> Running: 崩溃重启 → 从最近 checkpoint 续跑
  Delivered --> [*]
  Incomplete --> [*]
  Errored --> [*]
```

- **park ≠ 结束**：挂起等你，不会拿"AI 初判"替你自动生效（尤其涉及真实部署/授权）。
- **崩溃可续**：每轮 checkpoint（`tsx watch` 重启/进程死都能从最近完成轮续跑）。
- **诚实收尾**：跑不通不硬凑，`analyze_failure` 说清是数据/环境/本体限制。

---

## 9. 持久化与数据面

```mermaid
graph LR
  subgraph Durable["持久层"]
    SQL[("SQLite WAL<br/>data/agentic.db")]
    Conv["factory_conversations<br/>大脑消息+ctx 每轮 checkpoint"]
    Mem["factory_human_memories<br/>人工确认记忆 (域级)"]
    Refl["factory_reflections<br/>AI 反思/教训"]
    RunsT["runs / steps / events<br/>两系统共用"]
    Sandbox["factory_sandbox_attempts<br/>沙箱生命周期账本 (fail-closed)"]
  end
  subgraph Stream["流 / 文件"]
    SSE["GET /stream?run= (SSE)<br/>BrainEvent 实时 + 断线回放"]
    NDJSON["data/logs/&lt;tenant&gt;/…<br/>run 日志 + 事件账本"]
    MBFile["mailbox 文件<br/>HITL 人工消息投递(durable)"]
  end
  Brain2["runBrain"] --> Conv
  Brain2 --> Mem
  Brain2 --> Refl
  Brain2 --> SSE
  Brain2 --> NDJSON
  Runtime2["step-engine"] --> RunsT
  Runtime2 --> NDJSON
  API2["/v1"] <--> MBFile
  Sandbox -.生命周期闸门.-> Runtime2
  SQL --- Conv & Mem & Refl & RunsT & Sandbox
```

---

## 10. 一页速查：核心组件 → 文件

| 层 | 组件 | 文件 |
|---|---|---|
| 生成大脑 | ReAct 主循环 / 门 / park | `packages/agent-factory/src/conductor.ts` |
| 生成大脑 | 40+ 工厂工具 | `packages/agent-factory/src/tools.ts` |
| 本体闸门 | 可执行性分析 | `packages/agent-factory/src/ontology-readiness.ts` |
| 本体修复 | 自洽规范化 + 补丁 + 切片 | `packages/agent-factory/src/ontology-normalize.ts` |
| 认知专家 | 四维分治深读 (LIGHT 嵌套) | `packages/agent-factory/src/specialists.ts` |
| 意图/预算 | 意图门 / 共享账本类型 | `specialists.ts` · `brain-types.ts` |
| 驱动/流 | detached 驱动 + SSE + mailbox | `apps/api/src/services/agent-factory/{run-registry,mailbox}.ts` |
| 路由 | /v1 端点 + RBAC | `apps/api/src/routes/v1/agent-factory.ts` |
| 运行时 | 清单→Inngest 函数 | `packages/runtime/src/register.ts` |
| 运行时 | step 内动作 + 工具循环 | `packages/runtime/src/step-engine.ts` |
| 代码 agent | BaseAgent 子类 | `packages/agents/src/*` |
| 工具库 | 全局工具注册表 | `packages/tools/src/registry.ts` |
| 网关 | LLM 多 provider 单例 | `packages/llm-gateway` |
| 前端 | 事件→区块投影 | `apps/web/app/portal/[tenant]/(views)/factory/model.ts` |

---

*生成于 2026-07-14。图对齐当时的真实代码；若架构演进，以代码为准。*
