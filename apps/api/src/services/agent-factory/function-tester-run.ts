// #P2.5-Tester — 生成→真跑→验收 的执行装配(apps/api 同时依赖 agent-factory + runtime)。
// 把一个 GeneratedAgentSpec 渲染成 ts_function_module(交付形态)→ 变换成自包含测试模块 →
// 在 P0a 的 worker 隔离里【真执行它的 handler】→ 用 Tester 判据打分。这是"加一个真执行验证角色"
// (研究证据:AgentCoder/Self-Collab 的增益主要来自此,而非多派 leader)。

import {
  renderTsFunctionModule,
  harnessTsModuleForTest,
  gradeFunctionTest,
  type GeneratedAgentSpec,
  type TsFunctionModuleOpts,
  type FunctionTestVerdict,
} from "@agentic/agent-factory";
import { runGeneratedModule, runGeneratedModuleProcess, runGeneratedModuleContainer, type ModuleRunResult, type RunModuleOpts } from "@agentic/runtime";

// #P6 — isolation tier for the Tester's real execution. Escalate via FACTORY_EXEC_TIER:
//   worker(default) → in-process worker_thread(fastest;时间/内存隔离,非安全边界)
//   process         → child process + scrubbed env(剥离密钥;更强)
//   container       → Docker(--network none/--read-only/caps dropped/非root;最强,不可用则回退子进程)
export type ExecTier = "worker" | "process" | "container";
export function execTier(): ExecTier {
  const t = (process.env.FACTORY_EXEC_TIER ?? "").trim().toLowerCase();
  return t === "process" || t === "container" ? t : "worker";
}
function runByTier(tier: ExecTier, code: string, opts: RunModuleOpts): Promise<ModuleRunResult> {
  if (tier === "container") return runGeneratedModuleContainer(code, opts);
  if (tier === "process") return runGeneratedModuleProcess(code, opts);
  return runGeneratedModule(code, opts);
}

export interface TestGeneratedFunctionResult {
  /** 渲染出的交付形态代码(inngest.createFunction)。 */
  code: string;
  /** Tester 判据:跑通?发出期望事件? */
  verdict: FunctionTestVerdict;
  /** 实际用的隔离层(worker/process/container)。 */
  tier: ExecTier;
}

/** 渲染 + 隔离真跑 + 打分一个生成的 function。never throws。 */
export async function testGeneratedFunction(
  spec: GeneratedAgentSpec,
  opts: {
    testEvent?: unknown;
    /** 期望它 emit 的事件之一(缺省=只要 handler 跑通即算通过)。 */
    expectEmits?: string[];
    render?: TsFunctionModuleOpts;
    timeoutMs?: number;
    /** 若给,必须是 -sb 沙箱租户(隔离不变量)。 */
    tenantSlug?: string;
    /** 隔离层覆盖(缺省从 FACTORY_EXEC_TIER 读:worker/process/container)。 */
    tier?: ExecTier;
  } = {},
): Promise<TestGeneratedFunctionResult> {
  const code = renderTsFunctionModule(spec, opts.render);
  const harnessed = harnessTsModuleForTest(code);
  const tier = opts.tier ?? execTier();
  const run = await runByTier(tier, harnessed, {
    entryName: "__run",
    call: true,
    args: [opts.testEvent ?? { data: { payload: {} } }],
    // container startup is slower — give it more headroom by default.
    timeoutMs: opts.timeoutMs ?? (tier === "container" ? 30000 : 8000),
    tenantSlug: opts.tenantSlug,
  });
  const verdict = gradeFunctionTest(run, { expectEmits: opts.expectEmits });
  return { code, verdict, tier };
}
