# grok-build harness 深剖 × 我们的 harness × Agent 工厂强化路线

**日期**: 2026-07-17
**输入**: xAI 开源的 `grok-build`(Apache-2.0,~84 万行 Rust,Grok 4.5 背后的 coding agent harness)源码逐 crate 精读(agent 循环 / 工具 / 工作区-沙箱-checkpoint / 上下文-记忆-子代理 / 可扩展性)+ 官方 user-guide;对照本仓库 Agentic Operator 的 harness(step-engine / register / 沙箱三层 / 工厂大脑)与已完成的架构缺陷审计。
**目的**: 逐维对照两套 harness,并据 grok-build + 其它新技术给出**强化 Agent 工厂**的可落地路线(每条关联到我们已确认的审计缺陷)。

---

## 0. 一句话定位差异(别拿错参照系)

| | grok-build | 我们的 Agentic Operator |
|---|---|---|
| 本质 | **单个通用 coding agent**(TUI/headless/ACP 三面),人机协作改一个代码库 | **Agent 工厂**:一个 LLM 大脑**设计、测试、晋升出一批领域 agent**(产品),再让这些 agent 在 Inngest 上跑生产业务 |
| harness 服务对象 | 人类开发者的交互式编码回合 | (a) 工厂大脑自身的生成回合;(b) 生成出的 manifest/CodeAct agent 的**生产运行时** |
| 信任模型 | 改用户自己的机器/仓库,OS 沙箱兜底 | 多租户、领域本体驱动、fail-closed 证据链、沙箱证据决定可晋升 |
| 语言/形态 | Rust,本地优先 CLI | TS monorepo,Fastify API + Next 门户 + Inngest |

**结论先行**:grok-build 是"把**单 agent 交互回合**打磨到极致"的工程范本;我们是"把**多 agent 生产工厂**的证据链/治理打磨到极致"。两者可互补——它的**回合级韧性、OS 沙箱、事务性 checkpoint、mid-turn steering、编辑保真**能直接补我们工厂的短板;我们的**难度分层模型路由、本体接地、证据指纹、晋升治理**是它没有的。下面逐维拆。

---

## 1. grok-build harness 深度剖析(源码级)

### 1.1 Agent 主循环(`xai-grok-shell/.../turn.rs`)
三层嵌套循环:`handle_prompt`(外层目标循环,模型早停就注入续跑指令)→ `process_conversation_turn_with_recovery`(完成度自动补救,指数退避)→ `process_conversation_turn`(真正的 agentic loop:build_request → `run_turn_via_sampler` → tool_calls 空则收尾、非空则 `execute_tool_calls` 后继续)。
- **流式是生产者/消费者分离**:sampler actor 把 delta 推到共享 channel,专门的 `spawn_local` drainer 发 UI chunk;控制循环只消费**组装好的完整响应**;有 5s "stream-drain barrier" 保证事件顺序后才派发工具。
- **partial tool call 组装**在 L2 transform 里(按 delta index 累积参数片段),循环只见完整工具调用。

**novel 点**(超出普通 tool-use loop):
1. **服务端引导的 doom-loop 重采样**(`doom_loop.rs`):xAI 后端发非标 SSE `response.doom_loop_check`(如 `tail_repetition:8@thinking`、`low_logprob@response`),武装后**中途弃流**、在独立 doom 预算上重采,逃出重复/低概率死循环。
2. **mid-turn steering 一等原语**:用户 interjection 作为**独立合成用户轮次**注入循环迭代之间;还能中断阻塞型 wait 工具;排队行可原子提升为 interjection。
3. **send-now 抢占**:一个新 prompt 可 Ctrl+C-parity 地取消在飞回合,但**放过**后台任务/子代理/队列。
4. **投机式两遍压缩预热**(`compaction.rs`):距硬压缩阈值 ~10% 时,后台先把 ~95% 前缀预摘要成 NOTE₁ 缓存,把压缩延迟藏进有效回合背后。
5. **StructuredOutput 合成工具**:对不支持原生 schema 约束的后端,注入假 `StructuredOutput` 工具,循环拦截并对 JSON schema 校验,给模型最多 3 次纠正重试,**从不真执行**它。
6. **TodoGate 收尾门**:模型想在有未完成 todo 时结束回合,会被 nudge 继续。
7. **结构化取消级联**:`AbortHandle` + `CancelOnDrop` + 三个 RAII scope guard,任何退出路径(abort/panic/error)都能把 sampler 请求、子代理、前台进程、turn-active 标志全部 unwind。
8. **回合级韧性**:per-incident 401 退避(修过一个 11.6 天误睡的 bug)、HTTP/1.1 client-rebuild 重试(逃被毒化的 H2 池)、`RetryWithImageStrip`(疑似 413 时剥图重试)、空响应当瞬时错误重试。

**注意**:grok-build **没有** fast/heavy 模型路由(`tier.rs` 只是订阅门控;只有 per-purpose 辅助模型 + `reasoning_effort` 低/高)。整个 agentic loop 用同一 session 模型。

### 1.2 工具系统与编辑模型(`xai-grok-tools`,移植了 openai/codex + sst/opencode)
- **两 trait 拆分**:`Tool`(运行时契约,`run`/`execute` 双入口,`[Progress*, Terminal]` 流不变量,不装箱的 RPITIT future)+ `ToolMetadata`(grok 特有,`kind`/`namespace`/描述模板)。schema 用 `#[derive(JsonSchema)]` 自动生成,**宽松反序列化**(容忍数字字符串/浮点当整数,防模型 JSON 漂移)。
- **四种编辑范式共存**:`search_replace`(Anthropic 式 old/new,编辑时**重读活文件** + CRLF 归一 + **Unicode-confusable 归一回退**含 roundtrip 校验 + 失败给"最近匹配 line N"提示)、`apply_patch`(codex 结构化 envelope diff,**4 级模糊 seek_sequence**,**原子多文件**——全 hunk 能应用才写)、**`hashline_edit`(原创 novel)**:锚点 `LINE:LOCAL[:CONTEXT]`,LOCAL 是**空白归一的 FNV 行哈希**(抗重缩进),CONTEXT 是新鲜度指纹,stale 时 ±15 行搜索 shifted anchor 自动漂移恢复。
- **`xai-hunk-tracker`(novel)**:actor 式、**git 无关**的逐编辑追踪,每改一处成 `Hunk` 带 **agent-vs-user 归因**(`AgentEdit{prompt_index}` vs `ExternalEditOnAgentFile`),支持 Accept/Reject 基线推进,跨会话快照带 worktree 路径重写。
- **终端工具**:持久 shell 会话,~100ms 输出流式 coalesce,20KB 上限 + 2000 字符软换行,**auto-background-on-timeout**(超前台预算的命令**转后台而非杀掉**),PID 上浮,可 isolation-wrapped(unshare/mount)。
- **安全信号**:`CanonicalToolMeta`(`x.ai/tool` envelope,带 `read_only` 机器可读安全位,发布 JSON schema),harness 据此 gate 审批;crate 本身**策略无关**(权限在 harness 层)。**需求表达式**(`Expr<ToolRequirement>`)在配置校验期做工具间依赖检查。
- **结果规整**:两种截断哲学(grep 丢弃 vs bash 保留软换行);**MCP 输出溢出到盘 + 按格式(jq/grep)引导模型查**,不是简单截断。

### 1.3 工作区 / 沙箱 / Checkpoint(`xai-grok-workspace` / `xai-grok-sandbox` / `xai-fast-worktree`)
- **事务性多域 checkpoint(核心特性)**:每个用户 prompt 一个 checkpoint,捆绑三独立域——**FS 内容快照**(改前 before + 改后 after,首写优先,整文件内容)、**hunk delta**、**git HEAD/index**(软恢复:stash-or-abort → `git reset --soft`,**从不 --hard、保留回合内 commit**)。restore 有序事务化(先 git 软恢复→FS 回滚→冲突检测 Deleted/Created/ModifiedExternally→成功才截断),失败保留重试数据。落盘 `rewind_points.jsonl`(流式、有界内存)+ crash-safe 镜像(temp→fsync→rename→dir fsync)。用户 `/rewind` 或 Esc-Esc 回到任一 prompt,**恢复文件 + 截断对话**。
- **OS 内核沙箱**(`nono`→**Landlock/Seatbelt**):**整进程启动时施加、不可逆**,覆盖 in-process fs + 所有子进程(bash/rg/子代理),非 per-command 包裹、非 VM。profiles(off/workspace/devbox/read-only/strict)+ 自定义 `deny` 列表(**核级读写拒绝**,macOS Seatbelt runtime regex airtight + `/private` firmlink 别名闭合 + 关 `mv secret x && cat x` 旁路;Linux 缺 bubblewrap/过宽 glob → **拒绝启动**);**per-child seccomp 网络封锁**(EPERM connect/bind/...)。自定义 profile 应用失败 → `exit(1)` 不裸奔。
- **快速 worktree 隔离**(`xai-fast-worktree`):子代理/fork 各自 git worktree,`--no-checkout` + **并行 CoW 克隆** + **BTRFS O(1) 快照** + overlayfs + 池化预建;scratch-index snapshot-to-ref 干净 apply-back。
- **网络-FS 感知 SQLite journaling**(`xai-sqlite-journal`):按 statfs 魔数检测 NFS/CIFS/CephFS/FUSE,切 WAL→TRUNCATE + per-host DB 文件名,避开共享 home 的 WAL `-shm` SIGBUS。
- **PTY 控制器**(`ptyctl`):headless PTY + alacritty,screen 可读成 text/styled/**HTML**,HTTP+WS API 驱动交互式 TUI 程序。

### 1.4 上下文 / 记忆 / 子代理(源码级)
- **会话即真源**:`updates.jsonl`(append-only JSONL,ACP 更新流)是权威对话日志;`chat_history.jsonl` 原始消息;**SQLite FTS5 只做标题/prompt 搜索索引**(不是真源)。
- **两级上下文收缩**(标杆):
  - **(a) 每回合非-LLM 剪枝(>50% 触发)**:`prune_conversation` 只重写**又老又大的工具结果**(极老→占位符,中老→头尾软裁),近 N 回合不动;内嵌图片带滞回驱逐(47MB 触发→回收到 25MB);在请求副本上做、**KV-cache 感知**(只在必要时改)。
  - **(b) LLM 压缩(85% 触发,可配)**:**结构化重建非截断** —— Claude-Code 式**9 段结构摘要**(Primary Request/Key Concepts/Files/Errors/Problem Solving/All User Messages/Pending Tasks/Current Work/Next Step 含逐字续接点);重排为 `[System, user_info, AGENTS.md 逐字重注, 最后真用户轮, 近消息, 摘要]`(近消息**在摘要前**);质量门(<500 字符判退化)+ 重试阶梯 + 供应商无关的历史修复(每个 ToolResult 必有前置 tool_call id,补/删/去重孤儿)。
  - **可恢复性 `CompactionMode`**:`Summary`(有损)/ `Transcript`(摘要 + 指向原始 `updates.jsonl` 的指针)/ `Segments`(摘要 + `compaction/` 逐段 markdown,模型可 read/grep 取回压缩前精确细节)。
  - **投机式两遍预热**:距 85% 还差 ~10% 时后台先把 95% 前缀摘成 `NOTE₁` 缓存(前缀变则指纹失效),pass-2 = `NOTE₁ + 近尾` → 终摘,隐藏延迟。**压缩前先 flush 到记忆库**(embedding 相似度去重);压缩后把 todos/edited paths/在跑子代理/MCP 作 `<system-reminder>` 重注。
- **两级记忆**(`xai-grok-memory`,标杆):**真检索引擎 + 常驻规则并存**。
  - 后端 **SQLite + FTS5(BM25)+ sqlite-vec 向量 KNN**,per-workspace `index.sqlite`;存的是 markdown 分块的 `MEMORY.md`(全局/工作区/会话),**不是原始转录**。
  - 召回 = **混合排序 + 衰减**:归一 BM25 + cosine(默认向量 0.7 / 文本 0.3)+ 时间衰减(会话块 7 天半衰期,全局常青)+ 来源权重 + 访问频次加成 + 可选 **MMR** 多样化,`min_score 0.35`,取 top 6。embedding 默认 `None` → 开箱是 FTS 关键词,向量是可选升级。
  - **"dream" = LLM 固化/反思**:门控后台把散落会话日志合并去重进 `MEMORY.md`,解矛盾、弃 ephemeral(门:开启 + ≥4h + ≥3 会话)。
  - 3 路注入(都作 `<system-reminder>`):`memory_search`/`memory_get` 工具 + 首轮自动注入 + 压缩后重搜。**外加**经典**分层 AGENTS.md/CLAUDE.md**(root→cwd 全量常驻、深覆浅、压缩逐字重注)——两级设计:**笨可靠规则 + 智能检索记忆**。
- **子代理**(`xai-grok-subagent-resolution`):LLM 可调 `task`(默认后台并行、depth 上限 1)。**三层组合**:agent-type(`.md`+YAML,body 即 system prompt,读 `.grok`/`.claude/agents`)> role(TOML 预设)> persona(**带类型化 inputs/outputs 可链式**,一个输出喂下一个)。可 **resume 子代理**、**worktree 隔离**(snapshot/rehydrate)、capability 模式过滤工具集(read-only/read-write/execute/all)、fork-context 归一(父对话→last 3 轮逐字 + 更早摘要)。
- **codebase 符号图**(`xai-codebase-graph`,**重要反面警示**):tree-sitter def/ref/import 图,但**scope 解析在生产里休眠**(退化成 ctags 式名字倒排,go-to-def 返回所有同名);且**只经 ACP 暴露给 grok-web 编辑器,不喂 LLM**——模型自己的代码接地靠 **grep/read + LSP**,不是这个图。工程亮点在性能(string interner/增量 actor/版本化缓存),不在给模型的语义接地。
- **skills 渐进披露**:只有 name+desc(≤400 字节/条)进上下文,预算封顶到窗口 50%、3 级降级(全→简→仅名),body **调用时才载**,`paths:` 条件门控,Read/Edit 后动态发现增量宣告;`<system-reminder>` 注入、**系统提示从不为 skill 变更**。Anthropic Agent Skills 超集 + Claude/Cursor 互通。
- **Plan Mode**:只读(除 `plan.md`)→ `enter_plan_mode`(需批准)→ 探索 → 写 plan → `exit_plan_mode` → 人审(**行内评论**/请求修改/批准)→ 才实现;四态机持久化过重启。
- **一处弱点(对我们是机会)**:token 计量是**粗糙的 bytes/4 估计**(无真 tokenizer),图片按 765/张;各压缩/预算门都建在这个估计上。

### 1.5 可扩展性(源码级)
**整体是 Claude Code 的兼容超集**(直接读 `.claude/settings.json`/`~/.claude/skills`/marketplaces),向三个方向扩展、仅一处更窄:
- **MCP**:`rmcp` 薄封装,四传输(Stdio/StreamableHttp/SSE 派生/ACP 反向)。**渐进式发现**:不把所有 MCP 工具塞系统提示,给模型 `search_tool`(按名/描述发现)+ `use_tool`(全限定名调用),工具 spec 落盘供模型读;命名用 `server__tool`(非 Claude 的 `mcp__`,仅留 compat shim)。OAuth(DCR/PKCE)+ 跨进程去重避免多开浏览器。**半双工**:无 sampling/roots/elicitation——MCP server 不能回调 agent 的 LLM。
- **Hooks**(`xai-grok-hooks`):14 生命周期事件(仅 **PreToolUse 阻塞**),command + **HTTP hook(SSRF 加固)**,读 Claude/Cursor 的 hook 载荷。**关键局限:deny-only**——决策面只有 `Allow | Deny{reason}`,**无 `additionalContext`/`updatedInput`/`hookSpecificOutput`/上下文注入/工具 I/O 改写**;非阻塞 hook 的 stdout 不回喂模型。**这一处比 Claude Code hooks 弱**。fail-open(超时/崩溃不阻塞),顺序执行首个 Deny 短路。
- **Plugins + marketplace**:一个插件贡献 **6 类组件**——skills/commands/agents(子代理)/mcp_servers/hooks/**lsp_servers(一等 LSP,Claude 没有)**;组件可内联 JSON 或文件;marketplace = git repo,**CI 生成的 plugin-index.json SHA-钉到 commit**(漂移即隐藏组件);**两级信任门**(enable 载入非执行组件 / trust 才允许 hooks/MCP/LSP 执行,project-scope 需显式授信);**prompt 关键词 CTA**(按你在打的 prompt 文本匹配插件 keywords 提示安装)。
- **ACP**(`xai-acp-lib`,**Claude Code 没有的面**):`impl acp::Agent`,stdio + WebSocket serve + WS relay 三传输;把 fs/terminal/permission **委托给编辑器 UI**;`x.ai/*` 私有扩展命名空间(fs/git/worktree/search/session fork-rewind-compact/memory/mcp)。Zed/Neovim/Emacs/marimo 客户端。
- **权限系统**(独立于沙箱):**按严重度而非顺序/来源判定 `deny > ask > allow`**(全局 deny 不可被项目 allow 覆盖),规则 `Bash(git commit:*)`/`Read(src/**)`/`MCPTool(server__*)`;默认 **Deny**(按 CWE-1188 从 Allow 翻转);模式 default/dontAsk/bypassPermissions/acceptEdits/plan。**folder-trust**(VS-Code 式,repo-local 自动 spawn 命令 = 1-click RCE,故一次性授信门控)。
- **企业治理(标杆)**:六层配置精度,`requirements.toml` **outrank CLI**(admin-lock);**Ed25519 签名策略信封**(编译期公钥 + 对 managed/requirements.toml **逐字节篡改检测**)+ **macOS MDM forced-prefs**(`$VAR` 故意不展开防用户经 env 影响策略)+ campaigns overlay(不能覆盖 admin 字段)。远超 Claude Code 的单一 managed-settings.json。
- **Headless**:`--output-format` plain/json/streaming-json;**cost 用整数 ticks**(1 USD=10¹⁰)供账单对账,任一调用缺 cost 则不报假美元;`--best-of-n`/`--check` 自验/`--tools` 白名单/`--worktree`。

---

## 2. 我们的 harness 深度剖析(对应维度)

> 详见本仓库既有映射与审计(记忆:factory-architecture-defect-audit;docs 缺陷登记表)。这里按同样五维压缩对照。

- **Agent 主循环**:生成侧是 Conductor 生成器(意图门→策略路由→逐轮 streamTurn→守卫链+stageAdmission 派发工具);运行时侧是 `step-engine.ts` 的 LLM 工具循环(foldOldToolResults/ACI 窗 → gateway.chat → 工具解析 tenant→global→MCP → 沙箱决策阶梯 → tool_result 反馈,maxIters)+ `register.ts` 动作循环(每步 `step.run` 保证跨 Inngest 重放恰好一次)。**我们有 grok 没有的**:难度分层模型路由(fast/default/hard/review + 异构评审链)、推理内核真执行(cot/reflection/debate/tot)、多智能体舰队(design_fleet/review_fleet 并行→串行落地)。**我们缺 grok 有的**:doom-loop 重采样、mid-turn steering(我们靠 mailbox 停车而非注入在飞回合)、投机压缩预热、结构化取消级联的完备性、回合级 401/网络韧性打磨。
- **工具与编辑**:全局注册表 + 租户原生 + 声明式 + MCP;`defineTool` 描述符 + capabilities/集成绑定门。**但我们的"编辑"是生成 agent 代码/写业务数据,不是改用户代码库**——所以 grok 的 search_replace/apply_patch/hashline 编辑保真、hunk-tracker 归因**主要适用于工厂自身修改代码/草稿的场景**(见强化建议 §4.5)。
- **工作区/沙箱/checkpoint**:沙箱三层(worker 进程内 / process env-scrub / container `--network none`)+ CodeAct onRpc + 卡带回放 + 证据指纹/回执。**审计已确认缺陷**:worker 层继承宿主 env、无 OS 级 FS/网络封锁(V-2 纵深隐患);无文件级 rewind/checkpoint(草稿靠不可变版本,但没有"回到任一回合"的事务回滚);转录**把整个事件缓冲反复同步写进单个 SQLite 行**(F-03/F-04 写放大 + 事件循环停顿)。
- **上下文/记忆/子代理**:ACI 窗折叠 + 上下文预算 + 会话 checkpoint(factory_conversations)+ Mem0 记忆固化 + 技能归纳 + spawn_subagent(depth≤2)。**审计缺陷**:持久化的 fold 删结构帧留 think delta(F-15);记忆/技能投毒面(F-17/F-18);policy-stats 无锁丢更新(F-05)。
- **可扩展性**:MCP、skills(AWM 归纳)、租户包、集成档。无 hooks 生命周期、无 plan-mode 只读强制、无 ACP。

---

## 3. 逐维对照(谁强在哪)

| 维度 | grok-build 强项 | 我们强项 | 差距/机会 |
|---|---|---|---|
| Agent 循环韧性 | doom-loop 重采样、mid-turn steering、投机压缩、结构化取消、401/网络韧性 | 难度分层模型路由、推理内核真执行、多智能体舰队、Inngest 持久重放 | **补韧性**:steering、压缩预热、取消级联、doom-loop 检测 |
| 编辑保真 | 4 编辑范式 + Unicode-confusable + hashline 抗重缩进 + hunk 归因 | 契约优先 codegen + 3 门(编译/lint/探针)+ 执行归属 | 工厂改自身代码/草稿时**引入 apply_patch/hunk-tracker** |
| 沙箱 | **OS 内核沙箱**(Landlock/Seatbelt)整进程不可逆 + seccomp 网络 + deny 列表 | CodeAct 容器 `--network none` + 证据回执 + 卡带回放 | **worker/process 层加 OS 沙箱**(治 V-2) |
| Checkpoint | **事务性多域 rewind**(FS+hunk+git,有序+冲突检测+crash-safe) | 不可变版本化草稿 + 沙箱证据指纹 | 工厂草稿/生成过程加**文件级事务 checkpoint** |
| 持久化 | **JSONL 为真源 + SQLite 仅 FTS 索引** + 网络-FS 感知 journaling | SQLite 全量(runs/steps/转录)+ NDJSON 日志 | **转录改 append-only JSONL**(治 F-03/F-04 写放大) |
| 上下文 | 投机式两遍压缩预热 + plan-mode 保留 | ACI 窗 + 上下文预算 + 会话 checkpoint | 压缩预热;结构帧保留(治 F-15) |
| 子代理/隔离 | 快速 worktree(CoW/BTRFS/overlay/池化)+ apply-back | 沙箱 -sb 租户 + design_fleet 并行 | 并行舰队/子代理加 **worktree 隔离** |
| 规划门 | **Plan Mode**(只读强制 + 计划行内评审 + 四态机) | plan/critique_plan 门 + 本体接地 | plan 门加**只读强制 + 计划行内评审 UI** |
| 可扩展 | hooks 生命周期 + plugins/marketplace + ACP + 独立权限系统 | MCP + skills + 租户包 + 集成档 | 加 **hooks 生命周期 + 独立权限层** |
| 安全信号 | `read_only` 机器位 + 需求表达式 + deny 核级 | 集成绑定门 + probe 证据 + fail-closed | 工具 `read_only` 位驱动统一审批 |

---

## 4. 强化 Agent 工厂的路线(据 grok-build + 其它新技术)

> 每条:**借鉴点 → 我们现状 → 落地 → 关联审计缺陷/收益**。按"性价比 × 治痛点"排序。

### P0-A · 转录/事件持久化改「append-only JSONL 为真源 + SQLite 仅索引」
- **借鉴**:grok-build `updates.jsonl` append-only 是真源,SQLite FTS5 只做搜索;`xai-sqlite-journal` 按 statfs 切 WAL→TRUNCATE 避 SIGBUS。
- **现状**:我们 `run-registry.ts` 每 5s + 每 budget 帧把**整个事件缓冲(含每个 think token)`JSON.stringify` 重写进单个 SQLite 行**——审计确认的 **F-03/F-04**(写放大 + 事件循环停顿 + budget 路径 fail-stop)。
- **落地**:事件流改**增量 append 到 per-run NDJSON**(自上次以来的新事件),SQLite 只存运行元数据 + 一个可选 FTS 索引;think delta 不进 durable 转录、结构帧无条件保留(顺带治 **F-15**)。UI 重连从 NDJSON 尾部拉。
- **收益**:直接消除我们审计里两条 P1 写放大缺陷,且是 grok 已验证的成熟形态。

### P0-B · 沙箱三层加「OS 内核沙箱」兜底(Landlock/Seatbelt)
- **借鉴**:grok 用 `nono`(Landlock/Seatbelt)**整进程不可逆**施加 FS 读写 + 子进程网络(seccomp)封锁,deny 列表核级强制、失败拒启动。
- **现状**:我们 worker 层继承宿主 `process.env`、无 OS 级 FS/网络封锁(审计 **V-2**:虽终裁"模板无自由代码槽不可直接外泄",但仍是纵深隐患;process 层只 env-scrub、container 层才 `--network none`)。
- **落地**:给 FunctionTester 的 **worker/process 执行层包一层 OS 沙箱**——macOS Seatbelt profile / Linux Landlock+seccomp,限制 FS 写到沙箱数据根、封子进程网络、`deny` 列表护 `.env`/凭证。Node 侧可用 `sandbox-exec`(macOS)/ bubblewrap(Linux)包裹 worker 进程,或引 FFI。生产 CodeAct 已有容器,这条主要补**非容器执行层的默认安全**。
- **收益**:把"worker 非安全边界"从纵深隐患升级为核级强制,`FACTORY_EXEC_TIER` 未钉 container 时也安全。

### P0-C · 工厂生成过程加「事务性文件级 checkpoint + rewind」
- **借鉴**:grok 每 prompt 一个多域 checkpoint(FS 内容+hunk+git 软),有序事务恢复 + 外部编辑冲突检测 + crash-safe 落盘,用户 `/rewind` 回任一回合。
- **现状**:我们草稿是不可变版本化 + 沙箱证据指纹,但**生成过程本身没有"回到某一设计回合并恢复文件/ctx"的事务回滚**;design_fleet/refine 失败只能整体重来或靠证据作废。
- **落地**:给工厂 run 的每个 stage/回合存**轻量 before/after 快照**(specs/ctx/生成代码/草稿文件),做 `rewind_to(stage)`——回滚 ctx + 已写草稿文件 + 截断转录,带外部改动冲突检测。与我们既有的"改动即作废证据"新鲜度机制天然契合。
- **收益**:生成失败/走偏可精确回退到某回合而非全推倒;也让 F-06(交付 save 竞态)有干净的回滚点。

### P1-D · 主循环加「mid-turn steering + 结构化取消级联 + doom-loop 检测」
- **借鉴**:interjection 作为独立用户轮次注入迭代间;`AbortHandle`+`CancelOnDrop`+RAII guard 全路径 unwind;后端 doom-loop 信号中途弃流重采。
- **现状**:我们靠 **mailbox 停车**做 HITL(park→poll→resume),但用户**无法 steer 在飞回合**(得等停车点);取消靠 `runs.status` 轮询 + `cancelOn`,不如 grok 的 RAII 级联完备;无重复/低概率死循环检测(审计里 alive-ping 修过"无响应"但那是不同问题)。
- **落地**:(1) 给 Conductor 加**在飞回合注入**通道(mailbox 消息若标 `[介入]` 则作为合成用户轮次插入下一迭代,而非只在停车点消费);(2) 工具/推理超时与取消走统一的结构化级联(确保子代理/沙箱/子进程全 unwind);(3) 加轻量**重复检测**(连续 N 轮同工具同参/同文本 → 打断并 reflect),复用我们已有的 dup-call breaker 扩展。
- **收益**:交互性与韧性对齐 grok;死循环/走偏更早止损。

### P1-E · 「两级上下文收缩」+ 结构帧保留的持久 fold
- **借鉴**:grok **两级收缩**——(a) >50% 非-LLM 剪枝(只重写又老又大的工具结果、KV-cache 感知)先降压;(b) 85% LLM **结构化 9 段摘要**(非截断)+ **投机两遍预热**(提前 10% 后台摘 95% 前缀缓存)+ **可恢复段落存盘**(压缩后模型能 read/grep 取回精确细节)+ 压缩前 flush 记忆 + 压缩后重注 live-state(todos/子代理/MCP)。
- **现状**:我们有 ACI 窗折叠 + 上下文预算,但压缩偏单级/同步;持久 fold 删结构帧只留 think delta(**F-15**);token 计量方式待确认。
- **落地**:(1) 加**廉价第一级**:接近预算时先重写老的大 tool_result(而非整体压缩);(2) 硬阈值前后台 `spawn` **预热摘要**;(3) 压缩用**结构化多段摘要 + 段落落盘**(模型可回查),而非有损单摘;(4) durable 转录用**类型感知 fold**(agent.created/plan/stage/sandbox 无条件留,只压 think/delta)。
- **收益**:长 run 压缩不卡回合、可回查;修 F-15 的 UI/复盘数据丢失。**注意**:grok 的 token 计量是 bytes/4 粗估——我们如已有更准的计量,别抄它这块。

### P1-K · 记忆改「混合检索 + 相关性门控注入 + 去重」(强化 Mem0 并降投毒面)
- **借鉴**:grok 两级记忆——真检索引擎(FTS5+向量,BM25+cosine、时间衰减、MMR、min_score 门、top-K)**只把 top-K 相关块注入**上下文(非整库),"dream" 固化带 **embedding 相似度去重**;外加常驻分层 AGENTS.md 规则。
- **现状**:我们有 Mem0 式固化 → `agent_memory_long`,但审计发现**记忆/技能投毒面**(**F-17** 技能归纳无溯源门、**F-18** 记忆固化缺 fullChainRan 门 + 可 DELETE)、且召回侧信任边界弱。
- **落地**:(1) 召回改**混合排序 + 相关性 min_score 门 + MMR 去冗**,只注入 top-K(降"整库回流"带来的注入面);(2) 固化写入前**embedding 去重 + 溯源标记**(human vs AI-induced),DELETE 改软删/墓碑 + 人审(直接补 F-17/F-18);(3) 保留一条**常驻、人手编辑的规则层**(类似我们的 CLAUDE.md/记忆 index)与"智能检索层"分离——笨可靠 + 智能并存。
- **收益**:召回更准 + 上下文更省;把记忆投毒从"整库随 run 回流"收敛到"门控 top-K + 去重 + 溯源",直接缩小 F-17/F-18 的爆炸面。

### P1-F · Plan 门加「只读强制 + 计划行内评审」
- **借鉴**:grok Plan Mode 只读(除 plan 文件)、计划行内评论、四态机持久化。
- **现状**:我们有 plan/critique_plan(本体接地 + 独立 AI 评审),但**没有对生成侧的"只读探索强制"**,也没有把计划交人做**行内评论**的 HITL(现在是 ask_user 自由文本)。
- **落地**:generation 前置一个可选 **plan 相**:design_agent 前只允许读本体/搜工具/写 plan,`exit_plan` 把计划(带 ontology 锚点)交前端**行内评审**(复用即将建的 blueprint panel),批准才进 design。
- **收益**:高歧义生成任务少返工;与我们正在建的 blueprint 可视化天然合流。

### P1-G · 并行舰队/子代理加「worktree 隔离」
- **借鉴**:子代理 `isolation: worktree`(CoW/BTRFS O(1) 快照)+ scratch-index apply-back。
- **现状**:design_fleet N 子脑并行**但共享 ctx**,靠串行落地守单写(审计 F-06 正是这条不变量被绕);sandbox 用 -sb 租户隔离但非文件级。
- **落地**:当子代理/舰队成员会写文件(生成代码/草稿)时,给每个成员**独立 worktree/临时目录**,完成后 apply-back(冲突检测),而非共享写。
- **收益**:并行写零冲突;去掉 F-06 竞态的根。

### P2-H · 编辑保真:工厂改自身代码/草稿引入「apply_patch + hunk-tracker」
- **借鉴**:codex apply_patch(原子多文件 + 4 级模糊)、hashline(抗重缩进)、hunk-tracker(agent-vs-user 归因 + accept/reject 基线)。
- **现状**:工厂生成/修改**生成 agent 代码**用契约优先 codegen;但当工厂(或我们的 CI agent)改**自身代码/草稿文件**时,没有 grok 级的编辑保真与归因。
- **落地**:凡涉及"改现有文件"的工厂工具(报告写盘、草稿 .ts 更新)引入 apply_patch 式原子 diff + 编辑后 re-read 校验;可选 hunk 追踪做人审。
- **收益**:减少静默编辑损坏;为"工厂自我进化/自修"打基础。

### P2-I · 工具统一「read_only 机器位 + 独立权限层(严重度判定)+ hooks 生命周期(做得比 grok 强)」
- **借鉴**:`CanonicalToolMeta.read_only` 机器位驱动审批;权限**按严重度判定 `deny>ask>allow`**(全局 deny 不可被项目 allow 覆盖)、默认 Deny;hooks 生命周期。
- **⚠️ 别照抄的**:grok 的 **hooks 是 deny-only**(无上下文注入/工具 I/O 改写)——这是它明确比 Claude Code 弱的一处。我们要做就做**强版**(PreToolUse 可 deny/**改写 input**,PostToolUse 可**注入上下文**),而非退回 deny-only。
- **现状**:我们有集成绑定门 + probe 证据 + fail-closed,但审批逻辑散在各门;无统一 hooks 生命周期。
- **落地**:(1) 每个工具描述符补 `read_only`/effect 机器位(部分已有 sideEffect/effectScope);(2) 抽**统一审批层**,按严重度 `deny>ask>allow` 判定、默认 Deny(读放行、写/外呼过门);(3) 暴露 PreToolUse/PostToolUse **可改写/注入的 hooks**(租户/域可注入策略,如"某域禁某工具""某工具入参必须带 X")。
- **收益**:审批一致、可审计、可租户定制,且比 grok 的 deny-only 更有表达力。

### P2-L · 多租户治理引入「签名策略 + 严重度权限 + folder-trust」
- **借鉴**:grok 企业治理——**Ed25519 签名策略信封**(编译期公钥 + 对 managed/requirements 配置**逐字节篡改检测**)、`requirements.toml` **outrank CLI** 的 admin-lock 层、macOS MDM forced-prefs、folder-trust(自动 spawn = 1-click RCE 故一次性授信)。
- **现状**:我们多租户有 tenant scoping + AUTH_MODE + 集成档确认,但**没有"平台管理员签名下发、客户端逐字节校验、不可被租户/env 覆盖"的策略锁**。
- **落地**:给平台级策略(允许的工具/模型/egress 白名单/晋升权限)加**签名信封 + 客户端验签**层,置于租户配置**之上**不可覆盖;工具/域执行策略走同样的"admin-lock outrank"精度。
- **收益**:多租户/私有化部署下,平台策略不可被单租户或本地 env 篡改——对企业交付是硬需求。

### P2-J · 其它新技术(非 grok-build)值得纳入
- **本地优先 / 可插拔推理端点**:grok 强调 `base_url` 可指内网端点——我们模型路由已对接 New-api 活目录,可进一步让**难度分层**支持完全离线/内网模型(强化数据主权)。
- **MCP 输出溢出到盘 + 引导查询**:大工具输出不塞上下文,落盘 + 让模型 jq/grep——直接可移植到我们的工具结果规整(补我们 carry-forward blob offload 的"引导查询"侧)。
- **网络-FS 感知的 DB 打开**:若我们 SQLite 部署到共享盘,借 `xai-sqlite-journal` 的 statfs 检测逻辑避 SIGBUS。

---

## 4bis. 什么**别**抄(避免误学)

- **别为"喂模型"建 codebase 符号图**:grok 的 `xai-codebase-graph` 看着强,但 scope 解析**生产里休眠**(退化名字倒排)、且**只给 grok-web 编辑器不喂 LLM**;模型接地它靠 grep/read + LSP。我们的**本体接地(ontology anchor)对模型是更强、更语义的接地**——继续走本体,别去建一个给模型看的 AST 图。
- **别抄它的 token 计量**:bytes/4 粗估无真 tokenizer;若我们有更准计量,保留自己的。
- **别把"通用编辑保真"当工厂主线**:grok 的四编辑范式/hashline 是为"人改一个代码库"打磨的;我们主线是**生成/晋升领域 agent**,编辑保真只在"工厂改自身代码/草稿"这个次要场景有用(P2-H),别喧宾夺主。
- **别丢掉我们比它强的东西**:难度分层模型路由、推理内核真执行(cot/debate/tot)、证据指纹/回执、晋升治理、本体驱动 fail-closed——这些 grok 没有,是我们的护城河,强化时别为对齐它而稀释。

## 5. 优先级小结

| 优先 | 条目 | 治的痛点 |
|---|---|---|
| **P0** | A 转录改 JSONL 真源 + SQLite 仅索引 | F-03/F-04 写放大(审计 P1×2) |
| **P0** | B worker/process 加 OS 沙箱(Landlock/Seatbelt) | V-2 沙箱纵深隐患 |
| **P0** | C 生成过程事务 checkpoint/rewind | 生成走偏无干净回退 + F-06 |
| **P1** | D mid-turn steering + 取消级联 + doom 检测 | 交互性 + 死循环止损 |
| **P1** | E 两级压缩 + 预热 + 结构帧保留 fold | 长 run 卡顿 + F-15 |
| **P1** | F Plan 门只读强制 + 行内评审 | 高歧义返工(合流 blueprint) |
| **P1** | G 舰队/子代理 worktree 隔离 | F-06 竞态根因 |
| **P1** | K 记忆混合检索 + 门控注入 + 去重溯源 | F-17/F-18 投毒面 + 召回质量 |
| **P2** | H apply_patch + hunk-tracker | 工厂自修编辑保真 |
| **P2** | I read_only 位 + 独立权限 + hooks | 审批一致性/可扩展 |
| **P2** | J MCP 溢出到盘 / 本地优先 / statfs journaling / 渐进披露 skills | 上下文卫生 / 数据主权 / 稳健性 |
| **P2** | L 签名策略 + 严重度权限 + folder-trust | 多租户/私有化平台策略不可篡改 |

**与当前在建工作的合流**:P0-A/E 直接消我们审计的写放大与 fold 缺陷;P1-F 与正在建的 **blueprint 可视化**(build_blueprint)天然合并成"计划相 + 行内评审";P0-C/G 强化 design_fleet 的隔离与回退。建议顺序:先 P0-A(最高性价比、消两条 P1 缺陷)→ P0-B → P1-F(合流 blueprint)→ 其余按痛点推进。

---

*方法:克隆 2026-07-17 的 `xai-org/grok-build` main,派 5 个并行研究 agent 直读源码 —— **五维全 file:line 级**(agent 循环 / 工具与编辑 / 工作区-沙箱-checkpoint / 上下文-记忆-子代理 / 可扩展性-MCP-hooks-plugins-ACP-治理),对照本仓库 harness 既有映射与已确认审计缺陷(缺陷编号见记忆 factory-architecture-defect-audit 与 docs 缺陷登记表)。grok-build 结论均基于源码,非营销材料。关键 file:line 入口:agent 循环 `xai-grok-shell/src/session/acp_session_impl/turn.rs`;工具 `xai-grok-tools/src/{types/tool.rs,implementations/*}`;沙箱/checkpoint `xai-grok-{sandbox,workspace}/src/*`、`xai-fast-worktree`;记忆 `xai-grok-memory/src/*`;可扩展 `xai-grok-{mcp,hooks}/src/*`、`xai-grok-shell/src/agent/mvp_agent/acp_agent.rs`、`xai-grok-config/src/{signed_policy,macos_managed}.rs`。*
