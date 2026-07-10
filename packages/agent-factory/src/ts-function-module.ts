// #P1 — ts_function_module:把一个 GeneratedAgentSpec 渲染成【可部署到 Inngest 的 function】TS 模块,
// 对标旧 AO 的 server/inngest/agents/*.ts(create-jd / resume-parser / rule-check / match-resume /
// interview-inviter / candidate-identity)。这是融合蓝图 §07 的第一交付形态。
//
// 与 specToAgentCode(codegen.ts,产出"不直接运行"的 defineAgent 参考渲染)不同:本渲染器产出的是
// 旧六文件那种 inngest.createFunction 形态,并把六文件画像里【不可从 spec 推导的三类定制逻辑】显式
// 挖成三个槽位(#SLOT),留给 codegen_agent 用黄金范例填(骨架确定性渲染,槽位 LLM 填)。
//
// 地面实况(六文件画像):~30% 是骨架(注册/暂停闸/日志/信封解包/step 包裹/emit),可机械生成;
// ~60-75% 集中在三槽:fieldMapping(字段映射扁平化)/errorTaxonomy(业务FAIL·可恢复PARK·终态emit·
// 强制持久化rethrow)/controlFlow(多路收敛·fan-out)。step 原语只用三个:step.run/step.sendEvent/
// step.invoke——无 waitForEvent/cancelOn/并发键,所以动作空间很窄。
//
// 本模块【纯确定性】:同 spec 同 opts 逐字节同输出。真部署(把它注册进 -sb / 生产 Inngest)是 P1b。

import type { GeneratedAgentSpec } from "./spec-types";

export interface TsFunctionModuleOpts {
  /** import profile:new-AO(全局工具 registry) | old-AO(@/lib/* 旧仓库形态)。默认 new-AO。 */
  profile?: "new-ao" | "old-ao";
  /** 暂停闸 helper 名(旧 AO 用 skipIfRaasV1Paused)。缺省不生成暂停闸。 */
  pauseGate?: string;
}

function camel(s: string): string {
  return s ? s[0]!.toLowerCase() + s.slice(1) : "agent";
}
function esc(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
}
/** 稳定 step id:动词-清洗过的锚点(旧六文件的 sanitize 惯例)。 */
function stepId(verb: string, anchor: string): string {
  const a = anchor.replace(/[^A-Za-z0-9-]/g, "-").slice(0, 40).replace(/-+/g, "-").replace(/^-|-$/g, "");
  return `${verb}-${a || "x"}`;
}

/** 从 spec 推导失败 emit 事件名:多 emit 取最后一个;单/零 emit 从 trigger/action 派生一个 _FAILED。 */
function failEmitOf(spec: GeneratedAgentSpec): string {
  const emits = (spec.emit ?? []).filter(Boolean);
  if (emits.length > 1) return emits[emits.length - 1]!;
  const base = (emits[0] ?? spec.trigger?.[0] ?? spec.actionName ?? "TASK").toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/_(PROCESSED|DONE|GENERATED|SENT|PASSED|OK)$/, "");
  return `${base}_FAILED`;
}

/** 渲染一个 ts_function_module。 */
export function renderTsFunctionModule(spec: GeneratedAgentSpec, opts: TsFunctionModuleOpts = {}): string {
  const profile = opts.profile ?? "new-ao";
  const short = spec.short || spec.actionName || "agent";
  const exportName = camel(short) + (/agent$/i.test(short) ? "" : "Agent");
  const tools = (spec.tools ?? []).filter(Boolean);
  const emits = (spec.emit ?? []).filter(Boolean);
  const triggers = (spec.trigger ?? []).filter(Boolean);
  const retries = spec.hitl ? 1 : 3;
  const failEmit = failEmitOf(spec);
  const successEmit = emits[0] ?? "DONE";

  // 触发器:多 trigger → triggers:[{event}]（旧 create-jd 就是多 trigger）。
  const triggerConfig =
    triggers.length <= 1
      ? `{ event: ${JSON.stringify(triggers[0] ?? `${spec.domainId}/entry`)} }`
      : `[${triggers.map((t) => `{ event: ${JSON.stringify(t)} }`).join(", ")}]`;

  // 共享基础设施 = import-不生成。new-AO:全局工具经 ctx.tools;old-AO:@/lib/* 直接 import。
  const imports =
    profile === "old-ao"
      ? [
          `import { inngest } from "@/server/inngest/client";`,
          spec.hitl ? "" : `// import { NonRetriableError } from "inngest";`,
          ...(tools.length ? [`// [deploy-profile] 真部署时解开这些共享库 import(import 不生成):`, ...tools.map((t) => `// import { ${camel(t.split(".").pop() || "call")} } from "@/lib/${t.split(".")[0]}";`)] : []),
        ]
      : [
          `import { inngest } from "@/server/inngest/client";`,
          `// [deploy-profile] new-AO 形态:外部能力经 ctx.tools.run("<tool>", args) 走全局工具 registry。`,
          ...(tools.length ? [`// 本 agent 绑定的工具:${tools.join(", ")}`] : [`// 本 agent 不依赖外部工具。`]),
        ];

  const stepRuns = tools.length
    ? tools.map((t) => {
        const v = camel(t.split(".").pop() || "call");
        const id = stepId(v, `${spec.slug}-${t}`);
        return [
          `      // 外部调用包在 step.run(稳定 id) 里:幂等 + durable(重放只产一行)。`,
          `      const ${v}Result = await step.run(${JSON.stringify(id)}, async () => {`,
          profile === "old-ao"
            ? `        return await ${v}(mapped); // TODO(填槽 fieldMapping 后传对形状)`
            : `        return await (ctx as any)?.tools?.run?.(${JSON.stringify(t)}, mapped) ?? {};`,
          `      });`,
        ].join("\n");
      }).join("\n")
    : "      // (无外部调用)";

  // emit:单 emit 直发;多 emit 走分支(条件是 controlFlow 槽的一部分,骨架给二分示例)。
  const emitBlock =
    emits.length <= 1
      ? `      await step.sendEvent(${JSON.stringify(stepId("emit", successEmit))}, { name: ${JSON.stringify(successEmit)}, data: { ...mapped, ...decision } });`
      : [
          `      // 分支 emit(具体条件见 SYSTEM_PROMPT + #SLOT controlFlow):`,
          `      if (decision.pass) {`,
          `        await step.sendEvent(${JSON.stringify(stepId("emit", successEmit))}, { name: ${JSON.stringify(successEmit)}, data: { ...mapped, ...decision } });`,
          `      } else {`,
          `        await step.sendEvent(${JSON.stringify(stepId("emit", failEmit))}, { name: ${JSON.stringify(failEmit)}, data: { ...mapped, ...decision } });`,
          `      }`,
          emits.length > 2 ? `      // 其余分支:${emits.slice(1, -1).join(", ")} — 按条件补(controlFlow 槽)。` : "",
        ].filter(Boolean).join("\n");

  return [
    `// ${spec.nameZh || short} — 由 Agent 工厂从本体动作 \`${spec.actionName}\`(${spec.domainId})生成。`,
    `// 目标形态:可部署到 Inngest 的 function(对标旧 AO server/inngest/agents/*.ts)。`,
    `// trigger: ${triggers.join(" / ") || "(entry)"} → emit: ${emits.join(" | ") || "(terminal)"}`,
    ``,
    ...imports.filter(Boolean),
    ``,
    `const AGENT_ID = ${JSON.stringify(spec.slug)};`,
    `/** 工厂为这一个 agent 亲自推理出的 system prompt。 */`,
    "const SYSTEM_PROMPT = `" + esc(spec.systemPrompt ?? "") + "`;",
    ``,
    `// ──────────────────────────────────────────────────────────────────────────`,
    `// #SLOT-1 fieldMapping — 事件 payload 的松散字段 → 本 agent 需要的形状/文本。`,
    `//   黄金范例:create-jd.buildPromptFromRequirement(40+ 字段)、match-resume.buildResumeTextFromParsed。`,
    `//   TODO(工厂填槽):按本体 DataObject 字段与语义实现。骨架先透传。`,
    `function mapFields(data: Record<string, unknown>): Record<string, unknown> {`,
    `  return data;`,
    `}`,
    ``,
    `// #SLOT-2 errorTaxonomy — 把一次失败分成:business_fail(发 _FAILED 事件) / park(throw→Inngest 重试,`,
    `//   不发终态) / terminal(不可恢复,发 _FAILED) / rethrow(强制持久化失败,必须上抛)。`,
    `//   黄金范例:rule-check.isInfraFailure(park)、interview-inviter 终态码分级、resume-parser 依赖降级。`,
    `//   TODO(工厂填槽):按依赖健康分类实现。骨架保守默认 park(不误拒、等重试)。`,
    `function classifyError(_e: unknown): "business_fail" | "park" | "terminal" | "rethrow" {`,
    `  return "park";`,
    `}`,
    ``,
    `// #SLOT-3 controlFlow — 多路径/循环控制流(单路径 agent 此槽为空)。`,
    `//   黄金范例:rule-check 三路 JR 收敛 + per-JR fan-out;resume-parser 双路(parsed/etag)分叉。`,
    `//   TODO(工厂填槽):若本 agent 需要 fan-out,在 handler 里对每个子项 step.run(带稳定 per-item id)。`,
    `// ──────────────────────────────────────────────────────────────────────────`,
    ``,
    `export const ${exportName} = inngest.createFunction(`,
    `  { id: AGENT_ID, name: ${JSON.stringify(short)}, retries: ${retries} },`,
    `  ${triggerConfig},`,
    `  async ({ event, step, logger }) => {`,
    `    // 信封解包:RAAS canonical envelope(data.payload)优先,回退扁平 data。`,
    `    const raw = ((event.data as Record<string, unknown>)?.payload ?? event.data ?? {}) as Record<string, unknown>;`,
    `    const mapped = mapFields(raw);`,
    ...(opts.pauseGate ? [`    // 暂停闸(fleet kill-switch)——任何工作之前。`, `    // const paused = await ${opts.pauseGate}(AGENT_ID, logger); if (paused) return paused;`] : []),
    `    logger.info("${esc(spec.slug)} handler.start", { keys: Object.keys(mapped) });`,
    `    try {`,
    `      // 决策核心:用本 agent 的 SYSTEM_PROMPT 对 mapped 做判断(真部署时走 LLM 网关 / step.run)。`,
    `      const decision: { pass: boolean; [k: string]: unknown } = { pass: true };`,
    `      void SYSTEM_PROMPT;`,
    stepRuns,
    emitBlock,
    `      logger.info("${esc(spec.slug)} handler.done");`,
    `      return { ok: true };`,
    `    } catch (e) {`,
    `      const kind = classifyError(e);`,
    `      // park / rethrow → 上抛(Inngest 重试 / 强制持久化失败);business_fail / terminal → 发 _FAILED。`,
    `      if (kind === "park" || kind === "rethrow") throw e;`,
    `      await step.sendEvent(${JSON.stringify(stepId("emit", failEmit))}, { name: ${JSON.stringify(failEmit)}, data: { ...mapped, error: String((e as Error)?.message ?? e) } });`,
    `      return { ok: false };`,
    `    }`,
    `  },`,
    `);`,
    ``,
  ].join("\n");
}
