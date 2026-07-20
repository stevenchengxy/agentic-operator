# Agents-generation 工具库接线 + Ontology-grounded 蓝图可视化 — 设计

**日期**: 2026-07-17
**范围**: `packages/recruitment-capabilities` · `apps/api/src/services/agent-factory` · `packages/agent-factory/src` · `packages/tools/src` · `apps/web/.../factory`
**硬约束(用户)**: 一切信息取自 Ontology;AI 推理每一步都从 Ontology 取数据/证据支撑,并把 Ontology 事实持续留在推理上下文强化记忆;缺证据 **fail-closed**,绝不编造路由/字段/规则/凭证/契约。

---

## 1. 背景与已核实事实

### 1.1 当前阻断(截图)
Agents-generation 域生成时,6 个动作 `createJD / processResume / ruleCheckForCandidateIdentity / ruleCheckForMatchResume / matchResume / inviteInternalInterview` 因"缺工具"被设计门 fail-closed:阻断码 `catalog_readiness_requires_authoritative_input`,`还缺: integration_bindings`。点名缺失:`loadRaasRequirement / persistJd / persistRaasEntities / routeResumeProcessed`,以及需连接 `RAAS_System / GoHire_System / Allmeta_Ontology_System`。

### 1.2 根因(已核实,`grep` 证据)
缺失工具**已实现**在 `packages/recruitment-capabilities/`,由 `createRecruitmentRaasCapabilityPack(profile)` 打包:
- `loadRaasRequirement`(raas-requirement.ts)、`persistJd`(jd-store.ts)、`persistRaasEntities`(raas-persistence.ts)、`routeResumeProcessed`(route-resume-processed.ts)、`candidateDedupLookup`、`loadRaasRuleContext`、`reasoning.evaluateRules`、`routeMatchOutcome`、`routeInterviewInvitation`(共 9 个)。
- 工具是**租户绑定**的:`bindTool` 校验签名租户 `tenantSlug`,并可 `requireExplicitProfile` 强制 `tool_use[].config` 带确认过的集成档。

**关键**: `createRecruitmentRaasCapabilityPack` 在 `apps/api/src` 与 `packages/agent-factory/src` 中**零调用**(仅测试引用)。即工具实现好但**从未接进工厂运行时的租户原生工具目录**(`tenant-native-tool-provider.ts` 通道),所以设计门看不到它们 → 报"缺工具"。工厂拒绝自行绑定/猜契约是**正确的 fail-closed 行为**;修复责任在开发者侧接线,不在放松工厂。

### 1.3 现有可视化能力(已核实,可复用不重造)
- `deriveBusinessFlow`(business-flow.ts,纯确定性,无 LLM)→ `{t:'flow.business'}` 事件(`validate_graph` 发)→ 前端 `BusinessFlowPanel` React 泳道。
- `renderWorkflowSvg`(business-flow-svg.ts):**完整、确定性、暗色 SVG 泳道渲染器,当前无人使用(仅测试)** — 直接采纳。
- `viz.svgChart`(bar/donut/line/flow)、`report.htmlToPdf`(headless Chrome,网络隔离)— 纯渲染器,全局工具。
- `report-jobs.ts` 管线:读本体→`buildCharts`(图型硬编码)→`reportGenerator` agent 写 HTML→`verifyReportGrounding` 接地审校→`substituteCharts`→写 `data/reports/<tenant>/`→可选 PDF。触发:`generate_report` 大脑工具 / `POST /report`;后台任务面板经 `GET /background` 轮询。
- `create_plan` 是最接近"AI 推理编排多智能体工作流"的,但只输出**文本** BuildPlan,无图。
- **完全缺失**: mermaid、时序图、AI 决定图型 — 全库零引用。

---

## 2. 子系统 1 — Agents-generation 工具库接线

**目标**: 让 `design_agent` 能把这 9 个已实现工具绑定到 6 个动作,解除 `integration_bindings` 阻断,全程 ontology-grounded、能连的接真、没建好的显式标人工边界。

### 2.1 组件与做法
1. **补全租户原生工具契约**: 为 recruitment 包的每个工具补 `tenant-native-tool-provider.ts` 要求的声明:`category / source.modulePath / operation / effectScope / sandboxPolicy / probeSafety(write 或 dual) / lifecycle(requires_attempt_grant) / capabilities[].systems / credentialEnv`。工具**逻辑不改**,只加契约元数据。
2. **注册进域的租户原生目录**: 在 api bootstrap 把 `createRecruitmentRaasCapabilityPack(profile)` 经 tenant-native-tool-provider 接入 Agents-generation 域所属租户(zhaopin),使 `design_agent` 的工具目录可见这些工具。
3. **建集成档(integration profiles)**: 为需真实凭证/端点的工具建 confirmed 集成档,连真实系统:
   - `RAAS_System` → `raas-pg`(本地 raas-postgres 容器)
   - `Allmeta_Ontology_System` → Allmeta Studio :3500(`ALLMETA_API_KEY`)
   - `GoHire_System` → gohire.top(既有 robohire/gohire 工具族)
4. **人工边界**: 6 个动作里若某动作的目标系统确无后端,在域配置显式声明 human boundary(fail-closed 标注,草稿可过但诚实标"人工"),**不猜**。
5. **绑定依据 = Ontology**: action→system→operation 的映射取自权威 Ontology 声明(动作的 `action_steps` / 集成需求),不靠工具名启发式。

### 2.2 待实现时核实(上一个探查 agent 撞会话限额未完成)
- 权威 Ontology 里 6 个动作各自 `action_steps` 声明需要哪些 tool/system/operation(逐动作核对缺口)。
- `tenant-native-tool-provider.ts` 契约字段全集与校验点(`apps/api/.../tenant-native-tool-provider.ts:85-189`)。
- 集成档确认流(`integration-profile.ts` / `integration-profile-authorization.ts` / `tool-credential-gap.ts`)如何把 confirmed profile 喂给设计门。
- 9 个工具的现有契约/入参(`raas-requirement.ts` 等),确认 `capabilities.systems` 与 Ontology 系统名一致。

### 2.3 验收
- 重跑 Agents-generation 生成,6 个动作不再报 `integration_bindings` 缺失;或明确停在诚实的 human-boundary 标注(而非"缺工具")。
- 被绑定工具在沙箱金丝雀能真跑(卡带/真连,视集成档),不是占位。

---

## 3. 子系统 2 — Ontology-grounded 蓝图/工作流可视化

**目标**: 新大脑工具 `build_blueprint`,让 AI 推理编排 sub-agents/内部工具,把 Ontology 梳理成**分阶段** workflow/业务流/agent 蓝图,**AI 自由选图型**,渲染到内联事件 + 后台报告双落点;每个结构元素可追溯回 Ontology 证据。

### 3.1 数据模型: `BlueprintModel`(新增,`packages/agent-factory/src/blueprint.ts`)
```
BlueprintModel = {
  domain, ontologySig,                 // 绑定权威本体内容哈希(证据新鲜度)
  phases: Phase[],                     // AI 推理出的阶段
  diagrams: Diagram[],                 // AI 选定的图(可多张、多型)
  unresolved?: string[],               // 缺证据项(fail-closed 记录,不编造)
}
Phase = {
  id, title, intent,
  steps: BlueprintStep[],
  anchors: OntologyAnchor[],           // 该 phase 依据的本体锚点
}
BlueprintStep = {
  label, agent?, reads?, writes?, emits?,
  anchors: OntologyAnchor[],           // 每步的本体证据(entity/action/rule/event id)
}
OntologyAnchor = { kind: 'entity'|'action'|'rule'|'event', id, evidence }  // 必填,缺则该元素进 unresolved
Diagram = { kind: 'mermaid'|'sequence'|'swimlane'|'html', title, svg, source? }  // svg=预渲染字节
```
**接地不变量**: 任一 phase/step/edge 没有 ≥1 个 `OntologyAnchor` → 不进 `phases`,进 `unresolved`;`build_blueprint` 返回 unresolved 非空时如实呈现"待补证据",绝不填空。

### 3.2 推理编排(ontology-grounded)
- 复用**推理内核** `runReasoning`(cot/debate/tot)做 phase 划分;复用**本体 4 维专家**(objects/rules/actions/events)按 phase 取证。
- 每次内核步骤的输入都注入相关 Ontology 切片(强化记忆);产出必须引用锚点。
- **图型选择也是推理**: AI 依据内容判断(有明确事件时序→sequence;多 agent 并行→swimlane;阶段决策树→mermaid flow;需交互解释→html),选择理由记入 blueprint。

### 3.3 渲染(服务端预渲染→SVG,已定)
- 新纯渲染器 `packages/tools/src/viz/`:
  - `mermaidToSvg`:用**既有 headless Chrome**(现打 PDF 那套 `pdf.ts` 的 Chrome)载入内联 mermaid.js 页面 → 导出确定性 SVG 字节(网络隔离,自包含)。
  - `sequenceToSvg`:纯 SVG 时序图渲染器(lifelines + messages),或经同一 mermaid 通道(`sequenceDiagram`)。
  - 采纳 `renderWorkflowSvg` 作 swimlane。
- 全部产出**确定性 SVG 字节**,内嵌事件与报告,符合全库"SVG 逐字内嵌"约定,PDF 一致。

### 3.4 双落点(用户都要)
- **内联事件**: 新 `BrainEvent` 种类 `{t:'flow.blueprint', model}`(`brain-types.ts` union 加一项)→ 新前端 `BlueprintPanel`(镜像 `business-flow-panel.tsx` + 挂载点 + `model.ts` 接线)渲染分阶段 workflow + 内嵌 SVG,phase/step 悬浮显示 ontology 锚点。
- **后台报告**: `report-jobs.ts` 扩展:`buildCharts` 接受 blueprint 的 `Diagram.svg` 作 `ReportChart`,`reportGenerator` 写 ontology-grounded 蓝图 HTML,`verifyReportGrounding` 复用(每结论须引锚点),落 `data/reports/`,可导 PDF。触发:`build_blueprint` 大脑工具(或 `generate_report` 增 `blueprint` 模式)。

### 3.5 验收
- 对 Agents-generation 本体调 `build_blueprint`,产出分阶段蓝图,每 phase/step 带可追溯 ontology 锚点;
- AI 在不同本体上会选不同图型(至少验证 sequence 与 swimlane 两条路径);
- 内联事件在 UI 渲染、后台报告出 HTML(+PDF);
- 制造一个缺证据场景 → 该元素进 `unresolved` 而非被编造。

---

## 4. 隔离与边界(设计为可独立理解/测试的小单元)
- `blueprint.ts`(模型 + 接地不变量,纯函数,可单测)
- `mermaidToSvg` / `sequenceToSvg`(纯渲染器,确定性字节,可单测)
- `build_blueprint`(大脑工具,编排 + 取证 + 组装,依赖注入 ports)
- recruitment 工具接线(契约声明 + provider 注册 + 集成档,不改工具逻辑)
- 前端 `BlueprintPanel`(纯 fold 事件数组,无第二份状态)

## 5. 测试
- 单测: blueprint 接地不变量(缺锚点→unresolved)、mermaidToSvg/sequenceToSvg 确定性、recruitment 工具契约声明完整、tenant-native 注册。
- 集成/live: 重跑 Agents-generation 生成解阻断;`build_blueprint` live 产出双落点;沙箱金丝雀真跑被绑定工具。
- 遵守仓库既有 vitest(`pool:forks`,共享 SQLite)与 Node 26 约束。

## 6. 分期(用户选"两条线一起推";实现按此序降风险)
1. 子系统 1 接线(解当前 run 阻断,最高优先)。
2. `blueprint.ts` 模型 + 接地不变量 + 单测。
3. `mermaidToSvg`/`sequenceToSvg` 渲染器 + 单测。
4. `build_blueprint` 大脑工具 + 内联事件 + 前端 panel。
5. `report-jobs` 扩展蓝图报告 + PDF。
6. Live 验证两块互相印证(可视化直接画子系统 1 新接工具后的真实链路)。

## 7. 非目标(YAGNI)
- 不放松工厂 fail-closed 门去"猜"工具/契约。
- 不引入前端 mermaid 运行时(与确定性-SVG 约定冲突)。
- 不把 recruitment 业务工具全局化(破坏租户隔离)。
- 不改既有 `flow.business`/`deriveBusinessFlow`(蓝图是新增的更高层能力,不替换)。
