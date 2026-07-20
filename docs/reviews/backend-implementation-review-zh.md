# 後端實作審查報告（中文版）

> **審查範圍：** `apps/api/**`、`packages/{runtime,agents,llm-gateway,db,contracts,shared,tools}/**`
> **報告日期：** 2026-05-23
> **代碼基準：** Sprint 4 收尾後 + Dashboard 熱修復後的 `main` 分支
> **配套文件：** `backend-implementation-review-en.md`（英文版）

---

## 1. 摘要

Agentic Operator 後端是一個 **雙進程的 Node 26 + pnpm 11 monorepo**：一個不持有任何資料的 Next.js Web 層，搭配一個獨佔所有持久化邏輯的 Fastify 5 API。兩端只透過一個型別化的 Zod 契約套件（`@agentic/contracts`）以 HTTP 通訊。API 之後串接的是 SQLite WAL 儲存、分層的 Agent 執行時（宣告式 Inngest 函式 *與* 程式碼定義的 `BaseAgent` 子類別並存）、一個對接 14 家供應商的 LLM Gateway，以及一個追加寫入的 NDJSON 事件帳本。

經歷四次協同強化衝刺（Sprint 1→4，全程記錄於 `docs/team-execution/00-master-plan.md`）之後，平台目前的指標為：**api vitest 366/367 通過（99.7%）**、**typecheck 0 錯誤**、**web typecheck 0 錯誤**、**web vitest 82/82**、**煙霧測試 11/11 端點全部存活**。Wave 5 的最終結論是 **可上線（SHIPPABLE）**，其中三個測試夾具的小回歸被列為 V1.0.1 修補候選。

整體架構的優點仍然完整：端對端型別契約、Inngest 步驟引擎的耐久性、針對每條熱讀路徑都配有複合索引的 WAL 模式 SQLite、具備供應商鏈式容錯的 LLM gateway、統一的 `{ok, data}` 信封。Auth 流程已從先前「永遠走 dev bypass」的狀態，強化為 **cookie + bearer + 啟動時守門**；先前洩漏的 `__system` 與 `?tenant=` IDOR 風險已關閉；先前留在磁碟卻沒掛載的六條路由現在全數註冊；可觀測性（graceful shutdown、Prometheus `/metrics`、`x-request-id`、完整的 `HealthReport`）也已就位。

### 整體評分

| 維度 | 現況 | 證據位置 |
|---|---|---|
| 架構一致性 | 良好 | 端對端型別契約、分層 runtime、統一信封 |
| API 路由註冊 | 19/19 條路由皆已掛載 | `apps/api/src/server.ts:94-118` |
| Auth 安全 | 已強化 | dev 模式必須明確 `AUTH_MODE=dev`；生產環境 cookie + bearer |
| 跨租戶隔離 | 已關閉漏洞 | 移除 `__system` 退路、廢除 `?tenant=` 覆寫 |
| Schema 遷移 | 已版本化 + 入索引 | `packages/db/drizzle/0000…0014` |
| 測試 | api 99.7% 綠燈 | 366/367 vitest，0 typecheck 錯誤 |
| 可觀測性 | 已串接 | `x-request-id`、`/metrics`、`installGracefulShutdown` |
| 稽核 log | 讀寫面皆完整 | `auditRoutes` 已註冊；`writeAudit` 來自 11 個觸發點 |
| 上線結論 | SHIP-WITH-CAVEATS | `docs/V1_SHIP_VERDICT.md` |

---

## 2. 架構總覽

### 2.1 元件配置

```
瀏覽器 ── HTTPS ──▶ Next.js 16（apps/web，:3599）
                       │
                       │  rewrites：/v1/*  → API_URL
                       │            /health → API_URL
                       ▼
                     Fastify 5（apps/api，:3501）
                       │
   ┌───────────────────┼──────────────────────────────────┐
   │                   │                                  │
   ▼                   ▼                                  ▼
 SQLite WAL    Inngest Dev CLI（:8288）           data/{logs,artifacts}
 data/agentic.db   宣告式 agent + helloFn         NDJSON 帳本
 19 張表          + 程式碼 agent 函式            每次 run 一份 .log
```

開發時的進程：

| 連接埠 | 進程                          | 啟動方式                  |
|------:|-------------------------------|---------------------------|
| 3599  | Next.js dev server            | `pnpm dev` → `next dev`   |
| 3501  | Fastify API                   | `pnpm dev` → `tsx watch`  |
| 8288  | Inngest Dev CLI（UI）          | `pnpm dev` → `npx inngest-cli@latest dev` |
| 50052/3 | Inngest gRPC                | 由 inngest-cli 啟動       |

`predev` 腳本（`package.json:11`）會在每次 `dev` 之前強制清掉這些連接埠。生產上的執行入口是 `tsx --env-file=… src/server.ts`，搭配新增的 `installGracefulShutdown(app)`（位於 `server.ts:134`）。

### 2.2 請求流向（讀取路徑示例）

```
瀏覽器 ──▶ GET /v1/runs?limit=50
           │
           ▼
   Next rewrite（next.config.mjs:24）
           │
           ▼
   Fastify :3501 — onRequest hook
   ├── x-request-id（server.ts:44 的 genReqId）
   ├── auth 插件：cookie → bearer → dev-tenant（auth.ts:143）
   └── security 插件（security.ts）
           │
           ▼
   v1.runs.GET handler（routes/v1/runs.ts:13）
           │
           ▼
   ListRunsQuery.parse(req.query)
           │
           ▼
   queries/runs.ts:listRecentRuns(tenantSlug, opts)
           │
           ▼
   drizzle SELECT FROM runs JOIN agents JOIN events
   + hydrateStepInfo()（目前 step 的名稱、序號、總數）
           │
           ▼
   reply.ok(rows) → { ok: true, data: RunRow[] }
   ┊            ┊
   └── onSend ──┴── 回傳的 header 帶上 x-request-id
```

### 2.3 兩條並行的 Agent 執行路徑

平台同時提供 **兩種執行 agent 的方式**，兩者都寫入相同的 `runs`/`steps` 表與每次 run 的 `.log` 檔：

1. **宣告式 manifest agent**（`packages/runtime`）—— JSON 寫在 `models/<slug>-v<n>/workflow*.json`。每個 agent 對應一條 Inngest 函式，`id = "${tenantSlug}.${agentName}"`，並以 `event.data.subject` 作為並發鍵。預設重試 3 次，搭配完整的 step engine、耐久的 `step.run` 寫入，以及 HITL 暫停／恢復用的 `step.waitForEvent`。實作見 `packages/runtime/src/register.ts`（610 行）與 `step-engine.ts`（388 行）。
2. **程式碼定義 agent**（`packages/agents`）—— TypeScript 子類別繼承自 `BaseAgent`，於 import 時透過 `agentRegistry.register(...)` 自動註冊。`BaseAgent.run()` 為封裝邏輯，子類別只需覆寫 `buildMessages()`（prompt 組裝），必要時覆寫 `parseOutput()`。同步呼叫經由 `POST /v1/agents/:name/invoke`；非同步（Inngest 排程）為 v2 規劃。實作見 `packages/agents/src/run-engine.ts`（301 行）。

兩條路徑共用 `apps/api/src/bootstrap.ts:74-81` 建立的 LLM Gateway 單例：`setAgentGateway()` 給 `BaseAgent` 用、`setRuntimeGateway()` 給 manifest 引擎的 `logic` / `llmCall` 動作用。

### 2.4 值得保留的架構優勢

1. **統一信封** —— `registerEnvelope` 提供 `reply.ok`/`reply.fail`，所有路由形狀一致，前端的型別化 client（`apps/web/lib/api-client.ts`）也對齊。
2. **`@agentic/contracts` 單一真理源** —— Zod schema 同時被 API 與 UI 引用；`z.coerce.date()` 處理 JSON 序列化的 date 往返。
3. **Drizzle schema + 複合索引** —— 每張用戶可見表都以 `(tenant_id, …)` 為前綴的複合索引覆蓋熱讀路徑（`runs_tenant_started_idx`、`evt_tenant_name_received_idx` 等），每張表的 `tenant_id` 都帶 `ON DELETE CASCADE`。
4. **步驟引擎全程包在 `step.run()` 裡** —— Inngest 處理器中的所有 DB 寫入都會被 Inngest memoise，重試為耐久且冪等。HITL 用的是 `step.waitForEvent("task.resolved", { if: 'async.data.taskId == "<id>"' })`。
5. **追加式 NDJSON 事件帳本 + `payload_ref` 指標** —— 將 metadata 與 blob 分離，存取成本可控。
6. **LLM Gateway 具備供應商鏈式容錯** —— 暫時性錯誤會 retry once；錯誤分類乾淨，並由 `agent-invoke.ts:221-239` 對應到 HTTP 狀態碼。
7. **14 家供應商** —— `mock`、`anthropic`、`openai`、`openrouter`、`gemini`、`azure`、`groq`、`together`、`mistral`、`deepseek`、`qwen`、`bedrock`、`vertex`、`custom`。Key 採 SHA-256 雜湊持久化，且支援 `POST /v1/llm/providers/:id/test` 連線探測。

---

## 3. API 介面

除了 `/health`、`/metrics`、`/inngest` 之外，所有路由都掛在 `/v1/` 之下。Sprint 3 完成後，所有曾經孤立未掛載的路由都已就位。

### 3.1 路由清單

| 檔案：行 | 方法 | 端點 | Auth | 說明 |
|---|---|---|---|---|
| `routes/health.ts:12` | GET | `/health` | 無 | `HealthReport`：`ok, ts, uptime, version, schemaVersion, inngest, sqlite, disk, llmGateway` |
| `routes/metrics.ts` | GET | `/metrics` | 無 | Prometheus 格式輸出 —— `runs_total`、`tokens_total`、`run_duration_ms`、`llm_provider_errors_total` |
| `routes/inngest.ts:13` | * | `/inngest` | inngest 簽名 | adapter 將註冊的函式對外公開 |
| **v1/events** | | | | |
| `events.ts:40` | POST | `/v1/events` | requireAuth | 發佈 + 寫帳本 + `inngest.send` + 稽核 |
| `events.ts:140` | POST | `/v1/events/:id/replay` | requireAuth | 用 `makeId("evt")` 避免同毫秒碰撞 |
| `events.ts:200` | GET | `/v1/events` | requireAuth | 列表（limit, name, since） |
| `events.ts:210` | GET | `/v1/events/catalog` | requireAuth | 每租戶事件型別目錄 |
| `events.ts:220` | GET | `/v1/events/recent` | requireAuth | 從種子做 BFS 深度 3 的因果圖 |
| `events.ts:245` | GET | `/v1/events/stream` | requireAuth | 帶 category filter 的 SSE 串流 |
| **v1/runs** | | | | |
| `runs.ts:13` | GET | `/v1/runs` | requireAuth | filter status/agent/q |
| `runs.ts:27` | GET | `/v1/runs/:id` | requireAuth | 嚴格限定 tenant（Sprint 2 已移除 `__system` IDOR 退路） |
| `runs.ts:38` | POST | `/v1/runs/:id/replay` | requireAuth | 重發觸發事件並標上 `__replayOfRun` |
| `runs-logs.ts:29` | GET | `/v1/runs/:id/logs?follow=1` | requireAuth | 透過 `fs.watch` 對單次 run 的 `.log` 做 SSE 追蹤 |
| **v1/tasks** | | | | |
| `tasks.ts:12` | GET | `/v1/tasks` | requireAuth | 租戶範圍列表 |
| `tasks.ts:19` | GET | `/v1/tasks/:id` | requireAuth | |
| `tasks.ts:27` | POST | `/v1/tasks/:id/resolve` | requireAuth | 發送帶有 `tenantId` 的 `task.resolved` Inngest 事件 |
| **v1/agents** | | | | |
| `agents.ts:61` | GET | `/v1/agents` | requireAuth | Sprint 2 已移除 `?tenant=` 覆寫 |
| `agents.ts:86` | GET | `/v1/agents/:kebab` | requireAuth | |
| `agents.ts:97` | POST | `/v1/agents` | requireAuth | 舊版 manifest 上傳（工作流編輯器的 Save 仍走這條） |
| `agent-invoke.ts:36` | POST | `/v1/agents/:name/invoke?testRun=1` | requireAuth | 同步呼叫程式碼 agent，或退回 Inngest 排程的 manifest agent |
| **v1/deployments** | | | | |
| `deployments.ts:10` | GET | `/v1/deployments` | requireAuth | `{list, live}` 信封 |
| `deployments.ts:21` | POST | `/v1/deployments/:id/rollback` | requireAuth | 降版時嚴格限定同一個 `target`；寫稽核 |
| **v1/manifest-import** | | | | |
| `manifest-import.ts:91` | POST | `/v1/tenants/:slug/manifest-import` | requireAuth | mode：`validate`（pending 鎖 1h，搶到第二把 → 423）、`commit`（四階段原子化：DB tx → fsync → rename → Inngest 重新註冊） |
| `manifest-import.ts:200` | POST | `/v1/tenants/:slug/manifest-import/fetch-url` | requireAuth | 加上 SSRF guard 的 URL 抓取，被擋會寫稽核 |
| `manifest-import.ts:280` | POST | `/v1/tenants/:slug/manifest-import/fetch-repo` | requireAuth | 501 stub |
| `manifest-import.ts:300` | DELETE | `/v1/tenants/:slug/manifest-import/:deployment_id` | requireAuth | 釋放 pending 鎖 |
| **v1/tenants** | | | | |
| `tenants.ts:30..783` | GET/POST/PUT/DELETE/POST | `/v1/tenants[/:slug[/restore]]` | requireAuth | CRUD + archive + restore + 四步精靈支援 + create 時 `Idempotency-Key` |
| **v1/webhooks** | | | | |
| `webhooks.ts:27` | POST | `/v1/webhooks/:provider` | HMAC | 原始 body 的 HMAC-SHA256 驗章、±5 分鐘重放窗、in-process 冪等快取（1h TTL / 上限 10k）、header 清洗 |
| **v1/artifacts** | | | | |
| `artifacts.ts:9` | GET | `/v1/artifacts/:id` | requireAuth | 串流 `row.path`，檔案缺失回 410 |
| **v1/reads** | | | | |
| `reads.ts:13` | GET | `/v1/counts` `/workflows/dag` `/event-types` `/entity-types` | requireAuth | dashboard 聚合資料 |
| **v1/llm** | | | | |
| `llm.ts:47..250` | GET/POST/PATCH/DELETE | `/v1/llm/providers`、`/.../keys`、`/.../test`、`/llm/models`、`/llm/catalog`、`/llm/fleet[/:id]` | requireAuth | 14 家供應商目錄、遮罩金鑰庫、模型 fleet CRUD |
| **v1/audit** | | | | |
| `audit.ts:39` | GET | `/v1/audit` | requireAuth | cursor 分頁（`(at, id)`），filter since/until/actor/action |
| **v1/usage** | | | | |
| `usage.ts:81` | GET | `/v1/usage?since&until` | requireAuth | 總計 + byAgent + byModel + byDay + 預算總覽 |
| **v1/budgets** | | | | |
| `budgets.ts:74` | GET | `/v1/budgets` | requireAuth | 若無 row 則自動建立 |
| `budgets.ts:80` | PUT | `/v1/budgets` | requireAuth | 月上限更新 + 可選 `reset` |
| **v1/stream** | | | | |
| `stream.ts:29` | GET | `/v1/stream` | requireAuth | 透過 `subscribeStreamEvents()` 做租戶範圍的 SSE 多路復用 |
| **v1/workflow** | | | | |
| `workflow.ts:60..343` | GET/PUT | `/v1/tenants/:slug/workflow` | requireAuth | 現代編輯器存檔路徑：寫 `models/<slug>-vN/workflow_vN+1.json` + Inngest 熱重註冊 |
| **v1/tenant-code** | | | | |
| `tenant-code.ts:74..431` | GET/POST/PUT/DELETE | `/v1/tenants/:slug/code[/:version]` | requireAuth | 解開 tarball → 原子 `fs.rename` → Inngest 重註冊 + 稽核 |

### 3.2 契約與路由是否漂移

| 契約符號 | 路由實際使用 | 狀態 |
|---|---|---|
| `ApiError { code, message, hint? }` | `reply.fail(code, message, status, hint?)` | 對齊 |
| `RunRow`（含 `testRun`、`error` 等 33 欄） | `queries/runs.ts:listRecentRuns` 充水 | 對齊（`testRun`、`error` 為 Sprint 4 新增） |
| `IngestEventBody.payload` 為 `z.record(string, unknown)` | route 將 `req.body` 整體交給 Zod | 對齊 |
| `ManifestUploadBody.actions` 為 array-of-record | 以 `text json` 存入；SQLite 端不再驗證 | 可接受 |
| `HealthReport`（Sprint 2 擴充 `ts/uptime/version/schemaVersion/llmGateway`） | route 輸出擴充版本 | 對齊 |

目前沒有結構性漂移 —— 這是「client 與 server 都引用同一個 `@agentic/contracts`」的好處。

### 3.3 錯誤信封與狀態碼

`apps/api/src/plugins/error.ts` 提供 `reply.ok(data, status?)` → `{ok:true, data}` 與 `reply.fail(code, message, status?, hint?)` → `{ok:false, error:{code, message, hint}}`。`setErrorHandler` 攔 `ZodError`，轉成 400 `invalid_input` 並在 `hint` 帶上拼接的 issue 路徑。其他 thrown error 用 `err.statusCode || 500` 與 `err.code || 'internal_error'`。

| 錯誤碼 | 狀態 | 範例使用點 |
|---|---|---|
| `invalid_input` | 400 | Zod 驗證失敗（envelope plugin） |
| `bad_request` | 400 | agent-invoke 收到未知 provider |
| `unauthorized` | 401 | requireAuth、webhook 簽章 |
| `forbidden` | 403 | 跨租戶寫入、外部租戶 resolve |
| `not_found` | 404 | 任何讀路徑的目標 row 缺失 |
| `requires_confirmation` | 409 | manifest commit 缺 `?confirm=1` |
| `slug_taken` | 409 | tenant 建立時 slug 已存在 |
| `agent_disabled` | 409 | 對 disabled 的 agent 呼叫 invoke |
| `already_resolved` | 409 | task 非 `open` |
| `gone` | 410 | replay 硬刪除過的事件、檔案不存在的 artifact |
| `pending_import` | 423 | 同時併發 validate manifest |
| `provider_error` / `rate_limit` / `timeout` / `model_not_found` / `not_configured` / `network` | 502 / 429 / 504 / 400 / 503 / 502 | LLMError 由 `mapErrorStatus()` 對應 |
| `not_implemented` | 501 | 非同步 invoke、`manifest-import/fetch-repo` |

---

## 4. 資料庫結構

19 張表，定義於 `packages/db/src/schema.ts`（766 行）。所有遷移皆有版本號並入 journal，位於 `packages/db/drizzle/0000…0014_*.sql`；執行器為 `packages/db/src/migrate.ts`。

### 4.1 表結構分組

**身份：** `tenants`、`users`、`memberships`、`api_tokens`。
**工作流定義：** `workflows`、`workflow_versions`、`agents`、`agent_versions`、`event_listeners`。
**生命週期：** `deployments`（target ∈ `'workflow' | 'code_agent' | 'tenant_code'`）、`audit_log`。
**執行時狀態：** `events`、`runs`（含 `is_test`、`correlation_id`、`subject`）、`steps`、`tasks`、`artifacts`。
**記憶體 + 預算：** `agent_memory_short`、`agent_memory_long`、`tenant_budgets`。
**本體論覆蓋：** `event_types`、`entity_types`。
**Webhook 接收：** `webhook_subscriptions`、`idempotency_keys`（遷移 `0014`）。

### 4.2 為熱讀建立的索引

每張租戶範圍表都至少有一條以 `tenant_id` 為前綴的複合索引：

| 表 | 索引 |
|---|---|
| `runs` | `(tenant_id, started_at)`、`(tenant_id, status)`、`(agent_id)`、`(correlation_id)`、`(subject)` |
| `events` | `(tenant_id, name, received_at)`、`(tenant_id, subject)` |
| `steps` | `(run_id, ord)` |
| `tasks` | `(tenant_id, status)`、`(run_id)` |
| `audit_log` | `(tenant_id, at)`、`(target_type, target_id)` |
| `artifacts` | `(run_id)` |
| `agent_memory_*` | `(tenant_id, agent_id, key)` |

### 4.3 Pragmas 設定

`packages/db/src/client.ts:118-121`：

```
journal_mode = WAL          ✅
foreign_keys = ON           ✅
synchronous = NORMAL        ✅
busy_timeout = 5000         ✅
```

Client 端透過自訂的路徑搜尋器（`resolveNativeBinding`）解析 `better-sqlite3` 原生綁定，因此同一份程式碼能在 hoist 過後的 `node_modules/better-sqlite3/...` 與生產環境的 `.pnpm/...` 結構下都可運作。環境變數 `AGENTIC_SQLITE_BINDING` 允許運維把綁定放在已知路徑。

### 4.4 多租戶紀律

- 每張租戶範圍表都有 `tenant_id`，搭配 `ON DELETE CASCADE`。
- `with-tenant.ts` 提供 `tenantScope(ctx, table)`，但大多數 query 檔仍直接呼叫 `getDb()` 並手動加 `eq(table.tenantId, tenantId)`。慣例一致，但型別系統並未強制。
- 先前在 `/v1/runs/:id` 與 `/v1/runs/:id/logs` 上明確指定 `__system` 退路的 IDOR 已於 Sprint 2 移除；程式碼 agent 的 run 改為對 caller 做嚴格租戶範圍（system agent 的呼叫無論 caller 為誰，仍存到 `__system` 的 tenantId 下）。
- `/v1/agents` 上的 `?tenant=` query 也被廢除 —— 租戶完全由 auth 推導。

---

## 5. 啟動生命週期

`apps/api/src/server.ts` 建立 Fastify app，並執行 `apps/api/src/bootstrap.ts` 中的 `bootstrapRuntime()`。初始化順序：

```
1. getLLMGateway()             建立 adapter、註冊 14 家 provider
2. setAgentGateway(gateway)    指派模組級全域給 @agentic/agents
3. setRuntimeGateway(gateway)  指派模組級全域給 @agentic/runtime
4. setRuntimeMetrics(metrics)  將 prom-client registry 接到 manifest 引擎
5. bootstrapCodeAgents()       寫入 __system tenant / workflow / version / code-agent rows
6. bootstrapAll(TENANT_REGISTRIES)
     - readdir(models/)
     - 每個 tenant folder：loadModelsFromDisk()、upsert workflows + workflow_versions、
       transactionally 將舊 live 降版為 'live'、upsert agents +
       agent_versions + event_listeners、registerAgent() → Inngest function、upsert
       event_types + entity_types
     - 回傳 [...inngestFns]
7. reconcileImports()          a) 清掉過期的 pending；b) 完成中斷的 rename；
                               c) 從 workflow_versions.manifest_json 重新寫出磁碟上缺失的 manifest
8. inngestRoute(app, {client, functions})
9. registerSecurity(app)
10. installGracefulShutdown(app)   監聽 SIGTERM，於 ≤10s 內 drain 後 exit(0)
11. app.listen({port, host})
```

### 5.1 優勢

- 每一步皆冪等（既存 row 跳過）。
- 順序 gateway → metrics → agents → runtime → reconcile 確保第一個 Inngest 事件抵達時，step engine 已能呼叫 LLM。
- Deployment 切換是 `db.transaction(() => {…})`。
- `reconcileImports` 是 manifest-import 四階段 commit 的崩潰恢復網。
- `assertAuthModeSafe()` 在 `registerAuth()` 內執行；若偵測到 `AUTH_MODE=dev + NODE_ENV=production` 或 `AGENTIC_DEV_TENANT` 解不到 row，會 **直接拋例外** —— 與其讓生產環境靜悄悄地走 auth bypass，不如響亮地啟動失敗。
- `installGracefulShutdown` 在 `app.listen()` 之前註冊，因此 SIGTERM 發生在啟動緩慢期也能 drain。

### 5.2 已知失敗模式

| 失敗情境 | 目前行為 |
|---|---|
| DB 鎖超過 5 秒 | `busy_timeout` 退出；bootstrap 若無法寫入會拋例外 |
| Manifest 格式錯誤 | `bootstrapTenant` 拋例外 → 外層 `bootstrapAll` 攔下 → API 仍會啟動；該租戶被跳過 |
| 原生綁定缺失 | `resolveNativeBinding` 拋出明確錯誤 `[db/client] could not locate better_sqlite3.node` |
| 連接埠被占用 | `app.listen` reject → `process.exit(1)` |
| 兩個 API 實例同時啟動 | UQ 衝突會讓敗者拋例外；尚未改為 `ON CONFLICT DO NOTHING` |
| Inngest CLI 不可達 | API 仍會啟動；前幾筆事件無處可去 —— `/health` 會顯示 `inngest: degraded` |

---

## 6. Manifest agent —— packages/runtime

`packages/runtime` 是宣告式路徑的核心。各檔案行數：

| 檔案 | 行數 | 角色 |
|---|---|---|
| `register.ts` | 610 | 為每個 AgentSpec 建立 Inngest 函式；耐久性合約 |
| `lint.ts` | 583 | manifest 檢查器 —— 11 種衝突偵測（dangling trigger、orphan emitter、kebab 衝突、cron 合理性、model_not_configured、prompt-injection 嗅探等） |
| `step-engine.ts` | 388 | 分派 `logic` / `llmCall` / `condition` / `delay` / `subflow` / `manualTask` 動作 |
| `tenant-loader.ts` | 339 | 從 `data/tenants/<slug>/<version>/` 探索並載入 tenant code 套件 |
| `manifest.ts` | 287 | `AgentSchema` / `WorkflowSchema` Zod + 啟動時的 `findMissingTenantPrompts` 驗證 |
| `memory.ts` | 229 | 短期 + 長期記憶（subject / tenant / run 三種範圍） |
| `bootstrap.ts` | 215 | 租戶側 bootstrap 迴圈 |
| `scheduler.ts` | 157 | 由 `registerCronTriggers` 載入 cron |
| `hot-reload.ts` | 172 | manifest import 後重發 Inngest 註冊 |
| `retention.ts` | 168 | 對舊 `events` / `runs` 做 sweep + tombstone |
| `broadcast.ts` | （在 index 中） | `/v1/stream` 使用的租戶範圍 publish/subscribe |

### 6.1 耐久性合約

Inngest 重試時會 replay 每個 step。所以所有 DB 寫入都必須包在 `step.run("name", …)` 裡，這樣每次真實執行只會產生一份 row。`register.ts` 中的規則：

- `step.sendEvent` 是唯一冪等的下游事件發送方式 —— 不要在 step body 裡呼叫 `inngest.send`。
- HITL：在 `step.run("createTask", …)` 內建立 `tasks` row，然後用 `step.waitForEvent("task.resolved", { if: 'async.data.taskId == "<id>"' })`，逾時 7 天。
- `failRun`（`register.ts:446`）寫最終的 `runs.status = 'failed'`。Wave 4 punch list（UC-V11-35）標記這需移到 `step.run("finalize", …)` 內，以堵住一個競爭條件：若 `failRun` 之後又重試，會看到 `status='failed'` 而不寫新的 run row。

### 6.2 Step engine 的動作型別（Sprint 1 P1-RT-03）

```ts
type Action =
  | { type: 'logic'; prompt?: string; model?: string }
  | { type: 'llmCall'; messages: ChatMessage[]; tools?: ToolDef[] }
  | { type: 'condition'; expr: string }
  | { type: 'delay'; ms: number }
  | { type: 'subflow'; trigger: string }
  | { type: 'manualTask'; assigneeRole: string; payload?: unknown };
```

`evaluateCondition`（`condition.ts:122`）是 **fail-open** 的 AST walker —— 條件寫壞不會堵住分支。`tc-9` 涵蓋 11 個子案例（空、數值、相等、邏輯鏈、否定、禁止語法、識別字白名單、深度鏈未定義等）。

### 6.3 Manifest-import 精靈（UC-2，`services/manifest-import.ts`，1640 行）

兩種模式：

- **validate** —— 解析 + lint + 在記憶體內建立 diff，插入一筆 `deployments(status='pending', expires_at=now+1h)`，其 `id` 即為 import session token（第二個併發 caller 會收到 423，直到鎖過期或被釋放）。
- **commit** —— 四階段原子化 commit：
  1. 預檢再驗一次。
  2. 寫 `data/imports/<deployment_id>/workflow.json` + `fsync`。
  3. 同步 SQLite tx：降版舊 live → upsert `workflow_versions` / `deployments` / `agents` / `agent_versions` / `event_listeners` + 稽核 row。
  4. `fs.rename()` 進 `models/<slug>-vN/workflow_v<N+1>.json` + Inngest 重新註冊（`reregisterInngest`）。

任何階段中崩潰，都由下次啟動的 `reconcileImports()` 恢復。測試：`manifest-import-{validate,commit,concurrent,overwrite-guard,conflict,ssrf,perf}.test.ts`（合計 75 個子案例全綠）。

### 6.4 Lint 偵測器（11 種）

`lint.ts` 對 manifest 跑每個偵測器。嚴重度 `error`（會阻擋）／`warn`：

```
dangling_trigger          orphan_actor              prompt_injection_smell
concurrency_excess        kebab_id_collision        model_not_configured
invalid_cron              dangling_emitter          broken_subflow
required_field_missing    duplicate_event_listener
```

每個偵測器可選擇性回傳 `auto_fix` payload；精靈的「套用所有修正」按鈕就是經這條路徑往返。

---

## 7. 程式碼 agent —— packages/agents

程式碼 agent 路徑住在 `packages/agents`（約 700 行），是 manifest agent 的同步對應方：

- `base-agent.ts`（78 行）—— 封閉的 `BaseAgent` 類別；子類別覆寫 `buildMessages()`，必要時覆寫 `parseOutput()`。
- `run-engine.ts`（301 行）—— 安排 run row、step rows、gateway 呼叫、log writer、SSE publish。
- `registry.ts`（42 行）—— `agentRegistry.register(name, factory)` 於 import 時自動執行。
- `bootstrap.ts`（221 行）—— `bootstrapCodeAgents()` 為每個註冊的程式碼 agent 寫入 `__system` 租戶 + workflow + version + agent rows。
- `system/` —— 內建程式碼 agent；`testAgent` 僅由明確的測試環境註冊。
- `gateway-host.ts`（29 行）—— 模組全域的 `setGateway` / `getGateway`，給 LLM 派發用。

`agent.run(input, ctx)` 透過 `log-writer.ts` 寫單行 `.log` 檔，並透過 broadcast channel 發出 `run.started`/`run.step.*`/`run.completed|failed`，讓 `/v1/stream` 訂閱者（以及 `useStream` hook）即時讓 React-Query keys 失效重抓。

系統 agent 的呼叫不論 caller 是誰，都會把 row 存到 `__system` 的 tenantId 之下（`agent-invoke.ts:91`）。先前允許跨租戶讀取 `__system` run 的 IDOR 已於 Sprint 2 移除 —— 程式碼 agent 的 run 對 caller 仍然可見，因為它們對所有人都存在 `__system`，這是「共用租戶」設計，不是「per-caller 洩漏」。

---

## 8. LLM Gateway —— packages/llm-gateway

`packages/llm-gateway/src/gateway.ts`（179 行）是對接 14 家供應商的單例。`adapters/` 目錄下各家 adapter 處理 per-provider 的 HTTP 形狀；gateway 在上層加了：

- **供應商鏈式容錯** —— `chat({ providers: ['anthropic', 'openai'] })` 依序嘗試，暫時性錯誤 retry once。
- **基於 block 的 content 協定** —— `ChatMessage.content` 為 `string | ChatContentBlock[]`，block 分為 `text` / `tool_use` / `tool_result`。`flattenContentToText()` 讓不懂 block 的 adapter（大多數 OpenAI-compatible 供應商）仍可呼叫。
- **工具使用迴圈** —— 設定 `ChatRequest.tools` 時，gateway 會發出 `tool_use` block；caller 解析、執行工具，再以 `tool_result` block 回貼。mock adapter 透過 `_resetMockIdSeq()` 提供決定性模擬（`tc-15`、`tc-16`）。
- **預算 Hook** —— `packages/llm-gateway/src/budget.ts:174` 強制 per-tenant `tenant_budgets.monthly_token_cap` / `monthly_usd_cap`；超過會丟 `cost_limit_exceeded`，由 route 映射為 503。
- **錯誤分類** —— `LLMError { code: 'auth' | 'rate_limit' | 'timeout' | 'model_not_found' | 'not_configured' | 'network' | 'provider_error' | 'cost_limit_exceeded' }`，透過 `agent-invoke.ts:221-239` 對應 HTTP。

Adapters：`mock`、`anthropic`、`openai`、`openrouter`、`gemini`、`azure`、`groq`、`together`、`mistral`、`deepseek`、`qwen`、`bedrock`、`vertex`、`custom`。Bedrock 與 Vertex 還是部分 stub（Wave 4 的 UC-V11-26 已延至 V1.1）。

供應商金鑰持久化：`apps/api/src/services/provider-keys.ts`（339 行）。金鑰以不透明 blob 存在 sidecar JSON state 檔，scope ∈ `'workspace' | 'tenant'`。`POST /v1/llm/providers/:id/key` 會觸發 `resetLLMGateway()`，下一次呼叫就會用上新金鑰。`GET …/key` 的遮罩視圖只回傳前綴 + 最後 4 字元。

Model fleet（`services/model-fleet.ts`，238 行）是 per-tenant 的模型釘選介面 —— alias、role（`'default' | 'cheap' | 'long-context' | 'reasoning'`）、`dailyCapUsd`、`maxOutTokens`、`temperature`。

---

## 9. Auth + 多租戶

### 9.1 Auth 流程（Sprint 2 + Dashboard 熱修復）

`apps/api/src/plugins/auth.ts:143` —— `authenticate(req)` 的流程：

```
if AUTH_MODE=dev：
  return devTenant(req)
    ├── 讀 x-agentic-tenant header（dev 限定 override；slug 須符合 /^[a-z0-9_-]{1,32}$/）
    └── 否則退回 AGENTIC_DEV_TENANT（預設 'raas'）

否則（prod / staging）：
  存在 cookie 'agentic_session' ？
    yes → jwtVerify(jwt, AUTH_SESSION_SECRET, HS256)
          → 從 payload.tenant 解析租戶
          → 通過：return { via: 'cookie' }
  退回 Authorization: Bearer <token>
    → SHA-256 雜湊 → 比對 api_tokens.hash
    → 更新 api_tokens.last_used_at
    → return { via: 'token' }
  皆未命中 → null → requireAuth() 拋 401
```

Cookie 流程使用 `jose@5` 的 HS256。共用密鑰從 `AUTH_SESSION_SECRET`（標準名稱）或 `SESSION_SECRET`（web 端目前設定的）讀取，讓 Next.js 簽入 route 與 Fastify 驗證者用相同密鑰簽署。

### 9.2 啟動時守門

`assertAuthModeSafe()`（auth.ts:205）在以下情況拒絕返回：
1. `AUTH_MODE=dev` + `NODE_ENV=production` —— 會悄悄繞過 bearer auth，把每個請求都當成已認證的種子 admin 租戶。
2. `AUTH_MODE=dev` + `AGENTIC_DEV_TENANT` 指向不存在的 slug —— 會讓每個 dev 請求都解析為 null。

此守門在 `registerAuth()` 內執行，所以不安全的環境組合會 **崩潰啟動**，不會偷渡到生產。

### 9.3 租戶隔離保證

| 資源 | 可跨租戶讀取？ |
|---|---|
| runs（一般租戶） | 不可（tenantId filter） |
| runs（位於 `__system` 的程式碼 agent） | 不可 —— caller 必須是 `__system`（Sprint 2 已關閉先前的 IDOR） |
| run logs（程式碼 agent） | 同上 |
| events / tasks / artifacts | 不可（route 檢查 `row.tenantId !== auth.tenantId`） |
| agents | 不可（`?tenant=` override 已移除） |
| deployments | 不可（route 檢查 tenant） |

### 9.4 Webhook 接收（UC-13，Sprint 3 復原）

`/v1/webhooks/:provider`：
1. 以 `provider`（加上選用的 `x-tenant-slug` disambiguator）到 `webhook_subscriptions` 查訂閱。
2. Plugin-scoped JSON content-type parser 捕捉 `rawBody` 給 HMAC 用。
3. 對原始 byte 做 HMAC-SHA256；用 `timingSafeEqual` 做 constant-time 比對。
4. 對 `x-timestamp` header 套用 ±5 分鐘重放窗。
5. In-process 冪等快取（1h TTL / 10k 上限），以 `x-idempotency-key` / 簽章摘要為 key。
6. 從轉發 header 中剝除 `Authorization`/`Cookie`/`Set-Cookie`。
7. `inngest.send({ name: '<slug>/WEBHOOK_<PROVIDER>', data })`。Inngest 送失敗 → 寫 log + ack-202（避免上游進入重試風暴）。

Wave 4 UC-V11-27 已標記要移除 `WEBHOOK_HMAC_SECRET_DEFAULT` 退路，改為強制 per-subscription secret —— 目前仍會退回環境變數預設值。

---

## 10. 可觀測性

### 10.1 Logger

Pino，由 Fastify 內建提供。`genReqId: () => randomUUID()` + `requestIdHeader: 'x-request-id'` + `requestIdLogLabel: 'reqId'`。`server.ts:62-65` 的 `onSend` hook 把 `x-request-id` 回填到每個 response（SSE 串流若已透過 `raw.writeHead` flush header 則跳過）。

CORS 已 `exposedHeaders` 暴露該 header，瀏覽器才讀得到（`server.ts:74`）。

### 10.2 單次 run 的檔案 log

`packages/runtime/src/log-writer.ts` 將 `2026-05-23T08:14:02.001Z INFO run.start run_id=... …` 寫到 `data/logs/<tenant>/runs/<YYYY-MM-DD>/<run-id>.log`。`runs-logs.ts:91` 的 SSE tail 用 `fs.watch` 將新行以 `event: log` frame 推送。v1 足夠，但跨機器則需共用檔案系統。

### 10.3 稽核 log

有 11 個觸發點寫入 `audit_log`（透過 `apps/api/src/plugins/audit.ts:writeAudit`）：

```
tenant.create / tenant.update / tenant.archive / tenant.restore
manifest.import.commit / manifest.import.fetch_url.blocked
deployment.rollback   /  manifest.deploy   (legacy)
event.publish    /    event.replay
task.resolve
llm.key.rotate / llm.fleet.{add,update,remove}
budget.update
tenant.code.upload
```

`GET /v1/audit` 回傳 cursor 分頁的 rows，限制在 caller 租戶範圍；可 filter since/until/actor/action；預設 limit 100，clamp 至 [1, 500]。

### 10.4 Metrics

`/metrics` 輸出 Prometheus exposition：

- `runs_total{tenant, agent, status}`（counter）
- `tokens_total{tenant, provider, direction}`（counter）
- `run_duration_ms{tenant, agent}`（histogram）
- `llm_provider_errors_total{provider, code}`（counter）

Counter 在 `agent-invoke.ts`（同步程式碼 agent 路徑）與 `register.ts` finalize hook（manifest 路徑）兩處遞增（Sprint 4 已透過 `setRuntimeMetrics(metrics)` 接上）。

### 10.5 Health

`HealthReport` 結構：

```ts
{
  ok, ts, uptime, version, schemaVersion,
  inngest: { ok, status },
  sqlite: { ok, journalMode },
  disk:   { ok, freeBytes },
  llmGateway: { ok, defaultProvider, defaultModel, providers }
}
```

任何子系統不健康時回 503。

### 10.6 Tracing

Correlation ID 會在事件與 run 之間傳遞（`correlation.ts`）；目前尚未接 OpenTelemetry（UC-V11-34 延至 V2）。

---

## 11. 安全姿態

### 11.1 輸入驗證

所有 POST body 用 Zod 解析。`runs`/`events`/`audit`/`usage` 上的 query string 用 Zod 解析。Path param 尚未端對端做 Zod-regex 驗證（風險低，因為會打到 DB 且 miss 即 404）。

### 11.2 Rate limit

**尚未在 API 層實作。** `@fastify/rate-limit` 未註冊。Wave 4 已把 per-tenant rate-limit 延至 V1.1（UC-V11-10）。

### 11.3 CORS + Helmet

CORS 限定 `WEB_ORIGIN`、`credentials: true`、`exposedHeaders: ['x-request-id']`。`apps/api/src/plugins/security.ts`（183 行）安裝 `@fastify/helmet` 風格的 header（CSP、HSTS、X-Frame-Options 等），於 `server.ts:79` 註冊。

### 11.4 SSRF 守衛

`apps/api/src/services/ssrf-guard.ts`（330 行）。政策：

- 擋 `file://`、`ftp://`、`data:`、所有 RFC1918（10/8、172.16/12、192.168/16）、loopback、link-local（169.254/16，含 AWS metadata 169.254.169.254）。
- 預設 HTTPS-only；`http://localhost` 僅在 `AGENTIC_FETCH_ALLOW_HTTP_LOCALHOST=1` 時放行。
- 每次 redirect 重新檢查（最多 5 hops、body ≤5 MB、5s timeout）。
- DNS 解析做 snapshot，避免 resolve 與 connect 之間發生 TOCTOU swap。
- 政策違反時寫稽核 row `manifest.import.fetch_url.blocked`。
- 測試覆蓋：`manifest-import-ssrf.test.ts` —— 35 個子案例。

### 11.5 路徑穿越

`artifacts.ts:28` 串流 `row.path`。寫入者用 `path.join(artifactsRoot, runId, name)` 填欄位，故該欄位不受 user 控制。額外加強層（檢查解析後路徑必須在 `AGENTIC_ARTIFACTS_DIR` 下）為 TODO。

`tenant-code.ts:405-410` 拒絕任何 normalize 後不在解壓目錄下的 tar entry。

### 11.6 SQL 注入

所有 query 透過 Drizzle 的參數化 builder。有兩處原生 `sql\`\`` 樣板（`queries/runs.ts:34, 56`）用於 `IN (...)` 清單；用 `sql\`${id}\`` placeholder 插入，Drizzle 會 escape。

### 11.7 密鑰管理

- `.env` / `.env.local` 列入 gitignore。
- API token 在 `api_tokens.hash` 以 SHA-256 雜湊。
- `AUTH_SESSION_SECRET`（或 `SESSION_SECRET`）於啟動時讀入；生產環境若沒設，cookie auth 會拒絕認證。
- 供應商金鑰存在 sidecar JSON state 檔；API 只回傳前綴 + 最後 4 字元。

### 11.8 Webhook 抗重放

如 §9.4 所述 —— ±5 分鐘窗 + 1h 冪等快取。跨進程重放（多 API 實例）尚未覆蓋；目前快取是 in-process。對單實例 v1 已足夠。

---

## 12. 測試姿態

### 12.1 測試 harness

- Vitest + `pool: 'forks'`（better-sqlite3 是單執行緒）、`sequence.concurrent: false`。
- `app.inject()` harness 啟動 **真正的 Fastify app** —— 不走網路，但完整 handler chain 都會對著真實 SQLite 檔執行。
- Setup（`apps/api/test/setup.ts`）強制 `AUTH_MODE=dev`、`AGENTIC_DEV_TENANT=__system`、`LLM_DEFAULT_PROVIDER=mock`，將 logs/artifacts 導向 `data/test-{logs,artifacts}/`。

### 12.2 Sprint 4 收尾時的覆蓋率

| 指標 | 結果 |
|---|---|
| api vitest | **366 / 367（99.7%）** |
| api typecheck | 0 errors |
| web typecheck | 0 errors |
| web vitest | 82 / 82 |
| 煙霧端點 | 11 / 11 alive |
| `x-request-id` 是否回填 | every response |

### 12.3 測試清單

`apps/api/test/` 目前有 51 個 vitest 檔，涵蓋：每一條 `/v1/*` 路由、manifest-import 精靈（7 檔 / 75 子案例）、LLM gateway、broadcast channel + SSE、預算 hook、step engine、condition evaluator、branch-emit 解析、register helpers、tenant CRUD + isolation + idempotency、webhook 接收、cron trigger、tenant-loader、tenant-code upload、schema 漂移、run logs、graceful shutdown、metrics + health、auth mode guard、tenant header override（Sprint 4 後的熱修復），以及 event tester 的因果圖。

### 12.4 已知覆蓋缺口

- 六步 manifest-import 的 **UI 精靈** 沒有任何 Playwright 覆蓋（TC-119 仍只是手動 UAT）。
- Run-replay 尚未寫稽核 row（UC-6 留下的問題）。
- 跨租戶 bearer IDOR 的 e2e 測試（Wave 4 top-10 清單，僅部分寫完）。
- Wave 5 top-10 的新測試（RAAS stage walk、cookie-auth-prod、agents-500-tenant-code、failRun race）有列計畫，但尚未全部寫完。

---

## 13. 建置、打包、部署

### 13.1 開發執行

`package.json:11-13`：

```
predev: lsof -ti:3599,3501,8288,8289,50052,50053 | xargs kill -9
dev:    concurrently web :3599 + api :3501 + inngest :8288
```

API：`tsx watch --env-file=../../.env --env-file=.env.local src/server.ts`。

### 13.2 生產執行

`apps/api/package.json:start = tsx --env-file=… src/server.ts`。各 package 沒有 `tsc --emit`；turbo 的 `build` task 有配但只有 `apps/web` 有真正的 build（`next build`）。生產 container 化要做的事：Node 26 → `pnpm install --frozen-lockfile` → `pnpm db:migrate` → 在 `tini` 下執行 `tsx apps/api/src/server.ts` 以處理 signal。目前 repo 內還沒 Dockerfile。

### 13.3 ESM + 原生綁定

- 所有 workspace package 都是 `"type": "module"`。
- `better-sqlite3@12.10.0` 是 CJS 原生模組；由 `resolveNativeBinding` 沿 `node_modules`（hoist 與 `.pnpm/` 兩種）往上找。`AGENTIC_SQLITE_BINDING` env override 處理特殊安裝結構。
- Node 26（MODULE_VERSION 147）為必要，`.nvmrc` 已釘。Node 25 binary 與 Node 26 runtime 混搭會 `ERR_DLOPEN_FAILED`。Sprint 4 曾為此花上半天診斷（一次過期的 `pnpm rebuild` 週期）。

### 13.4 必要環境變數

```
DATABASE_URL              （預設 <repo>/data/agentic.db）
AGENTIC_LOGS_DIR          （預設 ./data/logs）
AGENTIC_ARTIFACTS_DIR     （預設 ./data/artifacts）
AGENTIC_MODELS_DIR        （不再硬編碼；env 或 ./models）
AGENTIC_TENANTS_DIR       （預設 ./data/tenants）
INNGEST_*                 （dev mode 有 bypass）
LLM_DEFAULT_PROVIDER      （mock 為安全預設）
ANTHROPIC_API_KEY / OPENAI_API_KEY / ...   （per-provider）
WEB_ORIGIN                （CORS 釘住）
AUTH_MODE                 （設 'dev' 才會啟用 dev 租戶；prod 切勿設）
AGENTIC_DEV_TENANT        （預設 'raas'）
AUTH_SESSION_SECRET       （cookie JWT；亦可用 SESSION_SECRET）
WEBHOOK_HMAC_SECRET_<PROVIDER>  （per-provider，外加可選的 DEFAULT）
AGENTIC_MAX_BODY_BYTES    （預設 10 MB）
AGENTIC_SHUTDOWN_TIMEOUT_MS （預設 10 秒）
LOG_LEVEL                 （pino，預設 'info'）
PORT / HOST               （預設 3501 / 0.0.0.0）
```

---

## 14. 仍未解決的問題與建議

依風險 × 不處理成本分桶。effort：S=≤1 天、M=2–5 天、L=1 週+。

### 14.1 V1.0.1 熱修候選（依 `docs/V1_SHIP_VERDICT.md`）

| ID | 標題 | effort | 現況 |
|---|---|---|---|
| tc-24 | testRun flag —— `runs.is_test` + SSE payload | S | Sprint 4 已串接；唯一還紅的子測試是因為它查的是過期的 `events` 表（測試 bug，非程式碼 bug —— 見 master plan 第 374 行） |
| tc-27 | tenant-code rollback response 形狀 —— 回填 `target` 欄位 | S | Sprint 4 engine+budget 那輪已收 |
| tc-5  | 測試隔離：`deployments.status='live'` 被 tc-27 翻動 | S | 已由 deployment scoping 修補緩解 |

### 14.2 Wave 4 後端尚未完成項目

| ID | 標題 | effort |
|---|---|---|
| UC-V11-22 | manifest 引擎 finalize 時遞增 `runs_total` | S（透過 `setRuntimeMetrics` 應已完成） |
| UC-V11-23 | 將 `agent.tool_use` 在 `runAction` 內接到租戶 tool name | M |
| UC-V11-24 | `BaseAgent` 加上 per-agent `defaultProviders` | S |
| UC-V11-27 | 移除 `WEBHOOK_HMAC_SECRET_DEFAULT` 退路 | S |
| UC-V11-35 | 把 `failRun` 移到 `step.run("finalize", …)` 內 | S |

### 14.3 延至 V1.1 / V2

- `@fastify/rate-limit` per-tenant + per-IP（UC-V11-10）。
- OpenTelemetry tracing（UC-V11-34 → V2）。
- Inngest 永久失敗用 DLQ（UC-V11-36 → V2）。
- Bedrock + Vertex 真正的 adapter（UC-V11-26）。
- Webhook 訂閱 CRUD UI（`webhook_subscriptions` 表已存在）。
- 多實例擴展（Postgres + 共用 queue，或 sticky routing）—— 目前是單機。
- Run-replay 寫稽核 row。
- 編譯出 production build（tsc-emit 或 esbuild bundle）—— 目前生產也跑 `tsx` 可接受，但 Dockerfile + `pnpm db:migrate` 順序需要寫。

### 14.4 該長期保留的優勢

1. Zod 契約覆蓋全部 API 的習慣；新路由不該自創形狀。
2. 啟動冪等 —— 每一步都要可重複執行。
3. Inngest step.run 紀律 —— Inngest handler 內的 DB 寫入務必在 `step.run` 之內。
4. Manifest 四階段 commit（DB tx → fsync → rename → re-register）—— 這保住了崩潰恢復性質。
5. `assertAuthModeSafe()` —— 「響亮地啟動失敗，勝過悄悄繞過生產 auth」的精神應該支配未來每一個依 env-var 分支的程式碼。

---

## 15. 快速檔案索引

| 關注點 | 檔案位置 |
|---|---|
| 啟動編排 | `apps/api/src/server.ts:38`、`apps/api/src/bootstrap.ts:71` |
| Auth | `apps/api/src/plugins/auth.ts:143`、`auth.ts:205` |
| 信封 + 錯誤映射 | `apps/api/src/plugins/error.ts:39` |
| Graceful shutdown | `apps/api/src/plugins/shutdown.ts` |
| Security headers | `apps/api/src/plugins/security.ts` |
| Manifest import（1640 行） | `apps/api/src/services/manifest-import.ts` |
| 崩潰恢復 | `apps/api/src/services/reconcile-imports.ts` |
| SSRF | `apps/api/src/services/ssrf-guard.ts` |
| 供應商金鑰 | `apps/api/src/services/provider-keys.ts` |
| Model fleet | `apps/api/src/services/model-fleet.ts` |
| Idempotency cache | `apps/api/src/services/idempotency.ts` |
| Step engine | `packages/runtime/src/register.ts:53`、`step-engine.ts:158` |
| Manifest linter | `packages/runtime/src/lint.ts` |
| Schema | `packages/db/src/schema.ts`、`packages/db/drizzle/` 下的 migrations |
| 原生綁定解析 | `packages/db/src/client.ts:25` |
| LLM Gateway | `packages/llm-gateway/src/gateway.ts:71` |
| BaseAgent + run engine | `packages/agents/src/{base-agent,run-engine}.ts` |
| Contracts | `packages/contracts/src/index.ts` |
| Web 型別 client | `apps/web/lib/api-client.ts:40` |
| 測試 | `apps/api/test/tc-*.test.ts`、`setup.ts`、`harness.ts` |

---

*本文件為中英雙語審查的中文半邊。英文版位於 `backend-implementation-review-en.md`。*
