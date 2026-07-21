# Agent Factory — 运行 retry + 会话内断点续跑 实现计划

**日期**: 2026-07-20 · **状态**: 已定方案，待带 TDD 实现
**用户需求**: 「工厂运行经常被打断，想要 retry 过程 + 聊天/数据持久化，当前聊天 session 中哪怕中断也能重新继续」

## 已定决策（用户 2026-07-20 拍板）
- **方案 A**：复用现有快照脊柱，不重写（非方案 C 的 Inngest durable steps 全量迁移）。
- **恢复哲学 = 混合**：不花钱的恢复全自动（崩溃续跑、重挂已完成沙箱）；凡会重新花钱的（沙箱判定未知需重跑、重试耗尽后重驱动）弹一个「继续」卡让用户一键确认。
- **重试策略 = 稳健**：整运行最多 2 次自动重驱动，指数退避从 5s 起，严格尊重 `spent.tokens` 熔断；循环内 LLM 重试从 1 次提到 3 次 + 退避。

## 现状（已核验，工作流 6-agent 对抗验证）
底子不差：
- **每轮 checkpoint**：`checkpointConversation()`（conductor.ts:1655-1677）每轮结束把「全部 messages + 完整 serializeCtx」upsert 进 SQLite `factory_conversations`（schema.ts:1884-1908）；还在每个人机门、每次决策、run 结束 finally 落盘。`#CRASH-CKPT` conductor.ts:2792-2800。
- **开机自恢复**：`autoResumeCrashedRuns()`（run-registry.ts:473-544，bootstrap.ts:553 调）把所有 `status='running'` 行以 `crash_resume` 重驱动，从 checkpoint 再水化（conductor.ts:1339-1461）。
- **SSE 断开无损**：驱动器 `drive()` 与浏览器连接解耦（run-registry.ts:1-11）。
- 会话归档（本会话刚建）保住被压缩折叠的对话原文，`recall_conversation` 检索。

## 待补缺口 → 5 个工作项（每项 TDD：先写红测再实现）

### WS1 · 副作用工具后即时 checkpoint（P0，最高价值）
**问题**：checkpoint 是「每轮」而非「每个副作用工具后」。副作用工具（sandbox_run/finish/save_draft）执行完、进程在本轮结束落盘（conductor.ts:2798）前死掉 → 恢复重发同一工具调用 → 重复真实副作用。
**改**：conductor.ts tool 派发循环，在 push `role:"tool"` 结果（:2755）后，若该工具属副作用集且 `opts.conversationId` → 立即 `await checkpointConversation()`。
**副作用工具集**（显式，新增常量；工具无 effect 标注）：`sandbox_run, finish, save_draft, create_agent, refine_agent, deploy_agent, spawn_subagent, design_fleet, promote_*`（实现时按 FACTORY_TOOLS 逐一核 roleOfTool + 语义确认，宁可多标不可漏标）。
**测**：模拟一轮内副作用工具返回后即触发 conversation.save（用 fake port 断言 save 调用次数/时机）。

### WS2 · sandbox_run 幂等键（P0）
**问题**：`remote-sandbox-deployer.ts:988` 每次 `randomUUID` 新 attemptId，无 `(conversationId, candidateFingerprint)` 查重 → 恢复重部署第 2 个临时 Inngest app + 重跑真实计费测试。
**改**：`sandbox-lifecycle-store.ts` 加 `findReusableAttempt({ownerTenantId, targetDomainId, candidateFingerprint})`（表已有 `candidateFingerprint` 列，:126）；deployer 在 mint attemptId 前先查——
- 命中且已有**完整判定** → 复用判定/重挂 observe，不重部署（不花钱，全自动）。
- 命中但**判定未知/不完整**（上次 mid-observe 死掉）→ 按「混合」策略：不静默重跑，返回需人工确认信号 → 弹「继续」卡（花钱前置确认）。
- 未命中 → 照常 mint。
**测**：同一 candidateFingerprint 二次 deploy → 不产生第 2 个 appId；未知判定 → 返回 ask 信号而非重部署。
**风险**：判定「完整 vs 未知」语义要严（UNKNOWN 绝不能静默当 PASS）。复用现有 fence/lease（sandbox-lifecycle-store.ts:350-473）。

### WS3 · finish→save_draft CAS 防重复版本（P0）
**问题**：`agent-draft-store.ts:728-748` `save()` 无 `expectedLatestVersionId` CAS → 恢复重放 finish 追加重复草稿版本、双进 latest。
**改**：save 加内容哈希 / CAS 守卫：重放若内容哈希与 latest 相同 → 返回既有 versionId，不追加。
**测**：同内容二次 save → 同一 versionId，版本数不增。

### WS4 · 会话内 + error 终态 自动重驱动阶梯（P1，直击「retry+会话内续跑」）
**问题**：恢复只在「开机」触发（run-registry.ts:481 只选 `status='running'`）；api 不重启则无驱动的 run 没人重拉；连续 2 次瞬时 LLM 失败 → 永久 `error` 无自动重试。
**改**：
- **周期性重挂**：新增 `.unref()` interval（非只靠 boot/list），重挂 `status='running'` 且本进程无 live driver 的行（复用 `isActiveRun` 判活 + autoResume 逻辑）。
- **error 终态有界重试**：run 行加 `resumeAttempts` 计数（factory_runs 新列或 ctx 字段）；`done` handler（run-registry.ts ~338-357）在瞬时 error 且预算有余时，退避后 `startRun(continuationMode:'crash_resume')` 重驱动，**最多 2 次、指数退避从 5s**，而非直接 finalize `error`。非瞬时错误照常终态。
- **混合门**：重试耗尽 → 弹「继续」卡（不静默无限重）。
**测**：瞬时 error 行 → 触发有界重驱动、计数递增、到上限停并弹卡；非瞬时 error → 不重驱动。

### ~~WS5 · 循环内 typed 瞬时重试~~ — ❌ 撤销（对抗验证证伪，2026-07-20）
**工作流综合此条为误判。** 核验真相：连接层重试**已经 robust**——`stream-gateway.ts:462-516` 有 `MAX_ATTEMPTS=5`（env `FACTORY_LLM_MAX_ATTEMPTS`）/模型 × 模型链、指数退避 2→4→8→16s、坏模型自动 failover 到链上下一个、402 额度自适应。且**这层直连 OpenAI 兼容 SDK(错误带 `.status`),不是 llm-gateway 的 LLMError**——`LLMError.transient` 在此层无对象可用,正则判 SDK status 正是对的机制。conductor.ts:2374-2430 的外层「重试一次」是套在已 robust 内层之上的粗兜底,改它价值极低。**结论:retry 在「单次 LLM 调用」维度已够;用户感到的「被打断」真缺口在 WS4(整运行 error 终态无重驱动)。不做 WS5。**

## 预算/上限默认（未单独问用户，取稳健默认，实现时于代码注释标明可 env 覆盖）
- WS4 error 重试独立于 boot 的 `MAX_RESUME=3`/24h，用自己的 `resumeAttempts≤2`。
- `budgetLedger`（树级 spawn 预算）恢复时**从 ctx.spent 重播种**以逼近原始上限（今天重置为新对象——是真实花费策略缺口）；会话级 `spent.tokens` 熔断已持久，双保险。
- `waiting_human` 中途崩溃的行：重新 emit 门卡（不必手动 /inject）——纳入 WS4 周期性重挂。

## 落点索引（file:line）
- conductor.ts: 2374-2430（循环内重试 WS5）· 2755（工具结果 push，WS1 注入点）· 2792-2800（#CRASH-CKPT）· 2809-2818（error 帧 WS5）· 1655-1677（checkpointConversation）· 1163-1221（serializeCtx）
- run-registry.ts: 473-544（autoResume WS4）· ~338-357（done handler WS4）· 444-453（zombie sweep → 周期化 WS4）
- remote-sandbox-deployer.ts: 961-1018 / :988（attemptId mint WS2）
- sandbox-lifecycle-store.ts: 95-148（createAttempt）· 350-473（fence/lease，WS2 复用）
- agent-draft-store.ts: 728-748（save WS3）
- llm-gateway/src/errors.ts: 21-26,40-42（transient WS5）

## 前提核验状态（工作流 finding 逐条过筛，2026-07-20）
- WS1 ✅ 真（亲读 conductor.ts:2792-2800，checkpoint 每轮一次非每工具）
- WS2 ✅ 真（remote-sandbox-deployer.ts:988 `randomUUID()` mint，candidateFingerprint 在手却不查重）
- WS4 ✅ 真（run-registry.ts:481 只选 `status='running'`，:502 `isActiveRun` 判活，boot 触发；error/waiting_human 不覆盖）
- WS3 ⚠️ 部分真、价值下调（亲读 agent-draft-store.ts:700-749：CAS 基础设施**已存在**——persistVersion/commitVersion 都接受 `expectedLatestVersionId`+`requireCurrentVersion` 做 compare-and-swap；只是公开 `save()` 没传它。且版本是 append-only（每版带 randomUUID），重复版本良性。**WS1 已把重放窗口缩到亚毫秒**，故 WS3 从 P0 降为「可选加固」：给 `save()` 加内容哈希 short-circuit（同内容→返回既有 count 不追加）。）
- WS5 ❌ 证伪（见上，连接层重试已 robust）

## 实现顺序（修正后）
WS1（小、高价值、自包含）→ WS3（小，先亲验前提）→ WS2（中、判定语义严谨：UNKNOWN 绝不静默当 PASS）→ WS4（核心「retry+会话内续跑」，需 factory_runs 新列 resumeAttempts + 周期 interval + error 有界重驱动）。每项：红测→实现→绿→typecheck。全绿后一次 live run 验证崩溃续跑不重复副作用。
**注**：WS4 是用户「retry」诉求的真正落点（整运行级重驱动），非 WS5。
