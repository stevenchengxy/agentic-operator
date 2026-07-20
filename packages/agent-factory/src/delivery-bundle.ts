// #DELIVERY-BUNDLE (P2-8) — one deterministic, inspectable delivery artifact.
//
// At finish time the evidence lives scattered across ctx (specs, validation, sandbox receipts, boundary
// contracts, regression verdicts). This packs it into ONE markdown bundle the user can hand to a
// reviewer / downstream team: per-agent cards, the event chain, external handoff contracts, the honest
// verification status (real receipts only — a simulated pass is labelled as such, never laundered).
// Pure function → unit-testable; the tool wraps it.

import type { BrainCtx } from "./brain-types";

const cap = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s);

export function buildDeliveryBundle(ctx: Pick<BrainCtx,
  "domain" | "specs" | "lastValidation" | "lastSandbox" | "boundaryEvents" | "testCases" | "regressionBaseline"
>): string {
  const specs = ctx.specs.filter((s) => !s.isSubAgent);
  const subs = ctx.specs.filter((s) => s.isSubAgent);
  const sb = ctx.lastSandbox;
  const lines: string[] = [];

  lines.push(`# 交付包 · ${ctx.domain}`);
  lines.push(`生成 agent：${specs.length} 个${subs.length ? `（另有 ${subs.length} 个 invoke 子 agent）` : ""} · 打包时间见运行记录`);

  lines.push(`\n## 一、Agent 清单`);
  for (const s of specs) {
    const code = s.generatedCode ? `${s.generatedCode.split("\n").length} 行${s.codeExecuted ? " · ⚙ 真实执行(CodeAct)" : " · 📄 声明式"}` : "无";
    lines.push([
      `\n### ${s.nameZh}（${s.actionName}）`,
      `- 触发: ${s.trigger.join("、") || "（无）"} → 产出: ${s.emit.join("、") || "（无）"}`,
      `- 工具: ${s.tools.join("、") || "无"}${s.unresolvedTools?.length ? ` · ⚠ 未解析: ${s.unresolvedTools.join("、")}` : ""}`,
      `- 输入: ${(s.inputSchema ?? []).map((f) => `${f.field}:${f.type}`).join(", ") || "无"} → 输出: ${(s.outputSchema ?? []).map((f) => `${f.field}:${f.type}`).join(", ") || "无"}`,
      `- 代码: ${code}${s.plan?.length ? ` · plan ${s.plan.length} 步` : ""}${s.compensationEvent ? ` · 补偿事件: ${s.compensationEvent}` : ""}`,
      `- 职责: ${cap(s.designReasoning ?? s.systemPrompt, 160)}`,
    ].join("\n"));
    for (const sub of subs.filter((x) => x.parentAction === s.actionName)) {
      lines.push(`  - ↳ 子 agent ${sub.short}（${cap(sub.parentTask ?? "", 40)}）· invoke 同步调用`);
    }
  }

  lines.push(`\n## 二、静态校验`);
  if (ctx.lastValidation) {
    const v = ctx.lastValidation as unknown as { ok?: boolean; issues?: string[] };
    lines.push(v.ok ? `✅ validate_graph 通过（事件图闭合 + 字段合同）` : `❌ 未通过：\n${(v.issues ?? []).slice(0, 10).map((i) => `- ${cap(i, 140)}`).join("\n")}`);
  } else lines.push(`（未运行 validate_graph）`);

  lines.push(`\n## 三、真实运行证据（沙箱）`);
  if (sb) {
    lines.push([
      sb.simulated ? `⚠ **模拟运行**——不构成交付证据` : `✅ 真实 Inngest 部署运行`,
      `- 部署 ${sb.deployed} 函数 · 实跑 ${sb.agentsRan} 个（${sb.ranAgents.join("、") || "无"}）`,
      `- 事件链: ${sb.fullChainRan ? "全链跑通" : "未全链"} · 成功终态: ${sb.reachedSuccessTerminal ? "✓" : "✗"}`,
      sb.codeRanAgents?.length ? `- 代码真实执行: ${sb.codeRanAgents.join("、")}` : "",
      sb.fidelityFailures?.length ? `- ⚠ 契约保真违约: ${sb.fidelityFailures.join("、")}` : "- 契约保真: 无违约",
      sb.degradedAgents.length ? `- ⚠ 降级: ${sb.degradedAgents.join("、")}` : "",
    ].filter(Boolean).join("\n"));
  } else lines.push(`（无沙箱证据——本包不可作为可上线依据）`);

  if (ctx.regressionBaseline && Object.keys(ctx.regressionBaseline.verdicts).length) {
    const vs = Object.entries(ctx.regressionBaseline.verdicts);
    const pass = vs.filter(([, v]) => v.pass).length;
    lines.push(`\n## 四、回归套件`);
    lines.push(`${pass}/${vs.length} 用例通过${vs.length - pass ? `；失败：${vs.filter(([, v]) => !v.pass).map(([n]) => n).join("、")}` : ""}`);
  }

  const externals = (ctx.boundaryEvents ?? []).filter((b) => b.kind === "external");
  if (externals.length) {
    lines.push(`\n## 五、对外交接契约（下游消费方核对用）`);
    for (const b of externals) {
      lines.push(`- **${b.event}** → 消费方: ${b.consumer ?? "（未填）"}${b.payloadContract ? `\n  payload: ${cap(b.payloadContract, 200)}` : ""}`);
    }
  }

  const caveats: string[] = [];
  if (!sb) caveats.push("无沙箱证据");
  if (sb?.simulated) caveats.push("沙箱为模拟运行");
  for (const s of specs) if (s.unresolvedTools?.length) caveats.push(`${s.actionName} 有未解析工具`);
  lines.push(`\n## ${externals.length ? "六" : "五"}、诚实声明`);
  lines.push(caveats.length ? caveats.map((c) => `- ⚠ ${c}`).join("\n") : "- 无保留事项：以上证据均来自真实运行回执。");

  return lines.join("\n");
}
